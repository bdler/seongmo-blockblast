import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SIZE, COLOR_COUNT, GENERATOR, TRAY_SIZE } from '../src/config.js';
import {
  clearLines,
  countFilled,
  createBoard,
  findFullLines,
  listPlacements,
  placeShape,
} from '../src/core/board.js';
import { generateTray, isTraySolvable, weightsFor } from '../src/core/generator.js';
import { createRng } from '../src/core/rng.js';
import { SHAPE_LIST, getShape } from '../src/core/shapes.js';

// '.'은 빈칸, '#'은 색 1
const boardFrom = (rows) => rows.map((line) => [...line].map((ch) => (ch === '.' ? 0 : 1)));

// 서로 맞닿은 빈칸이 없는 체커보드(32칸 채움). 점 블록만 놓을 수 있다
const checkerBoard = () =>
  boardFrom(Array.from({ length: 8 }, (_, r) => (r % 2 ? '.#.#.#.#' : '#.#.#.#.')));

// 7행의 빈칸이 (7,7) 하나뿐이고 나머지 빈칸은 서로 떨어져 있어 h5를 놓을 자리가 없다.
// 점으로 7행을 지워야 h5 자리가 생긴다
const clearNeededBoard = () =>
  boardFrom([...Array.from({ length: 7 }, (_, r) => (r % 2 ? '.#.#.#.#' : '#.#.#.#.')), '#######.']);

// 앞에서부터 n칸을 채운 보드(채움 비율 계산 확인용)
const filledBoard = (n) => {
  const board = createBoard();
  for (let i = 0; i < n; i++) board[Math.floor(i / BOARD_SIZE)][i % BOARD_SIZE] = 1;
  return board;
};

// 칸마다 확률 ratio로 무작위 색을 채우고, 가득 찬 줄은 지운다(실제 게임에는 가득 찬 줄이 남지 않는다)
const randomBoard = (rng, ratio) => {
  const board = createBoard().map((row) => row.map(() => (rng.next() < ratio ? 1 + rng.int(COLOR_COUNT) : 0)));
  return clearLines(board, findFullLines(board)).board;
};

const pieces = (...ids) => ids.map((shapeId, i) => ({ shapeId, color: i + 1 }));
const shapeOf = (piece) => getShape(piece.shapeId);

// isTraySolvable과 별개로 구현한 전수 탐색(순서·위치·줄 제거 모두 시뮬레이션)
function bruteSolvable(board, shapes) {
  if (shapes.length === 0) return true;
  return shapes.some((shape, i) => {
    const rest = shapes.filter((_, j) => j !== i);
    return listPlacements(board, shape).some(([r, c]) => {
      const placed = placeShape(board, shape, r, c, 1);
      return bruteSolvable(clearLines(placed, findFullLines(placed)).board, rest);
    });
  });
}

const share = (weights, predicate) => {
  const total = weights.reduce((a, b) => a + b, 0);
  const part = SHAPE_LIST.reduce((sum, shape, i) => sum + (predicate(shape) ? weights[i] : 0), 0);
  return part / total;
};

test('weightsFor는 SHAPE_LIST 순서의 양수 가중치를 돌려준다', () => {
  for (const n of [0, 20, 40, 60]) {
    const weights = weightsFor(filledBoard(n), 0);
    assert.equal(weights.length, SHAPE_LIST.length);
    assert.ok(weights.every((w) => Number.isFinite(w) && w > 0), `fill ${n}`);
  }
});

test('weightsFor: 중간 채움에서는 계열 비중을 계열 안의 모양 수로 나눈 값에 점수 구간 배수만 곱한다', () => {
  const weights = weightsFor(filledBoard(Math.round(64 * 0.45)), 0);
  const familySize = (family) => SHAPE_LIST.filter((shape) => shape.family === family).length;
  const hardMul = GENERATOR.scoreTiers.filter((tier) => tier.minScore <= 0).at(-1).hardMul;
  SHAPE_LIST.forEach((shape, i) => {
    const mul = GENERATOR.hardFamilies.includes(shape.family) ? hardMul : 1;
    const expected = (GENERATOR.familyWeights[shape.family] / familySize(shape.family)) * mul;
    assert.ok(Math.abs(weights[i] - expected) < 1e-12, shape.id);
  });
});

test('weightsFor: 채움 30% 미만이면 큰 블록, 60% 초과면 작은 블록의 비중이 커진다', () => {
  const big = (shape) => shape.size >= GENERATOR.bigMinSize;
  const small = (shape) => shape.size <= GENERATOR.smallMaxSize;
  const low = weightsFor(filledBoard(10), 0);
  const mid = weightsFor(filledBoard(30), 0);
  const high = weightsFor(filledBoard(50), 0);

  assert.ok(share(low, big) > share(mid, big));
  assert.ok(share(high, big) < share(mid, big));
  assert.ok(share(high, small) > share(mid, small));
  assert.ok(share(low, small) < share(mid, small));
});

test('weightsFor: 채움 비율이 기준값과 같으면 중간 구간이다(미만/초과만 조정)', () => {
  const cfg = { ...GENERATOR, fill: { ...GENERATOR.fill, low: 0.25, high: 0.5 } };
  const mid = weightsFor(filledBoard(24), 0, cfg);
  assert.deepEqual(weightsFor(filledBoard(16), 0, cfg), mid);
  assert.deepEqual(weightsFor(filledBoard(32), 0, cfg), mid);
  assert.notDeepEqual(weightsFor(filledBoard(15), 0, cfg), mid);
  assert.notDeepEqual(weightsFor(filledBoard(33), 0, cfg), mid);
});

test('weightsFor: 점수가 높아질수록 까다로운 계열 가중치만 커진다', () => {
  const board = filledBoard(30);
  const tiers = GENERATOR.scoreTiers.map((tier) => weightsFor(board, tier.minScore));
  for (let t = 1; t < tiers.length; t++) {
    SHAPE_LIST.forEach((shape, i) => {
      if (GENERATOR.hardFamilies.includes(shape.family)) {
        assert.ok(tiers[t][i] > tiers[t - 1][i], `${shape.id} 구간 ${t}`);
      } else {
        assert.equal(tiers[t][i], tiers[t - 1][i], `${shape.id} 구간 ${t}`);
      }
    });
  }
  assert.deepEqual(weightsFor(board, 1e9), tiers.at(-1));
});

test('isTraySolvable: 빈 보드에서는 어떤 조합이든 해결 가능하다', () => {
  const board = createBoard();
  assert.equal(isTraySolvable(board, pieces('sq3', 'sq3', 'sq3')), true);
  assert.equal(isTraySolvable(board, pieces('h5', 'v5', 'l5-tl')), true);
  assert.equal(isTraySolvable(board, pieces('dot', 'dot', 'dot')), true);
});

test('isTraySolvable: 놓을 곳이 없거나 자리를 두고 다투면 false다', () => {
  const checker = checkerBoard();
  assert.equal(isTraySolvable(checker, pieces('dot', 'dot', 'dot')), true);
  assert.equal(isTraySolvable(checker, pieces('h2', 'dot', 'dot')), false);
  assert.equal(isTraySolvable(checker, pieces('dot', 'v2', 'dot')), false);

  // (0,0)을 비워 단 하나의 두 칸 자리가 생기게 한다
  const oneSlot = checkerBoard();
  oneSlot[0][0] = 0;
  assert.equal(isTraySolvable(oneSlot, pieces('h2', 'dot', 'dot')), true);
  assert.equal(isTraySolvable(oneSlot, pieces('l3-tl', 'dot', 'dot')), true);
  assert.equal(isTraySolvable(oneSlot, pieces('h2', 'h2', 'dot')), false);
});

test('isTraySolvable: 줄 제거로 칸이 비는 것까지 시뮬레이션한다', () => {
  const board = clearNeededBoard();
  assert.deepEqual(findFullLines(board), { rows: [], cols: [] });
  assert.equal(listPlacements(board, getShape('h5')).length, 0);

  assert.equal(isTraySolvable(board, pieces('h5', 'dot', 'dot'), 1e6), true);
  assert.equal(isTraySolvable(board, pieces('h5', 'h5', 'dot'), 1e6), false);
});

test('isTraySolvable: 노드 예산을 다 쓰면 해결 가능으로 간주한다', () => {
  const board = clearNeededBoard();
  const impossible = pieces('h5', 'h5', 'dot');
  assert.equal(isTraySolvable(board, impossible, 1e6), false);
  assert.equal(isTraySolvable(board, impossible, 0), true);
  assert.equal(isTraySolvable(board, impossible, 1), true);
});

test('isTraySolvable: null 슬롯은 무시한다', () => {
  const board = checkerBoard();
  assert.equal(isTraySolvable(board, [null, { shapeId: 'dot', color: 1 }, null]), true);
  assert.equal(isTraySolvable(board, [null, { shapeId: 'h2', color: 1 }, null]), false);
  assert.equal(isTraySolvable(board, [null, null, null]), true);
});

test('isTraySolvable은 입력 보드를 수정하지 않고 독립 구현의 전수 탐색과 결과가 같다', () => {
  const rng = createRng(31337);
  let solvable = 0;
  let unsolvable = 0;
  for (let i = 0; i < 150; i++) {
    const board = randomBoard(rng, 0.5 + rng.next() * 0.3);
    const before = JSON.stringify(board);
    const shapes = Array.from({ length: TRAY_SIZE }, () => rng.pick(SHAPE_LIST));
    const trayPieces = shapes.map((shape) => ({ shapeId: shape.id, color: 1 }));

    const expected = bruteSolvable(board, shapes);
    assert.equal(isTraySolvable(board, trayPieces, 1e9), expected, `case ${i}: ${shapes.map((s) => s.id)}`);
    assert.equal(JSON.stringify(board), before);
    if (expected) solvable++;
    else unsolvable++;
  }
  assert.ok(solvable >= 10 && unsolvable >= 10, `해결 가능 ${solvable} / 불가능 ${unsolvable}`);
});

test('classic: 무작위 보드 1000개(채움 0~70%)에서 트레이는 해결 가능하거나 작은 블록 폴백이다', () => {
  let unsolvable = 0;
  for (let i = 0; i < 1000; i++) {
    const rng = createRng(i + 1);
    const board = randomBoard(rng, rng.next() * 0.7);
    const before = JSON.stringify(board);
    const tray = generateTray({ board, rng, mode: 'classic', trayIndex: 1, score: rng.int(6000) });

    assert.equal(JSON.stringify(board), before, '보드를 수정하면 안 된다');
    assert.equal(tray.length, TRAY_SIZE);
    for (const piece of tray) {
      assert.ok(SHAPE_LIST.some((shape) => shape.id === piece.shapeId));
      assert.ok(Number.isInteger(piece.color) && piece.color >= 1 && piece.color <= COLOR_COUNT);
    }
    if (!isTraySolvable(board, tray, GENERATOR.nodeBudget)) {
      unsolvable++;
      assert.ok(
        tray.every((piece) => shapeOf(piece).size <= GENERATOR.smallMaxSize),
        `해결 불가능한 트레이는 작은 블록 폴백이어야 한다 (case ${i})`,
      );
    }
  }
  assert.ok(unsolvable <= 10, `해결 불가능한 트레이 ${unsolvable}개`);
});

test('classic: 같은 보드와 같은 rng 상태면 같은 트레이를 만들고 rng를 소비한다', () => {
  const board = randomBoard(createRng(4), 0.4);
  const a = createRng(777);
  const b = createRng(777);
  const start = a.state();
  const trayA = generateTray({ board, rng: a, mode: 'classic', trayIndex: 3, score: 120 });
  const trayB = generateTray({ board, rng: b, mode: 'classic', trayIndex: 3, score: 120 });
  assert.deepEqual(trayA, trayB);
  assert.equal(a.state(), b.state());
  assert.notEqual(a.state(), start);

  const resumed = createRng(start);
  assert.deepEqual(generateTray({ board, rng: resumed, mode: 'classic', trayIndex: 3, score: 120 }), trayA);
});

test('classic: 맞닿은 빈칸이 없는 보드에서는 점 3개가 나온다(해결 가능한 유일한 조합)', () => {
  const board = checkerBoard();
  for (let seed = 1; seed <= 25; seed++) {
    const tray = generateTray({ board, rng: createRng(seed), mode: 'classic', trayIndex: 1, score: 0 });
    assert.deepEqual(tray.map((piece) => piece.shapeId), ['dot', 'dot', 'dot'], `seed ${seed}`);
  }
});

test('classic: 재뽑기를 못 하게 하면 해결 가능한 작은 블록 조합으로 폴백한다', () => {
  const cfg = { ...GENERATOR, maxRerolls: 0 };
  const board = createBoard();
  for (let seed = 1; seed <= 25; seed++) {
    const tray = generateTray({ board, rng: createRng(seed), mode: 'classic', trayIndex: 1, score: 0, cfg });
    assert.ok(tray.every((piece) => shapeOf(piece).size <= GENERATOR.smallMaxSize), `seed ${seed}`);
    assert.equal(isTraySolvable(board, tray), true);
  }

  // 작은 블록 조합조차 못 찾으면 점 3개
  const hopeless = { ...cfg, fallbackAttempts: 0 };
  const tray = generateTray({ board, rng: createRng(1), mode: 'classic', trayIndex: 1, score: 0, cfg: hopeless });
  assert.deepEqual(tray.map((piece) => piece.shapeId), ['dot', 'dot', 'dot']);
});

test('색은 1~COLOR_COUNT이고 한 트레이 안에서 서로 다르며 모든 색이 나온다', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const tray = generateTray({ board: createBoard(), rng: createRng(i), mode: 'classic' });
    const colors = tray.map((piece) => piece.color);
    assert.equal(new Set(colors).size, TRAY_SIZE, `case ${i}: ${colors}`);
    for (const color of colors) {
      assert.ok(Number.isInteger(color) && color >= 1 && color <= COLOR_COUNT);
      seen.add(color);
    }
  }
  assert.equal(seen.size, COLOR_COUNT);
});

test('daily: 트레이는 (seed, trayIndex)만의 함수이고 보드/점수/rng와 무관하다', () => {
  const seed = 'blockblast:2026-10-04';
  const nearlyFull = boardFrom(Array(8).fill('######.#'));
  const rng = createRng(1);
  const before = rng.state();

  const reference = generateTray({ mode: 'daily', seed, trayIndex: 4 });
  assert.equal(reference.length, TRAY_SIZE);
  assert.deepEqual(generateTray({ mode: 'daily', seed, trayIndex: 4 }), reference);
  assert.deepEqual(generateTray({ board: createBoard(), rng, mode: 'daily', seed, trayIndex: 4 }), reference);
  assert.deepEqual(generateTray({ board: nearlyFull, rng, mode: 'daily', seed, trayIndex: 4, score: 99999 }), reference);
  assert.deepEqual(
    generateTray({ board: nearlyFull, rng: createRng(999), mode: 'daily', seed, trayIndex: 4, cfg: { ...GENERATOR, maxRerolls: 0 } }),
    reference,
  );
  assert.equal(rng.state(), before, 'daily는 전달된 rng를 소비하지 않는다');
});

test('daily: 날짜 시드마다 재현 가능한 서로 다른 순서가 나온다', () => {
  const sequence = (seed) => Array.from({ length: 30 }, (_, n) => generateTray({ mode: 'daily', seed, trayIndex: n }));
  const today = sequence('blockblast:2026-10-04');
  assert.deepEqual(sequence('blockblast:2026-10-04'), today);
  assert.notDeepEqual(sequence('blockblast:2026-10-05'), today);
  assert.ok(new Set(today.map((tray) => JSON.stringify(tray))).size >= 25, '트레이마다 달라야 한다');

  for (const tray of today) {
    assert.equal(new Set(tray.map((piece) => piece.color)).size, TRAY_SIZE);
    for (const piece of tray) assert.ok(getShape(piece.shapeId));
  }
});

test('daily: 숫자 시드도 쓸 수 있다', () => {
  assert.deepEqual(generateTray({ mode: 'daily', seed: 12345, trayIndex: 0 }), generateTray({ mode: 'daily', seed: 12345, trayIndex: 0 }));
  assert.notDeepEqual(generateTray({ mode: 'daily', seed: 12345, trayIndex: 0 }), generateTray({ mode: 'daily', seed: 12346, trayIndex: 0 }));
});

test('generateTray: classic은 점수가 높을수록 까다로운 모양이 더 자주 나온다', () => {
  const hardCount = (score) => {
    let count = 0;
    for (let i = 0; i < 400; i++) {
      const tray = generateTray({ board: createBoard(), rng: createRng(i), mode: 'classic', score });
      count += tray.filter((piece) => GENERATOR.hardFamilies.includes(shapeOf(piece).family)).length;
    }
    return count;
  };
  assert.ok(hardCount(0) < hardCount(9000));
});
