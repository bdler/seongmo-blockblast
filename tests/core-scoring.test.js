import test from 'node:test';
import assert from 'node:assert/strict';
import { SCORING } from '../src/config.js';
import { nextCombo, scoreMove } from '../src/core/scoring.js';

const move = (linesCleared, combo, extra = {}) =>
  scoreMove({ placedCells: 0, linesCleared, combo, perfect: false, ...extra });

test('줄 제거 점수는 10 × L² (콤보 1, 배율 1)이다 - 가이드 5.2 표', () => {
  assert.equal(move(1, 1).clear, 10);
  assert.equal(move(2, 1).clear, 40);
  assert.equal(move(3, 1).clear, 90);
  assert.equal(move(4, 1).clear, 160);
});

test('콤보 배율은 1 + 0.5 × (콤보 − 1)이고 5에서 멈춘다', () => {
  const expected = { 1: 1, 2: 1.5, 3: 2, 4: 2.5, 5: 3, 6: 3.5, 7: 4, 8: 4.5, 9: 5, 10: 5, 50: 5 };
  for (const [combo, multiplier] of Object.entries(expected)) {
    assert.equal(move(1, Number(combo)).multiplier, multiplier, `콤보 ${combo}`);
  }
});

test('줄 제거 점수에 콤보 배율이 곱해진다', () => {
  assert.equal(move(1, 2).clear, 15);
  assert.equal(move(2, 3).clear, 80);
  assert.equal(move(3, 5).clear, 270);
  assert.equal(move(4, 9).clear, 800);
  assert.equal(move(4, 20).clear, 800);
});

test('여러 줄을 한 번에 지우는 쪽이 한 줄씩 지우는 것보다 항상 크다', () => {
  for (let combo = 1; combo <= 12; combo++) {
    for (let lines = 2; lines <= 8; lines++) {
      assert.ok(move(lines, combo).clear > lines * move(1, combo).clear, `L=${lines} combo=${combo}`);
    }
  }
});

test('배치 점수는 칸 수 × cellPoint이고 줄을 못 지우면 clear와 배율은 기본값이다', () => {
  const result = scoreMove({ placedCells: 5, linesCleared: 0, combo: 0, perfect: false });
  assert.deepEqual(result, { total: 5, place: 5, clear: 0, perfect: 0, multiplier: 1 });
});

test('퍼펙트 클리어는 +300을 더하고 total은 세 항목의 합이다', () => {
  const result = scoreMove({ placedCells: 4, linesCleared: 2, combo: 3, perfect: true });
  assert.deepEqual(result, { total: 4 + 80 + 300, place: 4, clear: 80, perfect: 300, multiplier: 2 });
});

test('cfg를 바꿔 넘기면 그 값으로 계산한다', () => {
  const cfg = { ...SCORING, cellPoint: 2, lineBase: 20, comboStep: 1, maxMultiplier: 3, perfectBonus: 7 };
  const result = scoreMove({ placedCells: 3, linesCleared: 2, combo: 4, perfect: true }, cfg);
  assert.deepEqual(result, { total: 6 + 240 + 7, place: 6, clear: 240, perfect: 7, multiplier: 3 });
});

test('소수 배율의 반올림은 Math.round(.5는 올림)이다', () => {
  const cfg = { ...SCORING, lineBase: 5, comboStep: 0.5 };
  // 5 × 1 × 1.5 = 7.5 -> 8
  assert.equal(scoreMove({ placedCells: 0, linesCleared: 1, combo: 2, perfect: false }, cfg).clear, 8);
});

test('nextCombo는 줄을 지우면 +1, 못 지우면 0이다', () => {
  assert.equal(nextCombo(0, 1), 1);
  assert.equal(nextCombo(3, 2), 4);
  assert.equal(nextCombo(3, 0), 0);
  assert.equal(nextCombo(0, 0), 0);
});

test('SCORING 설정은 동결된 기본값이다', () => {
  assert.ok(Object.isFrozen(SCORING));
  assert.deepEqual({ ...SCORING }, {
    cellPoint: 1,
    lineBase: 10,
    comboStep: 0.5,
    maxMultiplier: 5,
    perfectBonus: 300,
  });
});
