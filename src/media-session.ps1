param(
  [ValidateSet('snapshot', 'toggle', 'next', 'previous')]
  [string]$Action = 'snapshot'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

function Await-WinRtOperation($Operation, [Type]$ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Get-ImageDataUrl($Thumbnail) {
  if ($null -eq $Thumbnail) { return $null }
  try {
    $stream = Await-WinRtOperation $Thumbnail.OpenReadAsync() ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $buffer = Await-WinRtOperation ($stream.ReadAsync($null, $stream.Size, [Windows.Storage.Streams.InputStreamOptions]::None)) ([Windows.Storage.Streams.IBuffer])
    $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($buffer)
    $bytes = New-Object byte[] $buffer.Length
    $reader.ReadBytes($bytes)
    $reader.Dispose(); $stream.Dispose()
    return 'data:image/jpeg;base64,' + [Convert]::ToBase64String($bytes)
  } catch { return $null }
}

try {
  $manager = Await-WinRtOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) {
    @{ ok = $true; active = $false } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Action -eq 'toggle') { [void](Await-WinRtOperation $session.TryTogglePlayPauseAsync() ([bool])) }
  if ($Action -eq 'next') { [void](Await-WinRtOperation $session.TrySkipNextAsync() ([bool])) }
  if ($Action -eq 'previous') { [void](Await-WinRtOperation $session.TrySkipPreviousAsync() ([bool])) }

  $media = Await-WinRtOperation ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $session.GetPlaybackInfo()
  $timeline = $session.GetTimelineProperties()
  $controls = $playback.Controls
  $state = [string]$playback.PlaybackStatus
  $duration = if ($timeline.EndTime.TotalSeconds -gt 0) { [math]::Round($timeline.EndTime.TotalSeconds) } else { 0 }
  $position = if ($timeline.Position.TotalSeconds -gt 0) { [math]::Round($timeline.Position.TotalSeconds) } else { 0 }
  @{
    ok = $true
    active = $true
    title = if ($media.Title) { $media.Title } else { 'Unknown title' }
    artist = if ($media.Artist) { $media.Artist } else { 'Unknown artist' }
    album = $media.AlbumTitle
    source = $session.SourceAppUserModelId
    isPlaying = ($state -eq 'Playing')
    position = $position
    duration = $duration
    canToggle = [bool]$controls.IsPlayPauseToggleEnabled
    canNext = [bool]$controls.IsNextEnabled
    canPrevious = [bool]$controls.IsPreviousEnabled
    artwork = Get-ImageDataUrl $media.Thumbnail
  } | ConvertTo-Json -Compress -Depth 3
} catch {
  @{ ok = $false; active = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}