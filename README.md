# Smoke & Tape — Windows desktop widget

A Windows desktop cassette that reflects and controls the active Windows media session. It is desktop-first: draggable, resizable, always-on-top, and deliberately not optimized for mobile.

## Run it

Install dependencies, then run the app:

```powershell
npm install
npm start
```

The app uses Windows PowerShell's WinRT access to read the current Windows media session. Start music in Spotify, VLC, a supported browser tab, or another compatible player; the widget should then update automatically.

## Component anatomy

The cassette is organized into independently addressable layers:

- `cassette__shell` — smoked plastic housing, inner rim, gloss, and depth.
- `cassette__label` — integrated cover art and editable album metadata.
- `cassette__window` — tape bed, reels, tape line, and duration mark.
- `cassette__bridge`, screws, notches, and spine — the small physical details that make it feel manufactured.

Sizing is fluid (`clamp(300px, 54vw, 370px)`) so the object stays a substantial, readable presence across small and large screens.

## Current behavior

- Reads the current Windows Now Playing title, artist, playback state, timeline, source, and (when supplied by the source) artwork.
- Uses a public metadata lookup only as an artwork fallback when the media app does not supply cover art to Windows; it does not require an account or transmit playback controls.
- Provides play/pause, next, and previous controls when the active player permits them.
- Spins the cassette reels while Windows reports active playback.
- Shows a graceful waiting state when Windows has no active compatible media session.
- Starts as an always-on-top, borderless desktop widget. Drag its background to reposition it; resize from its edges and corners.
- Hides to the system tray instead of quitting when its × control is used. Click the cassette tray icon to bring it back; right-click it to quit.
- Remembers its last size, position, and always-on-top preference.

## Compatibility note

Windows only exposes controls that the currently playing app publishes. The widget does not log in to Spotify or scrape another app; it asks Windows for the active media session, so it can work across compatible players without an account connection. Artwork is also supplied by the player and may occasionally fall back to the cassette's built-in cover treatment.

## Deliberately out of scope

- Spotify sign-in, search, playlists, and queue editing.
- Side A/B as an actual playback concept.
- Volume and seeking controls (support varies across media sources).
- Mobile layouts.

## Planned next stages

1. Pointer-driven tilt and specular reflection.
2. Stronger artwork support and source-specific fallback identity.
3. Optional volume and seeking controls where Windows allows them.
4. Installer, icon, and production packaging.

## Reuse notes

For a production integration, move the `article.cassette` markup into a component and expose the label data, artwork palette, tape duration, and side as props. The present class names are deliberately stable hooks for those later behaviors.

## Structure

```
.
├── index.html                 # Renderer window
├── package.json
├── src/
│   ├── cassette.css           # Visual component
│   ├── main.js                # Electron window and safe IPC
│   ├── media-session.ps1      # Windows media-session bridge
│   ├── preload.js             # Narrow renderer API
│   └── renderer.js            # UI state and controls
└── README.md
```
