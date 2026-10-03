// Headless harness: loads app.js engine into a vm sandbox and runs the same
// assertions as clock-engine.test.html. Dev-only (not shipped to the server).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const sandbox = { window: { TEMPO_TEST_MODE: true }, performance: { now: () => 0 }, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const T = sandbox.window.Tempo;
if (!T) { console.error('FAILED: window.Tempo not exported'); process.exit(1); }

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('✗ ' + name + '\n    ' + (e.message || e)); }
}
function eq(a, b, m) { if (a !== b) throw new Error((m || 'not equal') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); }
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function makeClock() { let t = 0; return { now: () => t, advance: (ms) => { t += ms; }, get: () => t }; }
const MIN = 60000;
function symTC(b, i, ty) { return T.TimeControl.symmetric(b, i, ty || (i ? T.IncrementType.FISCHER : T.IncrementType.NONE)); }
function newEngine(b, i, ty) { const clk = makeClock(); const eng = new T.ClockEngine({ now: clk.now, timeControl: symTC(b, i, ty) }); return { eng, clk }; }

// mirror of the browser suite
eqTests();
function eqTests() {
  test('fmt mmss', () => { eq(T.formatTime(90000, 'adaptive'), '1:30'); eq(T.formatTime(600000, 'adaptive'), '10:00'); });
  test('fmt tenths', () => { eq(T.formatTime(59900, 'adaptive'), '59.9'); eq(T.formatTime(12345, 'adaptive'), '12.3'); });
  test('fmt hundredths', () => { eq(T.formatTime(9990, 'adaptive'), '9.99'); eq(T.formatTime(1234, 'adaptive'), '1.23'); });
  test('fmt hours', () => eq(T.formatTime(3661000, 'adaptive'), '1:01:01'));
  test('fmt negative', () => eq(T.formatTime(-5000, 'adaptive'), '0.00'));
  test('fmt mmss mode', () => eq(T.formatTime(5000, 'mmss'), '0:05'));
  test('sym tc', () => { const tc = symTC(3 * MIN, 2000); eq(tc.p1.baseMs, 180000); eq(tc.p1.incMs, 2000); });
  test('idle', () => { const { eng } = newEngine(10 * MIN, 0); eq(eng.state, T.GameState.IDLE); eq(eng.getRemaining(0), 600000); eq(eng.active, null); });
  test('asym', () => { const clk = makeClock(); const tc = new T.TimeControl({ type: T.IncrementType.FISCHER, p1: { baseMs: 5 * MIN, incMs: 3000 }, p2: { baseMs: 3 * MIN, incMs: 0 } }); const eng = new T.ClockEngine({ now: clk.now, timeControl: tc }); eq(eng.getRemaining(0), 300000); eq(eng.getRemaining(1), 180000); });
  test('start', () => { const { eng } = newEngine(10 * MIN, 0); eq(eng.start(0), true); eq(eng.state, T.GameState.RUNNING); eq(eng.active, 0); });
  test('countdown', () => { const { eng, clk } = newEngine(10 * MIN, 0); eng.start(0); clk.advance(4321); eq(eng.getRemaining(0), 600000 - 4321); eq(eng.getRemaining(1), 600000); });
  test('TIMING ACCURACY 10:00+5 / 2.5s', () => { const { eng, clk } = newEngine(10 * MIN, 5000, T.IncrementType.FISCHER); eng.start(0); clk.advance(2500); eng.press(0); eq(eng.players[0].remainingMs, 602500); eq(eng.active, 1); });
  test('no inc', () => { const { eng, clk } = newEngine(5 * MIN, 0, T.IncrementType.NONE); eng.start(0); clk.advance(3000); eng.press(0); eq(eng.players[0].remainingMs, 300000 - 3000); });
  test('press switch', () => { const { eng, clk } = newEngine(3 * MIN, 0); eng.start(0); clk.advance(1000); eng.press(0); eq(eng.active, 1); clk.advance(2000); eq(eng.getRemaining(1), 180000 - 2000); eq(eng.getRemaining(0), 180000 - 1000); });
  test('non-active ignored', () => { const { eng, clk } = newEngine(3 * MIN, 0); eng.start(0); clk.advance(1000); eq(eng.press(1), false); eq(eng.active, 0); });
  test('fischer accum', () => { const { eng, clk } = newEngine(2 * MIN, 2000, T.IncrementType.FISCHER); eng.start(0); clk.advance(1000); eng.press(0); clk.advance(1000); eng.press(1); clk.advance(500); eng.press(0); eq(eng.players[0].remainingMs, 122500); eq(eng.players[1].remainingMs, 121000); });
  test('DRIFT irregular', () => { const { eng, clk } = newEngine(10 * MIN, 0); eng.start(0); [16, 28, 11, 43, 100, 17].forEach((s) => { clk.advance(s); eng.checkFlag(); }); eq(eng.getRemaining(0), 600000 - 215); });
  test('DRIFT small=big', () => { const a = newEngine(10 * MIN, 0); a.eng.start(0); for (let i = 0; i < 1000; i++) { a.clk.advance(17); a.eng.checkFlag(); } const b = newEngine(10 * MIN, 0); b.eng.start(0); b.clk.advance(17000); eq(a.eng.getRemaining(0), b.eng.getRemaining(0)); });
  test('pause freeze', () => { const { eng, clk } = newEngine(5 * MIN, 0); eng.start(0); clk.advance(2000); eng.pause(); const s = eng.getRemaining(0); clk.advance(9999); eq(eng.getRemaining(0), s); eq(eng.state, T.GameState.PAUSED); });
  test('resume', () => { const { eng, clk } = newEngine(5 * MIN, 0); eng.start(0); clk.advance(2000); eng.pause(); clk.advance(5000); eng.resume(); clk.advance(1000); eq(eng.getRemaining(0), 300000 - 3000); });
  test('undo restore', () => { const { eng, clk } = newEngine(10 * MIN, 0); eng.start(0); clk.advance(3000); eng.press(0); eq(eng.active, 1); eng.undo(); eq(eng.active, 0); eq(eng.players[0].remainingMs, 597000); });
  test('undo refund opp', () => { const { eng, clk } = newEngine(10 * MIN, 0); eng.start(0); clk.advance(3000); eng.press(0); clk.advance(2000); eng.undo(); eq(eng.getRemaining(1), 600000); eq(eng.getRemaining(0), 597000); });
  test('undo reverse inc', () => { const { eng, clk } = newEngine(10 * MIN, 5000, T.IncrementType.FISCHER); eng.start(0); clk.advance(2000); eng.press(0); eng.undo(); eq(eng.players[0].remainingMs, 598000); });
  test('maxUndo cap', () => { const clk = makeClock(); const eng = new T.ClockEngine({ now: clk.now, timeControl: symTC(10 * MIN, 0), maxUndo: 3 }); eng.start(0); for (let i = 0; i < 6; i++) { clk.advance(100); eng.press(eng.active); } eq(eng.undoStack.length, 3); });
  test('checkFlag timeout', () => { const { eng, clk } = newEngine(1000, 0); eng.start(0); clk.advance(1500); eq(eng.checkFlag(), true); eq(eng.state, T.GameState.TIMEOUT); eq(eng.loser, 0); eq(eng.winner, 1); eq(eng.getRemaining(0), 0); });
  test('press overlong timeout', () => { const { eng, clk } = newEngine(2000, 0); eng.start(0); clk.advance(2500); eng.press(0); eq(eng.state, T.GameState.TIMEOUT); eq(eng.loser, 0); });
  test('timeout cb', () => { const clk = makeClock(); let cb = null; const eng = new T.ClockEngine({ now: clk.now, timeControl: symTC(1000, 0), onTimeout: (l, w) => { cb = { l, w }; } }); eng.start(1); clk.advance(1200); eng.checkFlag(); eq(cb.l, 1); eq(cb.w, 0); });
  test('undo from timeout', () => { const { eng, clk } = newEngine(2000, 0); eng.start(0); clk.advance(1000); eng.press(0); clk.advance(2500); eng.checkFlag(); eq(eng.state, T.GameState.TIMEOUT); eng.undo(); eq(eng.state, T.GameState.RUNNING); assert(eng.loser === null); });
  test('reset', () => { const { eng, clk } = newEngine(5 * MIN, 0); eng.start(0); clk.advance(10000); eng.press(0); eng.reset(); eq(eng.state, T.GameState.IDLE); eq(eng.getRemaining(0), 300000); eq(eng.active, null); eq(eng.canUndo(), false); });
  test('moves counter', () => { const { eng, clk } = newEngine(5 * MIN, 0); eng.start(0); clk.advance(100); eng.press(0); clk.advance(100); eng.press(1); clk.advance(100); eng.press(0); eq(eng.players[0].moves, 2); eq(eng.players[1].moves, 1); });
  test('integer ms', () => { const { eng, clk } = newEngine(5 * MIN, 0); eng.start(0); clk.advance(33.7); eng.press(0); assert(Number.isInteger(eng.players[0].remainingMs)); });
  test('blitz 3+2 sim', () => { const { eng, clk } = newEngine(3 * MIN, 2000, T.IncrementType.FISCHER); eng.start(0); [[0, 4000], [1, 6000], [0, 3000], [1, 5000]].forEach(([w, ms]) => { clk.advance(ms); eng.press(w); }); eq(eng.players[0].remainingMs, 177000); eq(eng.players[1].remainingMs, 173000); });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
process.exit(failed ? 1 : 0);
