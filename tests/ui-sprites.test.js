import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PALETTE } from '../src/config.js';
import {
  SPRITE_DANGER,
  SPRITE_SHADOW,
  SPRITE_WHITE,
  cellMetrics,
  createSpriteCache,
  hexToRgb,
  mixRgb,
  rgbaString,
  roundRectPath,
} from '../src/ui/block-sprites.js';
import { countCalls, createFakeContext } from './ui-fake-context.js';

function makeCache() {
  const created = [];
  const cache = createSpriteCache({
    createCanvas: (width, height) => {
      const fake = createFakeContext();
      const canvas = { width, height, getContext: () => fake.ctx, calls: fake.calls };
      created.push(canvas);
      return canvas;
    },
  });
  return { cache, created };
}

test('색 유틸: hex 변환, 섞기, rgba 문자열', () => {
  assert.deepEqual(hexToRgb('#ff5c6c'), [255, 92, 108]);
  assert.deepEqual(mixRgb([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128]);
  assert.deepEqual(mixRgb([10, 20, 30], [200, 100, 0], 0), [10, 20, 30]);
  assert.equal(rgbaString([1, 2, 3], 0.5), 'rgba(1,2,3,0.5)');
  assert.equal(rgbaString([1, 2, 3]), 'rgba(1,2,3,1)');
});

test('cellMetrics: 간격은 짝수이고 간격 + 블록 = 칸 크기이다', () => {
  for (let cellDev = 5; cellDev <= 260; cellDev += 1) {
    const { gap, size } = cellMetrics(cellDev);
    assert.equal(gap % 2, 0, `gap even at ${cellDev}`);
    assert.equal(gap + size, cellDev);
    assert.ok(gap >= 2 && size >= 1);
    if (cellDev >= 20) assert.ok(gap <= cellDev * 0.13, `gap ${gap} too wide at ${cellDev}`);
  }
  assert.deepEqual(cellMetrics(1), { gap: 0, size: 1 });
});

test('roundRectPath: 반지름이 크기를 넘어도 안전하게 경로를 닫는다', () => {
  const { ctx, calls } = createFakeContext();
  roundRectPath(ctx, 0, 0, 10, 6, 100);
  assert.equal(countCalls(calls, 'arcTo'), 4);
  assert.equal(countCalls(calls, 'closePath'), 1);
  for (const call of calls.filter((c) => c[0] === 'arcTo')) assert.ok(call[5] <= 3);
});

test('스프라이트 캐시: 같은 (종류, 크기)는 한 번만 만든다', () => {
  const { cache, created } = makeCache();
  const a = cache.get(3, 90);
  const b = cache.get(3, 90);
  assert.equal(a, b);
  assert.equal(created.length, 1);
  assert.notEqual(cache.get(3, 91), a);
  assert.notEqual(cache.get(4, 90), a);
  assert.equal(created.length, 3);
  assert.equal(cache.size(), 3);
});

test('스프라이트 캐시: 블록 스프라이트는 간격을 뺀 크기이다', () => {
  const { cache } = makeCache();
  const { size } = cellMetrics(135);
  const sprite = cache.get(1, 135);
  assert.equal(sprite.width, size);
  assert.equal(sprite.height, size);
});

test('스프라이트 캐시: 모든 색과 특수 스프라이트를 만들 수 있다', () => {
  const { cache } = makeCache();
  for (let colorId = 1; colorId <= PALETTE.length; colorId += 1) assert.ok(cache.get(colorId, 90));
  for (const kind of [SPRITE_DANGER, SPRITE_WHITE]) assert.ok(cache.get(kind, 90));
  const shadow = cache.get(SPRITE_SHADOW, 90);
  assert.ok(shadow.width > cellMetrics(90).size, 'shadow has blur padding');
  assert.equal(shadow.width, shadow.height);
});

test('스프라이트 캐시: 상한을 넘으면 비우고 다시 채운다(무한히 늘지 않는다)', () => {
  const { cache } = makeCache();
  for (let size = 20; size < 20 + 300; size += 1) cache.get(1, size);
  assert.ok(cache.size() <= 240);
  cache.clear();
  assert.equal(cache.size(), 0);
});
