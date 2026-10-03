/* =========================================================================
   Tempo — Chess Clock
   Vanilla JS. Timing engine + game model are fully separated from the DOM.
   The engine is injectable with a fake clock for tests (see tests/).
   ========================================================================= */
(function (global) {
  'use strict';

  /* ----------------------------------------------------------------------
     GAME MODEL
     ---------------------------------------------------------------------- */
  const GameState = Object.freeze({
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    TIMEOUT: 'timeout',
    FINISHED: 'finished',
  });

  const IncrementType = Object.freeze({
    FISCHER: 'fischer',
    NONE: 'none',
    // Extensible: BRONSTEIN, BYOYOMI ...
  });

  /** A single player's clock — pure data. */
  class PlayerClock {
    constructor({ startingMs, incrementMs = 0, name = 'Player' } = {}) {
      this.startingMs = Math.round(startingMs);
      this.remainingMs = Math.round(startingMs);
      this.incrementMs = Math.round(incrementMs);
      this.name = name;
      this.moves = 0;
    }
  }

  /** Time control definition. Supports asymmetric per-player base + increment. */
  class TimeControl {
    constructor({ type = IncrementType.FISCHER, p1, p2, label = '' } = {}) {
      // p1/p2: { baseMs, incMs, name }
      this.type = type;
      this.p1 = { baseMs: p1.baseMs, incMs: p1.incMs || 0, name: p1.name || 'Player 1' };
      this.p2 = { baseMs: p2.baseMs, incMs: p2.incMs || 0, name: p2.name || 'Player 2' };
      this.label = label;
    }
    static symmetric(baseMs, incMs, type = IncrementType.FISCHER, label = '') {
      return new TimeControl({
        type,
        p1: { baseMs, incMs },
        p2: { baseMs, incMs },
        label,
      });
    }
  }

  /* ----------------------------------------------------------------------
     CLOCK ENGINE
     Authoritative time source is options.now() (defaults to performance.now()).
     remaining = storedRemaining - (now() - lastStateChangeTimestamp)
     Stored remaining only changes at discrete state changes -> drift-resistant.
     ---------------------------------------------------------------------- */
  class ClockEngine {
    constructor(options = {}) {
      this.now = options.now || (() => performance.now());
      this.maxUndo = options.maxUndo != null ? options.maxUndo : 30;
      this.onTimeout = options.onTimeout || function () {};
      this.onSwitch = options.onSwitch || function () {};
      this.onStateChange = options.onStateChange || function () {};
      const tc = options.timeControl ||
        TimeControl.symmetric(10 * 60 * 1000, 0, IncrementType.NONE, '10+0');
      this._constructed = false;
      this.reset(tc);
      this._constructed = true;
    }

    reset(timeControl) {
      if (timeControl) this.timeControl = timeControl;
      const tc = this.timeControl;
      const noInc = tc.type === IncrementType.NONE;
      this.players = [
        new PlayerClock({ startingMs: tc.p1.baseMs, incrementMs: noInc ? 0 : tc.p1.incMs, name: tc.p1.name }),
        new PlayerClock({ startingMs: tc.p2.baseMs, incrementMs: noInc ? 0 : tc.p2.incMs, name: tc.p2.name }),
      ];
      this.state = GameState.IDLE;
      this.active = null;
      this.lastTs = null;
      this.undoStack = [];
      this.loser = null;
      this.winner = null;
      this.reason = null;
      this.startedAt = null;
      // Skip the callback during initial construction (consumer not ready yet).
      if (this._constructed) this.onStateChange();
      return this;
    }

    /** Remaining ms for a player, computed live from timestamps. */
    getRemaining(index) {
      const p = this.players[index];
      let rem = p.remainingMs;
      if (this.state === GameState.RUNNING && this.active === index && this.lastTs != null) {
        rem = rem - (this.now() - this.lastTs);
      }
      return rem;
    }

    /** Commit the active player's elapsed time into stored remaining. */
    _commitElapsed() {
      if (this.state !== GameState.RUNNING || this.lastTs == null) return;
      const t = this.now();
      const elapsed = t - this.lastTs;
      const p = this.players[this.active];
      p.remainingMs = Math.round(p.remainingMs - elapsed);
      this.lastTs = t;
      if (p.remainingMs <= 0) {
        p.remainingMs = 0;
        this._flag(this.active);
      }
    }

    _flag(loserIndex) {
      this.state = GameState.TIMEOUT;
      this.loser = loserIndex;
      this.winner = 1 - loserIndex;
      this.reason = 'timeout';
      this.lastTs = null;
      this.onTimeout(loserIndex, this.winner);
      this.onStateChange();
    }

    /** Poll for flag-fall — call each animation frame while running. */
    checkFlag() {
      if (this.state !== GameState.RUNNING) return false;
      if (this.getRemaining(this.active) <= 0) {
        this.players[this.active].remainingMs = 0;
        this._flag(this.active);
        return true;
      }
      return false;
    }

    _snapshot() {
      this.undoStack.push({
        time: this.now(),
        state: this.state,
        active: this.active,
        players: this.players.map((p) => ({ remainingMs: p.remainingMs, moves: p.moves })),
      });
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    }

    /** Start the clock; firstMover is the index whose clock runs first. */
    start(firstMover = 0) {
      if (this.state !== GameState.IDLE && this.state !== GameState.PAUSED) return false;
      if (this.state === GameState.IDLE) this.startedAt = Date.now();
      this.active = firstMover;
      this.state = GameState.RUNNING;
      this.lastTs = this.now();
      this.onStateChange();
      return true;
    }

    /**
     * Player pressed their side.
     * - When idle: tapping side `index` means that player moved -> opponent's clock runs.
     * - When running: only the active player's press registers; commits time,
     *   adds increment (Fischer), switches to opponent.
     */
    press(index) {
      if (this.state === GameState.IDLE) {
        return this.start(1 - index);
      }
      if (this.state !== GameState.RUNNING) return false;
      if (index !== this.active) return false;

      this._commitElapsed();
      if (this.state === GameState.TIMEOUT) return true;

      this._snapshot(); // after commit, before increment/switch -> clean undo target

      const p = this.players[this.active];
      p.remainingMs += p.incrementMs; // Fischer increment (0 when type none)
      p.moves += 1;

      this.active = 1 - this.active;
      this.lastTs = this.now();
      this.onSwitch(this.active);
      this.onStateChange();
      return true;
    }

    pause() {
      if (this.state !== GameState.RUNNING) return false;
      this._commitElapsed();
      if (this.state === GameState.TIMEOUT) return true;
      this.state = GameState.PAUSED;
      this.lastTs = null;
      this.onStateChange();
      return true;
    }

    resume() {
      if (this.state !== GameState.PAUSED) return false;
      this.state = GameState.RUNNING;
      this.lastTs = this.now();
      this.onStateChange();
      return true;
    }

    /** Undo the last press (and recover from a timeout caused by that press). */
    undo() {
      if (!this.undoStack.length) return false;
      const snap = this.undoStack.pop();
      this.state = snap.state === GameState.TIMEOUT ? GameState.RUNNING : snap.state;
      this.active = snap.active;
      this.players.forEach((p, i) => {
        p.remainingMs = snap.players[i].remainingMs;
        p.moves = snap.players[i].moves;
      });
      this.loser = null;
      this.winner = null;
      this.reason = null;
      this.lastTs = this.state === GameState.RUNNING ? this.now() : null;
      this.onStateChange();
      return true;
    }

    canUndo() { return this.undoStack.length > 0; }

    finish(reason) {
      this._commitElapsed();
      if (this.state === GameState.TIMEOUT) return;
      this.state = GameState.FINISHED;
      this.reason = reason || 'manual';
      this.lastTs = null;
      this.onStateChange();
    }
  }

  /* ----------------------------------------------------------------------
     TIME FORMATTING (display precision rules)
     >= 60s  -> MM:SS       (or H:MM:SS for very long controls)
     < 60s   -> SS.S
     < 10s   -> SS.SS
     ---------------------------------------------------------------------- */
  function formatTime(ms, mode) {
    if (ms == null || isNaN(ms)) ms = 0;
    if (ms < 0) ms = 0;
    const totalSec = ms / 1000;

    if (mode === 'mmss') {
      return mmss(totalSec);
    }
    if (mode === 'tenths') {
      if (totalSec >= 60) return mmss(totalSec);
      return floorFixed(totalSec, 1);
    }
    // adaptive (default)
    if (totalSec >= 60) return mmss(totalSec);
    if (totalSec >= 10) return floorFixed(totalSec, 1);
    return floorFixed(totalSec, 2);
  }

  function mmss(totalSec) {
    const s = Math.floor(totalSec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
    return `${m}:${pad(sec)}`;
  }
  function floorFixed(value, decimals) {
    const f = Math.pow(10, decimals);
    return (Math.floor(value * f) / f).toFixed(decimals);
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  /* Public API (used by app bootstrap and by the test runner). */
  const Tempo = {
    GameState, IncrementType, PlayerClock, TimeControl, ClockEngine,
    formatTime, mmss,
  };
  global.Tempo = Tempo;

  /* If loaded by the test runner, do not boot the DOM app. */
  if (global.TEMPO_TEST_MODE) return;
  if (typeof document === 'undefined') return;

  /* ======================================================================
     APPLICATION BOOTSTRAP (DOM + UI + subsystems)
     ====================================================================== */
  document.addEventListener('DOMContentLoaded', bootApp);

  function bootApp() {
    /* -------- Storage helpers -------- */
    const LS = {
      SETTINGS: 'tempo.settings.v1',
      PRESETS: 'tempo.presets.v1',
      HISTORY: 'tempo.history.v1',
      LAST_TC: 'tempo.lastTc.v1',
    };
    function load(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    }
    function save(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    }

    /* -------- Settings -------- */
    const DEFAULT_SETTINGS = {
      theme: 'system',
      precision: 'adaptive',
      warnThresholds: [30, 10, 5],
      startingPlayer: 'p1', // p1 | p2 | random
      tapProtection: true,
      tapInterval: 150,
      sound: true,
      haptics: true,
      autoPauseHidden: true,
      confirmReset: true,
      wakeLock: true,
      fullscreen: false,
    };
    let settings = Object.assign({}, DEFAULT_SETTINGS, load(LS.SETTINGS, {}));
    function persistSettings() { save(LS.SETTINGS, settings); }

    /* -------- Built-in presets -------- */
    const min = (m) => m * 60 * 1000;
    const sec = (s) => s * 1000;
    function tc(base, inc) { return { baseMs: min(base), incMs: sec(inc) }; }
    const BUILTIN_PRESETS = [
      { id: 'b_1_0', builtin: true, group: 'Bullet', name: '1+0', type: 'none', p1: tc(1, 0), p2: tc(1, 0) },
      { id: 'b_2_1', builtin: true, group: 'Bullet', name: '2+1', type: 'fischer', p1: tc(2, 1), p2: tc(2, 1) },
      { id: 'z_3_0', builtin: true, group: 'Blitz', name: '3+0', type: 'none', p1: tc(3, 0), p2: tc(3, 0) },
      { id: 'z_3_2', builtin: true, group: 'Blitz', name: '3+2', type: 'fischer', p1: tc(3, 2), p2: tc(3, 2) },
      { id: 'z_5_0', builtin: true, group: 'Blitz', name: '5+0', type: 'none', p1: tc(5, 0), p2: tc(5, 0) },
      { id: 'z_5_3', builtin: true, group: 'Blitz', name: '5+3', type: 'fischer', p1: tc(5, 3), p2: tc(5, 3) },
      { id: 'r_10_0', builtin: true, group: 'Rapid', name: '10+0', type: 'none', p1: tc(10, 0), p2: tc(10, 0) },
      { id: 'r_10_5', builtin: true, group: 'Rapid', name: '10+5', type: 'fischer', p1: tc(10, 5), p2: tc(10, 5) },
      { id: 'r_15_10', builtin: true, group: 'Rapid', name: '15+10', type: 'fischer', p1: tc(15, 10), p2: tc(15, 10) },
      { id: 'r_30_0', builtin: true, group: 'Rapid', name: '30+0', type: 'none', p1: tc(30, 0), p2: tc(30, 0) },
    ];
    let customPresets = load(LS.PRESETS, []);
    function allPresets() { return BUILTIN_PRESETS.concat(customPresets); }
    function persistPresets() { save(LS.PRESETS, customPresets); }

    /* -------- History -------- */
    let history = load(LS.HISTORY, []);
    function persistHistory() { save(LS.HISTORY, history); }

    /* -------- DOM refs -------- */
    const $ = (id) => document.getElementById(id);
    const screens = {
      home: $('screen-home'),
      clock: $('screen-clock'),
      settings: $('screen-settings'),
      presets: $('screen-presets'),
      history: $('screen-history'),
    };

    /* -------- Selected time control -------- */
    let selectedPresetId = load(LS.LAST_TC, 'r_10_0');
    if (!allPresets().some((p) => p.id === selectedPresetId)) selectedPresetId = 'r_10_0';

    function presetToTimeControl(p) {
      return new Tempo.TimeControl({
        type: p.type,
        p1: { baseMs: p.p1.baseMs, incMs: p.p1.incMs, name: p.p1.name || 'Player 1' },
        p2: { baseMs: p.p2.baseMs, incMs: p.p2.incMs, name: p.p2.name || 'Player 2' },
        label: p.name,
      });
    }

    /* ==================================================================
       SOUND (Web Audio API — generated tones only)
       ================================================================== */
    const Sound = (function () {
      let ctx = null;
      function ensure() {
        if (!settings.sound) return null;
        if (!ctx) {
          try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
          catch (e) { ctx = null; }
        }
        if (ctx && ctx.state === 'suspended') ctx.resume();
        return ctx;
      }
      function tone(freq, dur, type, gainVal) {
        const c = ensure();
        if (!c) return;
        const t0 = c.currentTime;
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gainVal || 0.25, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g); g.connect(c.destination);
        osc.start(t0); osc.stop(t0 + dur + 0.02);
      }
      return {
        unlock() { ensure(); },
        click() { tone(880, 0.05, 'square', 0.18); },
        warn() { tone(660, 0.12, 'sine', 0.28); },
        beep() { tone(1040, 0.09, 'triangle', 0.3); },
        timeout() {
          tone(300, 0.5, 'sawtooth', 0.3);
          setTimeout(() => tone(220, 0.6, 'sawtooth', 0.3), 180);
        },
      };
    })();

    /* ==================================================================
       HAPTICS
       ================================================================== */
    function vibrate(pattern) {
      if (!settings.haptics) return;
      if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
    }

    /* ==================================================================
       WAKE LOCK
       ================================================================== */
    const WakeLock = (function () {
      let sentinel = null;
      async function request() {
        if (!settings.wakeLock) return;
        if (!('wakeLock' in navigator)) return;
        try {
          sentinel = await navigator.wakeLock.request('screen');
          sentinel.addEventListener('release', () => { sentinel = null; });
        } catch (e) { sentinel = null; }
      }
      async function release() {
        if (sentinel) { try { await sentinel.release(); } catch (e) {} sentinel = null; }
      }
      return { request, release, reacquire() { if (settings.wakeLock) request(); } };
    })();

    /* ==================================================================
       ENGINE INSTANCE + RENDER LOOP
       ================================================================== */
    let warnState = { p1: 0, p2: 0 }; // last threshold index announced per player

    /* Clock DOM refs (declared before engine so onStateChange can render). */
    const el = {
      p1: $('player-1'), p2: $('player-2'),
      p1time: $('p1-time'), p2time: $('p2-time'),
      p1name: $('p1-name'), p2name: $('p2-name'),
      p1moves: $('p1-moves'), p2moves: $('p2-moves'),
      p1inc: $('p1-inc'), p2inc: $('p2-inc'),
      state: $('clock-state'),
      pause: $('btn-pause'), undo: $('btn-undo'), reset: $('btn-reset'),
    };

    const engine = new Tempo.ClockEngine({
      timeControl: presetToTimeControl(getPreset(selectedPresetId)),
      onTimeout: handleTimeout,
      onSwitch: handleSwitch,
      onStateChange: () => { updateControls(); },
    });

    function getPreset(id) { return allPresets().find((p) => p.id === id) || BUILTIN_PRESETS[6]; }

    let rafId = null;
    function renderLoop() {
      engine.checkFlag();
      renderClock();
      checkWarnings();
      if (engine.state === Tempo.GameState.RUNNING) {
        rafId = requestAnimationFrame(renderLoop);
      } else {
        rafId = null;
      }
    }
    function startLoop() { if (rafId == null) rafId = requestAnimationFrame(renderLoop); }

    /* -------- Clock rendering -------- */
    function renderClock() {
      for (let i = 0; i < 2; i++) {
        const rem = engine.getRemaining(i);
        const timeEl = i === 0 ? el.p1time : el.p2time;
        const half = i === 0 ? el.p1 : el.p2;
        const txt = Tempo.formatTime(rem, settings.precision);
        if (timeEl.textContent !== txt) timeEl.textContent = txt;
        const isActive = engine.active === i &&
          (engine.state === Tempo.GameState.RUNNING || engine.state === Tempo.GameState.PAUSED);
        half.classList.toggle('is-active', isActive);
        const low = rem <= (settings.warnThresholds[0] || 30) * 1000 && rem > 0;
        half.classList.toggle('low-time', low && engine.state === Tempo.GameState.RUNNING);
        half.classList.toggle('timeout-loser', engine.state === Tempo.GameState.TIMEOUT && engine.loser === i);
      }
    }

    function checkWarnings() {
      if (engine.state !== Tempo.GameState.RUNNING) return;
      const i = engine.active;
      const key = i === 0 ? 'p1' : 'p2';
      const remSec = engine.getRemaining(i) / 1000;
      const thresholds = (settings.warnThresholds || []).slice().sort((a, b) => b - a);
      // find how many thresholds have been crossed
      let crossed = 0;
      for (const t of thresholds) { if (remSec <= t) crossed++; }
      if (crossed > warnState[key]) {
        warnState[key] = crossed;
        if (settings.sound) Sound.warn();
        vibrate([40, 30, 40]);
        flashHalf(i);
      }
      // reset if time went back up (undo / increment)
      const maxCrossable = thresholds.filter((t) => remSec <= t).length;
      if (maxCrossable < warnState[key]) warnState[key] = maxCrossable;
    }

    function flashHalf(i) {
      const half = i === 0 ? el.p1 : el.p2;
      half.classList.remove('flash'); void half.offsetWidth; half.classList.add('flash');
    }

    function updateControls() {
      if (!el.pause) return;
      const s = engine.state;
      el.pause.textContent = s === Tempo.GameState.PAUSED ? '▶' : '⏸';
      el.pause.setAttribute('aria-label', s === Tempo.GameState.PAUSED ? 'Resume' : 'Pause');
      el.undo.disabled = !engine.canUndo();
      const labels = { idle: 'Ready', running: 'Running', paused: 'Paused', timeout: 'Time out', finished: 'Finished' };
      if (el.state) el.state.textContent = labels[s] || s;
      el.p1moves.textContent = engine.players[0].moves + (engine.players[0].moves === 1 ? ' move' : ' moves');
      el.p2moves.textContent = engine.players[1].moves + (engine.players[1].moves === 1 ? ' move' : ' moves');
      el.p1name.textContent = engine.players[0].name;
      el.p2name.textContent = engine.players[1].name;
      el.p1inc.textContent = engine.players[0].incrementMs ? '+' + (engine.players[0].incrementMs / 1000) + 's' : '';
      el.p2inc.textContent = engine.players[1].incrementMs ? '+' + (engine.players[1].incrementMs / 1000) + 's' : '';
    }

    /* -------- Engine callbacks -------- */
    let lastPressTs = 0;
    let pendingFirstMover = 0;
    function resolveFirstMover() {
      if (settings.startingPlayer === 'p1') return 0;
      if (settings.startingPlayer === 'p2') return 1;
      return Math.random() < 0.5 ? 0 : 1;
    }
    function handleSwitch() {
      if (settings.sound) Sound.click();
      vibrate(20);
    }
    function handleTimeout(loser, winner) {
      if (settings.sound) Sound.timeout();
      vibrate([120, 60, 120, 60, 240]);
      WakeLock.release();
      renderClock();
      updateControls();
      const names = [engine.players[0].name, engine.players[1].name];
      showResult(names[winner] + ' wins', names[loser] + ' ran out of time.', winner);
      recordGame(winner, 'timeout');
    }

    /* -------- Player tap handling -------- */
    function onPlayerTap(index) {
      Sound.unlock();
      const now = performance.now();
      if (engine.state === Tempo.GameState.RUNNING &&
          settings.tapProtection && (now - lastPressTs) < settings.tapInterval) {
        return; // debounce accidental double taps
      }
      const wasIdle = engine.state === Tempo.GameState.IDLE;
      let handled;
      if (wasIdle) {
        // Starting-player setting decides who is on the clock first.
        handled = engine.start(pendingFirstMover);
      } else {
        handled = engine.press(index);
      }
      if (handled) {
        lastPressTs = now;
        if (wasIdle) {
          WakeLock.request();
          startLoop();
          hideOverlay();
          if (settings.sound) Sound.click();
          vibrate(20);
        }
        startLoop();
      }
    }
    el.p1.addEventListener('click', () => onPlayerTap(0));
    el.p2.addEventListener('click', () => onPlayerTap(1));

    /* -------- Clock controls -------- */
    el.pause.addEventListener('click', () => {
      Sound.unlock();
      if (engine.state === Tempo.GameState.RUNNING) {
        engine.pause(); WakeLock.release();
      } else if (engine.state === Tempo.GameState.PAUSED) {
        engine.resume(); WakeLock.request(); startLoop();
      }
      renderClock();
    });
    el.undo.addEventListener('click', () => {
      Sound.unlock();
      if (engine.undo()) {
        warnState = { p1: 0, p2: 0 };
        hideOverlay();
        if (engine.state === Tempo.GameState.RUNNING) { WakeLock.request(); startLoop(); }
        renderClock();
        toast('Move undone');
      }
    });
    el.reset.addEventListener('click', () => {
      Sound.unlock();
      doReset();
    });
    $('btn-clock-home').addEventListener('click', () => {
      if (engine.state === Tempo.GameState.RUNNING) {
        if (!confirm('Leave the current game?')) return;
      }
      engine.pause(); WakeLock.release();
      goHome();
    });

    function doReset() {
      if (settings.confirmReset && engine.state !== Tempo.GameState.IDLE) {
        if (!confirm('Reset the clock?')) return;
      }
      engine.reset(presetToTimeControl(getPreset(selectedPresetId)));
      warnState = { p1: 0, p2: 0 };
      WakeLock.release();
      showOverlay();
      renderClock(); updateControls();
    }

    /* -------- Start overlay -------- */
    function showOverlay() {
      const ov = $('start-overlay');
      ov.hidden = false;
      const p = getPreset(selectedPresetId);
      $('overlay-tc').textContent = describePreset(p);
      pendingFirstMover = resolveFirstMover();
      const who = engine.players[pendingFirstMover].name;
      $('overlay-sub').textContent = 'Tap either side to begin. ' + who +
        "'s clock will start first" +
        (settings.startingPlayer === 'random' ? ' (random).' : '.');
    }
    function hideOverlay() { $('start-overlay').hidden = true; }
    $('overlay-dismiss').addEventListener('click', () => {
      // If a starting player is configured, we still wait for a tap; just close the card.
      hideOverlay();
    });

    /* -------- Navigation -------- */
    function showScreen(name) {
      Object.keys(screens).forEach((k) => {
        const s = screens[k];
        if (k === name) { s.hidden = false; s.classList.add('is-active'); }
        else { s.hidden = true; s.classList.remove('is-active'); }
      });
    }
    function goHome() { showScreen('home'); renderHome(); }
    function goClock() {
      showScreen('clock');
      engine.reset(presetToTimeControl(getPreset(selectedPresetId)));
      warnState = { p1: 0, p2: 0 };
      renderClock(); updateControls(); showOverlay();
      if (settings.fullscreen && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    }

    $('btn-start').addEventListener('click', () => { Sound.unlock(); goClock(); });
    $('nav-settings').addEventListener('click', () => { showScreen('settings'); renderSettings(); });
    $('nav-presets').addEventListener('click', () => { showScreen('presets'); renderPresets(); });
    $('nav-history').addEventListener('click', () => { showScreen('history'); renderHistory(); });
    document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', goHome));

    /* ==================================================================
       HOME RENDER (preset chips)
       ================================================================== */
    function describePreset(p) {
      const fmt = (t) => {
        const m = t.baseMs / 60000;
        const baseLabel = m >= 1 ? (Number.isInteger(m) ? m + ' min' : m.toFixed(1) + ' min') : (t.baseMs / 1000) + ' s';
        const inc = t.incMs ? ' + ' + (t.incMs / 1000) + 's' : '';
        return baseLabel + inc;
      };
      const sym = p.p1.baseMs === p.p2.baseMs && p.p1.incMs === p.p2.incMs;
      if (sym) return fmt(p.p1) + (p.type === 'none' ? ' · no increment' : ' · Fischer');
      return 'P1 ' + fmt(p.p1) + ' / P2 ' + fmt(p.p2);
    }

    function renderHome() {
      const container = $('preset-groups');
      container.textContent = '';
      const groups = {};
      allPresets().forEach((p) => {
        const g = p.group || 'Custom';
        (groups[g] = groups[g] || []).push(p);
      });
      const order = ['Bullet', 'Blitz', 'Rapid', 'Custom'];
      const keys = Object.keys(groups).sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      keys.forEach((g) => {
        const wrap = document.createElement('div');
        wrap.className = 'preset-group';
        const h = document.createElement('h3');
        h.textContent = g;
        wrap.appendChild(h);
        const row = document.createElement('div');
        row.className = 'preset-row';
        groups[g].forEach((p) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'preset-chip';
          btn.textContent = p.name;
          btn.setAttribute('aria-pressed', String(p.id === selectedPresetId));
          btn.addEventListener('click', () => {
            selectedPresetId = p.id;
            save(LS.LAST_TC, selectedPresetId);
            renderHome();
          });
          row.appendChild(btn);
        });
        wrap.appendChild(row);
        container.appendChild(wrap);
      });
      const sel = getPreset(selectedPresetId);
      $('selected-preset-name').textContent = sel.name + ' — ' + describePreset(sel);
    }

    /* ==================================================================
       SETTINGS RENDER
       ================================================================== */
    function makeToggle(labelText, hintText, checked, onChange) {
      const row = document.createElement('div');
      row.className = 'setting';
      const lab = document.createElement('label');
      lab.textContent = labelText;
      if (hintText) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = hintText; lab.appendChild(h); }
      const sw = document.createElement('span');
      sw.className = 'switch';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      const track = document.createElement('span'); track.className = 'track';
      const thumb = document.createElement('span'); thumb.className = 'thumb';
      sw.appendChild(input); sw.appendChild(track); sw.appendChild(thumb);
      const id = 'set-' + Math.random().toString(36).slice(2, 8);
      input.id = id; lab.setAttribute('for', id);
      row.appendChild(lab); row.appendChild(sw);
      return row;
    }
    function makeSelect(labelText, options, value, onChange) {
      const row = document.createElement('div');
      row.className = 'setting';
      const lab = document.createElement('label'); lab.textContent = labelText;
      const sel = document.createElement('select');
      options.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        if (o.value === value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => onChange(sel.value));
      const id = 'set-' + Math.random().toString(36).slice(2, 8);
      sel.id = id; lab.setAttribute('for', id);
      row.appendChild(lab); row.appendChild(sel);
      return row;
    }

    function renderSettings() {
      const body = $('settings-body');
      body.textContent = '';

      const gAppear = groupEl('Appearance');
      gAppear.appendChild(makeSelect('Theme', [
        { value: 'system', label: 'System' }, { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' }, { value: 'wood', label: 'Wood' },
        { value: 'marble', label: 'Marble' }, { value: 'night', label: 'Night' },
      ], settings.theme, (v) => { settings.theme = v; persistSettings(); applyTheme(); }));
      gAppear.appendChild(makeSelect('Display precision', [
        { value: 'adaptive', label: 'Adaptive (MM:SS → SS.S → SS.SS)' },
        { value: 'tenths', label: 'Tenths under a minute' },
        { value: 'mmss', label: 'Always MM:SS' },
      ], settings.precision, (v) => { settings.precision = v; persistSettings(); }));
      body.appendChild(gAppear);

      const gPlay = groupEl('Gameplay');
      gPlay.appendChild(makeSelect('Starting player', [
        { value: 'p1', label: 'Player 1' }, { value: 'p2', label: 'Player 2' },
        { value: 'random', label: 'Random' },
      ], settings.startingPlayer, (v) => { settings.startingPlayer = v; persistSettings(); }));
      gPlay.appendChild(makeToggle('Tap protection', 'Ignore taps faster than the interval below', settings.tapProtection, (v) => { settings.tapProtection = v; persistSettings(); }));
      // tap interval numeric
      const tapRow = document.createElement('div'); tapRow.className = 'setting';
      const tapLab = document.createElement('label'); tapLab.textContent = 'Tap interval (ms)';
      const tapInput = document.createElement('input'); tapInput.type = 'number'; tapInput.min = '0'; tapInput.max = '1000'; tapInput.step = '10';
      tapInput.value = settings.tapInterval;
      tapInput.addEventListener('change', () => { settings.tapInterval = clampInt(tapInput.value, 0, 2000, 150); tapInput.value = settings.tapInterval; persistSettings(); });
      tapRow.appendChild(tapLab); tapRow.appendChild(tapInput);
      gPlay.appendChild(tapRow);
      gPlay.appendChild(makeToggle('Confirm before reset', '', settings.confirmReset, (v) => { settings.confirmReset = v; persistSettings(); }));
      body.appendChild(gPlay);

      const gWarn = groupEl('Low-time warnings');
      const warnRow = document.createElement('div'); warnRow.className = 'field';
      const warnLab = document.createElement('label'); warnLab.textContent = 'Thresholds (seconds, comma separated)';
      const warnInput = document.createElement('input'); warnInput.type = 'text';
      warnInput.value = (settings.warnThresholds || []).join(', ');
      warnInput.addEventListener('change', () => {
        const parsed = warnInput.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
        settings.warnThresholds = parsed.length ? parsed.sort((a, b) => b - a) : [30, 10, 5];
        warnInput.value = settings.warnThresholds.join(', ');
        persistSettings();
      });
      warnRow.appendChild(warnLab); warnRow.appendChild(warnInput);
      gWarn.appendChild(warnRow);
      body.appendChild(gWarn);

      const gFeedback = groupEl('Feedback & device');
      gFeedback.appendChild(makeToggle('Sound', 'Generated tones (no files)', settings.sound, (v) => { settings.sound = v; persistSettings(); if (v) Sound.unlock(); }));
      gFeedback.appendChild(makeToggle('Haptics', 'Vibration (if supported)', settings.haptics, (v) => { settings.haptics = v; persistSettings(); }));
      gFeedback.appendChild(makeToggle('Keep screen awake', 'Screen Wake Lock while running', settings.wakeLock, (v) => { settings.wakeLock = v; persistSettings(); }));
      gFeedback.appendChild(makeToggle('Auto-pause when hidden', 'Pause when the tab/app is backgrounded', settings.autoPauseHidden, (v) => { settings.autoPauseHidden = v; persistSettings(); }));
      gFeedback.appendChild(makeToggle('Fullscreen on start', 'Enter fullscreen when a game begins', settings.fullscreen, (v) => { settings.fullscreen = v; persistSettings(); }));
      body.appendChild(gFeedback);

      const gData = groupEl('Data');
      const resetRow = document.createElement('div'); resetRow.className = 'setting';
      const resetLab = document.createElement('label'); resetLab.textContent = 'Reset all settings';
      const resetBtn = document.createElement('button'); resetBtn.className = 'btn btn-ghost btn-sm'; resetBtn.textContent = 'Reset';
      resetBtn.addEventListener('click', () => {
        if (confirm('Restore default settings?')) {
          settings = Object.assign({}, DEFAULT_SETTINGS);
          persistSettings(); applyTheme(); renderSettings(); toast('Settings reset');
        }
      });
      resetRow.appendChild(resetLab); resetRow.appendChild(resetBtn);
      gData.appendChild(resetRow);
      body.appendChild(gData);
    }
    function groupEl(title) {
      const g = document.createElement('div'); g.className = 'setting-group';
      const h = document.createElement('h3'); h.textContent = title; g.appendChild(h);
      return g;
    }
    function clampInt(v, lo, hi, dflt) {
      const n = parseInt(v, 10);
      if (isNaN(n)) return dflt;
      return Math.min(hi, Math.max(lo, n));
    }

    /* ==================================================================
       PRESETS SCREEN
       ================================================================== */
    function renderPresets() {
      const body = $('presets-body');
      body.textContent = '';
      allPresets().forEach((p) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        const main = document.createElement('div'); main.className = 'li-main';
        const title = document.createElement('div'); title.className = 'li-title';
        title.textContent = p.name;
        if (p.builtin) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = ' built-in'; title.appendChild(document.createTextNode(' ')); title.appendChild(t); }
        const sub = document.createElement('div'); sub.className = 'li-sub';
        sub.textContent = describePreset(p);
        main.appendChild(title); main.appendChild(sub);
        item.appendChild(main);

        const actions = document.createElement('div'); actions.className = 'li-actions';
        const useBtn = document.createElement('button'); useBtn.className = 'icon-btn'; useBtn.textContent = '▶';
        useBtn.setAttribute('aria-label', 'Use ' + p.name);
        useBtn.addEventListener('click', () => { selectedPresetId = p.id; save(LS.LAST_TC, selectedPresetId); goClock(); });
        actions.appendChild(useBtn);
        if (!p.builtin) {
          const edit = document.createElement('button'); edit.className = 'icon-btn'; edit.textContent = '✎';
          edit.setAttribute('aria-label', 'Edit ' + p.name);
          edit.addEventListener('click', () => openPresetEditor(p));
          const del = document.createElement('button'); del.className = 'icon-btn danger'; del.textContent = '🗑';
          del.setAttribute('aria-label', 'Delete ' + p.name);
          del.addEventListener('click', () => {
            if (confirm('Delete preset "' + p.name + '"?')) {
              customPresets = customPresets.filter((x) => x.id !== p.id);
              persistPresets();
              if (selectedPresetId === p.id) { selectedPresetId = 'r_10_0'; save(LS.LAST_TC, selectedPresetId); }
              renderPresets();
            }
          });
          actions.appendChild(edit); actions.appendChild(del);
        }
        item.appendChild(actions);
        body.appendChild(item);
      });
    }

    $('btn-new-preset').addEventListener('click', () => openPresetEditor(null));

    /* -------- Custom preset editor modal -------- */
    let editorTarget = null;
    function openPresetEditor(preset) {
      editorTarget = preset;
      const body = $('modal-body');
      body.textContent = '';
      $('modal-title').textContent = preset ? 'Edit preset' : 'New custom preset';

      const nameField = fieldText('Preset name', preset ? preset.name : '', 'e.g. Classical 60+30');
      body.appendChild(nameField.wrap);

      const typeField = fieldSelect('Increment type', [
        { value: 'fischer', label: 'Fischer (add after move)' },
        { value: 'none', label: 'None' },
      ], preset ? preset.type : 'fischer');
      body.appendChild(typeField.wrap);

      const asymField = document.createElement('div'); asymField.className = 'setting';
      const asymLab = document.createElement('label'); asymLab.textContent = 'Different time per player';
      const asymSw = document.createElement('span'); asymSw.className = 'switch';
      const asymInput = document.createElement('input'); asymInput.type = 'checkbox';
      const asymTrack = document.createElement('span'); asymTrack.className = 'track';
      const asymThumb = document.createElement('span'); asymThumb.className = 'thumb';
      asymSw.appendChild(asymInput); asymSw.appendChild(asymTrack); asymSw.appendChild(asymThumb);
      asymField.appendChild(asymLab); asymField.appendChild(asymSw);
      body.appendChild(asymField);

      const p1min = preset ? preset.p1.baseMs / 60000 : 5;
      const p1inc = preset ? preset.p1.incMs / 1000 : 0;
      const p2min = preset ? preset.p2.baseMs / 60000 : 5;
      const p2inc = preset ? preset.p2.incMs / 1000 : 0;
      const asym = preset ? (preset.p1.baseMs !== preset.p2.baseMs || preset.p1.incMs !== preset.p2.incMs) : false;
      asymInput.checked = asym;

      const p1Row = twoNum('Player 1 minutes', p1min, 'Player 1 increment (s)', p1inc);
      const p2Row = twoNum('Player 2 minutes', p2min, 'Player 2 increment (s)', p2inc);
      p2Row.wrap.querySelector('label').textContent = 'Player 2 minutes';
      const p2Header = document.createElement('div'); p2Header.className = 'field'; 
      body.appendChild(labelSmall('Player 1'));
      body.appendChild(p1Row.wrap);
      const p2Block = document.createElement('div');
      p2Block.appendChild(labelSmall('Player 2'));
      p2Block.appendChild(p2Row.wrap);
      body.appendChild(p2Block);
      function syncAsym() { p2Block.style.display = asymInput.checked ? '' : 'none'; }
      asymInput.addEventListener('change', syncAsym); syncAsym();

      $('modal-root').hidden = false;

      $('modal-save').onclick = function () {
        const name = nameField.input.value.trim() || 'Custom';
        const type = typeField.select.value;
        const b1 = Math.round(parseFloat(p1Row.a.value) * 60000) || 0;
        const i1 = Math.round(parseFloat(p1Row.b.value) * 1000) || 0;
        let b2 = b1, i2 = i1;
        if (asymInput.checked) {
          b2 = Math.round(parseFloat(p2Row.a.value) * 60000) || 0;
          i2 = Math.round(parseFloat(p2Row.b.value) * 1000) || 0;
        }
        if (b1 <= 0 || b2 <= 0) { toast('Base time must be greater than 0'); return; }
        const obj = {
          id: preset ? preset.id : 'c_' + Date.now().toString(36),
          builtin: false, group: 'Custom', name: name, type: type,
          p1: { baseMs: b1, incMs: type === 'none' ? 0 : i1 },
          p2: { baseMs: b2, incMs: type === 'none' ? 0 : i2 },
        };
        if (preset) {
          customPresets = customPresets.map((x) => (x.id === preset.id ? obj : x));
        } else {
          customPresets.push(obj);
        }
        persistPresets();
        closeModal();
        renderPresets();
        toast('Preset saved');
      };
      $('modal-cancel').onclick = closeModal;
    }
    function closeModal() { $('modal-root').hidden = true; }

    function fieldText(labelText, value, placeholder) {
      const wrap = document.createElement('div'); wrap.className = 'field';
      const lab = document.createElement('label'); lab.textContent = labelText;
      const input = document.createElement('input'); input.type = 'text'; input.value = value || '';
      input.placeholder = placeholder || ''; input.maxLength = 40;
      wrap.appendChild(lab); wrap.appendChild(input);
      return { wrap, input };
    }
    function fieldSelect(labelText, options, value) {
      const wrap = document.createElement('div'); wrap.className = 'field';
      const lab = document.createElement('label'); lab.textContent = labelText;
      const select = document.createElement('select');
      options.forEach((o) => { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; if (o.value === value) op.selected = true; select.appendChild(op); });
      wrap.appendChild(lab); wrap.appendChild(select);
      return { wrap, select };
    }
    function twoNum(la, va, lb, vb) {
      const wrap = document.createElement('div'); wrap.className = 'field-row';
      const fa = document.createElement('div'); fa.className = 'field';
      const laEl = document.createElement('label'); laEl.textContent = la;
      const a = document.createElement('input'); a.type = 'number'; a.min = '0'; a.step = '0.5'; a.value = va;
      fa.appendChild(laEl); fa.appendChild(a);
      const fb = document.createElement('div'); fb.className = 'field';
      const lbEl = document.createElement('label'); lbEl.textContent = lb;
      const b = document.createElement('input'); b.type = 'number'; b.min = '0'; b.step = '1'; b.value = vb;
      fb.appendChild(lbEl); fb.appendChild(b);
      wrap.appendChild(fa); wrap.appendChild(fb);
      return { wrap, a, b };
    }
    function labelSmall(text) {
      const d = document.createElement('div'); d.className = 'field';
      const l = document.createElement('label'); l.textContent = text; l.style.fontWeight = '600'; l.style.color = 'var(--text)';
      d.appendChild(l); return d;
    }

    /* ==================================================================
       HISTORY
       ================================================================== */
    function recordGame(winner, reason) {
      const p = getPreset(selectedPresetId);
      history.unshift({
        date: new Date().toISOString(),
        p1: engine.players[0].name,
        p2: engine.players[1].name,
        tc: describePreset(p),
        tcName: p.name,
        winner: winner, // 0,1
        reason: reason,
        p1Remaining: Math.max(0, Math.round(engine.getRemaining(0))),
        p2Remaining: Math.max(0, Math.round(engine.getRemaining(1))),
        moves: engine.players[0].moves + engine.players[1].moves,
      });
      if (history.length > 100) history.length = 100;
      persistHistory();
    }
    function renderHistory() {
      const body = $('history-body');
      body.textContent = '';
      if (!history.length) {
        const e = document.createElement('div'); e.className = 'empty-state';
        e.textContent = 'No games played yet. Completed games will appear here.';
        body.appendChild(e); return;
      }
      history.forEach((h) => {
        const item = document.createElement('div'); item.className = 'list-item';
        const main = document.createElement('div'); main.className = 'li-main';
        const title = document.createElement('div'); title.className = 'li-title';
        const wname = h.winner === 0 ? h.p1 : h.p2;
        title.textContent = wname + ' won';
        const sub = document.createElement('div'); sub.className = 'li-sub';
        const d = new Date(h.date);
        sub.textContent = h.p1 + ' vs ' + h.p2 + ' · ' + h.tcName + ' · ' + h.reason + ' · ' + d.toLocaleString();
        main.appendChild(title); main.appendChild(sub);
        item.appendChild(main);
        body.appendChild(item);
      });
    }
    $('btn-clear-history').addEventListener('click', () => {
      if (history.length && confirm('Clear all game history?')) {
        history = []; persistHistory(); renderHistory(); toast('History cleared');
      }
    });

    /* ==================================================================
       RESULT DIALOG
       ================================================================== */
    function showResult(title, text, winner) {
      $('result-title').textContent = title;
      $('result-text').textContent = text;
      $('result-root').hidden = false;
    }
    $('result-rematch').addEventListener('click', () => {
      $('result-root').hidden = true;
      doReset();
    });
    $('result-home').addEventListener('click', () => {
      $('result-root').hidden = true;
      goHome();
    });

    /* ==================================================================
       THEME
       ================================================================== */
    function applyTheme() {
      document.documentElement.setAttribute('data-theme', settings.theme);
    }

    /* ==================================================================
       PAGE VISIBILITY (auto-pause)
       ================================================================== */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (settings.autoPauseHidden && engine.state === Tempo.GameState.RUNNING) {
          engine.pause(); WakeLock.release(); renderClock();
          toast('Paused (app hidden)');
        }
      } else {
        WakeLock.reacquire();
        if (engine.state === Tempo.GameState.RUNNING) startLoop();
      }
    });

    /* ==================================================================
       TOAST
       ================================================================== */
    let toastTimer = null;
    function toast(msg) {
      const t = $('toast');
      t.textContent = msg; t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
    }

    /* ==================================================================
       PWA INSTALL + SERVICE WORKER
       ================================================================== */
    let deferredPrompt = null;
    const installBtn = $('btn-install');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.style.display = 'block';
    });
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.style.display = 'none';
    });
    window.addEventListener('appinstalled', () => { installBtn.style.display = 'none'; });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').then(() => {
          $('offline-badge').hidden = false;
        }).catch(() => {});
      });
    }

    /* -------- Keyboard shortcuts (desktop convenience) -------- */
    document.addEventListener('keydown', (e) => {
      if (!screens.clock.classList.contains('is-active')) return;
      if (e.code === 'Space') { e.preventDefault(); onPlayerTap(engine.active == null ? 0 : engine.active); }
      else if (e.key === 'p' || e.key === 'P') { el.pause.click(); }
      else if (e.key === 'z' || e.key === 'Z') { el.undo.click(); }
      else if (e.key === 'a' || e.key === 'ArrowLeft') { onPlayerTap(0); }
      else if (e.key === 'l' || e.key === 'ArrowRight') { onPlayerTap(1); }
    });

    /* -------- First-gesture sound unlock -------- */
    document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

    /* ==================================================================
       INIT
       ================================================================== */
    applyTheme();
    goHome();
    updateControls();
  }
})(typeof window !== 'undefined' ? window : this);
