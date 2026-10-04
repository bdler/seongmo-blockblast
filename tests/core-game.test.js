import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SIZE, COLOR_COUNT, SCORING, TRAY_SIZE } from '../src/config.js';
import { countFilled, createBoard, listPlacements } from '../src/core/board.js';
import { generateTray } from '../src/core/generator.js';
import {
  applyMove,
  createGame,
  isGameOver,
  listMoves,
  previewMove,
  restoreGame,
} from '../src/core/game.js';
import { createRng } from '../src/core/rng.js';
import { getShape } from '../src/core/shapes.js';

// '.'은 빈칸, '1'~'7'은 색, '#'은 색 1
const boardFrom = (rows) =>
  rows.map((line) => [...line].map((ch) => (ch === '.' ? 0 : ch === '#' ? 1 : Number(ch))));

const deepFreeze = (value) => {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const piece = (shapeId, color = 1) => ({ shapeId, color });

// 시작 상태에 필드를 덮어써서 시나리오용 상태를 만든다
const stateWith = (overrides, options = {}) => ({ ...createGame(options), ...overrides });

// 서로 맞닿은 빈칸이 없는 체커보드: 점 블록만 놓을 수 있다
const checkerBoard = () =>
  boardFrom(Array.from({ length: 8 }, (_, r) => (r % 2 ? '.#.#.#.#' : '#.#.#.#.')));

// 체커보드에서 점 하나만 남은 트레이. 이 점을 놓으면 트레이가 비어 리필된다
const lastDotState = (options) =>
  stateWith({ board: checkerBoard(), tray: [null, null, piece('dot', 3)], moves: 5, score: 40 }, options);

// 2행과 3열이 (2,3)만 빼고 가득 찬 보드. (2,3)에 점을 놓으면 행과 열이 동시에 찬다. (7,7)은 지워지지 않고 남는다
const crossBoard = () => {
  const board = createBoard();
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (i !== 3) board[2][i] = 2;
    if (i !== 2) board[i][3] = 3;
  }
  board[7][7] = 4;
  return board;
};

const eventTypes = (events) => events.map((event) => event.type);

const randomMove = (state, rng) => rng.pick(listMoves(state));

function playRandom(options, botSeed, maxMoves = 2000) {
  let state = createGame(options);
  const rng = createRng(botSeed);
  const states = [state];
  const eventLog = [];
  while (state.status === 'playing' && state.moves < maxMoves) {
    const { trayIndex, row, col } = randomMove(state, rng);
    const result = applyMove(state, trayIndex, row, col);
    assert.equal(result.ok, true);
    state = result.state;
    states.push(state);
    eventLog.push(result.events);
  }
  return { states, eventLog };
}

test('createGame: 시작 상태는 JSON으로 직렬화되고 필드가 올바르다', () => {
  const state = createGame();
  assert.equal(state.version, 1);
  assert.equal(state.mode, 'classic');
  assert.equal(state.seed, 1);
  assert.ok(Number.isInteger(state.rngState) && state.rngState >= 0 && state.rngState < 2 ** 32);
  assert.deepEqual(state.board, createBoard());
  assert.equal(state.tray.length, TRAY_SIZE);
  for (const slot of state.tray) {
    assert.ok(getShape(slot.shapeId));
    assert.ok(Number.isInteger(slot.color) && slot.color >= 1 && slot.color <= COLOR_COUNT);
  }
  assert.deepEqual(
    { trayIndex: state.trayIndex, score: state.score, combo: state.combo, maxCombo: state.maxCombo },
    { trayIndex: 0, score: 0, combo: 0, maxCombo: 0 },
  );
  assert.deepEqual({ lines: state.lines, moves: state.moves, perfects: state.perfects }, { lines: 0, moves: 0, perfects: 0 });
  assert.equal(state.status, 'playing');
  assert.deepEqual(clone(state), state);
});

test('createGame: 같은 시드는 같은 상태, 다른 시드는 다른 상태이고 문자열 시드도 된다', () => {
  assert.deepEqual(createGame({ seed: 42 }), createGame({ seed: 42 }));
  assert.deepEqual(createGame({ seed: 'abc' }), createGame({ seed: 'abc' }));
  assert.equal(createGame({ seed: 'abc' }).seed, 'abc');
  assert.notDeepEqual(createGame({ seed: 1 }).tray, createGame({ seed: 2 }).tray);
  assert.notDeepEqual(createGame({ seed: 'abc' }), createGame({ seed: 'abd' }));
  assert.notDeepEqual(createGame({ seed: 1 }), createGame({ seed: '1' }));
});

test('createGame: daily의 첫 트레이는 (seed, 0)만의 함수다', () => {
  const seed = 'blockblast:2026-10-04';
  const state = createGame({ mode: 'daily', seed });
  assert.equal(state.mode, 'daily');
  assert.deepEqual(state.tray, generateTray({ mode: 'daily', seed, trayIndex: 0 }));
});

test('createGame: 알 수 없는 모드나 잘못된 시드는 예외를 던진다', () => {
  assert.throws(() => createGame({ mode: 'adventure' }), RangeError);
  assert.throws(() => createGame({ seed: NaN }), TypeError);
  assert.throws(() => createGame({ seed: {} }), TypeError);
});

test('createGame: 새 게임은 어떤 시드/모드에서도 끝난 상태가 아니다', () => {
  for (const mode of ['classic', 'daily']) {
    for (let seed = 0; seed < 300; seed++) {
      const state = createGame({ mode, seed: `s${seed}` });
      assert.equal(state.status, 'playing');
      assert.equal(isGameOver(state), false);
      assert.ok(listMoves(state).length > 0);
    }
  }
});

test('applyMove: 단순 배치는 place와 score 이벤트만 만들고 슬롯을 비운다', () => {
  const state = stateWith({ tray: [piece('h3', 2), piece('dot'), piece('v2')] });
  const result = applyMove(state, 0, 4, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.events, [
    { type: 'place', shapeId: 'h3', color: 2, cells: [[4, 2], [4, 3], [4, 4]] },
    { type: 'score', delta: 3, total: 3, breakdown: { place: 3, clear: 0, perfect: 0 } },
  ]);
  const next = result.state;
  assert.deepEqual(next.tray, [null, piece('dot'), piece('v2')]);
  assert.deepEqual(next.board[4], [0, 0, 2, 2, 2, 0, 0, 0]);
  assert.equal(countFilled(next.board), 3);
  assert.deepEqual(
    { score: next.score, combo: next.combo, lines: next.lines, moves: next.moves, trayIndex: next.trayIndex, status: next.status },
    { score: 3, combo: 0, lines: 0, moves: 1, trayIndex: 0, status: 'playing' },
  );
  assert.equal(next.rngState, state.rngState);
  assert.equal(countFilled(state.board), 0);
});

test('applyMove: 한 줄을 지우면 clear, combo, score 이벤트가 이 순서로 나온다', () => {
  const board = boardFrom(['#.......', ...Array(6).fill('........'), '1234567.']);
  const state = stateWith({ board, tray: [piece('dot', 5), piece('h2'), piece('v2')] });
  const result = applyMove(state, 0, 7, 7);
  assert.deepEqual(eventTypes(result.events), ['place', 'clear', 'combo', 'score']);
  const [, clear, combo, score] = result.events;
  assert.deepEqual(clear.rows, [7]);
  assert.deepEqual(clear.cols, []);
  assert.equal(clear.lines, 1);
  assert.deepEqual(clear.cells.map(({ color }) => color), [1, 2, 3, 4, 5, 6, 7, 5]);
  assert.deepEqual(clear.cells.map(({ r, c }) => [r, c]), Array.from({ length: 8 }, (_, c) => [7, c]));
  assert.deepEqual(combo, { type: 'combo', count: 1, multiplier: 1 });
  assert.deepEqual(score, { type: 'score', delta: 11, total: 11, breakdown: { place: 1, clear: 10, perfect: 0 } });

  const next = result.state;
  assert.equal(next.score, 11);
  assert.equal(next.lines, 1);
  assert.equal(next.combo, 1);
  assert.equal(next.maxCombo, 1);
  assert.equal(next.perfects, 0);
  assert.deepEqual(next.board[7], Array(8).fill(0));
  assert.equal(next.board[0][0], 1);
});

test('applyMove: 행과 열이 교차해 동시에 차면 모두 지우고 교차 칸은 한 번만 보고한다', () => {
  const board = crossBoard();
  const state = stateWith({ board, tray: [piece('dot', 6), piece('h2'), piece('v2')] });

  const result = applyMove(state, 0, 2, 3);
  assert.deepEqual(eventTypes(result.events), ['place', 'clear', 'combo', 'score']);
  const clear = result.events[1];
  assert.deepEqual(clear.rows, [2]);
  assert.deepEqual(clear.cols, [3]);
  assert.equal(clear.lines, 2);
  assert.equal(clear.cells.length, 15);
  assert.equal(new Set(clear.cells.map(({ r, c }) => `${r},${c}`)).size, 15);
  assert.deepEqual(clear.cells.filter(({ r, c }) => r === 2 && c === 3), [{ r: 2, c: 3, color: 6 }]);
  assert.deepEqual(result.events[3].breakdown, { place: 1, clear: 40, perfect: 0 });
  assert.equal(result.state.score, 41);
  assert.equal(result.state.lines, 2);
  assert.equal(countFilled(result.state.board), 1);
  assert.equal(result.state.board[7][7], 4);
});

test('applyMove: 콤보가 이어지면 배율이 오르고 끊기면 comboBreak가 나온다', () => {
  const board = boardFrom(['#.......', ...Array(6).fill('........'), '#######.']);
  let state = stateWith({ board, combo: 2, maxCombo: 2, score: 100, tray: [piece('dot'), piece('dot'), piece('dot')] });

  const cleared = applyMove(state, 0, 7, 7);
  assert.deepEqual(eventTypes(cleared.events), ['place', 'clear', 'combo', 'score']);
  assert.deepEqual(cleared.events[2], { type: 'combo', count: 3, multiplier: 2 });
  assert.deepEqual(cleared.events[3], { type: 'score', delta: 21, total: 121, breakdown: { place: 1, clear: 20, perfect: 0 } });
  assert.equal(cleared.state.combo, 3);
  assert.equal(cleared.state.maxCombo, 3);

  const broken = applyMove(cleared.state, 1, 4, 4);
  assert.deepEqual(eventTypes(broken.events), ['place', 'comboBreak', 'score']);
  assert.deepEqual(broken.events[1], { type: 'comboBreak', previous: 3 });
  assert.equal(broken.state.combo, 0);
  assert.equal(broken.state.maxCombo, 3);

  const plain = applyMove(broken.state, 2, 5, 5);
  assert.ok(!eventTypes(plain.events).includes('comboBreak'));
  assert.equal(plain.state.combo, 0);
});

test('applyMove: 콤보 배율은 상한에서 멈춘다', () => {
  const board = boardFrom(['#.......', ...Array(6).fill('........'), '#######.']);
  const state = stateWith({ board, combo: 30, maxCombo: 30, tray: [piece('dot'), piece('dot'), piece('dot')] });
  const result = applyMove(state, 0, 7, 7);
  assert.deepEqual(result.events[2], { type: 'combo', count: 31, multiplier: SCORING.maxMultiplier });
  assert.equal(result.events[3].breakdown.clear, 10 * SCORING.maxMultiplier);
});

test('applyMove: 줄을 지워 보드가 완전히 비면 perfect 보너스를 준다', () => {
  const board = boardFrom([...Array(7).fill('........'), '#######.']);
  const state = stateWith({ board, tray: [piece('dot'), piece('h2'), piece('v2')] });
  const result = applyMove(state, 0, 7, 7);
  assert.deepEqual(eventTypes(result.events), ['place', 'clear', 'combo', 'perfect', 'score']);
  assert.deepEqual(result.events[3], { type: 'perfect', bonus: SCORING.perfectBonus });
  assert.deepEqual(result.events[4], {
    type: 'score',
    delta: 1 + 10 + SCORING.perfectBonus,
    total: 1 + 10 + SCORING.perfectBonus,
    breakdown: { place: 1, clear: 10, perfect: SCORING.perfectBonus },
  });
  assert.equal(result.state.perfects, 1);
  assert.equal(countFilled(result.state.board), 0);
});

test('applyMove: 줄을 못 지운 이동은 보드가 비어 있어도 perfect가 아니다', () => {
  const state = stateWith({ tray: [piece('dot'), piece('dot'), piece('dot')] });
  const result = applyMove(state, 0, 0, 0);
  assert.ok(!eventTypes(result.events).includes('perfect'));
  assert.equal(result.state.perfects, 0);
});

test('applyMove: 세 번째 블록을 놓으면 trayIndex+1의 새 트레이로 리필된다', () => {
  const state = stateWith({ tray: [null, null, piece('dot', 3)], trayIndex: 4, moves: 11, score: 50 });
  const result = applyMove(state, 2, 3, 3);
  assert.deepEqual(eventTypes(result.events), ['place', 'score', 'trayRefill']);
  const next = result.state;
  assert.equal(next.trayIndex, 5);
  assert.equal(next.tray.length, TRAY_SIZE);
  assert.ok(next.tray.every((slot) => slot !== null));
  assert.deepEqual(result.events[2].tray, next.tray);
  assert.notEqual(result.events[2].tray, next.tray);
  assert.notEqual(next.rngState, state.rngState);

  const expected = generateTray({
    board: next.board,
    rng: createRng(state.rngState),
    mode: 'classic',
    seed: state.seed,
    trayIndex: 5,
    score: next.score,
  });
  assert.deepEqual(next.tray, expected);
});

test('applyMove: daily의 리필 트레이는 (seed, trayIndex)만의 함수다', () => {
  const seed = 'blockblast:2026-10-04';
  let state = createGame({ mode: 'daily', seed });
  for (let i = 0; i < TRAY_SIZE; i++) {
    const { trayIndex, row, col } = listMoves(state)[0];
    state = applyMove(state, trayIndex, row, col).state;
  }
  assert.equal(state.status, 'playing');
  assert.equal(state.trayIndex, 1);
  assert.deepEqual(state.tray, generateTray({ mode: 'daily', seed, trayIndex: 1 }));
});

test('게임오버: 트레이를 막 비운 직후가 아니라 리필 이후에 판정한다', () => {
  // 마지막 블록을 놓으면 트레이가 비지만 새 트레이(classic은 점 3개로 폴백)를 놓을 수 있으므로 계속된다
  const result = applyMove(lastDotState(), 2, 0, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(eventTypes(result.events), ['place', 'score', 'trayRefill']);
  assert.equal(result.state.status, 'playing');
  assert.deepEqual(result.state.tray.map((slot) => slot.shapeId), ['dot', 'dot', 'dot']);
});

test('게임오버: 리필된 새 트레이를 놓을 곳이 없으면 trayRefill 다음에 gameover가 나온다', () => {
  // daily는 보드를 보지 않고 트레이를 만든다. 두 번째 트레이에 점이 없는 시드를 찾는다
  let seed;
  for (let n = 0; seed === undefined; n++) {
    const candidate = `no-dot-${n}`;
    const next = generateTray({ mode: 'daily', seed: candidate, trayIndex: 1 });
    if (next.every((slot) => slot.shapeId !== 'dot')) seed = candidate;
  }
  const state = lastDotState({ mode: 'daily', seed });
  const result = applyMove(state, 2, 0, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(eventTypes(result.events), ['place', 'score', 'trayRefill', 'gameover']);
  assert.deepEqual(result.events[3], {
    type: 'gameover',
    score: 41,
    stats: { lines: 0, maxCombo: 0, moves: 6, perfects: 0 },
  });
  assert.equal(result.state.status, 'over');
  assert.equal(isGameOver(result.state), true);
  assert.equal(result.state.trayIndex, 1);
  assert.ok(result.state.tray.every((slot) => slot !== null));
  assert.deepEqual(listMoves(result.state), []);
});

test('게임오버: 트레이 중간에도 남은 블록을 모두 못 놓으면 리필 없이 끝난다', () => {
  const state = stateWith({ board: checkerBoard(), tray: [piece('h2'), piece('dot'), piece('v2')], moves: 9 });
  const result = applyMove(state, 1, 0, 1);
  assert.deepEqual(eventTypes(result.events), ['place', 'score', 'gameover']);
  assert.equal(result.state.status, 'over');
  assert.deepEqual(result.state.tray, [piece('h2'), null, piece('v2')]);
  assert.equal(result.state.trayIndex, 0);
  assert.equal(result.events[2].stats.moves, 10);
});

test('applyMove: 실패하면 입력 상태 그대로, 이벤트 없이 오류 코드를 돌려준다', () => {
  const state = deepFreeze(stateWith({ tray: [piece('h3'), null, piece('sq2')] }));
  const over = deepFreeze({ ...clone(state), status: 'over' });
  const full = deepFreeze(stateWith({ board: boardFrom(['#.......', ...Array(7).fill('........')]), tray: [piece('h3'), null, piece('dot')] }));

  const cases = [
    ['bad_args', state, -1, 0, 0],
    ['bad_args', state, 3, 0, 0],
    ['bad_args', state, 1.5, 0, 0],
    ['bad_args', state, '0', 0, 0],
    ['bad_args', state, undefined, 0, 0],
    ['bad_args', state, null, 0, 0],
    ['bad_args', state, 0, 0.5, 0],
    ['bad_args', state, 0, 0, NaN],
    ['bad_args', state, 0, 'a', 0],
    ['bad_args', state, 0, 0, undefined],
    ['bad_args', null, 0, 0, 0],
    ['bad_args', undefined, 0, 0, 0],
    ['bad_args', {}, 0, 0, 0],
    ['game_over', over, 0, 0, 0],
    ['empty_slot', state, 1, 0, 0],
    ['out_of_bounds', state, 0, -1, 0],
    ['out_of_bounds', state, 0, 0, -1],
    ['out_of_bounds', state, 0, 8, 0],
    ['out_of_bounds', state, 0, 0, 6],
    ['out_of_bounds', state, 2, 7, 0],
    ['out_of_bounds', state, 2, 0, 7],
    ['overlap', full, 0, 0, 0],
    ['overlap', full, 2, 0, 0],
  ];
  for (const [error, input, trayIndex, row, col] of cases) {
    const result = applyMove(input, trayIndex, row, col);
    const label = `${error}: ${JSON.stringify([trayIndex, row, col])}`;
    assert.equal(result.ok, false, label);
    assert.equal(result.error, error, label);
    assert.equal(result.state, input, label);
    assert.deepEqual(result.events, [], label);
  }
});

test('applyMove: 정확히 경계에 맞는 배치는 허용한다', () => {
  const state = stateWith({ tray: [piece('h5'), piece('v5'), piece('sq3')] });
  assert.equal(applyMove(state, 0, 7, 3).ok, true);
  assert.equal(applyMove(state, 1, 3, 7).ok, true);
  assert.equal(applyMove(state, 2, 5, 5).ok, true);
  assert.equal(applyMove(state, 2, 6, 5).error, 'out_of_bounds');
});

test('previewMove: 놓았을 때 지워질 줄과 칸을 알려준다', () => {
  const board = crossBoard();
  const state = deepFreeze(stateWith({ board, tray: [piece('dot', 6), piece('h2'), null] }));

  const preview = previewMove(state, 0, 2, 3);
  assert.equal(preview.valid, true);
  assert.equal('reason' in preview, false);
  assert.deepEqual(preview.cells, [[2, 3]]);
  assert.deepEqual(preview.clearRows, [2]);
  assert.deepEqual(preview.clearCols, [3]);
  assert.equal(preview.clearCells.length, 15);
  assert.ok(preview.clearCells.some(([r, c]) => r === 2 && c === 3), '새로 놓는 칸도 포함');
  assert.ok(!preview.clearCells.some(([r, c]) => r === 7 && c === 7));
  const keys = preview.clearCells.map(([r, c]) => r * 8 + c);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));

  const quiet = previewMove(state, 1, 5, 5);
  assert.deepEqual(quiet, { valid: true, cells: [[5, 5], [5, 6]], clearRows: [], clearCols: [], clearCells: [] });
});

test('previewMove: 유효하지 않으면 이유를 알려주고 모양을 알면 놓으려던 좌표를 담는다', () => {
  const board = boardFrom(['#.......', ...Array(7).fill('........')]);
  const state = deepFreeze(stateWith({ board, tray: [piece('h3'), null, piece('dot')] }));
  const none = { clearRows: [], clearCols: [], clearCells: [] };

  assert.deepEqual(previewMove(state, 0, 0, 6), { valid: false, reason: 'out_of_bounds', cells: [[0, 6], [0, 7], [0, 8]], ...none });
  assert.deepEqual(previewMove(state, 0, 0, 0), { valid: false, reason: 'overlap', cells: [[0, 0], [0, 1], [0, 2]], ...none });
  assert.deepEqual(previewMove(state, 1, 0, 0), { valid: false, reason: 'empty_slot', cells: [], ...none });
  assert.deepEqual(previewMove(state, 5, 0, 0), { valid: false, reason: 'bad_args', cells: [], ...none });
  assert.deepEqual(previewMove(state, 0, 0.5, 0), { valid: false, reason: 'bad_args', cells: [], ...none });
  assert.deepEqual(previewMove({ ...state, status: 'over' }, 2, 3, 3), { valid: false, reason: 'game_over', cells: [], ...none });
});

test('listMoves: 놓을 수 있는 모든 (슬롯, 행, 열)을 순서대로 돌려준다', () => {
  const board = boardFrom(['#.......', ...Array(7).fill('........')]);
  const state = deepFreeze(stateWith({ board, tray: [piece('h3'), null, piece('sq3')] }));
  const moves = listMoves(state);

  const expected = [
    ...listPlacements(board, getShape('h3')).map(([row, col]) => ({ trayIndex: 0, row, col })),
    ...listPlacements(board, getShape('sq3')).map(([row, col]) => ({ trayIndex: 2, row, col })),
  ];
  assert.deepEqual(moves, expected);
  assert.ok(moves.every(({ trayIndex, row, col }) => applyMove(state, trayIndex, row, col).ok));
  assert.ok(moves.every(({ trayIndex }) => trayIndex !== 1));
});

test('listMoves: 끝난 게임은 빈 배열이다', () => {
  const state = stateWith({ board: checkerBoard(), tray: [piece('h2'), piece('dot'), piece('v2')] });
  const over = applyMove(state, 1, 0, 1).state;
  assert.equal(over.status, 'over');
  assert.deepEqual(listMoves(over), []);
});

test('불변성: 동결된 입력으로 한 판을 끝까지 두어도 입력을 수정하지 않는다', () => {
  for (const options of [{ mode: 'classic', seed: 11 }, { mode: 'daily', seed: 'blockblast:2026-10-04' }]) {
    let state = deepFreeze(createGame(options));
    const rng = createRng(3);
    while (state.status === 'playing') {
      const before = JSON.stringify(state);
      const { trayIndex, row, col } = randomMove(state, rng);

      previewMove(state, trayIndex, row, col);
      const result = applyMove(state, trayIndex, row, col);
      assert.equal(result.ok, true);
      assert.equal(JSON.stringify(state), before);

      // 이전 상태와 구조를 공유하지 않는다
      assert.notEqual(result.state.board, state.board);
      assert.notEqual(result.state.tray, state.tray);
      for (const event of result.events) {
        if (event.type === 'trayRefill') assert.notEqual(event.tray, result.state.tray);
      }
      state = deepFreeze(result.state);
    }
    assert.equal(isGameOver(state), true);
  }
});

test('불변성: 실패한 이동과 restoreGame도 입력을 수정하지 않는다', () => {
  const state = deepFreeze(createGame({ seed: 5 }));
  applyMove(state, 0, -1, 0);
  applyMove(state, 7, 0, 0);
  previewMove(state, 0, 99, 99);
  listMoves(state);
  isGameOver(state);

  const saved = deepFreeze(clone(state));
  const restored = restoreGame(saved);
  assert.deepEqual(restored, state);
  restored.board[0][0] = 5;
  restored.tray[0].color = 7;
  assert.equal(saved.board[0][0], 0);
  assert.notEqual(saved.tray[0].color, 7);
});

test('결정성: 같은 시드와 같은 수순이면 모든 상태와 이벤트가 똑같다', () => {
  for (const options of [{ mode: 'classic', seed: 2024 }, { mode: 'classic', seed: 'hello' }, { mode: 'daily', seed: 'blockblast:2026-10-04' }]) {
    const a = playRandom(options, 99);
    const b = playRandom(options, 99);
    assert.deepEqual(a.states, b.states);
    assert.deepEqual(a.eventLog, b.eventLog);
    assert.ok(a.states.length > 5);
  }
  assert.notDeepEqual(playRandom({ seed: 1 }, 99).states, playRandom({ seed: 2 }, 99).states);
});

test('결정성: daily는 플레이 내용과 상관없이 같은 트레이 순서가 나온다', () => {
  const seed = 'blockblast:2026-10-04';
  let refills = 0;
  for (const botSeed of [1, 2, 3, 4]) {
    for (const state of playRandom({ mode: 'daily', seed }, botSeed).states) {
      // 트레이가 가득 찬 상태는 방금 만들어진 트레이다
      if (state.tray.every((slot) => slot !== null)) {
        assert.deepEqual(state.tray, generateTray({ mode: 'daily', seed, trayIndex: state.trayIndex }));
        refills++;
      }
    }
  }
  assert.ok(refills > 8);
});

test('restoreGame: JSON을 거친 상태가 시작/진행 중/종료 어디서든 똑같이 복원되고 이어서 같은 결과가 나온다', () => {
  for (const options of [{ mode: 'classic', seed: 77 }, { mode: 'daily', seed: 'blockblast:2026-10-04' }]) {
    const { states } = playRandom(options, 8);
    const picks = [0, 1, Math.floor(states.length / 2), states.length - 1];
    for (const index of picks) {
      const original = states[index];
      const restored = restoreGame(JSON.parse(JSON.stringify(original)));
      assert.deepEqual(restored, original, `index ${index}`);
      assert.notEqual(restored, original);

      if (original.status === 'playing') {
        const rng = createRng(index);
        let a = original;
        let b = restored;
        for (let i = 0; i < 12 && a.status === 'playing'; i++) {
          const { trayIndex, row, col } = randomMove(a, rng);
          const ra = applyMove(a, trayIndex, row, col);
          const rb = applyMove(b, trayIndex, row, col);
          assert.deepEqual(rb, ra);
          a = ra.state;
          b = rb.state;
        }
      }
    }
  }
});

test('restoreGame: 알 수 없는 필드는 버리고 시드는 숫자/문자열 모두 받는다', () => {
  const state = createGame({ seed: 'abc' });
  assert.deepEqual(restoreGame({ ...clone(state), extra: 1 }), state);
  assert.deepEqual(restoreGame(clone(createGame({ seed: 12 }))), createGame({ seed: 12 }));
});

test('restoreGame: 구조가 조금이라도 어긋나면 null이다', () => {
  const valid = playRandom({ seed: 6 }, 6).states[7];
  assert.equal(valid?.status, 'playing');
  assert.notEqual(restoreGame(clone(valid)), null);

  const corruptions = {
    'version 다름': (s) => { s.version = 2; },
    'version 없음': (s) => { delete s.version; },
    '알 수 없는 mode': (s) => { s.mode = 'adventure'; },
    'seed가 객체': (s) => { s.seed = {}; },
    'seed가 null': (s) => { s.seed = null; },
    'seed가 NaN': (s) => { s.seed = NaN; },
    'rngState 음수': (s) => { s.rngState = -1; },
    'rngState 범위 초과': (s) => { s.rngState = 2 ** 32; },
    'rngState 소수': (s) => { s.rngState = 1.5; },
    'rngState 문자열': (s) => { s.rngState = '12'; },
    'board 없음': (s) => { delete s.board; },
    'board가 7행': (s) => { s.board.pop(); },
    'board가 9행': (s) => { s.board.push(Array(8).fill(0)); },
    'board 행 길이 7': (s) => { s.board[3].pop(); },
    'board 행이 배열 아님': (s) => { s.board[2] = 'abcdefgh'; },
    'board 칸 8': (s) => { s.board[0][0] = COLOR_COUNT + 1; },
    'board 칸 음수': (s) => { s.board[0][0] = -1; },
    'board 칸 소수': (s) => { s.board[0][0] = 1.5; },
    'board 칸 문자열': (s) => { s.board[0][0] = '1'; },
    'board 칸 null': (s) => { s.board[0][0] = null; },
    'tray 길이 2': (s) => { s.tray.pop(); },
    'tray 길이 4': (s) => { s.tray.push(null); },
    'tray가 배열 아님': (s) => { s.tray = {}; },
    'tray 모양 id 없음': (s) => { s.tray[0] = { shapeId: 'nope', color: 1 }; },
    'tray 모양 id 상속 속성': (s) => { s.tray[0] = { shapeId: 'constructor', color: 1 }; },
    'tray 색 0': (s) => { s.tray[0] = { shapeId: 'dot', color: 0 }; },
    'tray 색 8': (s) => { s.tray[0] = { shapeId: 'dot', color: COLOR_COUNT + 1 }; },
    'tray 색 소수': (s) => { s.tray[0] = { shapeId: 'dot', color: 1.5 }; },
    'tray 원소 undefined': (s) => { s.tray[0] = undefined; },
    'tray 원소 문자열': (s) => { s.tray[0] = 'dot'; },
    'score 음수': (s) => { s.score = -1; },
    'score 문자열': (s) => { s.score = '10'; },
    'score 무한대': (s) => { s.score = Infinity; },
    'score NaN': (s) => { s.score = NaN; },
    'score 소수': (s) => { s.score = 1.5; },
    'combo 음수': (s) => { s.combo = -1; },
    'maxCombo 없음': (s) => { delete s.maxCombo; },
    'lines 음수': (s) => { s.lines = -3; },
    'moves null': (s) => { s.moves = null; },
    'perfects 음수': (s) => { s.perfects = -1; },
    'trayIndex 음수': (s) => { s.trayIndex = -1; },
    'trayIndex 소수': (s) => { s.trayIndex = 0.5; },
    'status 이상한 값': (s) => { s.status = 'won'; },
    'status 없음': (s) => { delete s.status; },
    'status over인데 둘 곳이 있다': (s) => { s.status = 'over'; },
    'status playing인데 둘 곳이 없다': (s) => {
      s.board = clone(checkerBoard());
      s.tray = [{ shapeId: 'h2', color: 1 }, null, { shapeId: 'v2', color: 2 }];
    },
    'status playing인데 트레이가 비었다': (s) => { s.tray = [null, null, null]; },
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    const saved = clone(valid);
    corrupt(saved);
    assert.equal(restoreGame(saved), null, name);
  }

  for (const bad of [null, undefined, 0, 7, 'state', '{}', [], [valid], () => valid, {}]) {
    assert.equal(restoreGame(bad), null, String(bad));
  }
});

test('restoreGame: 정상적으로 끝난 게임은 over 상태 그대로 복원된다', () => {
  const { states } = playRandom({ seed: 21 }, 21);
  const last = states.at(-1);
  assert.equal(last.status, 'over');
  assert.deepEqual(restoreGame(clone(last)), last);
  assert.equal(applyMove(restoreGame(clone(last)), 0, 0, 0).error, 'game_over');
});
