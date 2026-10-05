import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EFFECTS } from '../src/config.js';
import { createRng } from '../src/core/index.js';
import { clamp01, easeInBack, easeInCubic, easeOutBack, easeOutCubic, lerp, pulse } from '../src/ui/easing.js';
import { createEffects, createParticlePool } from '../src/ui/effects.js';
import { countCalls, createFakeCanvasFactory, createFakeContext, labelOf } from './ui-fake-context.js';

const CELL = 40;

function makeEffects(seed = 1, options = {}) {
  const rng = createRng(seed);
  const factory = createFakeCanvasFactory();
  const effects = createEffects({ rng: () => rng.next(), createCanvas: factory.createCanvas, ...options });
  effects.setMetrics({ cell: CELL, dpr: 1 });
  effects.canvases = factory.canvases;
  return effects;
}

function snapshot(effects) {
  const fake = createFakeContext();
  effects.drawOverlay(fake.ctx, 1);
  return JSON.stringify(fake.calls);
}

test('파티클 풀: 상한을 넘기면 spawn이 false를 돌려주고 count는 상한을 넘지 않는다', () => {
  const pool = createParticlePool(5);
  for (let i = 0; i < 5; i += 1) assert.equal(pool.spawn(i, 0, 0, 0, 1000, 4, 1, 0, 0, 0), true);
  assert.equal(pool.spawn(9, 9, 0, 0, 1000, 4, 1, 0, 0, 0), false);
  assert.equal(pool.count, 5);
  assert.equal(pool.max, 5);
});

test('파티클 풀: 수명이 다한 파티클은 빠지고 남은 파티클의 값은 그대로이다', () => {
  const pool = createParticlePool(8);
  pool.spawn(1, 0, 0, 0, 100, 4, 1, 0, 0, 0);
  pool.spawn(2, 0, 0, 0, 500, 5, 2, 1, 0, 0);
  pool.spawn(3, 0, 0, 0, 100, 6, 3, 2, 0, 0);
  pool.spawn(4, 0, 0, 0, 500, 7, 4, 0, 0, 0);
  pool.update(150, 0, 0);
  assert.equal(pool.count, 2);
  const survivors = [];
  for (let i = 0; i < pool.count; i += 1) survivors.push([pool.fields.x[i], pool.fields.size[i], pool.fields.color[i], pool.fields.kind[i]]);
  survivors.sort((a, b) => a[0] - b[0]);
  assert.deepEqual(survivors, [
    [2, 5, 2, 1],
    [4, 7, 4, 0],
  ]);
  pool.update(500, 0, 0);
  assert.equal(pool.count, 0);
});

test('파티클 풀: 죽은 자리를 다시 쓸 수 있다', () => {
  const pool = createParticlePool(2);
  pool.spawn(0, 0, 0, 0, 10, 4, 1, 0, 0, 0);
  pool.spawn(0, 0, 0, 0, 10, 4, 1, 0, 0, 0);
  pool.update(20, 0, 0);
  assert.equal(pool.count, 0);
  assert.equal(pool.spawn(0, 0, 0, 0, 10, 4, 1, 0, 0, 0), true);
  assert.equal(pool.count, 1);
});

test('파티클 풀: 중력은 아래(+y)로, 감쇠는 속도를 줄인다', () => {
  const pool = createParticlePool(2);
  pool.spawn(0, 0, 100, 0, 5000, 4, 1, 0, 0, 0);
  pool.update(100, 1000, 0);
  assert.ok(pool.fields.y[0] > 0);
  assert.ok(pool.fields.x[0] > 0);
  const slow = createParticlePool(2);
  slow.spawn(0, 0, 100, 0, 5000, 4, 1, 0, 0, 0);
  slow.update(100, 0, 5);
  assert.ok(slow.fields.x[0] < pool.fields.x[0]);
});

test('burst: 요청이 상한보다 많아도 EFFECTS.maxParticles를 넘지 않는다', () => {
  const effects = makeEffects();
  const made = effects.burst(100, 100, 3, EFFECTS.maxParticles * 3);
  assert.equal(made, EFFECTS.maxParticles);
  assert.equal(effects.particleCount, EFFECTS.maxParticles);
  assert.equal(effects.burst(100, 100, 3, 10), 0);
  assert.equal(effects.sparkleRain(0, 0, 100, 100, 10), 0);
  assert.equal(effects.particleCount, EFFECTS.maxParticles);
});

test('burst: 주입한 rng가 같으면 결과(상태와 그려지는 호출)가 완전히 같다', () => {
  const run = (seed) => {
    const effects = makeEffects(seed);
    effects.burst(120, 80, 2, 40);
    effects.sparkleRain(0, 0, 200, 200, 20);
    for (let i = 0; i < 12; i += 1) effects.update(16);
    return snapshot(effects);
  };
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
});

test('burst: 시간이 지나면 모두 사라지고 isActive가 false가 된다', () => {
  const effects = makeEffects();
  assert.equal(effects.isActive(), false);
  effects.burst(50, 50, 4, 30);
  assert.equal(effects.isActive(), true);
  for (let i = 0; i < 100; i += 1) effects.update(16);
  assert.equal(effects.particleCount, 0);
  assert.equal(effects.isActive(), false);
});

test('burst: 파티클이 요청한 색 번호와 흰 반짝이만 쓴다', () => {
  const effects = makeEffects(3);
  const fake = createFakeContext();
  effects.burst(50, 50, 5, 60);
  effects.drawOverlay(fake.ctx, 1);
  assert.ok(countCalls(fake.calls, 'setTransform') >= 60);
});

test('reducedMotion: 파티클, 흔들림, 번쩍임, 반짝임이 모두 꺼진다', () => {
  const effects = makeEffects(1, { reducedMotion: true });
  assert.equal(effects.reducedMotion, true);
  assert.equal(effects.burst(10, 10, 1, 50), 0);
  assert.equal(effects.sparkleRain(0, 0, 10, 10, 50), 0);
  effects.shake(20);
  effects.lineFlash(0, 0, 10, 10);
  effects.startShimmer();
  effects.update(16);
  assert.equal(effects.particleCount, 0);
  assert.equal(effects.shimmerActive, false);
  assert.deepEqual({ x: effects.offset.x, y: effects.offset.y }, { x: 0, y: 0 });
  assert.equal(effects.isActive(), false);
});

test('reducedMotion: 글자는 뜨지만 떠오르지 않고 팝 효과도 없다', () => {
  const effects = makeEffects(1, { reducedMotion: true });
  effects.addText({ text: '좋아요!', x: 100, y: 100, size: 30, color: '#ffcf3f', life: 800, rise: 50, glow: true });
  assert.equal(effects.isActive(), true);
  effects.update(400);
  const fake = createFakeContext();
  effects.drawOverlay(fake.ctx, 1);
  const draw = fake.calls.find((call) => call[0] === 'drawImage');
  assert.ok(draw, 'text is drawn');
  assert.equal(draw[3] + draw[5] / 2, 100, 'no rise');
  assert.equal(draw[4], draw[1].width / 1.15, 'no pop scaling');
  const sprite = effects.canvases.find((canvas) => labelOf(canvas) !== null);
  assert.equal(sprite.calls.some((call) => call[0] === 'set:shadowBlur' && call[1] > 0), false, 'no glow');
});

test('setReducedMotion(true): 진행 중이던 파티클과 흔들림을 바로 끈다', () => {
  const effects = makeEffects();
  effects.burst(10, 10, 1, 20);
  effects.shake(12);
  effects.update(16);
  effects.setReducedMotion(true);
  assert.equal(effects.particleCount, 0);
  assert.deepEqual({ x: effects.offset.x, y: effects.offset.y }, { x: 0, y: 0 });
  effects.setReducedMotion(false);
  assert.ok(effects.burst(10, 10, 1, 5) > 0);
});

test('shake: 진폭 안에서 흔들리다가 지속 시간이 지나면 0으로 돌아온다', () => {
  const effects = makeEffects();
  effects.shake(10);
  let peak = 0;
  for (let t = 0; t < EFFECTS.shake.durationMs; t += 8) {
    effects.update(8);
    peak = Math.max(peak, Math.abs(effects.offset.x), Math.abs(effects.offset.y));
    assert.ok(Math.abs(effects.offset.x) <= 10 + 1e-6 && Math.abs(effects.offset.y) <= 10 + 1e-6);
  }
  assert.ok(peak > 1, 'it actually moves');
  for (let i = 0; i < 5; i += 1) effects.update(16);
  assert.deepEqual({ x: effects.offset.x, y: effects.offset.y }, { x: 0, y: 0 });
  assert.equal(effects.isActive(), false);
});

test('shake: 진행 중인 큰 흔들림을 작은 흔들림이 덮어쓰지 않는다', () => {
  const effects = makeEffects();
  effects.shake(20);
  effects.update(16);
  effects.shake(2);
  let peak = 0;
  for (let i = 0; i < 10; i += 1) {
    effects.update(8);
    peak = Math.max(peak, Math.abs(effects.offset.x));
  }
  assert.ok(peak > 2.5, `kept the large shake (peak ${peak})`);
});

test('글자: 슬롯이 가득 차면 가장 오래된 글자를 덮어쓰고 수명이 끝나면 사라진다', () => {
  const effects = makeEffects();
  for (let i = 0; i < EFFECTS.maxTexts; i += 1) {
    effects.addText({ text: `t${i}`, x: 0, y: 0, size: 20, color: '#ffffff', life: 1000 });
    effects.update(10);
  }
  assert.equal(effects.activeTextCount, EFFECTS.maxTexts);
  effects.addText({ text: 'new', x: 0, y: 0, size: 20, color: '#ffffff', life: 1000 });
  assert.equal(effects.activeTextCount, EFFECTS.maxTexts);
  const fake = createFakeContext();
  effects.update(1);
  effects.drawOverlay(fake.ctx, 1);
  const drawn = fake.calls.filter((call) => call[0] === 'drawImage').map((call) => labelOf(call[1]));
  assert.equal(drawn.length, EFFECTS.maxTexts);
  assert.ok(drawn.includes('new'));
  assert.ok(!drawn.includes('t0'), 'oldest was replaced');
  effects.update(2000);
  assert.equal(effects.activeTextCount, 0);
});

test('글자: 스프라이트는 addText에서 한 번만 그리고 프레임마다 다시 그리지 않는다', () => {
  const effects = makeEffects();
  effects.addText({ text: '콤보 ×3', x: 50, y: 80, size: 40, color: '#ff9a3c', life: 800, glow: true });
  const sprite = effects.canvases.find((canvas) => labelOf(canvas) === '콤보 ×3');
  assert.ok(sprite, 'label rendered into its own canvas');
  const drawsAtCreation = sprite.calls.length;
  for (let i = 0; i < 20; i += 1) {
    effects.update(16);
    effects.drawOverlay(createFakeContext().ctx, 1);
  }
  assert.equal(sprite.calls.length, drawsAtCreation, 'no per-frame text drawing');
  assert.equal(countCalls(sprite.calls, 'strokeText'), 1, 'outline');
  assert.equal(sprite.calls.some((call) => call[0] === 'set:shadowBlur' && call[1] > 0), true, 'glow baked into the sprite');
});

test('글자: delay가 지나기 전에는 그리지 않고, 시작하면 위로 떠오른다', () => {
  const effects = makeEffects();
  effects.addText({ text: '+12', x: 50, y: 100, size: 24, color: '#ffffff', life: 800, delay: 200, rise: 40 });
  effects.update(100);
  let fake = createFakeContext();
  effects.drawOverlay(fake.ctx, 1);
  assert.equal(countCalls(fake.calls, 'drawImage'), 0);
  effects.update(500);
  fake = createFakeContext();
  effects.drawOverlay(fake.ctx, 1);
  const draw = fake.calls.find((call) => call[0] === 'drawImage');
  assert.ok(draw && draw[3] + draw[5] / 2 < 100, 'risen above the start');
});

test('글자: maxWidth가 있으면 스프라이트의 fillText/strokeText에 넘기고 폭도 그 안에 든다', () => {
  const effects = makeEffects();
  effects.addText({ text: '퍼펙트!퍼펙트!퍼펙트!', x: 0, y: 0, size: 60, color: '#ffffff', life: 500, maxWidth: 100 });
  const sprite = effects.canvases.find((canvas) => labelOf(canvas) !== null);
  const fill = sprite.calls.find((call) => call[0] === 'fillText');
  assert.equal(fill[4], 100 * 1.15);
  assert.equal(sprite.calls.find((call) => call[0] === 'strokeText')[4], 100 * 1.15);
  effects.update(400); // 팝 연출이 끝난 뒤의 크기
  const fake = createFakeContext();
  effects.drawOverlay(fake.ctx, 1);
  const draw = fake.calls.find((call) => call[0] === 'drawImage');
  assert.ok(draw[4] <= 100 + 2 * 0.55 * 60 + 4, 'sprite width is maxWidth plus the glow padding only');
});

test('글자: dpr이 높으면 스프라이트를 기기 픽셀로 그리고 CSS 크기는 같다', () => {
  const effects1 = makeEffects();
  const effects3 = makeEffects();
  effects3.setMetrics({ cell: CELL, dpr: 3 });
  for (const effects of [effects1, effects3]) effects.addText({ text: '좋아요!', x: 0, y: 0, size: 30, color: '#ffcf3f', life: 800 });
  const css = (effects, dpr) => {
    effects.update(400);
    const fake = createFakeContext();
    effects.drawOverlay(fake.ctx, dpr);
    return fake.calls.find((call) => call[0] === 'drawImage');
  };
  const low = css(effects1, 1);
  const high = css(effects3, 3);
  assert.ok(high[1].height > low[1].height * 2.5, 'more device pixels');
  assert.ok(Math.abs(high[5] - low[5]) < 8, 'same CSS height (padding rounding aside)');
});

test('줄 번쩍임/퍼펙트 반짝임: 시간이 지나면 꺼지고, 그리는 동안 캔버스 상태를 되돌린다', () => {
  const effects = makeEffects();
  effects.lineFlash(10, 10, 200, 40);
  effects.startShimmer();
  assert.equal(effects.shimmerActive, true);
  const fake = createFakeContext();
  effects.update(100);
  effects.drawWorld(fake.ctx, { boardX: 10, boardY: 10, boardSize: 320, radius: 12 });
  assert.equal(countCalls(fake.calls, 'save'), countCalls(fake.calls, 'restore'));
  assert.equal(fake.ctx.globalAlpha, 1);
  for (let i = 0; i < 200; i += 1) effects.update(16);
  assert.equal(effects.shimmerActive, false);
  assert.equal(effects.isActive(), false);
});

test('clear: 진행 중인 모든 이펙트를 비운다', () => {
  const effects = makeEffects();
  effects.burst(10, 10, 1, 20);
  effects.addText({ text: 'x', x: 0, y: 0, size: 20, color: '#ffffff', life: 500 });
  effects.shake(10);
  effects.startShimmer();
  effects.lineFlash(0, 0, 10, 10);
  effects.update(16);
  effects.clear();
  assert.equal(effects.isActive(), false);
  assert.equal(effects.particleCount, 0);
  assert.equal(effects.activeTextCount, 0);
});

test('이징: 끝점과 범위가 맞다', () => {
  for (const ease of [easeOutCubic, easeInCubic, easeOutBack, easeInBack]) {
    assert.ok(Math.abs(ease(0)) < 1e-9);
    assert.ok(Math.abs(ease(1) - 1) < 1e-9);
    assert.equal(ease(-5), ease(0));
    assert.equal(ease(5), ease(1));
  }
  assert.ok(easeOutBack(0.7) > 1, 'overshoots');
  assert.ok(easeInBack(0.2) < 0, 'pulls back first');
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.ok(Math.abs(pulse(0)) < 1e-9 && Math.abs(pulse(0.5) - 1) < 1e-9 && Math.abs(pulse(1)) < 1e-9);
});
