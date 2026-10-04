import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SIZE } from '../src/config.js';
import {
  canPlace,
  canPlaceAnywhere,
  clearLines,
  cloneBoard,
  countFilled,
  createBoard,
  findFullLines,
  hasAnyMove,
  isBoardEmpty,
  listPlacements,
  placeShape,
} from '../src/core/board.js';
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

test('createBoard는 빈 8x8이고 호출마다 새 배열이다', () => {
  const a = createBoard();
  const b = createBoard();
  assert.equal(a.length, BOARD_SIZE);
  assert.ok(a.every((row) => row.length === BOARD_SIZE && row.every((v) => v === 0)));
  a[0][0] = 3;
  assert.equal(b[0][0], 0);
});

test('cloneBoard는 깊은 복사다', () => {
  const board = boardFrom(['#.......', ...Array(7).fill('........')]);
  const copy = cloneBoard(board);
  assert.deepEqual(copy, board);
  copy[0][0] = 0;
  copy[1][1] = 5;
  assert.equal(board[0][0], 1);
  assert.equal(board[1][1], 0);
});

test('canPlace: 경계 안이면 허용하고 한 칸이라도 벗어나면 거부한다', () => {
  const board = createBoard();
  const h3 = getShape('h3');
  const sq3 = getShape('sq3');
  assert.equal(canPlace(board, h3, 0, 0), true);
  assert.equal(canPlace(board, h3, 7, 5), true);
  assert.equal(canPlace(board, h3, 7, 6), false);
  assert.equal(canPlace(board, h3, -1, 0), false);
  assert.equal(canPlace(board, h3, 0, -1), false);
  assert.equal(canPlace(board, h3, 8, 0), false);
  assert.equal(canPlace(board, sq3, 5, 5), true);
  assert.equal(canPlace(board, sq3, 6, 5), false);
  assert.equal(canPlace(board, sq3, 5, 6), false);
});

test('canPlace: 정수가 아닌 좌표는 거부한다', () => {
  const board = createBoard();
  const dot = getShape('dot');
  for (const [r, c] of [[0.5, 0], [0, 0.5], [NaN, 0], [0, undefined], ['1', 1]]) {
    assert.equal(canPlace(board, dot, r, c), false, `${r},${c}`);
  }
});

test('canPlace: 채워진 칸과 겹치면 거부하고 정확히 맞는 빈 자리는 허용한다', () => {
  const board = boardFrom([
    '###.####',
    '###.####',
    '........',
    ...Array(5).fill('........'),
  ]);
  assert.equal(canPlace(board, getShape('v2'), 0, 3), true);
  assert.equal(canPlace(board, getShape('v3'), 0, 3), true);
  assert.equal(canPlace(board, getShape('h2'), 0, 2), false);
  assert.equal(canPlace(board, getShape('dot'), 0, 0), false);
  assert.equal(canPlace(board, getShape('l3-tr'), 0, 2), false);
  // l3-br의 비어 있는 모퉁이가 채워진 칸(1,2) 위에 놓여도 상관없다
  assert.equal(canPlace(board, getShape('l3-br'), 1, 2), true);
});

test('canPlace: 가득 찬 한 줄 틈에 모양이 딱 맞으면 허용한다', () => {
  const board = boardFrom([
    '########',
    '###..###',
    '###..###',
    '########',
    ...Array(4).fill('........'),
  ]);
  assert.equal(canPlace(board, getShape('sq2'), 1, 3), true);
  assert.equal(canPlace(board, getShape('sq2'), 1, 2), false);
  assert.equal(canPlace(board, getShape('h3'), 1, 2), false);
});

test('placeShape는 새 보드를 돌려주고 입력을 수정하지 않는다', () => {
  const board = deepFreeze(createBoard());
  const next = placeShape(board, getShape('l3-tl'), 2, 3, 4);
  assert.notEqual(next, board);
  assert.equal(countFilled(board), 0);
  assert.deepEqual(
    next.flatMap((row, r) => row.flatMap((v, c) => (v === 4 ? [[r, c]] : []))),
    [[2, 3], [2, 4], [3, 3]],
  );
});

test('placeShape는 놓을 수 없는 위치와 잘못된 색을 거부한다', () => {
  const board = placeShape(createBoard(), getShape('dot'), 0, 0, 1);
  assert.throws(() => placeShape(board, getShape('dot'), 0, 0, 2), RangeError);
  assert.throws(() => placeShape(board, getShape('h2'), 0, 7, 2), RangeError);
  assert.throws(() => placeShape(board, getShape('dot'), 1, 1, 0), RangeError);
  assert.throws(() => placeShape(board, getShape('dot'), 1, 1, 8), RangeError);
  assert.throws(() => placeShape(board, getShape('dot'), 1, 1, 1.5), RangeError);
});

test('findFullLines: 행만, 열만, 없음', () => {
  const rowOnly = boardFrom(['........', '........', '########', ...Array(5).fill('........')]);
  assert.deepEqual(findFullLines(rowOnly), { rows: [2], cols: [] });

  const colOnly = boardFrom(Array(8).fill('.....#..'));
  assert.deepEqual(findFullLines(colOnly), { rows: [], cols: [5] });

  assert.deepEqual(findFullLines(createBoard()), { rows: [], cols: [] });
  assert.deepEqual(findFullLines(boardFrom(['#######.', ...Array(7).fill('........')])), { rows: [], cols: [] });
});

test('findFullLines: 행과 열이 교차해도 모두 찾는다(가이드 13.1 예시)', () => {
  const board = Array.from({ length: 8 }, (_, r) =>
    Array.from({ length: 8 }, (_, c) => (r === 2 || c === 5 ? 1 : 0)));
  assert.deepEqual(findFullLines(board), { rows: [2], cols: [5] });
});

test('findFullLines: 여러 줄은 오름차순이다', () => {
  const board = boardFrom([
    '########',
    '.......#',
    '########',
    '.......#',
    '.......#',
    '.......#',
    '.......#',
    '.......#',
  ]);
  assert.deepEqual(findFullLines(board), { rows: [0, 2], cols: [7] });
});

test('clearLines: 행+열이 동시에 지워지고 교차 칸은 한 번만 보고된다', () => {
  const board = boardFrom([
    '...2....',
    '...2....',
    '11121111',
    '...3....',
    '...3....',
    '...3....',
    '...3....',
    '...3....',
  ]);
  // 2행은 모두 채움(교차 칸 (2,3)=2), 3열도 모두 채움
  const lines = findFullLines(board);
  assert.deepEqual(lines, { rows: [2], cols: [3] });

  const { board: next, clearedCells } = clearLines(board, lines);
  assert.equal(clearedCells.length, 15);
  assert.equal(new Set(clearedCells.map(({ r, c }) => `${r},${c}`)).size, 15);
  assert.equal(clearedCells.filter(({ r, c }) => r === 2 && c === 3).length, 1);
  assert.deepEqual(clearedCells.find(({ r, c }) => r === 2 && c === 3), { r: 2, c: 3, color: 2 });
  assert.deepEqual(clearedCells[0], { r: 0, c: 3, color: 2 });
  assert.deepEqual(clearedCells[clearedCells.length - 1], { r: 7, c: 3, color: 3 });
  assert.ok(isBoardEmpty(next));
});

test('clearLines: 색은 지우기 전 값이고 clearedCells는 행 우선 순서다', () => {
  const board = boardFrom([
    '1234567.',
    '.......1',
    '.......2',
    '.......3',
    '.......4',
    '.......5',
    '.......6',
    '1234567#',
  ]);
  const lines = findFullLines(board);
  assert.deepEqual(lines, { rows: [7], cols: [] });
  const { clearedCells } = clearLines(board, lines);
  assert.deepEqual(clearedCells.map(({ color }) => color), [1, 2, 3, 4, 5, 6, 7, 1]);
  assert.deepEqual(clearedCells.map(({ r, c }) => [r, c]), Array.from({ length: 8 }, (_, c) => [7, c]));
});

test('clearLines: 지우지 않는 칸은 그대로이고 입력은 수정되지 않는다', () => {
  const board = deepFreeze(boardFrom([
    '#.......',
    '########',
    '#.......',
    '#.......',
    '#...3...',
    '#.......',
    '#.......',
    '#.......',
  ]));
  const lines = findFullLines(board);
  assert.deepEqual(lines, { rows: [1], cols: [0] });
  const { board: next } = clearLines(board, lines);
  assert.equal(countFilled(next), 1);
  assert.equal(next[4][4], 3);
  assert.equal(countFilled(board), 8 + 7 + 1);
});

test('clearLines: 지울 줄이 없으면 같은 내용의 새 보드와 빈 목록을 준다', () => {
  const board = boardFrom(['#.......', ...Array(7).fill('........')]);
  const { board: next, clearedCells } = clearLines(board, { rows: [], cols: [] });
  assert.deepEqual(next, board);
  assert.notEqual(next, board);
  assert.deepEqual(clearedCells, []);
});

test('clearLines: 가득 차지 않은 줄을 지정해도 실제로 블록이 있던 칸만 보고한다', () => {
  const board = boardFrom(['#.#.....', ...Array(7).fill('........')]);
  const { clearedCells } = clearLines(board, { rows: [0], cols: [] });
  assert.deepEqual(clearedCells, [{ r: 0, c: 0, color: 1 }, { r: 0, c: 2, color: 1 }]);
});

test('퍼펙트 클리어: 줄을 지운 뒤 보드가 비면 isBoardEmpty가 true다', () => {
  const almost = boardFrom(['#######.', ...Array(7).fill('........')]);
  const placed = placeShape(almost, getShape('dot'), 0, 7, 3);
  const { board } = clearLines(placed, findFullLines(placed));
  assert.equal(isBoardEmpty(board), true);

  const leftover = placeShape(placed, getShape('dot'), 5, 5, 3);
  const cleared = clearLines(leftover, findFullLines(leftover)).board;
  assert.equal(isBoardEmpty(cleared), false);
  assert.equal(countFilled(cleared), 1);
});

test('countFilled와 isBoardEmpty', () => {
  assert.equal(countFilled(createBoard()), 0);
  assert.equal(isBoardEmpty(createBoard()), true);
  const board = boardFrom(['#.#.....', '.3......', ...Array(6).fill('........')]);
  assert.equal(countFilled(board), 3);
  assert.equal(isBoardEmpty(board), false);
});

test('listPlacements: 빈 보드에서의 자리 수와 순서', () => {
  const board = createBoard();
  assert.equal(listPlacements(board, getShape('dot')).length, 64);
  assert.equal(listPlacements(board, getShape('h5')).length, 8 * 4);
  assert.equal(listPlacements(board, getShape('v4')).length, 5 * 8);
  assert.equal(listPlacements(board, getShape('sq3')).length, 36);
  assert.deepEqual(listPlacements(board, getShape('sq3')).slice(0, 3), [[0, 0], [0, 1], [0, 2]]);
  assert.deepEqual(listPlacements(board, getShape('sq3')).at(-1), [5, 5]);
});

test('listPlacements: 채워진 칸을 피하고 canPlace와 일치한다', () => {
  const board = boardFrom([
    '#.......',
    '........',
    '..##....',
    ...Array(5).fill('........'),
  ]);
  for (const id of ['dot', 'h2', 'v3', 'sq2', 'l3-br', 't-0', 'sq3']) {
    const shape = getShape(id);
    const expected = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) if (canPlace(board, shape, r, c)) expected.push([r, c]);
    }
    assert.deepEqual(listPlacements(board, shape), expected, id);
  }
  assert.ok(!listPlacements(board, getShape('dot')).some(([r, c]) => r === 0 && c === 0));
});

test('canPlaceAnywhere', () => {
  const full = boardFrom(Array(8).fill('##.#####'));
  assert.equal(canPlaceAnywhere(full, getShape('dot')), true);
  assert.equal(canPlaceAnywhere(full, getShape('v2')), true);
  assert.equal(canPlaceAnywhere(full, getShape('h2')), false);
  assert.equal(canPlaceAnywhere(full, getShape('v5')), true);
  assert.equal(canPlaceAnywhere(createBoard(), getShape('sq3')), true);

  const checker = boardFrom(Array.from({ length: 8 }, (_, r) => (r % 2 ? '.#.#.#.#' : '#.#.#.#.')));
  assert.equal(canPlaceAnywhere(checker, getShape('dot')), true);
  assert.equal(canPlaceAnywhere(checker, getShape('h2')), false);
  assert.equal(canPlaceAnywhere(checker, getShape('v2')), false);
});

test('hasAnyMove: 하나라도 놓을 수 있으면 true, null 슬롯은 무시한다', () => {
  const checker = boardFrom(Array.from({ length: 8 }, (_, r) => (r % 2 ? '.#.#.#.#' : '#.#.#.#.')));
  const dot = getShape('dot');
  const h2 = getShape('h2');
  assert.equal(hasAnyMove(checker, [h2, h2, h2]), false);
  assert.equal(hasAnyMove(checker, [h2, null, dot]), true);
  assert.equal(hasAnyMove(checker, [null, null, null]), false);
  assert.equal(hasAnyMove(checker, []), false);
  assert.equal(hasAnyMove(createBoard(), [null, getShape('sq3'), null]), true);
});

test('보드 함수들은 동결된 입력에도 예외 없이 동작한다', () => {
  const board = deepFreeze(boardFrom(['###.####', ...Array(7).fill('........')]));
  const shape = getShape('h2');
  canPlace(board, shape, 0, 0);
  canPlaceAnywhere(board, shape);
  listPlacements(board, shape);
  hasAnyMove(board, [shape]);
  findFullLines(board);
  countFilled(board);
  isBoardEmpty(board);
  cloneBoard(board);
  placeShape(board, getShape('dot'), 0, 3, 1);
});
