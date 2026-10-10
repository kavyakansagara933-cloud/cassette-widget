# Cassette Widget

A retro cassette-tape "now playing" widget for the Windows desktop. It shows whatever is playing on your PC (Spotify, a browser tab, VLC and other players) on a glass-shelled cassette with a handwritten label, the album cover, spinning reels and basic playback controls.

<!-- Add a screenshot at docs/screenshot.png, then uncomment the next line -->
<!-- ![Cassette Widget](docs/screenshot.png) -->

## Features

- **Live now-playing info** from Windows media sessions: title, artist, album art, play state and progress
- **Album art on the label**, with a duotone tint picked from the cover's dominant colour, so every track gets its own look
- **Cover fallback**: if Windows has no thumbnail for a track, the cover is looked up online in the background (see Privacy)
- **Playback controls**: play/pause, next, previous, and click or drag the progress bar to seek (when the player allows it)
- **Real widget behaviour**: frameless and transparent, no taskbar button, tray icon, always-on-top pin, remembers its position
- **Click-through**: only the cassette and the controls catch the mouse; clicks anywhere else go to the apps behind it
- **Drag to move**: drag the cassette anywhere on screen; a plain click opens or hides the controls
- **Light on resources**: one long-running media process instead of one per update, adaptive polling, slower when hidden

## Requirements

- Windows 10 (version 1809 or later) or Windows 11
- [Node.js](https://nodejs.org/) (LTS)

## Run it

```bash
git clone https://github.com/kavyakansagara933-cloud/cassette-widget.git
cd cassette-widget
npm install
npm run dev
```

Start a song in any media player and the cassette picks it up within a second or so. Only one copy of the widget runs at a time; starting it again just brings the existing one forward.

## Using the widget

| Action | What it does |
| --- | --- |
| Click the cassette | Show or hide the controls panel |
| Drag the cassette | Move the widget |
| Click or drag the progress bar | Seek (if the player supports it) |
| Hover the widget | Reveals the pin, minimise and close buttons |
| Tray icon | Show or hide the widget, or quit |

The close and minimise buttons only hide the widget. Use **Quit** in the tray menu to exit.

## How it works

```
renderer.js  <--  preload.js  <-->  main.js  <-->  media-daemon.ps1
 (the UI)        (safe bridge)    (Electron main)   (Windows media API)
```

- **`media-daemon.ps1`** is a PowerShell script started once by the app. It talks to the Windows media transport controls, and prints one JSON line whenever something changes. Artwork is sent separately and only once per track, so the title shows up instantly and the cover follows as soon as Windows has it.
- **`main.js`** keeps the latest state in memory and answers the UI immediately. It also owns the window, tray, saved settings, and click-through switching. If the daemon is missing or crashes, it falls back to `media-session.ps1`, a one-shot version of the same script.
- **`preload.js`** exposes a small, safe API (`snapshot`, `command`, `seek`, window controls) to the page.
- **`renderer.js`** paints the label, extracts the cover's colour, runs the progress bar and seeking, and decides which parts of the window should catch the mouse.

## Project structure

```
cassette-widget/
├─ index.html
├─ package.json
└─ src/
   ├─ main.js            Electron main process
   ├─ preload.js         bridge between page and main
   ├─ renderer.js        UI logic
   ├─ cassette.css       all styling
   ├─ media-daemon.ps1   long-running Windows media process
   └─ media-session.ps1  one-shot fallback
```

## Notes and limits

- **Windows only.** It relies on the Windows media transport controls.
- **Seeking depends on the player.** The progress bar only reacts when the current player reports that seeking is supported.
- **When several players are open**, the widget follows one that is playing and stays with it instead of jumping between apps.
- **Privacy:** only when Windows provides no cover, the song title and artist are sent to Apple's public iTunes Search API to find one. Nothing else leaves your PC, and nothing is sent when Windows supplies the cover itself.

## Roadmap

- Desktop-layer mode: sit behind other windows by default, with a hotkey to bring it on top
- Don't steal focus when clicked, and hide from Alt+Tab
- Stay on screen if monitors change, plus tray options for size, lock and reset position
- Fade or hide when nothing is playing
- Reels that wind from one spool to the other with the song's progress
- Launch at login once the app is packaged as an installer