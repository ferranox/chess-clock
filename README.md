# Tempo — Chess Clock

A fast, drift‑resistant, **offline‑first** chess clock built as a Progressive Web App.
Pure static files — **HTML5 + CSS3 + vanilla JavaScript only**. No frameworks, no npm,
no build step, no external/remote resources. Drop the folder on any static web server
and it works immediately.

**Canonical URL:** <https://chess.ferranox.xyz/>

---

## Highlights

- ⏱ **Drift‑resistant timing engine** driven by `performance.now()` timestamps — never tick counting.
- ♟ **Time controls**: Bullet, Blitz, Rapid presets + fully custom (asymmetric per‑player) controls.
- ➕ **Increment**: Fischer or none (architecture is extensible to Bronstein / Byo‑yomi).
- 📱 **Mobile‑first**: giant tap targets, landscape side‑by‑side / portrait stacked, `100dvh`, safe‑area insets.
- 🎨 **Themes**: Light, Dark, System, plus chess‑inspired **Wood**, **Marble** and **Night**.
- 🔔 **Feedback**: Web Audio generated tones, vibration (haptics), configurable low‑time warnings.
- 🔒 **Device integration**: Screen Wake Lock, Page Visibility auto‑pause, PWA install, fullscreen.
- 💾 **Persistence**: settings, custom presets and game history saved to `localStorage`.
- ♿ **Accessible**: ARIA labels, semantic HTML, visible focus, reduced‑motion support, large touch targets.
- 🧪 **Tested**: 32 self‑contained browser tests (no external deps) covering the timing engine.

---

## File structure

```
chess-clock/
├── index.html                 # Single‑page app: Home, Clock, Settings, Presets, History
├── styles.css                 # All styling, CSS variables, themes, responsive layout
├── app.js                     # Engine + game model + UI + subsystems (all logic)
├── manifest.webmanifest       # PWA manifest (canonical https://chess.ferranox.xyz/)
├── service-worker.js          # Cache‑first service worker with versioned cache
├── favicon.ico                # Multi‑size ICO (16/32/48/64)
├── favicon-16.png             # 16×16 favicon
├── favicon-32.png             # 32×32 favicon
├── icons/
│   ├── icon-192.png           # 192×192 PWA icon (any + maskable)
│   ├── icon-512.png           # 512×512 PWA icon (any + maskable)
│   └── apple-touch-icon.png   # exactly 180×180 Apple touch icon
├── tests/
│   ├── clock-engine.test.html # Self‑contained browser test runner (open in a browser)
│   └── run-node.js            # Optional headless Node harness (dev only)
├── generate_assets.py         # Regenerates all icons/favicons with Pillow (dev only)
└── README.md
```

`generate_assets.py`, `tests/run-node.js` are development helpers — they are **not**
required at runtime and can be omitted when deploying, though they do no harm.

---

## Deployment

No build step. Upload the folder contents to the web root so that:

```
https://chess.ferranox.xyz/index.html
https://chess.ferranox.xyz/manifest.webmanifest
https://chess.ferranox.xyz/service-worker.js
https://i.ytimg.com/vi/RsRyBoasMWs/maxresdefault.jpg
```

Requirements:

- Serve over **HTTPS** (required for Service Worker, Wake Lock and installability).
- Serve `manifest.webmanifest` with `Content-Type: application/manifest+json` (most servers do this automatically; a plain static host is fine).
- The service worker is scoped to `/`, matching the canonical root deployment.

### Local preview

```bash
cd chess-clock
python3 -m http.server 8000
# open http://localhost:8000
```

> Note: `localhost` here refers to the machine running the server, not a hosted URL.
> Wake Lock and install prompts need a secure context (HTTPS or `localhost`).

---

## How to use

1. On **Home**, pick a time control chip (Bullet / Blitz / Rapid / your custom presets).
2. Press **Start game**.
3. On the **Clock** screen, tap either half to begin — the configured *starting player's*
   clock runs first.
4. After making your move, tap **your** half to stop your clock, add your increment
   (Fischer) and start your opponent.
5. Use the centre control bar: **⏸ pause/▶ resume**, **↶ undo**, **✕ exit**, **⟳ reset**.

**Keyboard (desktop):** `Space` = press active side · `A`/`←` = Player 1 · `L`/`→` = Player 2 ·
`P` = pause/resume · `Z` = undo.

---

## Architecture

The timing engine and game model are **completely separated from the DOM**. All rendering
reads from the engine; it never drives it.

### Model

| Class          | Responsibility |
| -------------- | -------------- |
| `PlayerClock`  | `startingMs`, `remainingMs`, `incrementMs`, `name`, `moves` |
| `TimeControl`  | `type` (`fischer` \| `none`) and per‑player base + increment (asymmetric supported) |
| `GameState`    | `idle` \| `running` \| `paused` \| `timeout` \| `finished` |
| `ClockEngine`  | Holds two `PlayerClock`s; `start` / `press` / `pause` / `resume` / `undo` / `reset` / `checkFlag` |

### Timing (drift resistance)

Stored remaining time only changes at **discrete state changes** (start, press, pause).
The live value for the active player is always computed as:

```
remaining = storedRemaining − (now() − lastStateChangeTimestamp)
```

Because the display loop (`requestAnimationFrame`) merely *reads* this value, irregular
frame intervals cannot accumulate error — 1000 frames of 17 ms give exactly the same
remaining as a single 17 000 ms jump (verified by tests). Stored remaining is kept in
**integer milliseconds** to avoid float creep.

The engine is **injectable with a fake clock**:

```js
let t = 0;
const engine = new Tempo.ClockEngine({
  now: () => t,                              // fake time source
  timeControl: Tempo.TimeControl.symmetric(600000, 5000, 'fischer'),
});
engine.start(0);
t += 2500;                                   // 2.5 s move
engine.press(0);
engine.players[0].remainingMs;               // 602500  (600000 − 2500 + 5000)
```

### Undo

Every press pushes a timestamped snapshot (committed remaining + move counts + active
player) **after** committing elapsed time but **before** applying increment / switching.
`undo()` restores that snapshot, which correctly:

- reverses the Fischer increment of the undone move,
- refunds any real time the opponent spent after the switch,
- can recover from a timeout caused by the undone move.

---

## Time controls

| Group  | Presets |
| ------ | ------- |
| Bullet | 1+0, 2+1 |
| Blitz  | 3+0, 3+2, 5+0, 5+3 |
| Rapid  | 10+0, 10+5, 15+10, 30+0 |
| Custom | Any base time + increment, **asymmetric per player**, Fischer or none |

Custom presets can be created, renamed, edited and deleted on the **Presets** screen.
Built‑in presets are protected from deletion.

---

## Display precision

Adaptive by default:

| Remaining | Format | Example |
| --------- | ------ | ------- |
| ≥ 60 s    | `MM:SS` (or `H:MM:SS`) | `10:00` |
| 10–60 s   | `SS.S`  | `42.7` |
| < 10 s    | `SS.SS` | `4.83` |

Values are **floored**, so the clock never shows more time than remains. Alternative
modes (“always MM:SS”, “tenths under a minute”) are available in Settings.

---

## Settings (persisted)

- **Theme** — Light / Dark / System / Wood / Marble / Night
- **Display precision** — Adaptive / Tenths / Always MM:SS
- **Starting player** — Player 1 / Player 2 / Random
- **Tap protection** — ignore taps faster than a configurable interval (default 150 ms)
- **Confirm before reset**
- **Low‑time warning thresholds** — default `30, 10, 5` seconds (visual + sound + vibration)
- **Sound** — Web Audio generated tones (no audio files)
- **Haptics** — `navigator.vibrate()` (graceful no‑op when unsupported)
- **Keep screen awake** — Screen Wake Lock while running
- **Auto‑pause when hidden** — pause on tab/app background via Page Visibility API
- **Fullscreen on start**

---

## Game history

Completed games are stored in `localStorage` with date, player names, time control,
winner and reason (e.g. timeout). Viewable and clearable on the **History** screen.

---

## Device & lifecycle behaviour

- **Sound** — an `AudioContext` is created lazily on the **first user gesture** (browsers
  block audio before interaction). All tones are synthesised; no network requests.
- **Haptics** — vibration patterns for switch, warning and timeout; silently skipped if
  the device/browser has no vibration support.
- **Wake Lock** — requested while running, released on pause/finish, re‑acquired when the
  page becomes visible again. No‑op where the API is unavailable.
- **Page Visibility** — when configured, the clock auto‑pauses if the app is backgrounded,
  so no time is lost to a phone locking or a tab switch.
- **Orientation** — landscape lays the halves side‑by‑side; portrait stacks them, with the
  opponent’s half rotated 180° so both players read their clock upright.

---

## Accessibility & security

- Semantic landmarks, ARIA labels on interactive controls, `role="timer"` on the clocks.
- Visible focus states, reduced‑motion media query, large (≥48 px) touch targets.
- **No `eval`**, no remote code. All user‑entered text (player / preset names) is inserted
  with `textContent` — never `innerHTML` — so it is safely escaped.

---

## Testing

Open the test runner in a browser:

```
tests/clock-engine.test.html
```

It boots only the engine module (`window.TEMPO_TEST_MODE = true`), runs **32** assertions
against a **fake clock**, and shows a green/red summary. Coverage includes:

- time formatting rules (MM:SS / SS.S / SS.SS / H:MM:SS / clamping),
- **timing accuracy** (10:00 + 5 s Fischer, ~2.5 s move → **10:02.5**),
- **drift resistance** with irregular intervals (16, 28, 11, 43, 100, 17 ms) and 1000‑frame equivalence,
- increment accumulation, asymmetric controls, pause/resume,
- undo (restore, opponent refund, increment reversal, max‑undo cap, recover‑from‑timeout),
- timeout detection via `checkFlag` and via overlong press, timeout callback,
- reset, move counters, integer‑ms storage, and a full simulated Blitz 3+2 game.

Optional headless run (Node, dev only):

```bash
node tests/run-node.js
```

> The `10:02.5` expectation is the mathematically correct result of
> `600000 ms − 2500 ms + 5000 ms = 602500 ms`.

---

## Regenerating assets

Icons and favicons are generated with [Pillow](https://python-pillow.org/):

```bash
pip install Pillow
python3 generate_assets.py
```

This recreates `favicon.ico`, `favicon-16/32.png` and the `icons/` PNGs with the Tempo
chess‑clock branding (a brass clock face with hands and bell buttons on a dark rounded tile).

---

## Updating a deployment (cache busting)

Bump `CACHE_VERSION` in `service-worker.js` on every deploy:

```js
const CACHE_VERSION = 'tempo-v1.0.1'; // ← increment this
```

The worker deletes old caches on `activate`, so returning visitors pick up the new build.

---

## Browser support

Modern evergreen browsers (Chrome/Edge, Firefox, Safari, and their mobile versions).
Progressive enhancement is used throughout: Wake Lock, Vibration, install prompt and
fullscreen degrade gracefully where unsupported — the clock itself always works.

---

## License

Released for the owner of <https://chess.ferranox.xyz/> to use and modify freely.
