# media-daemon.ps1
# Long-running replacement for media-session.ps1.
#
# Start it ONCE and keep it alive. It prints one JSON object per line on stdout:
#   {"type":"state", ok, active, key, title, artist, album, source, isPlaying, position, duration, canToggle, canNext, canPrevious}
#   {"type":"art", "key": "<same key as the state>", "artwork": "data:image/...;base64,..."}
# State lines never contain artwork. The art line is sent once per track, as soon as
# Windows has the thumbnail ready (retried for ~10 s), so titles show up instantly.
#
# Commands: write a line to stdin: toggle | next | previous | seek <seconds>
# The daemon exits by itself when stdin is closed (parent process gone).
#
# Stability rules (so the widget does not flicker):
#  - the media session is chosen deliberately and kept ("sticky") instead of following
#    whichever app Windows calls "current" at that instant
#  - a missing session, empty metadata or a failed WinRT call must persist for ~2 s
#    before it is reported; short glitches are ignored

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

# ---------- WinRT await helper (reflection lookup done once, not per call) ----------
$script:asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } |
  Select-Object -First 1
$script:genericCache = @{}

function Await-WinRtOperation($Operation, [Type]$ResultType) {
  if (-not $script:genericCache.ContainsKey($ResultType)) {
    $script:genericCache[$ResultType] = $script:asTaskMethod.MakeGenericMethod($ResultType)
  }
  $task = $script:genericCache[$ResultType].Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Emit($Object) {
  [Console]::Out.WriteLine(($Object | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}

# ---------- thumbnail (same reading logic as media-session.ps1) ----------
function Get-ImageDataUrl($Thumbnail) {
  if ($null -eq $Thumbnail) { return $null }
  try {
    $stream = Await-WinRtOperation $Thumbnail.OpenReadAsync() ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $mime = if ($stream.ContentType) { [string]$stream.ContentType } else { 'image/jpeg' }
    $buffer = Await-WinRtOperation ($stream.ReadAsync($null, $stream.Size, [Windows.Storage.Streams.InputStreamOptions]::None)) ([Windows.Storage.Streams.IBuffer])
    $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($buffer)
    $bytes = New-Object byte[] $buffer.Length
    $reader.ReadBytes($bytes)
    $reader.Dispose(); $stream.Dispose()
    if ($bytes.Length -eq 0) { return $null }
    return "data:$mime;base64," + [Convert]::ToBase64String($bytes)
  } catch { return $null }
}

# ---------- session choice: prefer a playing session, stay on it ----------
$script:stickyId = $null

function Select-Session($Manager) {
  $sessions = @($Manager.GetSessions())
  if ($sessions.Count -eq 0) { return $null }

  $playing = @($sessions | Where-Object { [string]$_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' })
  $pool = if ($playing.Count -gt 0) { $playing } else { $sessions }

  $pick = $pool | Where-Object { $_.SourceAppUserModelId -eq $script:stickyId } | Select-Object -First 1
  if ($null -eq $pick -and $playing.Count -eq 0) { $pick = $Manager.GetCurrentSession() }
  if ($null -eq $pick) { $pick = $pool[0] }

  if ($null -ne $pick) { $script:stickyId = $pick.SourceAppUserModelId }
  return $pick
}

# ---------- stdin commands (non-blocking) ----------
$stdin = [Console]::OpenStandardInput()
$stdinBuffer = New-Object byte[] 256
$pending = ''
$readTask = $stdin.ReadAsync($stdinBuffer, 0, $stdinBuffer.Length)

# ---------- state ----------
$manager = Await-WinRtOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$lastKey = $null
$lastJson = ''
$force = $true
$artSent = $false
$artTries = 0
$nextArtTry = [DateTime]::MinValue
$lastError = ''
$noSessionTicks = 0
$emptyTicks = 0
$failTicks = 0
$GraceTicks = 8     # 8 ticks x 250 ms = ~2 s before a glitch is believed

while ($true) {
  # --- commands ---
  if ($readTask.IsCompleted) {
    if ($readTask.IsFaulted -or $readTask.Result -le 0) { break }   # parent closed stdin: exit
    $pending += [System.Text.Encoding]::UTF8.GetString($stdinBuffer, 0, $readTask.Result)
    $readTask = $stdin.ReadAsync($stdinBuffer, 0, $stdinBuffer.Length)
    while (($newline = $pending.IndexOf("`n")) -ge 0) {
      $command = $pending.Substring(0, $newline).Trim()
      $pending = $pending.Substring($newline + 1)
      try {
        $target = Select-Session $manager
        if ($null -ne $target) {
          if ($command -eq 'toggle')   { [void](Await-WinRtOperation $target.TryTogglePlayPauseAsync() ([bool])) }
          if ($command -eq 'next')     { [void](Await-WinRtOperation $target.TrySkipNextAsync() ([bool])) }
          if ($command -eq 'previous') { [void](Await-WinRtOperation $target.TrySkipPreviousAsync() ([bool])) }
          if ($command -like 'seek *') {
            # "seek 83" = jump to 83 seconds. WinRT wants the position in 100 ns ticks.
            $seconds = [double]::Parse($command.Substring(5).Trim(), [System.Globalization.CultureInfo]::InvariantCulture)
            if ($seconds -ge 0) { [void](Await-WinRtOperation $target.TryChangePlaybackPositionAsync([long]($seconds * 10000000)) ([bool])) }
          }
        }
      } catch { }
      $force = $true
    }
  }

  # --- one tick ---
  try {
    $session = Select-Session $manager

    if ($null -eq $session) {
      $noSessionTicks++
      if ($noSessionTicks -lt $GraceTicks) { Start-Sleep -Milliseconds 250; continue }   # brief gap (track change, app switch): say nothing
      $key = ''
      $state = [ordered]@{ type = 'state'; ok = $true; active = $false }
      $media = $null
    } else {
      $noSessionTicks = 0
      $media = Await-WinRtOperation ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])

      # Players often publish empty metadata for a moment while changing track: wait it out.
      if (-not $media.Title -and -not $media.Artist) {
        $emptyTicks++
        if ($emptyTicks -lt $GraceTicks) { Start-Sleep -Milliseconds 250; continue }
      } else {
        $emptyTicks = 0
      }

      $playback = $session.GetPlaybackInfo()
      $timeline = $session.GetTimelineProperties()
      $controls = $playback.Controls
      $playing = ([string]$playback.PlaybackStatus -eq 'Playing')

      $duration = if ($timeline.EndTime.TotalSeconds -gt 0) { [math]::Round($timeline.EndTime.TotalSeconds) } else { 0 }
      $position = [math]::Max(0, $timeline.Position.TotalSeconds)
      if ($playing) {
        # Position is a snapshot taken at LastUpdatedTime; add the time elapsed since then.
        $delta = ([DateTimeOffset]::Now - $timeline.LastUpdatedTime).TotalSeconds
        if ($delta -gt 0 -and $delta -lt 21600) { $position += $delta }
      }
      if ($duration -gt 0) { $position = [math]::Min($position, $duration) }

      $key = "$($media.Title)|$($media.Artist)|$($media.AlbumTitle)|$($session.SourceAppUserModelId)"
      $state = [ordered]@{
        type = 'state'
        ok = $true
        active = $true
        key = $key
        title = if ($media.Title) { $media.Title } else { 'Unknown title' }
        artist = if ($media.Artist) { $media.Artist } else { 'Unknown artist' }
        album = $media.AlbumTitle
        source = $session.SourceAppUserModelId
        isPlaying = $playing
        position = [math]::Floor($position)
        duration = $duration
        canToggle = [bool]$controls.IsPlayPauseToggleEnabled
        canNext = [bool]$controls.IsNextEnabled
        canPrevious = [bool]$controls.IsPreviousEnabled
        canSeek = [bool]$controls.IsPlaybackPositionEnabled
      }
    }

    # new track (or really no session): reset the artwork retry state
    if ($key -ne $lastKey) {
      $lastKey = $key
      $artSent = $false
      $artTries = 0
      $nextArtTry = [DateTime]::MinValue
      $force = $true
    }

    # state first, so the title appears immediately
    $json = $state | ConvertTo-Json -Compress -Depth 3
    if ($force -or $json -ne $lastJson) {
      [Console]::Out.WriteLine($json)
      [Console]::Out.Flush()
      $lastJson = $json
      $force = $false
    }

    # artwork second: only once per track, retried until Windows has it
    if ($null -ne $media -and -not $artSent -and $artTries -lt 30 -and [DateTime]::Now -ge $nextArtTry) {
      $artwork = Get-ImageDataUrl $media.Thumbnail
      if ($artwork) {
        Emit ([ordered]@{ type = 'art'; key = $key; artwork = $artwork })
        $artSent = $true
      } else {
        $artTries++
        $nextArtTry = [DateTime]::Now.AddMilliseconds(300)
      }
    }

    $failTicks = 0
    $lastError = ''
    Start-Sleep -Milliseconds 250
  } catch {
    # A single failed WinRT call must not blank the widget: only report after repeated failures.
    $failTicks++
    $message = $_.Exception.Message
    if ($failTicks -ge $GraceTicks -and $message -ne $lastError) {
      Emit ([ordered]@{ type = 'state'; ok = $false; active = $false; error = $message })
      $lastError = $message
      $lastKey = $null
      $lastJson = ''
    }
    Start-Sleep -Milliseconds 500
  }
}