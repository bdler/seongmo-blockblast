import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, hashSeed, mulberry32, seedToInt } from '../src/core/rng.js';

// 가이드 6.4의 참조 구현. 이 모듈의 결과와 비트 단위로 같아야 한다
function referenceMulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const draw = (rng, n) => Array.from({ length: n }, () => rng.next());

test('hashSeed는 FNV-1a 표준 값과 같다', () => {
  assert.equal(hashSeed(''), 2166136261);
  assert.equal(hashSeed('a'), 0xe40c292c);
  assert.equal(hashSeed('foobar'), 0xbf9cf968);
});

test('hashSeed는 uint32를 돌려주고 같은 입력에 같은 값을 준다', () => {
  for (const text of ['blockblast:2026-10-04', '성모', '😀', 'x'.repeat(1000)]) {
    const h = hashSeed(text);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32, text);
    assert.equal(hashSeed(text), h);
  }
  assert.notEqual(hashSeed('blockblast:2026-10-04'), hashSeed('blockblast:2026-10-05'));
});

test('seedToInt는 숫자와 문자열을 받아 uint32로 바꾼다', () => {
  assert.equal(seedToInt(42), 42);
  assert.equal(seedToInt(-1), 4294967295);
  assert.equal(seedToInt(2 ** 32 + 7), 7);
  assert.equal(seedToInt(3.9), 3);
  assert.equal(seedToInt('abc'), hashSeed('abc'));
  assert.throws(() => seedToInt(NaN), TypeError);
  assert.throws(() => seedToInt(Infinity), TypeError);
  assert.throws(() => seedToInt(null), TypeError);
  assert.throws(() => seedToInt({}), TypeError);
});

test('같은 시드는 같은 수열을 만들고 다른 시드는 다른 수열을 만든다', () => {
  assert.deepEqual(draw(createRng(123), 50), draw(createRng(123), 50));
  assert.deepEqual(draw(createRng('hello'), 50), draw(createRng('hello'), 50));
  assert.notDeepEqual(draw(createRng(123), 5), draw(createRng(124), 5));
  assert.notDeepEqual(draw(createRng('a'), 5), draw(createRng('b'), 5));
});

test('createRng와 mulberry32는 참조 구현과 같은 수열이다', () => {
  for (const seed of [0, 1, 123456, 4294967295]) {
    const reference = referenceMulberry32(seed);
    const rng = createRng(seed);
    const fn = mulberry32(seed);
    for (let i = 0; i < 100; i++) {
      const expected = reference();
      assert.equal(rng.next(), expected);
      assert.equal(fn(), expected);
    }
  }
});

test('next는 [0, 1) 범위이고 분포가 대체로 고르다', () => {
  const rng = createRng(2024);
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / n - 0.5) < 0.02, `평균 ${sum / n}`);
});

test('state()로 만든 새 rng는 같은 흐름을 정확히 이어간다', () => {
  const rng = createRng(99);
  draw(rng, 17);
  const resumed = createRng(rng.state());
  assert.deepEqual(draw(rng, 30), draw(resumed, 30));
  assert.equal(rng.state(), resumed.state());
});

test('state()는 uint32이고 이어받은 rng의 int/pick/weightedIndex도 같다', () => {
  const rng = createRng('seed');
  rng.int(10);
  const state = rng.state();
  assert.ok(Number.isInteger(state) && state >= 0 && state < 2 ** 32);

  const a = createRng(state);
  const b = createRng(state);
  const items = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 20; i++) {
    assert.equal(a.int(7), b.int(7));
    assert.equal(a.pick(items), b.pick(items));
    assert.equal(a.weightedIndex([1, 2, 3]), b.weightedIndex([1, 2, 3]));
  }
});

test('int는 0 이상 max 미만의 정수를 모든 값으로 고르게 낸다', () => {
  const rng = createRng(5);
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 6000; i++) {
    const v = rng.int(6);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 6);
    counts[v]++;
  }
  for (const count of counts) assert.ok(count > 800 && count < 1200, `분포 ${counts}`);
  assert.equal(createRng(1).int(1), 0);
});

test('int는 잘못된 인자를 거부한다', () => {
  const rng = createRng(1);
  for (const bad of [0, -1, 1.5, NaN, Infinity, '3']) {
    assert.throws(() => rng.int(bad), RangeError, String(bad));
  }
});

test('pick은 배열의 원소를 고르고 빈 배열은 거부한다', () => {
  const rng = createRng(8);
  const items = [10, 20, 30];
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(rng.pick(items));
  assert.deepEqual([...seen].sort(), [10, 20, 30]);
  assert.throws(() => rng.pick([]), RangeError);
});

test('weightedIndex는 가중치에 비례하고 0 가중치는 절대 뽑지 않는다', () => {
  const rng = createRng(77);
  const counts = [0, 0, 0, 0];
  const weights = [1, 0, 3, 0];
  const n = 8000;
  for (let i = 0; i < n; i++) counts[rng.weightedIndex(weights)]++;
  assert.equal(counts[1], 0);
  assert.equal(counts[3], 0);
  assert.ok(Math.abs(counts[2] / counts[0] - 3) < 0.4, `비율 ${counts}`);
  assert.equal(createRng(1).weightedIndex([0, 0, 5]), 2);
});

test('weightedIndex는 잘못된 가중치를 거부한다', () => {
  const rng = createRng(1);
  assert.throws(() => rng.weightedIndex([]), RangeError);
  assert.throws(() => rng.weightedIndex([0, 0]), RangeError);
  assert.throws(() => rng.weightedIndex([1, -1]), RangeError);
  assert.throws(() => rng.weightedIndex([1, NaN]), RangeError);
  assert.throws(() => rng.weightedIndex([1, Infinity]), RangeError);
});
