import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATOR } from '../src/config.js';
import { SHAPES, SHAPE_LIST, getShape, hasShape } from '../src/core/shapes.js';

const cellKey = (cells) => cells.map(([r, c]) => `${r},${c}`).sort().join(';');

// 90도 회전 후 다시 좌상단으로 정규화
const rotate = (cells) => {
  const height = Math.max(...cells.map(([r]) => r)) + 1;
  const rotated = cells.map(([r, c]) => [c, height - 1 - r]);
  const minR = Math.min(...rotated.map(([r]) => r));
  const minC = Math.min(...rotated.map(([, c]) => c));
  return rotated.map(([r, c]) => [r - minR, c - minC]);
};

const mirror = (cells) => {
  const width = Math.max(...cells.map(([, c]) => c)) + 1;
  return cells.map(([r, c]) => [r, width - 1 - c]);
};

test('카탈로그는 가이드 5.3대로 37종이다', () => {
  assert.equal(SHAPE_LIST.length, 37);
  const perFamily = {};
  for (const shape of SHAPE_LIST) perFamily[shape.family] = (perFamily[shape.family] ?? 0) + 1;
  assert.deepEqual(perFamily, {
    dot: 1,
    line: 8,
    square: 2,
    rect: 2,
    smallL: 4,
    bigL: 4,
    lTetro: 8,
    tee: 4,
    skew: 4,
  });
});

test('id는 유일하고 SHAPES의 키와 일치한다', () => {
  const ids = SHAPE_LIST.map((shape) => shape.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(Object.keys(SHAPES), ids);
  for (const shape of SHAPE_LIST) assert.equal(SHAPES[shape.id], shape);
});

test('모든 모양은 최소 행/열이 0으로 정규화되어 있고 크기 필드가 맞다', () => {
  for (const shape of SHAPE_LIST) {
    const rows = shape.cells.map(([r]) => r);
    const cols = shape.cells.map(([, c]) => c);
    assert.equal(Math.min(...rows), 0, `${shape.id} min row`);
    assert.equal(Math.min(...cols), 0, `${shape.id} min col`);
    assert.equal(shape.height, Math.max(...rows) + 1, `${shape.id} height`);
    assert.equal(shape.width, Math.max(...cols) + 1, `${shape.id} width`);
    assert.equal(shape.size, shape.cells.length, `${shape.id} size`);
    assert.equal(new Set(shape.cells.map(([r, c]) => `${r},${c}`)).size, shape.size, `${shape.id} 중복 칸`);
  }
});

test('칸은 행 우선 순서이고 서로 이어져 있다', () => {
  for (const shape of SHAPE_LIST) {
    const keys = shape.cells.map(([r, c]) => r * 10 + c);
    assert.deepEqual(keys, [...keys].sort((a, b) => a - b), `${shape.id} 정렬`);

    const seen = new Set([keys[0]]);
    const queue = [shape.cells[0]];
    while (queue.length > 0) {
      const [r, c] = queue.pop();
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        const key = nr * 10 + nc;
        if (keys.includes(key) && !seen.has(key)) {
          seen.add(key);
          queue.push([nr, nc]);
        }
      }
    }
    assert.equal(seen.size, shape.size, `${shape.id} 연결`);
  }
});

test('칸 집합이 같은 모양은 없다', () => {
  const keys = SHAPE_LIST.map((shape) => cellKey(shape.cells));
  assert.equal(new Set(keys).size, keys.length);
});

test('회전과 좌우 반전에 닫혀 있다(모든 방향이 각자의 모양으로 등록됨)', () => {
  const catalog = new Set(SHAPE_LIST.map((shape) => cellKey(shape.cells)));
  for (const shape of SHAPE_LIST) {
    let cells = shape.cells.map(([r, c]) => [r, c]);
    for (let turn = 0; turn < 4; turn++) {
      cells = rotate(cells);
      assert.ok(catalog.has(cellKey(cells)), `${shape.id} 회전 ${turn + 1}`);
    }
    assert.ok(catalog.has(cellKey(mirror(shape.cells))), `${shape.id} 반전`);
  }
});

test('모든 모양은 빈 8x8 보드에 들어가고 계열 이름이 설정에 있다', () => {
  for (const shape of SHAPE_LIST) {
    assert.ok(shape.width <= 8 && shape.height <= 8, shape.id);
    assert.ok(shape.family in GENERATOR.familyWeights, `${shape.id}: ${shape.family}`);
  }
  for (const family of Object.keys(GENERATOR.familyWeights)) {
    assert.ok(SHAPE_LIST.some((shape) => shape.family === family), `계열 ${family}에 모양이 없다`);
  }
});

test('모양 데이터는 깊게 동결되어 있다', () => {
  assert.ok(Object.isFrozen(SHAPES));
  assert.ok(Object.isFrozen(SHAPE_LIST));
  for (const shape of SHAPE_LIST) {
    assert.ok(Object.isFrozen(shape), shape.id);
    assert.ok(Object.isFrozen(shape.cells), shape.id);
    for (const cell of shape.cells) assert.ok(Object.isFrozen(cell), shape.id);
  }
});

test('대표 모양의 칸이 그림대로다', () => {
  assert.deepEqual(getShape('dot').cells, [[0, 0]]);
  assert.deepEqual(getShape('h3').cells, [[0, 0], [0, 1], [0, 2]]);
  assert.deepEqual(getShape('v2').cells, [[0, 0], [1, 0]]);
  assert.deepEqual(getShape('r2x3').cells, [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
  assert.deepEqual(getShape('l3-br').cells, [[0, 1], [1, 0], [1, 1]]);
  assert.deepEqual(getShape('l5-tl').cells, [[0, 0], [0, 1], [0, 2], [1, 0], [2, 0]]);
  assert.deepEqual(getShape('t-0').cells, [[0, 0], [0, 1], [0, 2], [1, 1]]);
  assert.deepEqual(getShape('s-h').cells, [[0, 1], [0, 2], [1, 0], [1, 1]]);
});

test('getShape는 모르는 id에서 예외를 던지고 hasShape는 false를 준다', () => {
  assert.throws(() => getShape('nope'), /unknown shape/);
  assert.throws(() => getShape('constructor'), /unknown shape/);
  assert.throws(() => getShape(undefined), /unknown shape/);
  assert.equal(hasShape('h3'), true);
  assert.equal(hasShape('toString'), false);
  assert.equal(hasShape(3), false);
});
