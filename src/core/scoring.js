import { SCORING } from '../config.js';

/**
 * 한 번의 이동 점수를 계산한다.
 *
 * - place = placedCells × cellPoint
 * - multiplier = min(maxMultiplier, 1 + comboStep × (combo − 1)). combo는 이 이동 이후의 값이며
 *   줄을 못 지운 이동(combo 0)도 배율은 1로 취급한다
 * - clear = Math.round(lineBase × L² × multiplier), L = linesCleared. Math.round는 .5를 올린다
 *   (기본 설정에서는 항상 정수라 반올림이 일어나지 않는다)
 * - perfect = perfect ? perfectBonus : 0
 *
 * @param {{ placedCells: number, linesCleared: number, combo: number, perfect: boolean }} move
 * @param {typeof SCORING} [cfg]
 * @returns {{ total: number, place: number, clear: number, perfect: number, multiplier: number }}
 */
export function scoreMove({ placedCells, linesCleared, combo, perfect }, cfg = SCORING) {
  const multiplier = Math.min(cfg.maxMultiplier, 1 + cfg.comboStep * Math.max(0, combo - 1));
  const place = placedCells * cfg.cellPoint;
  const clear = Math.round(cfg.lineBase * linesCleared * linesCleared * multiplier);
  const perfectBonus = perfect ? cfg.perfectBonus : 0;
  return { total: place + clear + perfectBonus, place, clear, perfect: perfectBonus, multiplier };
}

/**
 * 줄을 지운 이동이면 콤보 +1, 못 지웠으면 0으로 초기화한다.
 * @param {number} prev 이동 전 콤보
 * @param {number} linesCleared
 * @returns {number}
 */
export function nextCombo(prev, linesCleared) {
  return linesCleared > 0 ? prev + 1 : 0;
}
