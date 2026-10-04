/*
 * 독립 오라클. 코어 구현은 보지 않고 규칙(가이드 5~7장, types.js)만으로 쓴 단순 참조 모델과
 * 코어 공개 API(src/core/index.js)를 차분 테스트한다. 일부러 느리고 단순하게(중첩 반복문) 작성했다.
 * 트레이 리필은 코어의 난수 선택이라 오라클이 재현하지 않고, 형식을 검증한 뒤 그대로 이어받는다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core/index.js';
import { BOARD_SIZE, TRAY_SIZE, COLOR_COUNT } from '../src/config.js';

// 규칙에서 직접 가져온 값. 코어의 SCORING/상수를 import하지 않는 것이 독립성의 핵심이다.
const SIZE = 8;
const TRAY_LEN = 3;
const COLORS = 7;
const CELL_POINT = 1;
const LINE_BASE = 10;
const COMBO_STEP = 0.5;
const MULTIPLIER_CAP = 5;
const PERFECT_BONUS = 300;
const SHAPE_COUNT = 37;

/* ───────────── 테스트 보조 ───────────── */

// 코어 난수와 섞이지 않도록 테스트 전용 난수(splitmix32)를 따로 둔다.
function makeRand(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

// 입력을 얼려서 던지면 코어가 입력을 수정하는 순간 TypeError로 드러난다.
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

function boardFromRows(rows) {
  return rows.map((line) => [...line].map((ch) => (ch === '.' ? 0 : Number(ch))));
}

const SHAPE_IDS = core.SHAPE_LIST.map((shape) => shape.id);
const cellsOf = (shapeId) => core.getShape(shapeId).cells;

/* ───────────── 참조 모델: 보드 ───────────── */

function refEmptyBoard() {
  const board = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) row.push(0);
    board.push(row);
  }
  return board;
}

function refCopy(board) {
  return board.map((row) => row.slice());
}

function refAbs(cells, row, col) {
  const out = [];
  for (const [dr, dc] of cells) out.push([row + dr, col + dc]);
  return out;
}

// 보드 밖이 하나라도 있으면 겹침 여부와 관계없이 out_of_bounds가 우선한다.
function refProblem(board, cells, row, col) {
  for (const [dr, dc] of cells) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return 'out_of_bounds';
  }
  for (const [dr, dc] of cells) {
    if (board[row + dr][col + dc] !== 0) return 'overlap';
  }
  return null;
}

function refFullLines(board) {
  const rows = [];
  const cols = [];
  for (let r = 0; r < SIZE; r++) {
    let full = true;
    for (let c = 0; c < SIZE; c++) if (board[r][c] === 0) full = false;
    if (full) rows.push(r);
  }
  for (let c = 0; c < SIZE; c++) {
    let full = true;
    for (let r = 0; r < SIZE; r++) if (board[r][c] === 0) full = false;
    if (full) cols.push(c);
  }
  return { rows, cols };
}

function refCountFilled(board) {
  let count = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (board[r][c] !== 0) count += 1;
  }
  return count;
}

// 배치 → 가득 찬 줄을 전부 먼저 찾기 → 한꺼번에 지우기.
function refPlaceAndClear(board, cells, row, col, color) {
  const next = refCopy(board);
  const placed = refAbs(cells, row, col);
  for (const [r, c] of placed) next[r][c] = color;
  const { rows, cols } = refFullLines(next);
  const cleared = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (rows.includes(r) || cols.includes(c)) cleared.push({ r, c, color: next[r][c] });
    }
  }
  for (const { r, c } of cleared) next[r][c] = 0;
  return { board: next, placed, rows, cols, cleared };
}

// 모양이 (0,0) 기준으로 정규화되어 있으므로 기준점은 보드 안(0..7)만 보면 된다.
function refCanPlaceAnywhere(board, cells) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (refProblem(board, cells, r, c) === null) return true;
    }
  }
  return false;
}

function refHasMove(board, tray) {
  for (const piece of tray) {
    if (piece !== null && refCanPlaceAnywhere(board, cellsOf(piece.shapeId))) return true;
  }
  return false;
}

/* ───────────── 참조 모델: 이동/미리보기 ───────────── */

function isBadArgs(trayIndex, row, col) {
  return !Number.isInteger(trayIndex) || trayIndex < 0 || trayIndex >= TRAY_LEN
    || !Number.isInteger(row) || !Number.isInteger(col);
}

function refMoves(model) {
  const out = [];
  if (model.status === 'over') return out;
  for (let slot = 0; slot < TRAY_LEN; slot++) {
    const piece = model.tray[slot];
    if (piece === null) continue;
    const cells = cellsOf(piece.shapeId);
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (refProblem(model.board, cells, row, col) === null) out.push({ trayIndex: slot, row, col });
      }
    }
  }
  return out;
}

/**
 * 한 번의 이동을 참조 규칙대로 계산한다.
 * 리필 트레이는 코어가 뽑으므로 coreTray로 받아 이어받는다(리필이 없으면 쓰이지 않는다).
 */
function refStep(model, trayIndex, row, col, coreTray) {
  if (isBadArgs(trayIndex, row, col)) return { ok: false, error: 'bad_args' };
  if (model.status === 'over') return { ok: false, error: 'game_over' };
  const piece = model.tray[trayIndex];
  if (piece === null) return { ok: false, error: 'empty_slot' };
  const cells = cellsOf(piece.shapeId);
  const problem = refProblem(model.board, cells, row, col);
  if (problem !== null) return { ok: false, error: problem };

  const next = structuredClone(model);
  const result = refPlaceAndClear(model.board, cells, row, col, piece.color);
  const lines = result.rows.length + result.cols.length;
  next.board = result.board;
  next.tray[trayIndex] = null;
  next.moves = model.moves + 1;
  const events = [{ type: 'place', shapeId: piece.shapeId, color: piece.color, cells: result.placed }];

  if (lines > 0) {
    events.push({ type: 'clear', rows: result.rows, cols: result.cols, cells: result.cleared, lines });
    next.lines = model.lines + lines;
  }

  next.combo = lines > 0 ? model.combo + 1 : 0;
  next.maxCombo = Math.max(model.maxCombo, next.combo);
  let multiplier = 1;
  if (lines > 0) {
    multiplier = Math.min(MULTIPLIER_CAP, 1 + COMBO_STEP * (next.combo - 1));
    events.push({ type: 'combo', count: next.combo, multiplier });
  } else if (model.combo > 0) {
    events.push({ type: 'comboBreak', previous: model.combo });
  }

  const perfect = lines > 0 && refCountFilled(next.board) === 0;
  if (perfect) {
    next.perfects = model.perfects + 1;
    events.push({ type: 'perfect', bonus: PERFECT_BONUS });
  }

  const place = result.placed.length * CELL_POINT;
  const clear = Math.round(LINE_BASE * lines * lines * multiplier);
  const bonus = perfect ? PERFECT_BONUS : 0;
  const delta = place + clear + bonus;
  next.score = model.score + delta;
  events.push({ type: 'score', delta, total: next.score, breakdown: { place, clear, perfect: bonus } });

  let refilled = false;
  if (next.tray.every((slot) => slot === null)) {
    refilled = true;
    next.trayIndex = model.trayIndex + 1;
    next.tray = coreTray ? structuredClone(coreTray) : next.tray;
    events.push({ type: 'trayRefill', tray: structuredClone(next.tray) });
  }

  // 게임오버는 리필 뒤의 트레이로 판정한다.
  if (!refHasMove(next.board, next.tray)) {
    next.status = 'over';
    events.push({
      type: 'gameover',
      score: next.score,
      stats: { lines: next.lines, maxCombo: next.maxCombo, moves: next.moves, perfects: next.perfects },
    });
  }
  return { ok: true, model: next, events, refilled };
}

/**
 * game_over의 cells/clear*는 가이드가 정하지 않아 오라클이 단언하지 않는다(openIssues).
 */
function refPreview(model, trayIndex, row, col) {
  const empty = { cells: [], clearRows: [], clearCols: [], clearCells: [] };
  if (isBadArgs(trayIndex, row, col)) return { valid: false, reason: 'bad_args', ...empty };
  if (model.status === 'over') return { valid: false, reason: 'game_over', lenient: true };
  const piece = model.tray[trayIndex];
  if (piece === null) return { valid: false, reason: 'empty_slot', ...empty };
  const cells = cellsOf(piece.shapeId);
  const abs = refAbs(cells, row, col);
  const problem = refProblem(model.board, cells, row, col);
  if (problem !== null) return { valid: false, reason: problem, ...empty, cells: abs };

  const result = refPlaceAndClear(model.board, cells, row, col, piece.color);
  const clearCells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (result.rows.includes(r) || result.cols.includes(c)) clearCells.push([r, c]);
    }
  }
  return { valid: true, cells: abs, clearRows: result.rows, clearCols: result.cols, clearCells };
}

/* ───────────── 참조 모델: 해결 가능성(완전 탐색) ───────────── */

class SearchBudgetExceeded extends Error {}

function refSolvable(board, cellLists, counter) {
  if (cellLists.length === 0) return true;
  for (let i = 0; i < cellLists.length; i++) {
    const rest = cellLists.filter((_, j) => j !== i);
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (refProblem(board, cellLists[i], row, col) !== null) continue;
        counter.nodes += 1;
        if (counter.nodes > counter.limit) throw new SearchBudgetExceeded();
        const after = refPlaceAndClear(board, cellLists[i], row, col, 1).board;
        if (refSolvable(after, rest, counter)) return true;
      }
    }
  }
  return false;
}

// 탐색이 한도를 넘으면 null(판정 보류)을 돌려준다.
function refSolvableOrNull(board, tray, limit) {
  const lists = tray.filter((piece) => piece !== null).map((piece) => cellsOf(piece.shapeId));
  try {
    return refSolvable(board, lists, { nodes: 0, limit });
  } catch (error) {
    if (error instanceof SearchBudgetExceeded) return null;
    throw error;
  }
}

/* ───────────── 차분 테스트 하니스 ───────────── */

function makeStats() {
  return {
    games: 0, moves: 0, invalid: 0, previews: 0, refills: 0, clears: 0, crossClears: 0,
    multiClears: 0, tripleClears: 0, quadClears: 0, perfects: 0, comboBreaks: 0, maxCombo: 0,
    capHits: 0, gameovers: 0, gameoversAtRefill: 0, midTrayGameovers: 0, solverChecked: 0,
    solverSkipped: 0, solverUnsolvable: 0, positions: 0,
  };
}

function recordStats(stats, ref) {
  stats.moves += 1;
  for (const event of ref.events) {
    if (event.type === 'clear') {
      stats.clears += 1;
      if (event.rows.length > 0 && event.cols.length > 0) stats.crossClears += 1;
      if (event.lines >= 2) stats.multiClears += 1;
      if (event.lines >= 3) stats.tripleClears += 1;
      if (event.lines >= 4) stats.quadClears += 1;
    } else if (event.type === 'combo') {
      stats.maxCombo = Math.max(stats.maxCombo, event.count);
      if (event.multiplier === MULTIPLIER_CAP) stats.capHits += 1;
    } else if (event.type === 'comboBreak') {
      stats.comboBreaks += 1;
    } else if (event.type === 'perfect') {
      stats.perfects += 1;
    } else if (event.type === 'trayRefill') {
      stats.refills += 1;
    } else if (event.type === 'gameover') {
      stats.gameovers += 1;
      if (ref.refilled) stats.gameoversAtRefill += 1;
      else stats.midTrayGameovers += 1;
    }
  }
}

function assertValidTray(tray, label) {
  assert.ok(Array.isArray(tray) && tray.length === TRAY_LEN, `${label}: tray must have ${TRAY_LEN} slots`);
  const colors = new Set();
  for (const piece of tray) {
    assert.ok(piece !== null && typeof piece === 'object', `${label}: refilled slot must hold a piece`);
    assert.deepEqual(Object.keys(piece).sort(), ['color', 'shapeId'], `${label}: piece keys`);
    assert.ok(core.hasShape(piece.shapeId), `${label}: unknown shape ${piece.shapeId}`);
    assert.ok(Number.isInteger(piece.color) && piece.color >= 1 && piece.color <= COLORS, `${label}: color range`);
    colors.add(piece.color);
  }
  assert.equal(colors.size, TRAY_LEN, `${label}: colors must be distinct within a tray`);
}

function assertStateEqual(actual, expected, label) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: state keys`);
  for (const key of Object.keys(expected)) {
    assert.deepEqual(actual[key], expected[key], `${label}: state.${key}`);
  }
}

function assertInitialState(state, mode, seed, label) {
  assertValidTray(state.tray, label);
  assert.ok(Number.isInteger(state.rngState) && state.rngState >= 0 && state.rngState <= 0xffffffff, `${label}: rngState`);
  assert.deepEqual(state, {
    version: 1, mode, seed, rngState: state.rngState, board: refEmptyBoard(), tray: state.tray,
    trayIndex: 0, score: 0, combo: 0, maxCombo: 0, lines: 0, moves: 0, perfects: 0, status: 'playing',
  }, `${label}: initial state`);
  if (mode === 'classic') {
    // 첫 트레이가 쓴 난수만큼 흐름이 전진한 상태로 저장되어야 첫 리필이 같은 난수를 재사용하지 않는다.
    const rng = core.createRng(seed);
    const first = core.generateTray({ board: refEmptyBoard(), rng, mode, seed, trayIndex: 0, score: 0 });
    assert.deepEqual(state.tray, first, `${label}: first classic tray must equal generateTray on an empty board`);
    assert.equal(state.rngState, rng.state(), `${label}: rngState must be the stream position after the first tray`);
  }
}

// 코어가 한 번 이동한 결과를 참조 모델과 모든 필드에서 비교한다.
function stepAndCompare(ctx, state, model, move) {
  const { trayIndex, row, col } = move;
  const label = `${ctx.label} after ${model.moves} moves, args (${trayIndex}, ${row}, ${col})`;
  const snapshot = JSON.stringify(state);
  const result = core.applyMove(state, trayIndex, row, col);
  assert.equal(JSON.stringify(state), snapshot, `${label}: applyMove mutated its input`);
  const ref = refStep(model, trayIndex, row, col, result.ok ? result.state.tray : null);
  assert.equal(result.ok, ref.ok, `${label}: ok mismatch (core error ${result.error}, reference error ${ref.error})`);

  if (!ref.ok) {
    assert.equal(result.error, ref.error, `${label}: error code`);
    assert.equal(result.state, state, `${label}: failed move must return the same state object`);
    assert.deepEqual(result.events, [], `${label}: failed move must have no events`);
    ctx.stats.invalid += 1;
    return { state, model };
  }

  if (ref.refilled) {
    assertValidTray(result.state.tray, label);
    assertRefillMatchesGenerator(state, result, label);
    if (model.mode === 'classic') {
      assert.equal(ref.model.status, 'playing', `${label}: classic refill must never end the game`);
      checkSolvability(ctx, result.state, label);
    }
  }
  assert.ok(Number.isInteger(result.state.rngState) && result.state.rngState >= 0
    && result.state.rngState <= 0xffffffff, `${label}: rngState must stay a uint32`);
  if (!(ref.refilled && model.mode === 'classic')) {
    assert.equal(result.state.rngState, model.rngState, `${label}: rngState moves only on a classic refill`);
  }
  ref.model.rngState = result.state.rngState;

  assertStateEqual(result.state, ref.model, label);
  assert.deepEqual(result.events, ref.events, `${label}: events`);
  assert.notEqual(result.state, state, `${label}: must return a new state`);
  const refillEvent = result.events.find((event) => event.type === 'trayRefill');
  if (refillEvent) {
    assert.notEqual(refillEvent.tray, result.state.tray, `${label}: trayRefill must carry a copy`);
  }
  recordStats(ctx.stats, ref);
  return { state: deepFreeze(result.state), model: ref.model };
}

// 가이드 7장: 클래식은 (후처리된 보드, 새 점수)로 뽑고, 데일리는 (seed, trayIndex)로만 정해진다.
function assertRefillMatchesGenerator(prev, result, label) {
  const next = result.state;
  if (prev.mode === 'classic') {
    const rng = core.createRng(prev.rngState);
    const regenerated = core.generateTray({
      board: deepFreeze(structuredClone(next.board)), rng, mode: 'classic', seed: prev.seed,
      trayIndex: prev.trayIndex + 1, score: next.score,
    });
    assert.deepEqual(next.tray, regenerated, `${label}: classic refill must equal generateTray on the cleared board`);
    assert.equal(next.rngState, rng.state(), `${label}: rngState must be the stream position after the refill`);
    return;
  }
  const rng = core.createRng(12345);
  const regenerated = core.generateTray({
    board: next.board, rng, mode: 'daily', seed: prev.seed, trayIndex: prev.trayIndex + 1, score: next.score,
  });
  assert.deepEqual(next.tray, regenerated, `${label}: daily refill must depend only on (seed, trayIndex)`);
  assert.equal(rng.state(), core.createRng(12345).state(), `${label}: daily generation must not consume the passed rng`);
}

function checkSolvability(ctx, state, label) {
  const verdict = refSolvableOrNull(state.board, state.tray, 60000);
  if (verdict === null) {
    ctx.stats.solverSkipped += 1;
    return;
  }
  ctx.stats.solverChecked += 1;
  if (verdict === false) {
    ctx.stats.solverUnsolvable += 1;
    ctx.unsolvable.push(label);
  }
}

function checkPreview(ctx, state, model, trayIndex, row, col) {
  const snapshot = JSON.stringify(state);
  const preview = core.previewMove(state, trayIndex, row, col);
  assert.equal(JSON.stringify(state), snapshot, 'previewMove mutated its input');
  const expected = refPreview(model, trayIndex, row, col);
  const label = `${ctx.label} preview (${trayIndex}, ${row}, ${col})`;
  if (expected.lenient) {
    assert.equal(preview.valid, false, label);
    assert.equal(preview.reason, expected.reason, label);
  } else {
    assert.deepEqual(preview, expected, label);
    assert.equal('reason' in preview, !expected.valid, `${label}: reason key only when invalid`);
  }
  const applied = core.applyMove(state, trayIndex, row, col);
  assert.equal(applied.ok, preview.valid, `${label}: preview.valid must agree with applyMove`);
  if (!applied.ok) assert.equal(applied.error, preview.reason, `${label}: reason must equal the applyMove error`);
  ctx.stats.previews += 1;
}

function checkMoveList(ctx, state, model) {
  assert.deepEqual(core.listMoves(state), refMoves(model), `${ctx.label}: listMoves must equal brute force`);
  assert.equal(core.isGameOver(state), model.status === 'over', `${ctx.label}: isGameOver`);
}

function checkSerialization(state, label) {
  const json = JSON.parse(JSON.stringify(state));
  assert.deepEqual(json, state, `${label}: state must be plain JSON`);
  const restored = core.restoreGame(json);
  assert.deepEqual(restored, state, `${label}: restoreGame(JSON roundtrip) must equal the state`);
  return restored;
}

function wildArgs(rand) {
  const pickNumber = (low, high) => {
    const roll = rand.next();
    if (roll < 0.03) return rand.pick([NaN, Infinity, -Infinity]);
    if (roll < 0.07) return low + rand.next() * (high - low);
    return low + rand.int(high - low + 1);
  };
  return { trayIndex: pickNumber(-1, 3), row: pickNumber(-3, 10), col: pickNumber(-3, 10) };
}

/* ───────────── 정책: 시드 게임용 ───────────── */

// 사방 중 3면 이상이 막힌 빈칸(작은 블록만 들어가는 틈)의 수
function refPockets(board) {
  let pockets = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0) continue;
      let blocked = 0;
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || board[nr][nc] !== 0) blocked += 1;
      }
      if (blocked >= 3) pockets += 1;
    }
  }
  return pockets;
}

function choosePolicyMove(policy, model, rand) {
  const moves = refMoves(model);
  if (policy === 'random' || rand.chance(policy === 'cleaner' ? 0.02 : 0.08)) return rand.pick(moves);
  const scored = moves.map((move) => {
    const piece = model.tray[move.trayIndex];
    const sim = refPlaceAndClear(model.board, cellsOf(piece.shapeId), move.row, move.col, piece.color);
    const lines = sim.rows.length + sim.cols.length;
    const tidy = policy === 'cleaner' ? -refCountFilled(sim.board) - 6 * refPockets(sim.board) : 0;
    return { move, sim, value: lines * 50 + tidy + rand.next() * 4 };
  }).sort((a, b) => b.value - a.value);
  if (policy !== 'cleaner') return scored[0].move;

  // 남은 블록이 갈 곳을 잃는 수는 크게 감점한다. 느려지지 않게 상위 후보만 검사한다.
  let best = null;
  let bestValue = -Infinity;
  for (const { move, sim, value } of scored.slice(0, 8)) {
    let adjusted = value;
    model.tray.forEach((other, slot) => {
      if (other !== null && slot !== move.trayIndex && !refCanPlaceAnywhere(sim.board, cellsOf(other.shapeId))) {
        adjusted -= 200;
      }
    });
    if (adjusted > bestValue) {
      bestValue = adjusted;
      best = move;
    }
  }
  return best;
}

function playGame(ctx, { mode, seed, policy, maxMoves, rand }) {
  let state = core.createGame({ mode, seed });
  assertInitialState(state, mode, seed, ctx.label);
  if (mode === 'daily') {
    const first = core.generateTray({ board: refEmptyBoard(), rng: core.createRng(1), mode: 'daily', seed, trayIndex: 0, score: 0 });
    assert.deepEqual(state.tray, first, `${ctx.label}: first daily tray must equal generateTray(seed, 0)`);
  }
  deepFreeze(state);
  let model = structuredClone(state);
  ctx.stats.games += 1;

  while (true) {
    checkMoveList(ctx, state, model);
    if (rand.chance(0.15)) checkSerialization(state, ctx.label);
    if (model.status === 'over') {
      for (let i = 0; i < 3; i++) stepAndCompare(ctx, state, model, wildArgs(rand));
      checkPreview(ctx, state, model, 0, 0, 0);
      break;
    }
    if (model.moves >= maxMoves) break;

    // 시도 중 유효한 수는 정책을 어지럽히므로 오라클이 무효로 보는 인자만 던진다(유효한 임의 수는 국면 테스트가 맡는다).
    if (rand.chance(0.35)) {
      for (let i = 1 + rand.int(3); i > 0; i--) {
        const attempt = wildArgs(rand);
        if (!refStep(model, attempt.trayIndex, attempt.row, attempt.col, null).ok) {
          stepAndCompare(ctx, state, model, attempt);
        }
      }
    }

    const move = choosePolicyMove(policy, model, rand);
    checkPreview(ctx, state, model, move.trayIndex, move.row, move.col);
    for (let i = 0; i < 2; i++) {
      const probe = wildArgs(rand);
      checkPreview(ctx, state, model, probe.trayIndex, probe.row, probe.col);
    }
    ({ state, model } = stepAndCompare(ctx, state, model, move));

    // 저장/복원은 흐름을 바꾸면 안 되므로, 가끔 복원본으로 갈아 끼워 계속 진행한다.
    if (rand.chance(0.1)) state = deepFreeze(checkSerialization(state, ctx.label));
  }
  return model;
}

/* ───────────── 임의 국면 생성 ───────────── */

function breakFullLines(rand, board) {
  while (true) {
    const { rows, cols } = refFullLines(board);
    if (rows.length + cols.length === 0) return;
    for (const r of rows) board[r][rand.int(SIZE)] = 0;
    for (const c of cols) board[rand.int(SIZE)][c] = 0;
  }
}

function randomPiece(rand) {
  return { shapeId: rand.pick(SHAPE_IDS), color: 1 + rand.int(COLORS) };
}

function craftState(rand, mode, board, tray) {
  const combo = rand.int(12);
  return {
    version: 1,
    mode,
    seed: mode === 'daily' ? `2026-${1 + rand.int(12)}-${1 + rand.int(28)}` : rand.int(1000000),
    rngState: rand.int(4294967296),
    board,
    tray,
    trayIndex: rand.int(40),
    score: rand.int(8000),
    combo,
    maxCombo: combo + rand.int(5),
    lines: rand.int(500),
    moves: rand.int(900),
    perfects: rand.int(5),
    status: refHasMove(board, tray) ? 'playing' : 'over',
  };
}

function randomTray(rand, nullChance) {
  const tray = [];
  for (let i = 0; i < TRAY_LEN; i++) tray.push(rand.chance(nullChance) ? null : randomPiece(rand));
  if (tray.every((slot) => slot === null)) tray[rand.int(TRAY_LEN)] = randomPiece(rand);
  return tray;
}

function randomPosition(rand, mode) {
  const board = refEmptyBoard();
  const fill = rand.pick([0.1, 0.35, 0.55, 0.75]);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (rand.chance(fill)) board[r][c] = 1 + rand.int(COLORS);
  }
  // 거의 찬 줄을 만들어 줄 제거가 자주 일어나게 한다.
  const lineCount = rand.int(4);
  for (let i = 0; i < lineCount; i++) {
    const isRow = rand.chance(0.5);
    const index = rand.int(SIZE);
    for (let k = 0; k < SIZE; k++) {
      if (isRow) board[index][k] = 1 + rand.int(COLORS);
      else board[k][index] = 1 + rand.int(COLORS);
    }
    const holes = 1 + rand.int(2);
    for (let h = 0; h < holes; h++) {
      const k = rand.int(SIZE);
      if (isRow) board[index][k] = 0;
      else board[k][index] = 0;
    }
  }
  breakFullLines(rand, board);
  return { state: craftState(rand, mode, board, randomTray(rand, 0.4)), target: null };
}

// 한 모양이 정확히 몇 개의 줄을 완성하도록 보드를 거꾸로 만든다(교차/다중/퍼펙트 클리어용).
function constructivePosition(rand, mode) {
  const shapeId = rand.pick(SHAPE_IDS);
  const shape = core.getShape(shapeId);
  const row = rand.int(SIZE - shape.height + 1);
  const col = rand.int(SIZE - shape.width + 1);
  const footprint = refAbs(shape.cells, row, col);
  const isPiece = (r, c) => footprint.some(([fr, fc]) => fr === r && fc === c);

  const board = refEmptyBoard();
  const candidates = [];
  for (const r of new Set(footprint.map(([fr]) => fr))) candidates.push({ isRow: true, index: r });
  for (const c of new Set(footprint.map(([, fc]) => fc))) candidates.push({ isRow: false, index: c });
  const chosen = candidates.filter(() => rand.chance(0.7));
  for (const { isRow, index } of chosen) {
    for (let k = 0; k < SIZE; k++) {
      const [r, c] = isRow ? [index, k] : [k, index];
      if (!isPiece(r, c)) board[r][c] = 1 + rand.int(COLORS);
    }
  }
  const noise = rand.pick([0, 0, 0.1, 0.4]);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!isPiece(r, c) && rand.chance(noise)) board[r][c] = 1 + rand.int(COLORS);
    }
  }
  breakFullLines(rand, board);

  const tray = [];
  for (let i = 0; i < TRAY_LEN; i++) tray.push(rand.chance(0.5) ? null : randomPiece(rand));
  const slot = rand.int(TRAY_LEN);
  tray[slot] = { shapeId, color: 1 + rand.int(COLORS) };
  return { state: craftState(rand, mode, board, tray), target: { trayIndex: slot, row, col } };
}

function checkPosition(ctx, position, rand) {
  const state = deepFreeze(position.state);
  const model = structuredClone(state);
  ctx.stats.positions += 1;
  checkMoveList(ctx, state, model);
  checkSerialization(state, ctx.label);
  const moves = refMoves(model);
  const picks = position.target ? [position.target] : [];
  for (let i = 0; i < 10 && moves.length > 0; i++) picks.push(rand.pick(moves));
  for (const move of picks) {
    checkPreview(ctx, state, model, move.trayIndex, move.row, move.col);
    stepAndCompare(ctx, state, model, move);
  }
  for (let i = 0; i < 6; i++) {
    const probe = wildArgs(rand);
    checkPreview(ctx, state, model, probe.trayIndex, probe.row, probe.col);
    stepAndCompare(ctx, state, model, probe);
  }
}

function newCtx(label) {
  return { label, stats: makeStats(), unsolvable: [] };
}

/* ───────────── 시나리오 보조 ───────────── */

function craft(overrides = {}) {
  const base = core.createGame({ mode: overrides.mode ?? 'classic', seed: overrides.seed ?? 7 });
  return deepFreeze({ ...structuredClone(base), ...overrides });
}

function run(ctx, state, trayIndex, row, col) {
  const model = structuredClone(state);
  const out = stepAndCompare(ctx, state, model, { trayIndex, row, col });
  const result = core.applyMove(state, trayIndex, row, col);
  return { result, ...out };
}

const eventTypes = (events) => events.map((event) => event.type);
const trayPiece = (shapeId, color = 3) => ({ shapeId, color });

/* ═════════════════════════ 테스트 ═════════════════════════ */

describe('규칙 상수와 모양 카탈로그', () => {
  test('config 상수는 가이드와 같다', () => {
    assert.equal(BOARD_SIZE, SIZE);
    assert.equal(TRAY_SIZE, TRAY_LEN);
    assert.equal(COLOR_COUNT, COLORS);
  });

  const FIXED_SHAPES = {
    dot: ['X'],
    h2: ['XX'], h3: ['XXX'], h4: ['XXXX'], h5: ['XXXXX'],
    v2: ['X', 'X'], v3: ['X', 'X', 'X'], v4: ['X', 'X', 'X', 'X'], v5: ['X', 'X', 'X', 'X', 'X'],
    sq2: ['XX', 'XX'], sq3: ['XXX', 'XXX', 'XXX'],
    r2x3: ['XXX', 'XXX'], r3x2: ['XX', 'XX', 'XX'],
    'l3-tl': ['XX', 'X.'], 'l3-tr': ['XX', '.X'], 'l3-bl': ['X.', 'XX'], 'l3-br': ['.X', 'XX'],
    'l5-tl': ['XXX', 'X..', 'X..'], 'l5-tr': ['XXX', '..X', '..X'],
    'l5-bl': ['X..', 'X..', 'XXX'], 'l5-br': ['..X', '..X', 'XXX'],
    's-h': ['.XX', 'XX.'], 's-v': ['X.', 'XX', '.X'], 'z-h': ['XX.', '.XX'], 'z-v': ['.X', 'XX', 'X.'],
  };
  const ROTATING = { 'l4': ['X.', 'X.', 'XX'], 'j4': ['.X', '.X', 'XX'], 't': ['XXX', '.X.'] };

  function cellsFromPicture(picture) {
    const out = [];
    picture.forEach((line, r) => [...line].forEach((ch, c) => { if (ch === 'X') out.push([r, c]); }));
    return out;
  }

  // 시계 방향 90도 회전 후 (0,0) 기준으로 정규화
  function rotateClockwise(cells) {
    const height = Math.max(...cells.map(([r]) => r)) + 1;
    const turned = cells.map(([r, c]) => [c, height - 1 - r]);
    const minR = Math.min(...turned.map(([r]) => r));
    const minC = Math.min(...turned.map(([, c]) => c));
    return turned.map(([r, c]) => [r - minR, c - minC]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  test('37종이고 id가 유일하며 SHAPES와 SHAPE_LIST가 일치한다', () => {
    assert.equal(core.SHAPE_LIST.length, SHAPE_COUNT);
    assert.equal(new Set(SHAPE_IDS).size, SHAPE_COUNT);
    for (const shape of core.SHAPE_LIST) {
      assert.equal(core.SHAPES[shape.id], shape);
      assert.equal(core.getShape(shape.id), shape);
      assert.equal(core.hasShape(shape.id), true);
    }
    assert.equal(core.hasShape('nope'), false);
    assert.throws(() => core.getShape('nope'));
  });

  test('분류별 개수가 가이드 5.3과 같다', () => {
    const counts = {};
    for (const shape of core.SHAPE_LIST) counts[shape.family] = (counts[shape.family] ?? 0) + 1;
    assert.deepEqual(counts, { dot: 1, line: 8, square: 2, rect: 2, smallL: 4, bigL: 4, lTetro: 8, tee: 4, skew: 4 });
  });

  test('모든 모양은 정규화되어 있고 동결되어 있으며 한 덩어리다', () => {
    for (const shape of core.SHAPE_LIST) {
      assert.ok(Object.isFrozen(shape) && Object.isFrozen(shape.cells), `${shape.id} frozen`);
      const cells = shape.cells.map(([r, c]) => [r, c]);
      assert.equal(shape.size, cells.length);
      assert.equal(Math.min(...cells.map(([r]) => r)), 0);
      assert.equal(Math.min(...cells.map(([, c]) => c)), 0);
      assert.equal(shape.height, Math.max(...cells.map(([r]) => r)) + 1);
      assert.equal(shape.width, Math.max(...cells.map(([, c]) => c)) + 1);
      const sorted = cells.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      assert.deepEqual(cells, sorted, `${shape.id} row-major order`);
      assert.equal(new Set(cells.map(([r, c]) => `${r},${c}`)).size, cells.length, `${shape.id} unique cells`);
      const seen = new Set([`${cells[0][0]},${cells[0][1]}`]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [r, c] of cells) {
          const key = `${r},${c}`;
          if (seen.has(key)) continue;
          if ([[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].some(([nr, nc]) => seen.has(`${nr},${nc}`))) {
            seen.add(key);
            grew = true;
          }
        }
      }
      assert.equal(seen.size, cells.length, `${shape.id} must be 4-connected`);
    }
  });

  test('고정 방향 모양은 그림과 정확히 같다', () => {
    for (const [id, picture] of Object.entries(FIXED_SHAPES)) {
      assert.deepEqual(core.getShape(id).cells.map(([r, c]) => [r, c]), cellsFromPicture(picture), id);
    }
  });

  test('L/J/T는 시계 방향 90도씩 도는 4방향 전체다', () => {
    for (const [prefix, picture] of Object.entries(ROTATING)) {
      let expected = cellsFromPicture(picture);
      const rotations = [];
      for (let i = 0; i < 4; i++) {
        rotations.push(expected);
        expected = rotateClockwise(expected);
      }
      const keys = rotations.map((cells) => JSON.stringify(cells));
      assert.equal(new Set(keys).size, 4, `${prefix} has 4 distinct orientations`);
      const actual = [0, 1, 2, 3].map((n) => JSON.stringify(core.getShape(`${prefix}-${n}`).cells.map(([r, c]) => [r, c])));
      assert.deepEqual([...actual].sort(), [...keys].sort(), `${prefix} orientation set`);
      for (let n = 0; n < 4; n++) {
        const turned = JSON.stringify(rotateClockwise(JSON.parse(actual[n])));
        assert.equal(turned, actual[(n + 1) % 4], `${prefix}-${n} rotates clockwise into ${prefix}-${(n + 1) % 4}`);
      }
    }
  });

  test('카탈로그 id는 문서화된 37종과 정확히 같다', () => {
    const expected = [...Object.keys(FIXED_SHAPES)];
    for (const prefix of Object.keys(ROTATING)) for (let n = 0; n < 4; n++) expected.push(`${prefix}-${n}`);
    assert.deepEqual([...SHAPE_IDS].sort(), expected.sort());
  });
});

describe('rng: 가이드 6.4의 참조 구현과 비교', () => {
  function guideHashSeed(str) {
    let h = 2166136261;
    for (const ch of str) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function guideMulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test('hashSeed와 mulberry32는 가이드 코드와 같은 값을 낸다', () => {
    for (const text of ['', 'a', '2026-10-04', '2026-10-04:7', '성모', '😀x', 'seongmo-blockblast']) {
      assert.equal(core.hashSeed(text), guideHashSeed(text), text);
    }
    for (const seed of [0, 1, 42, 123456, 0xffffffff, 2166136261]) {
      const ours = core.mulberry32(seed);
      const guide = guideMulberry32(seed);
      for (let i = 0; i < 200; i++) assert.equal(ours(), guide());
    }
  });

  test('createRng는 상태 하나로 같은 흐름을 이어간다', () => {
    const rng = core.createRng(2026);
    for (let i = 0; i < 17; i++) rng.next();
    const resumed = core.createRng(rng.state());
    for (let i = 0; i < 50; i++) assert.equal(resumed.next(), rng.next());
  });
});

describe('generator: 가이드 7.1의 가중치 방향', () => {
  const BIG = ['sq3', 'h5', 'v5', 'l5-tl', 'l5-tr', 'l5-bl', 'l5-br'];
  const SMALL = ['dot', 'h2', 'v2', 'l3-tl', 'l3-tr', 'l3-bl', 'l3-br'];
  const HARD = ['s-h', 's-v', 'z-h', 'z-v', 'l5-tl', 'l5-tr', 'l5-bl', 'l5-br'];

  function boardWithFill(filled) {
    const board = refEmptyBoard();
    // 줄이 완성되지 않도록 마지막 열은 비워 둔다
    for (let i = 0; i < filled; i++) board[Math.floor(i / 7)][i % 7] = 1;
    return board;
  }

  const weightOf = (weights, id) => weights[SHAPE_IDS.indexOf(id)];

  test('SHAPE_LIST와 같은 순서이고 모든 가중치가 양수다', () => {
    for (const fill of [0, 10, 25, 40, 49]) {
      for (const score of [0, 999, 1000, 3000, 6000, 100000]) {
        const weights = core.weightsFor(boardWithFill(fill), score);
        assert.equal(weights.length, SHAPE_COUNT);
        assert.ok(weights.every((w) => Number.isFinite(w) && w > 0));
      }
    }
  });

  test('여유 있는 보드(fill < 0.3)는 큰 블록을, 빡빡한 보드(fill > 0.6)는 작은 블록을 상대적으로 키운다', () => {
    // 채움 비율 0, 28/64(≈0.44), 45/64(≈0.70)
    const roomy = core.weightsFor(boardWithFill(0), 0);
    const middle = core.weightsFor(boardWithFill(28), 0);
    const tight = core.weightsFor(boardWithFill(45), 0);
    for (const id of BIG) {
      assert.ok(weightOf(roomy, id) > weightOf(middle, id), `${id} must grow on a roomy board`);
      assert.ok(weightOf(tight, id) < weightOf(middle, id), `${id} must shrink on a tight board`);
    }
    for (const id of SMALL) {
      assert.ok(weightOf(tight, id) > weightOf(middle, id), `${id} must grow on a tight board`);
      assert.ok(weightOf(roomy, id) <= weightOf(middle, id), `${id} must not grow on a roomy board`);
    }
  });

  test('점수 구간이 높을수록 S/Z와 큰 L만 커진다', () => {
    const board = boardWithFill(28);
    const tiers = [0, 1000, 3000, 6000].map((score) => core.weightsFor(board, score));
    for (const id of SHAPE_IDS) {
      for (let i = 1; i < tiers.length; i++) {
        if (HARD.includes(id)) assert.ok(weightOf(tiers[i], id) > weightOf(tiers[i - 1], id), `${id} tier ${i}`);
        else assert.equal(weightOf(tiers[i], id), weightOf(tiers[0], id), `${id} tier ${i} must be unchanged`);
      }
    }
  });
});

describe('scoring: 규칙 공식과 전수 비교', () => {
  test('scoreMove는 공식과 같고 nextCombo는 +1/0이다', () => {
    for (const placedCells of [1, 2, 4, 5, 9]) {
      for (let linesCleared = 0; linesCleared <= 10; linesCleared++) {
        for (let combo = 0; combo <= 16; combo++) {
          for (const perfect of [false, true]) {
            const multiplier = Math.min(MULTIPLIER_CAP, 1 + COMBO_STEP * Math.max(0, combo - 1));
            const place = placedCells * CELL_POINT;
            const clear = Math.round(LINE_BASE * linesCleared * linesCleared * multiplier);
            const bonus = perfect ? PERFECT_BONUS : 0;
            const label = JSON.stringify({ placedCells, linesCleared, combo, perfect });
            assert.deepEqual(
              core.scoreMove({ placedCells, linesCleared, combo, perfect }),
              { total: place + clear + bonus, place, clear, perfect: bonus, multiplier },
              label,
            );
          }
        }
      }
    }
    for (let prev = 0; prev < 20; prev++) {
      assert.equal(core.nextCombo(prev, 0), 0);
      for (let lines = 1; lines <= 4; lines++) assert.equal(core.nextCombo(prev, lines), prev + 1);
    }
  });

  test('여러 줄 동시 제거가 줄을 따로 지우는 것보다 항상 크다 (L² 항)', () => {
    for (let lines = 2; lines <= 6; lines++) {
      const together = core.scoreMove({ placedCells: 1, linesCleared: lines, combo: 1, perfect: false }).clear;
      const separate = lines * core.scoreMove({ placedCells: 1, linesCleared: 1, combo: 1, perfect: false }).clear;
      assert.ok(together > separate, `L=${lines}`);
    }
  });
});

describe('board: 참조 구현과 임의 보드 비교', () => {
  function randomBoard(rand) {
    const board = refEmptyBoard();
    const fill = rand.pick([0.1, 0.3, 0.5, 0.7, 0.85]);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) if (rand.chance(fill)) board[r][c] = 1 + rand.int(COLORS);
    }
    return board;
  }

  test('canPlace/placeShape/listPlacements/canPlaceAnywhere/hasAnyMove', () => {
    const rand = makeRand(101);
    for (let round = 0; round < 120; round++) {
      const board = deepFreeze(randomBoard(rand));
      for (const shape of core.SHAPE_LIST) {
        const placements = [];
        for (let row = -2; row < SIZE + 2; row++) {
          for (let col = -2; col < SIZE + 2; col++) {
            const fits = refProblem(board, shape.cells, row, col) === null;
            assert.equal(core.canPlace(board, shape, row, col), fits, `${shape.id} (${row},${col})`);
            if (fits && row >= 0 && col >= 0) placements.push([row, col]);
            if (fits && round % 10 === 0) {
              const color = 1 + rand.int(COLORS);
              const expected = refCopy(board);
              for (const [r, c] of refAbs(shape.cells, row, col)) expected[r][c] = color;
              assert.deepEqual(core.placeShape(board, shape, row, col, color), expected);
            } else if (!fits && round % 10 === 0) {
              assert.throws(() => core.placeShape(board, shape, row, col, 1), RangeError);
            }
          }
        }
        assert.deepEqual(core.listPlacements(board, shape), placements, `${shape.id} listPlacements`);
        assert.equal(core.canPlaceAnywhere(board, shape), placements.length > 0);
      }
      const tray = [trayPiece(rand.pick(SHAPE_IDS)), null, trayPiece(rand.pick(SHAPE_IDS))];
      assert.equal(core.hasAnyMove(board, tray.map((p) => (p ? core.getShape(p.shapeId) : null))), refHasMove(board, tray));
      assert.equal(core.hasAnyMove(board, [null, null, null]), false);
    }
  });

  test('정수가 아닌 좌표와 잘못된 색 번호는 거부한다', () => {
    const board = refEmptyBoard();
    const dot = core.getShape('dot');
    for (const bad of [0.5, NaN, Infinity, '1', null, undefined]) {
      assert.equal(core.canPlace(board, dot, bad, 0), false);
      assert.equal(core.canPlace(board, dot, 0, bad), false);
    }
    for (const color of [0, 8, -1, 1.5, NaN, '3']) {
      assert.throws(() => core.placeShape(board, dot, 0, 0, color), RangeError, String(color));
    }
  });

  test('findFullLines/clearLines/countFilled/isBoardEmpty', () => {
    const rand = makeRand(202);
    for (let round = 0; round < 600; round++) {
      const board = randomBoard(rand);
      for (let i = rand.int(4); i > 0; i--) {
        const isRow = rand.chance(0.5);
        const index = rand.int(SIZE);
        for (let k = 0; k < SIZE; k++) {
          if (isRow) board[index][k] = 1 + rand.int(COLORS);
          else board[k][index] = 1 + rand.int(COLORS);
        }
      }
      deepFreeze(board);
      const lines = refFullLines(board);
      assert.deepEqual(core.findFullLines(board), lines);
      const cleared = [];
      const expected = refCopy(board);
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (lines.rows.includes(r) || lines.cols.includes(c)) {
            cleared.push({ r, c, color: board[r][c] });
            expected[r][c] = 0;
          }
        }
      }
      assert.deepEqual(core.clearLines(board, lines), { board: expected, clearedCells: cleared });
      assert.equal(core.countFilled(board), refCountFilled(board));
      assert.equal(core.isBoardEmpty(board), refCountFilled(board) === 0);
    }
    assert.equal(core.isBoardEmpty(core.createBoard()), true);
    assert.deepEqual(core.createBoard(), refEmptyBoard());
    const original = deepFreeze(boardFromRows(['1.......', '........', '........', '........', '........', '........', '........', '........']));
    const copy = core.cloneBoard(original);
    assert.deepEqual(copy, original);
    assert.notEqual(copy, original);
    assert.notEqual(copy[0], original[0]);
  });
});

describe('isTraySolvable: 완전 탐색 참조와 비교', () => {
  test('충분한 예산이면 참조 탐색과 항상 같은 답을 낸다', () => {
    const rand = makeRand(303);
    let compared = 0;
    let solvable = 0;
    for (let round = 0; round < 400; round++) {
      const board = refEmptyBoard();
      const fill = rand.pick([0.25, 0.45, 0.6, 0.7, 0.8]);
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) if (rand.chance(fill)) board[r][c] = 1 + rand.int(COLORS);
      }
      breakFullLines(rand, board);
      const tray = [randomPiece(rand), randomPiece(rand), randomPiece(rand)];
      if (rand.chance(0.2)) tray[rand.int(TRAY_LEN)] = null;
      const expected = refSolvableOrNull(board, tray, 150000);
      if (expected === null) continue;
      compared += 1;
      if (expected) solvable += 1;
      deepFreeze(board);
      assert.equal(core.isTraySolvable(board, tray, 50000000), expected, `round ${round}`);
    }
    assert.ok(compared >= 300, `compared only ${compared}`);
    assert.ok(solvable > 40 && solvable < compared - 40, `answer mix ${solvable}/${compared}`);
    assert.equal(core.isTraySolvable(refEmptyBoard(), [null, null, null]), true);
  });

  test('노드 예산을 다 쓰면 해결 가능으로 간주하고, 예산이 늘수록 답이 true에서 false로만 바뀐다', () => {
    const rand = makeRand(404);
    let unsolvableChecked = 0;
    for (let round = 0; round < 300 && unsolvableChecked < 25; round++) {
      const board = refEmptyBoard();
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) if (rand.chance(0.7)) board[r][c] = 1 + rand.int(COLORS);
      }
      breakFullLines(rand, board);
      const tray = [randomPiece(rand), randomPiece(rand), randomPiece(rand)];
      const exact = refSolvableOrNull(board, tray, 150000);
      if (exact === null) continue;
      const answers = [0, 1, 2, 3, 5, 10, 50, 200, 1000, 5000, 50000000].map((budget) => core.isTraySolvable(board, tray, budget));
      assert.equal(answers.at(-1), exact, `round ${round}: a huge budget must give the exact answer`);
      assert.equal(answers[0], true, `round ${round}: a zero budget is exhausted immediately`);
      for (let i = 1; i < answers.length; i++) {
        assert.ok(!(answers[i] === true && answers[i - 1] === false), `round ${round}: answers must not flip back to true`);
      }
      if (!exact) unsolvableChecked += 1;
    }
    assert.ok(unsolvableChecked >= 15, `only ${unsolvableChecked} unsolvable cases`);
  });
});

describe('시나리오: 규칙 하나씩 손으로 만든 국면', () => {
  test('교차 줄 제거: 행과 열이 한 칸을 공유해도 둘 다 지워진다', () => {
    const ctx = newCtx('cross');
    const board = refEmptyBoard();
    for (let k = 0; k < SIZE; k++) {
      if (k !== 3) {
        board[3][k] = (k % COLORS) + 1;
        board[k][3] = ((k + 3) % COLORS) + 1;
      }
    }
    board[7][0] = 2;
    const state = craft({ board, tray: [trayPiece('dot', 5), null, null] });
    const { result } = run(ctx, state, 0, 3, 3);
    assert.equal(result.ok, true);
    const clear = result.events.find((event) => event.type === 'clear');
    assert.deepEqual(clear.rows, [3]);
    assert.deepEqual(clear.cols, [3]);
    assert.equal(clear.lines, 2);
    assert.equal(clear.cells.length, 15, '교차 칸은 한 번만 센다');
    assert.deepEqual(clear.cells.map(({ r, c }) => [r, c]), [
      [0, 3], [1, 3], [2, 3], [3, 0], [3, 1], [3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [3, 7], [4, 3], [5, 3], [6, 3], [7, 3],
    ]);
    assert.equal(clear.cells.find(({ r, c }) => r === 3 && c === 3).color, 5, '교차 칸의 색은 방금 놓은 블록');
    assert.equal(result.state.score, 1 + 40);
    assert.equal(result.state.lines, 2);
    assert.equal(result.state.board[7][0], 2, '줄 밖의 칸은 그대로');
    assert.equal(core.countFilled(result.state.board), 1);
  });

  test('이중/삼중/사중/오중 동시 제거 점수', () => {
    const ctx = newCtx('multi');
    const cases = [
      { shape: 'sq2', lines: 2, expected: 4 + 40 },
      { shape: 'v3', lines: 3, expected: 3 + 90 },
      { shape: 'v4', lines: 4, expected: 4 + 160 },
      { shape: 'v5', lines: 5, expected: 5 + 250 },
    ];
    for (const { shape, lines, expected } of cases) {
      const board = refEmptyBoard();
      for (let r = 0; r < lines; r++) for (let c = 1; c < SIZE; c++) board[r][c] = 2;
      if (shape === 'sq2') for (let r = 0; r < 2; r++) board[r][1] = 0;
      board[7][7] = 4; // 퍼펙트 보너스가 섞이지 않도록 남겨 두는 칸
      const state = craft({ board, tray: [trayPiece(shape), null, null] });
      const { result } = run(ctx, state, 0, 0, 0);
      assert.equal(result.state.score, expected, shape);
      const clear = result.events.find((event) => event.type === 'clear');
      assert.equal(clear.lines, lines, shape);
      assert.deepEqual(clear.rows, Array.from({ length: lines }, (_, i) => i));
    }
  });

  test('퍼펙트 클리어: 줄을 지워 보드가 비면 +300', () => {
    const ctx = newCtx('perfect');
    const board = refEmptyBoard();
    for (let c = 0; c < 7; c++) board[0][c] = 4;
    const state = craft({ board, tray: [trayPiece('dot'), trayPiece('h2', 2), null] });
    const { result } = run(ctx, state, 0, 0, 7);
    assert.deepEqual(eventTypes(result.events), ['place', 'clear', 'combo', 'perfect', 'score']);
    assert.deepEqual(result.events.find((e) => e.type === 'perfect'), { type: 'perfect', bonus: 300 });
    assert.equal(result.state.score, 1 + 10 + 300);
    assert.equal(result.state.perfects, 1);
    assert.equal(core.isBoardEmpty(result.state.board), true);
    assert.deepEqual(result.events.at(-1).breakdown, { place: 1, clear: 10, perfect: 300 });
  });

  test('퍼펙트 클리어에도 콤보 배율이 붙는다', () => {
    const ctx = newCtx('perfect-combo');
    const board = refEmptyBoard();
    for (let c = 0; c < 7; c++) board[0][c] = 4;
    const state = craft({ board, tray: [trayPiece('dot'), trayPiece('h2', 2), null], combo: 1, maxCombo: 1 });
    const { result } = run(ctx, state, 0, 0, 7);
    assert.equal(result.state.score, 1 + 15 + 300);
  });

  test('줄을 못 지운 이동에서는 보드가 비어 있어도 퍼펙트가 아니다', () => {
    const ctx = newCtx('no-perfect');
    const state = craft({ tray: [trayPiece('dot'), null, null] });
    const { result } = run(ctx, state, 0, 4, 4);
    assert.ok(!eventTypes(result.events).includes('perfect'));
    assert.equal(result.state.perfects, 0);
  });

  test('콤보: 연속 +1, 못 지우면 0으로 초기화(comboBreak), 배율 상한 5', () => {
    const ctx = newCtx('combo');
    const board = refEmptyBoard();
    for (const r of [0, 1]) for (let c = 0; c < 7; c++) board[r][c] = 2;
    board[6][6] = 6;
    const start = craft({ board, tray: [trayPiece('dot', 1), trayPiece('dot', 2), trayPiece('dot', 3)] });

    const first = run(ctx, start, 0, 0, 7);
    assert.deepEqual(first.result.events.find((e) => e.type === 'combo'), { type: 'combo', count: 1, multiplier: 1 });
    assert.equal(first.result.state.score, 1 + 10);

    const second = run(ctx, first.state, 1, 1, 7);
    assert.deepEqual(second.result.events.find((e) => e.type === 'combo'), { type: 'combo', count: 2, multiplier: 1.5 });
    assert.equal(second.result.state.score, 11 + 1 + 15);
    assert.equal(second.result.state.combo, 2);

    const third = run(ctx, second.state, 2, 7, 0);
    assert.deepEqual(third.result.events.find((e) => e.type === 'comboBreak'), { type: 'comboBreak', previous: 2 });
    assert.equal(third.result.state.combo, 0);
    assert.equal(third.result.state.maxCombo, 2, 'maxCombo는 끊겨도 유지');
    assert.deepEqual(eventTypes(third.result.events).slice(0, 2), ['place', 'comboBreak']);
    assert.ok(eventTypes(third.result.events).includes('trayRefill'));
    assert.equal(third.result.state.trayIndex, 1);

    const restart = craft({ board, tray: [trayPiece('dot'), null, null], combo: 0, maxCombo: 2 });
    const again = run(ctx, restart, 0, 0, 7);
    assert.deepEqual(again.result.events.find((e) => e.type === 'combo'), { type: 'combo', count: 1, multiplier: 1 });
    assert.equal(again.result.state.maxCombo, 2);
  });

  test('콤보 배율은 5에서 멈춘다', () => {
    const ctx = newCtx('cap');
    const board = refEmptyBoard();
    for (let c = 0; c < 7; c++) board[0][c] = 2;
    board[5][5] = 1;
    const expectations = [[0, 11], [1, 16], [2, 21], [4, 31], [7, 46], [8, 51], [9, 51], [10, 51], [30, 51]];
    for (const [before, score] of expectations) {
      const state = craft({ board, tray: [trayPiece('dot'), null, null], combo: before, maxCombo: before });
      const { result } = run(ctx, state, 0, 0, 7);
      assert.equal(result.state.score, score, `combo ${before} -> ${before + 1}`);
      assert.equal(result.state.combo, before + 1);
    }
  });

  test('마지막 블록을 놓았고 리필된 블록이 하나도 안 들어가면 리필 상태로 게임오버', () => {
    const ctx = newCtx('refill-gameover');
    const checker = refEmptyBoard();
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if ((r + c) % 2 === 0) checker[r][c] = 1;
    let seed = 0;
    while (core.generateTray({ board: checker, rng: core.createRng(1), mode: 'daily', seed: `s${seed}`, trayIndex: 1 })
      .some((p) => p.shapeId === 'dot')) seed += 1;
    const state = craft({ mode: 'daily', seed: `s${seed}`, board: checker, tray: [null, null, trayPiece('dot')] });
    const { result } = run(ctx, state, 2, 0, 1);
    assert.equal(result.ok, true);
    assert.deepEqual(eventTypes(result.events), ['place', 'score', 'trayRefill', 'gameover']);
    assert.equal(result.state.status, 'over');
    assert.equal(result.state.trayIndex, 1);
    assertValidTray(result.state.tray, 'refill-gameover');
    assert.deepEqual(result.events[2].tray, result.state.tray);
    assert.deepEqual(result.events[3], { type: 'gameover', score: 1, stats: { lines: 0, maxCombo: 0, moves: 1, perfects: 0 } });
    assert.deepEqual(core.listMoves(result.state), []);
    assert.equal(core.isGameOver(result.state), true);
    assert.equal(core.applyMove(result.state, 0, 0, 0).error, 'game_over');
    assert.equal(core.previewMove(result.state, 0, 0, 0).reason, 'game_over');
  });

  test('반대로 리필된 블록이 들어가면 게임오버가 아니다', () => {
    const ctx = newCtx('refill-alive');
    const checker = refEmptyBoard();
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if ((r + c) % 2 === 0) checker[r][c] = 1;
    let seed = 0;
    while (!core.generateTray({ board: checker, rng: core.createRng(1), mode: 'daily', seed: `s${seed}`, trayIndex: 1 })
      .some((p) => p.shapeId === 'dot')) seed += 1;
    const state = craft({ mode: 'daily', seed: `s${seed}`, board: checker, tray: [null, null, trayPiece('dot')] });
    const { result } = run(ctx, state, 2, 0, 1);
    assert.deepEqual(eventTypes(result.events), ['place', 'score', 'trayRefill']);
    assert.equal(result.state.status, 'playing');
  });

  test('트레이 중간에 남은 블록이 못 들어가면 리필 없이 게임오버', () => {
    const ctx = newCtx('mid-gameover');
    const checker = refEmptyBoard();
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if ((r + c) % 2 === 0) checker[r][c] = 1;
    for (const mode of ['classic', 'daily']) {
      const state = craft({ mode, board: checker, tray: [trayPiece('dot'), trayPiece('h2'), null] });
      const { result } = run(ctx, state, 0, 0, 1);
      assert.deepEqual(eventTypes(result.events), ['place', 'score', 'gameover'], mode);
      assert.equal(result.state.status, 'over');
      assert.deepEqual(result.state.tray, [null, trayPiece('h2'), null]);
      assert.equal(result.state.trayIndex, 0);
    }
    const alive = craft({ board: checker, tray: [trayPiece('dot'), trayPiece('dot', 4), null] });
    assert.equal(run(ctx, alive, 0, 0, 1).result.state.status, 'playing');
  });

  test('줄을 지워서 남은 블록이 들어가게 되면 게임오버가 아니다', () => {
    const ctx = newCtx('clear-saves');
    const board = refEmptyBoard();
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if ((r + c) % 2 === 0) board[r][c] = 1;
    for (let c = 0; c < 7; c++) board[0][c] = 2;
    const state = craft({ board, tray: [trayPiece('dot'), trayPiece('h2'), null] });
    const saved = run(ctx, state, 0, 0, 7).result;
    assert.deepEqual(eventTypes(saved.events), ['place', 'clear', 'combo', 'score']);
    assert.equal(saved.state.status, 'playing', '0행이 비워져서 h2가 들어간다');
    const doomed = run(ctx, state, 0, 1, 0).result;
    assert.deepEqual(eventTypes(doomed.events), ['place', 'score', 'gameover']);
  });

  test('실패한 이동: 오류 코드와 검사 순서', () => {
    const ctx = newCtx('errors');
    const board = refEmptyBoard();
    board[2][2] = 5;
    board[4][0] = 6;
    board[5][7] = 6;
    const over = craft({ board, status: 'over', tray: [trayPiece('dot'), null, trayPiece('h3')] });
    const state = craft({ board, tray: [trayPiece('dot'), null, trayPiece('h3')] });
    const cases = [
      [state, 1, 0, 0, 'empty_slot'],
      [state, 0, 2, 2, 'overlap'],
      [state, 2, 2, 1, 'overlap'],
      [state, 2, 2, 0, 'overlap'],
      [state, 0, -1, 0, 'out_of_bounds'],
      [state, 0, 0, 8, 'out_of_bounds'],
      [state, 0, 8, 0, 'out_of_bounds'],
      [state, 2, 0, 6, 'out_of_bounds'],
      [state, 2, 2, 6, 'out_of_bounds'],
      [state, 2, 2, 7, 'out_of_bounds'],
      [state, 2, 4, -1, 'out_of_bounds'], // 일부는 밖이고 안쪽 칸은 겹쳐도 out_of_bounds가 우선
      [state, 2, 5, 6, 'out_of_bounds'],
      [state, 1, 99, 99, 'empty_slot'],
      [over, 0, 0, 0, 'game_over'],
      [over, 1, 0, 0, 'game_over'],
      [over, 1, 99, 99, 'game_over'],
      [over, 5, 0, 0, 'bad_args'],
      [over, 0, 0.5, 0, 'bad_args'],
    ];
    for (const [input, trayIndex, row, col, error] of cases) {
      const { result } = run(ctx, input, trayIndex, row, col);
      assert.equal(result.error, error, `(${trayIndex},${row},${col})`);
      assert.equal(result.state, input);
      assert.deepEqual(result.events, []);
    }
  });

  test('잘못된 인자 타입은 bad_args이고 미리보기는 빈 결과다', () => {
    const ctx = newCtx('bad-args');
    const state = craft({ tray: [trayPiece('h3'), trayPiece('dot'), trayPiece('sq2')] });
    const bad = [
      [null, 0, 0], ['1', 0, 0], [0, '1', 0], [0, 0, '1'], [undefined, 0, 0], [0, undefined, 0], [0, 0, undefined],
      [NaN, 0, 0], [0, NaN, 0], [0, 0, Infinity], [1.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [-1, 0, 0], [3, 0, 0], [99, 0, 0],
    ];
    for (const [trayIndex, row, col] of bad) {
      const { result } = run(ctx, state, trayIndex, row, col);
      assert.equal(result.error, 'bad_args', JSON.stringify([trayIndex, row, col]));
      assert.deepEqual(core.previewMove(state, trayIndex, row, col), {
        valid: false, reason: 'bad_args', cells: [], clearRows: [], clearCols: [], clearCells: [],
      });
    }
  });

  test('미리보기: 유효하지 않아도 모양을 알면 cells를 채우고, 줄 강조 칸은 행 우선', () => {
    const board = refEmptyBoard();
    for (let c = 0; c < SIZE; c++) if (c !== 2 && c !== 3) board[1][c] = 2;
    board[5][5] = 4;
    const state = craft({ board, tray: [trayPiece('h2'), null, trayPiece('sq2')] });
    assert.deepEqual(core.previewMove(state, 0, 1, 2), {
      valid: true,
      cells: [[1, 2], [1, 3]],
      clearRows: [1],
      clearCols: [],
      clearCells: [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7]],
    });
    assert.deepEqual(core.previewMove(state, 0, 0, 7), {
      valid: false, reason: 'out_of_bounds', cells: [[0, 7], [0, 8]], clearRows: [], clearCols: [], clearCells: [],
    });
    assert.deepEqual(core.previewMove(state, 2, 4, 4), {
      valid: false, reason: 'overlap', cells: [[4, 4], [4, 5], [5, 4], [5, 5]], clearRows: [], clearCols: [], clearCells: [],
    });
    assert.deepEqual(core.previewMove(state, 1, 0, 0), {
      valid: false, reason: 'empty_slot', cells: [], clearRows: [], clearCols: [], clearCells: [],
    });
    const plain = core.previewMove(state, 2, 6, 0);
    assert.deepEqual(Object.keys(plain).sort(), ['cells', 'clearCells', 'clearCols', 'clearRows', 'valid']);
  });
});

describe('차분 테스트: 시드 게임 360판', () => {
  const POLICIES = ['random', 'cleaner', 'greedy', 'cleaner'];

  function runGames(label, indexes, modeOf, seedOf) {
    const ctx = newCtx(label);
    const perPolicy = {};
    for (const i of indexes) {
      const gameCtx = { ...ctx, label: `${label} #${i}` };
      const rand = makeRand(9000 + i);
      const before = ctx.stats.moves;
      playGame(gameCtx, { mode: modeOf(i), seed: seedOf(i), policy: POLICIES[i % 4], maxMoves: 200, rand });
      perPolicy[POLICIES[i % 4]] = (perPolicy[POLICIES[i % 4]] ?? 0) + ctx.stats.moves - before;
    }
    ctx.perPolicy = perPolicy;
    return ctx;
  }

  const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

  test('클래식 240판 (숫자/문자열 시드)', (t) => {
    const ctx = runGames('classic', range(0, 240), () => 'classic', (i) => (i % 5 === 4 ? `seed-${i}` : 1000 + i * 7919));
    t.diagnostic(`${JSON.stringify(ctx.stats)} movesByPolicy=${JSON.stringify(ctx.perPolicy)}`);
    const s = ctx.stats;
    assert.equal(s.games, 240);
    // 밸런스 조정으로 게임 길이가 바뀌어도 테스트가 헛돌지만 않도록 여유 있는 하한만 둔다
    assert.ok(s.moves > 6000, `moves ${s.moves}`);
    assert.ok(s.invalid > 3000, `invalid attempts ${s.invalid}`);
    assert.ok(s.crossClears >= 30 && s.tripleClears >= 5, JSON.stringify(s));
    assert.ok(s.comboBreaks >= 600 && s.maxCombo >= 4, JSON.stringify(s));
    assert.ok(s.refills >= 2000 && s.gameovers >= 100, JSON.stringify(s));
    assert.equal(s.gameoversAtRefill, 0, '클래식은 리필 직후 게임오버가 없어야 한다');
    assert.ok(s.midTrayGameovers >= 100, JSON.stringify(s));
    assert.deepEqual(ctx.unsolvable, [], `classic refill must be solvable when the exhaustive search can decide (${s.solverChecked} checked, ${s.solverSkipped} skipped)`);
    assert.equal(s.solverChecked, s.refills, 'every classic refill must be checked by the exhaustive search');
  });

  test('데일리 120판 (날짜 문자열/숫자 시드)', (t) => {
    const ctx = runGames('daily', range(240, 360), () => 'daily', (i) => (i % 4 === 3 ? i : `2026-10-${(i % 28) + 1}`));
    t.diagnostic(`${JSON.stringify(ctx.stats)} movesByPolicy=${JSON.stringify(ctx.perPolicy)}`);
    const s = ctx.stats;
    assert.equal(s.games, 120);
    assert.ok(s.moves > 1500, `moves ${s.moves}`);
    assert.ok(s.refills >= 500 && s.gameovers >= 100, JSON.stringify(s));
  });
});

describe('차분 테스트: 임의 국면 (줄 제거/퍼펙트/게임오버 경계)', () => {
  function runPositions(label, make, count, seed) {
    const ctx = newCtx(label);
    const rand = makeRand(seed);
    for (let i = 0; i < count; i++) {
      ctx.label = `${label} #${i}`;
      checkPosition(ctx, make(rand, i % 2 === 0 ? 'classic' : 'daily'), rand);
    }
    return ctx;
  }

  test('임의 보드 국면 1500개', (t) => {
    const ctx = runPositions('random-position', randomPosition, 1500, 5151);
    t.diagnostic(JSON.stringify(ctx.stats));
    const s = ctx.stats;
    assert.ok(s.clears >= 800 && s.crossClears >= 80 && s.tripleClears >= 20, JSON.stringify(s));
    assert.ok(s.gameovers >= 400 && s.gameoversAtRefill >= 20, JSON.stringify(s));
    assert.ok(s.invalid >= 4000, JSON.stringify(s));
  });

  test('구성한 국면 2000개: 한 번의 배치로 여러 줄이 완성된다', (t) => {
    const ctx = runPositions('constructive-position', constructivePosition, 2000, 6262);
    t.diagnostic(JSON.stringify(ctx.stats));
    const s = ctx.stats;
    assert.ok(s.clears >= 2500 && s.crossClears >= 300 && s.multiClears >= 600, JSON.stringify(s));
    assert.ok(s.tripleClears >= 100 && s.quadClears >= 10, JSON.stringify(s));
    assert.ok(s.perfects >= 100, JSON.stringify(s));
    assert.ok(s.capHits >= 100, JSON.stringify(s));
  });
});

function firstEmptyCell(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (board[r][c] === 0) return [r, c];
  }
  return null;
}

describe('결정성: 데일리/클래식/저장 복원', () => {
  test('데일리: 같은 시드면 보드와 점수가 달라도 같은 트레이 순서', () => {
    const rand = makeRand(777);
    for (const seed of ['2026-10-04', 'x', 20261004]) {
      for (let trayIndex = 0; trayIndex < 30; trayIndex++) {
        const seen = new Set();
        for (let round = 0; round < 6; round++) {
          const { state } = randomPosition(rand, 'daily');
          const board = state.board;
          const last = { shapeId: 'dot', color: 1 };
          const crafted = craft({
            mode: 'daily', seed, board, trayIndex, tray: [null, null, last], score: rand.int(9999), rngState: rand.int(2 ** 32),
            combo: rand.int(9), moves: rand.int(500),
          });
          const dotCell = firstEmptyCell(board);
          if (dotCell === null) continue;
          const result = core.applyMove(crafted, 2, dotCell[0], dotCell[1]);
          assert.equal(result.ok, true);
          assert.equal(result.state.trayIndex, trayIndex + 1);
          seen.add(JSON.stringify(result.state.tray));
          assert.equal(result.state.rngState, crafted.rngState, 'daily must not use rngState');
        }
        assert.equal(seen.size, 1, `seed ${seed} trayIndex ${trayIndex + 1} must not depend on the board`);
      }
    }
    const sequenceA = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => JSON.stringify(core.generateTray({ mode: 'daily', seed: 'A', trayIndex: n })));
    const sequenceB = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => JSON.stringify(core.generateTray({ mode: 'daily', seed: 'B', trayIndex: n })));
    assert.notDeepEqual(sequenceA, sequenceB);
    assert.notEqual(new Set(sequenceA).size, 1, '트레이가 매번 같으면 안 된다');
  });

  test('데일리: 서로 다른 플레이가 같은 트레이 순서를 본다', () => {
    const seed = '2026-10-04';
    const traysSeen = [new Map(), new Map()];
    ['random', 'cleaner'].forEach((policy, side) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const ctx = newCtx(`daily-same-seed ${policy} ${attempt}`);
        const rand = makeRand(31 + attempt * 13 + side);
        const model = playGameTracking(ctx, { seed, policy, rand }, traysSeen[side]);
        assert.ok(model.moves >= 1);
      }
    });
    for (const [index, tray] of traysSeen[0]) {
      if (traysSeen[1].has(index)) assert.equal(traysSeen[1].get(index), tray, `trayIndex ${index}`);
    }
    assert.ok(traysSeen[0].size >= 3 && traysSeen[1].size >= 3);
  });

  function playGameTracking(ctx, { seed, policy, rand }, traysSeen) {
    let state = core.createGame({ mode: 'daily', seed });
    traysSeen.set(0, JSON.stringify(state.tray));
    deepFreeze(state);
    let model = structuredClone(state);
    while (model.status === 'playing' && model.moves < 200) {
      const move = choosePolicyMove(policy, model, rand);
      ({ state, model } = stepAndCompare(ctx, state, model, move));
      const trayKey = JSON.stringify(state.tray);
      if (state.tray.every((slot) => slot !== null)) traysSeen.set(state.trayIndex, trayKey);
    }
    return model;
  }

  test('클래식: 같은 시드와 같은 수순이면 상태와 이벤트가 똑같다', () => {
    function record(seed, policySeed) {
      let state = core.createGame({ mode: 'classic', seed });
      const rand = makeRand(policySeed);
      const log = [JSON.stringify(state)];
      let model = structuredClone(state);
      while (model.status === 'playing' && model.moves < 150) {
        const move = choosePolicyMove('cleaner', model, rand);
        const result = core.applyMove(state, move.trayIndex, move.row, move.col);
        const ref = refStep(model, move.trayIndex, move.row, move.col, result.state.tray);
        ref.model.rngState = result.state.rngState;
        log.push(JSON.stringify([result.state, result.events]));
        state = result.state;
        model = ref.model;
      }
      return log;
    }
    assert.deepEqual(record(4242, 5), record(4242, 5));
    assert.deepEqual(record('hello', 6), record('hello', 6));
    const firstTrays = new Set();
    for (let seed = 0; seed < 60; seed++) firstTrays.add(JSON.stringify(core.createGame({ mode: 'classic', seed }).tray));
    assert.ok(firstTrays.size >= 20, `first trays must vary with the seed (${firstTrays.size} distinct of 60)`);
  });

  test('저장/복원: JSON 왕복 후 이어서 진행해도 상태와 이벤트가 같다 (리필과 난수 포함)', () => {
    for (const mode of ['classic', 'daily']) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const rand = makeRand(55 + attempt);
        const seed = mode === 'daily' ? `2026-10-${attempt + 1}` : 3000 + attempt;
        let original = core.createGame({ mode, seed });
        let model = structuredClone(original);
        let twin = null;
        let steps = 0;
        while (model.status === 'playing' && steps < 120) {
          const move = choosePolicyMove('cleaner', model, rand);
          const result = core.applyMove(original, move.trayIndex, move.row, move.col);
          assert.equal(result.ok, true);
          const ref = refStep(model, move.trayIndex, move.row, move.col, result.state.tray);
          ref.model.rngState = result.state.rngState;
          if (twin !== null) {
            const twinResult = core.applyMove(twin, move.trayIndex, move.row, move.col);
            assert.deepEqual(twinResult.state, result.state, `${mode} #${attempt} step ${steps}: restored game diverged`);
            assert.deepEqual(twinResult.events, result.events, `${mode} #${attempt} step ${steps}: events diverged`);
            twin = twinResult.state;
          }
          original = result.state;
          model = ref.model;
          steps += 1;
          if (steps % 9 === 0) {
            twin = core.restoreGame(JSON.parse(JSON.stringify(original)));
            assert.deepEqual(twin, original);
            assert.notEqual(twin, original);
          }
        }
        assert.ok(steps >= 5);
      }
    }
  });

  test('restoreGame: 깊은 복사이고 알 수 없는 필드는 버린다', () => {
    const state = core.createGame({ mode: 'classic', seed: 5 });
    const saved = JSON.parse(JSON.stringify(state));
    saved.extra = 'x';
    saved.board.extra = 1;
    saved.tray[0].extra = 2;
    const restored = core.restoreGame(saved);
    assert.deepEqual(restored, state);
    restored.board[0][0] = 5;
    restored.tray[0].color = 9;
    assert.equal(saved.board[0][0], 0);
    assert.notEqual(saved.tray[0].color, 9);
    assert.notEqual(restored.board, saved.board);
  });

  test('restoreGame: 손상된 저장 데이터는 null', () => {
    const base = JSON.parse(JSON.stringify(core.createGame({ mode: 'classic', seed: 5 })));
    const mutate = (change) => {
      const copy = structuredClone(base);
      change(copy);
      return copy;
    };
    const bad = {
      'version 2': mutate((s) => { s.version = 2; }),
      'no version': mutate((s) => { delete s.version; }),
      'mode adventure': mutate((s) => { s.mode = 'adventure'; }),
      'mode missing': mutate((s) => { delete s.mode; }),
      'seed NaN': mutate((s) => { s.seed = null; }),
      'seed object': mutate((s) => { s.seed = {}; }),
      'rngState negative': mutate((s) => { s.rngState = -1; }),
      'rngState too big': mutate((s) => { s.rngState = 2 ** 32; }),
      'rngState float': mutate((s) => { s.rngState = 1.5; }),
      'board 7 rows': mutate((s) => { s.board.pop(); }),
      'board 9 cols': mutate((s) => { s.board[0].push(0); }),
      'board color 8': mutate((s) => { s.board[0][0] = 8; }),
      'board negative': mutate((s) => { s.board[0][0] = -1; }),
      'board float': mutate((s) => { s.board[0][0] = 0.5; }),
      'board string': mutate((s) => { s.board[0][0] = '1'; }),
      'tray short': mutate((s) => { s.tray.pop(); }),
      'tray unknown shape': mutate((s) => { s.tray[0].shapeId = 'nope'; }),
      'tray color 0': mutate((s) => { s.tray[0].color = 0; }),
      'tray color 8': mutate((s) => { s.tray[0].color = 8; }),
      'tray not object': mutate((s) => { s.tray[0] = 5; }),
      'negative score': mutate((s) => { s.score = -1; }),
      'fractional moves': mutate((s) => { s.moves = 1.5; }),
      'unsafe lines': mutate((s) => { s.lines = Number.MAX_SAFE_INTEGER + 1; }),
      'NaN combo': mutate((s) => { s.combo = NaN; }),
      'string trayIndex': mutate((s) => { s.trayIndex = '0'; }),
      'status unknown': mutate((s) => { s.status = 'paused'; }),
      'playing but no move': mutate((s) => {
        s.board = refEmptyBoard().map((row) => row.map(() => 1));
        s.board[0][0] = 0;
        s.tray = [{ shapeId: 'h2', color: 1 }, null, null];
      }),
      'over but a move exists': mutate((s) => { s.status = 'over'; }),
      'playing with an empty tray': mutate((s) => { s.tray = [null, null, null]; }),
    };
    for (const [name, saved] of Object.entries(bad)) {
      assert.equal(core.restoreGame(saved), null, name);
    }
    for (const junk of [null, undefined, 42, 'x', [], true]) assert.equal(core.restoreGame(junk), null, String(junk));
    assert.deepEqual(core.restoreGame(structuredClone(base)), base, 'the untouched baseline must restore');
  });

  test('createGame: 초기 상태, 기본값, 잘못된 모드', () => {
    assertInitialState(core.createGame(), 'classic', 1, 'default');
    assertInitialState(core.createGame({ mode: 'daily', seed: '2026-10-04' }), 'daily', '2026-10-04', 'daily');
    for (const mode of ['adventure', 'Classic', '', null, 3]) {
      assert.throws(() => core.createGame({ mode, seed: 1 }), RangeError, String(mode));
    }
  });

  test('순수성: 입력 상태, 결과 상태, 이벤트는 서로 메모리를 공유하지 않는다', () => {
    // 마지막 블록이라 trayRefill 이벤트까지 나오는 국면. 입력은 얼려 있어서 공유하면 쓰기에서 바로 터진다.
    const state = craft({ tray: [null, null, trayPiece('dot', 2)] });
    const before = JSON.stringify(state);
    const result = core.applyMove(state, 2, 3, 3);
    assert.ok(eventTypes(result.events).includes('trayRefill'));
    const resultJson = JSON.stringify(result.state);
    for (const event of result.events) {
      if (event.tray) event.tray.forEach((p) => { p.color = 9; });
      if (event.cells) event.cells.length = 0;
    }
    assert.equal(JSON.stringify(result.state), resultJson, '이벤트를 고쳐도 결과 상태가 바뀌면 안 된다');
    result.state.board[7][7] = 7;
    result.state.board[3][3] = 7;
    result.state.tray.forEach((p) => { p.color = 9; });
    result.state.tray.fill(null);
    assert.equal(JSON.stringify(state), before, '결과를 고쳐도 입력 상태가 바뀌면 안 된다');
  });
});
