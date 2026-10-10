const cassette = document.querySelector('[data-cassette]');
const titleNodes = document.querySelectorAll('[data-title]');
const artistNodes = document.querySelectorAll('[data-artist]');
const progress = document.querySelector('[data-progress]');
const elapsed = document.querySelector('[data-elapsed]');
const total = document.querySelector('[data-total]');
const artwork = document.querySelector('[data-artwork]');
const toggle = document.querySelector('[data-command="toggle"]');
const nextBtn = document.querySelector('[data-command="next"]');
const prevBtn = document.querySelector('[data-command="previous"]');
const playerPanel = document.querySelector('.player-panel');
const showcase = document.querySelector('.showcase');
const timelineRow = document.querySelector('.player-panel__timeline');

/* ---------- small helpers ---------- */

// Only touch the DOM when the text actually changed (refresh runs every tick).
function setText(target, value) {
  const nodes = target.forEach ? target : [target];
  nodes.forEach((node) => { if (node.textContent !== value) node.textContent = value; });
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}

function setControlsOpen(open) {
  showcase.classList.toggle('is-controls-open', open);
  cassette.setAttribute('aria-expanded', String(open));
  cassette.setAttribute('aria-label', open ? 'Hide playback controls' : 'Open playback controls');
  playerPanel.setAttribute('aria-hidden', String(!open));
  playerPanel.inert = !open;
}

/* ---------- album-art tint (dominant colour) ---------- */

const artColorCache = new Map();
const tintCanvas = document.createElement('canvas');
tintCanvas.width = tintCanvas.height = 32;
const tintCtx = tintCanvas.getContext('2d', { willReadFrequently: true });
let currentArtUrl = '';

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [Math.round((h * 60 + 360) % 360), s, l];
}

function extractTint(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        tintCtx.clearRect(0, 0, 32, 32);
        tintCtx.drawImage(img, 0, 0, 32, 32);
        const px = tintCtx.getImageData(0, 0, 32, 32).data;
        const buckets = new Map();
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 200) continue;
          const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
          if (s < 0.25 || l < 0.12 || l > 0.92) continue;   // skip greys, near-black, near-white
          const key = Math.round(h / 20) % 18;
          buckets.set(key, (buckets.get(key) || 0) + s * (1 - Math.abs(l - 0.5)));
        }
        let best = null;
        buckets.forEach((weight, key) => { if (!best || weight > best.weight) best = { weight, h: key * 20 }; });
        resolve(best ? { h: best.h } : null);
      } catch {
        resolve(null);   // canvas tainted or decode failed: keep the default navy
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function applyTint(tint) {
  if (!tint) {
    artwork.style.removeProperty('--duo');
    cassette.style.removeProperty('--ink');
    return;
  }
  artwork.style.setProperty('--duo', `hsl(${tint.h} 62% 38%)`);
  cassette.style.setProperty('--ink', `hsl(${tint.h} 55% 24%)`);
}

async function updateTint(url) {
  if (url === currentArtUrl) return;
  currentArtUrl = url || '';
  if (!url) return applyTint(null);
  if (!artColorCache.has(url)) {
    if (artColorCache.size > 30) artColorCache.delete(artColorCache.keys().next().value);
    artColorCache.set(url, await extractTint(url));
  }
  if (url === currentArtUrl) applyTint(artColorCache.get(url));   // ignore stale results if the track changed meanwhile
}

/* ---------- snapshot -> UI ---------- */

let lastKey = '';          // title|artist of the current track
let shownArt = '';         // artwork currently painted
let trackChangedAt = 0;    // when the current track was first seen
let awaitingArt = false;   // true while a new track has no artwork yet

// seeking
let playbackInfo = { duration: 0, canSeek: false };
let scrubbing = false;                  // true while the progress bar is being dragged
let seekHold = { until: 0, seconds: 0 };   // after a seek, show the target until the player reports it

let inactiveStreak = 0;    // consecutive "nothing playing / error" snapshots

function applySnapshot(data) {
  const active = Boolean(data?.ok && data.active);

  // While a track is showing, ignore short idle/error blips (track changes, app switches,
  // a failed poll). Only go idle if it persists for ~3 snapshots.
  if (!active && lastKey) {
    inactiveStreak += 1;
    if (inactiveStreak < 3) return;
  } else {
    inactiveStreak = 0;
  }

  const playing = active && Boolean(data.isPlaying);
  const art = active && data.artwork ? data.artwork : '';

  // New track: drop the old artwork immediately instead of showing stale art.
  const key = active ? `${data.title}|${data.artist}` : '';
  if (key !== lastKey) {
    lastKey = key;
    trackChangedAt = Date.now();
    if (shownArt) {
      shownArt = '';
      artwork.style.backgroundImage = '';
      updateTint(null);
    }
  }
  // Poll fast for a few seconds after a track change, then stop (some tracks have no art).
  awaitingArt = active && !art && Date.now() - trackChangedAt < 8000;

  cassette.classList.toggle('is-playing', playing);
  cassette.classList.toggle('is-idle', !active);
  cassette.classList.toggle('has-artwork', Boolean(art));
  showcase.classList.toggle('is-playing', playing);

  setText(titleNodes, active ? data.title : 'Ready when you are');
  setText(artistNodes, active ? data.artist : 'Play something on your PC');
  setText(total, active && data.duration ? formatTime(data.duration) : '—:——');
  setText(toggle, playing ? 'Pause' : 'Play');

  playbackInfo = { duration: active ? Number(data.duration) || 0 : 0, canSeek: Boolean(active && data.canSeek) };
  timelineRow.classList.toggle('is-seekable', playbackInfo.canSeek && playbackInfo.duration > 0);
  if (!scrubbing) {
    const position = Date.now() < seekHold.until ? seekHold.seconds : (active ? data.position : 0);
    setText(elapsed, active ? formatTime(position) : '0:00');
    progress.style.setProperty('--progress', `${active && data.duration ? Math.min(100, (position / data.duration) * 100) : 0}%`);
  }
  toggle.disabled = !active || !data.canToggle;
  nextBtn.disabled = !active || !data.canNext;
  prevBtn.disabled = !active || !data.canPrevious;

  // Repaint the (large) artwork data URL only when it really changed.
  if (art !== shownArt) {
    shownArt = art;
    artwork.style.backgroundImage = art ? `url("${art}")` : '';
    updateTint(art || null);
  }
}

/* ---------- polling: one request at a time, adaptive rate ---------- */

let polling = false;
let queued = false;

async function refresh() {
  if (polling) { queued = true; return; }   // never stack slow snapshots on top of each other
  polling = true;
  try { applySnapshot(await window.desktopMedia.snapshot()); }
  catch { applySnapshot({ ok: false, active: false }); }
  finally {
    polling = false;
    if (queued) { queued = false; refresh(); }
  }
}

function schedule() {
  const delay = document.hidden ? 4000 : awaitingArt ? 400 : 1500;
  setTimeout(async () => { await refresh(); schedule(); }, delay);
}

/* ---------- controls ---------- */

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', async () => {
    button.classList.add('is-pressed');
    await window.desktopMedia.command(button.dataset.command);
    setTimeout(() => button.classList.remove('is-pressed'), 120);
    refresh();
  });
});
document.querySelector('[data-minimize]').addEventListener('click', () => window.desktopMedia.minimize());
document.querySelector('[data-close]').addEventListener('click', () => window.desktopMedia.close());

const pin = document.querySelector('[data-pin]');
pin.addEventListener('click', async () => {
  const pinned = await window.desktopMedia.togglePin();
  pin.setAttribute('aria-pressed', String(pinned));
  pin.title = pinned ? 'Always on top: on' : 'Always on top: off';
});

(async () => {
  const { pinned } = await window.desktopMedia.widgetState();
  pin.setAttribute('aria-pressed', String(pinned));
  pin.title = pinned ? 'Always on top: on' : 'Always on top: off';
  await refresh();
  schedule();
})();

/* ---------- hover tilt (throttled to one update per frame) ---------- */

let tiltFrame = 0;
let lastPointer = null;

cassette.addEventListener('pointermove', (event) => {
  lastPointer = event;
  if (tiltFrame) return;
  tiltFrame = requestAnimationFrame(() => {
    tiltFrame = 0;
    const box = cassette.getBoundingClientRect();
    const horizontal = ((lastPointer.clientX - box.left) / box.width - .5) * 2;
    const vertical = ((lastPointer.clientY - box.top) / box.height - .5) * 2;
    cassette.style.setProperty('--tilt-x', `${vertical * -3.5}deg`);
    cassette.style.setProperty('--tilt-y', `${horizontal * 5}deg`);
    cassette.style.setProperty('--glare-x', `${50 + horizontal * 30}%`);
    cassette.style.setProperty('--glare-y', `${45 + vertical * 25}%`);
  });
});
cassette.addEventListener('pointerleave', () => {
  if (tiltFrame) { cancelAnimationFrame(tiltFrame); tiltFrame = 0; }
  cassette.style.removeProperty('--tilt-x'); cassette.style.removeProperty('--tilt-y');
  cassette.style.removeProperty('--glare-x'); cassette.style.removeProperty('--glare-y');
});

/* ---------- click-through: only the cassette, panel and buttons catch the mouse ---------- */

const INTERACTIVE = '.cassette__shell, .player-panel, .window-controls';
let ignoring = null;        // current click-through state sent to the main process
let overUi = false;
let hotTimer = 0;
let drag = null;            // { x, y, moved } while the cassette is being dragged
let suppressClick = false;

function setIgnore(value) {
  if (value === ignoring) return;
  ignoring = value;
  window.desktopMedia.setIgnoreMouse(value);
}

function setHot(on) {
  clearTimeout(hotTimer);
  if (on) showcase.classList.add('is-hot');
  else hotTimer = setTimeout(() => showcase.classList.remove('is-hot'), 1500);   // keep the buttons up long enough to reach them
}

window.addEventListener('mousemove', (event) => {
  if (drag || scrubbing) return;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const now = Boolean(target && target.closest(INTERACTIVE));
  if (now === overUi && ignoring !== null) return;
  overUi = now;
  setIgnore(!now);
  setHot(now);
});
document.addEventListener('mouseleave', () => {
  if (drag || scrubbing) return;
  overUi = false;
  setIgnore(true);
  setHot(false);
});
setIgnore(true);   // start click-through; the first mouse move over the cassette makes it interactive

/* ---------- seeking: click or drag the progress bar ---------- */

function fractionFromPointer(event) {
  const box = progress.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
}
function previewSeek(fraction) {
  progress.style.setProperty('--progress', `${fraction * 100}%`);
  setText(elapsed, formatTime(fraction * playbackInfo.duration));
}
timelineRow.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !playbackInfo.canSeek || !playbackInfo.duration) return;
  const box = progress.getBoundingClientRect();
  if (event.clientX < box.left - 6 || event.clientX > box.right + 6) return;   // the time labels are not part of the bar
  scrubbing = true;
  progress.classList.add('is-scrubbing');
  timelineRow.setPointerCapture(event.pointerId);
  previewSeek(fractionFromPointer(event));
});
timelineRow.addEventListener('pointermove', (event) => {
  if (scrubbing) previewSeek(fractionFromPointer(event));
});
function endScrub(event, commit) {
  if (!scrubbing) return;
  scrubbing = false;
  progress.classList.remove('is-scrubbing');
  if (timelineRow.hasPointerCapture(event.pointerId)) timelineRow.releasePointerCapture(event.pointerId);
  if (!commit) return;
  const seconds = Math.min(Math.max(0, playbackInfo.duration - 1), Math.round(fractionFromPointer(event) * playbackInfo.duration));
  seekHold = { until: Date.now() + 1500, seconds };
  window.desktopMedia.seek(seconds);
}
timelineRow.addEventListener('pointerup', (event) => endScrub(event, true));
timelineRow.addEventListener('pointercancel', (event) => endScrub(event, false));

/* ---------- drag the widget by the cassette (a plain click still opens the controls) ---------- */

cassette.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { x: event.screenX, y: event.screenY, moved: false };
  cassette.setPointerCapture(event.pointerId);
});
cassette.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.x;
  const dy = event.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;   // small wobble is still a click
  drag.moved = true;
  drag.x = event.screenX;
  drag.y = event.screenY;
  window.desktopMedia.dragBy(dx, dy);
});
function endDrag(event) {
  if (!drag) return;
  suppressClick = drag.moved;
  drag = null;
  if (suppressClick) setTimeout(() => { suppressClick = false; }, 50);
  if (cassette.hasPointerCapture(event.pointerId)) cassette.releasePointerCapture(event.pointerId);
}
cassette.addEventListener('pointerup', endDrag);
cassette.addEventListener('pointercancel', endDrag);

cassette.addEventListener('click', () => {
  if (suppressClick) { suppressClick = false; return; }   // that was a drag, not a click
  setControlsOpen(!showcase.classList.contains('is-controls-open'));
});
cassette.addEventListener('keydown', (event) => {
  if (event.code === 'Enter' || event.code === 'Space') {
    event.preventDefault();
    setControlsOpen(!showcase.classList.contains('is-controls-open'));
  }
});
window.addEventListener('keydown', (event) => {
  if (event.target === cassette) return;
  if (event.code === 'Space' && !event.repeat) {
    event.preventDefault();
    toggle.click();
  }
});
setControlsOpen(false);