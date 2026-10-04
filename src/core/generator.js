import { BOARD_SIZE, COLOR_COUNT, GENERATOR, TRAY_SIZE } from '../config.js';
import {
  canPlaceAnywhere,
  clearLines,
  countFilled,
  findFullLines,
  listPlacements,
  placeShape,
} from './board.js';
import { createRng, hashSeed } from './rng.js';
import { SHAPE_LIST, getShape } from './shapes.js';

/**
 * @typedef {import('./types.js').Board} Board
 * @typedef {import('./types.js').Shape} Shape
 * @typedef {import('./types.js').TrayPiece} TrayPiece
 */

const FAMILY_SIZES = SHAPE_LIST.reduce((sizes, shape) => {
  sizes[shape.family] = (sizes[shape.family] ?? 0) + 1;
  return sizes;
}, {});

/**
 * 계열 비중을 계열 안의 모양 수로 나눈 모양 하나의 기본 가중치.
 * @param {Shape} shape
 * @param {typeof GENERATOR} cfg
 */
function baseWeight(shape, cfg) {
  return cfg.familyWeights[shape.family] / FAMILY_SIZES[shape.family];
}

/**
 * 점수 구간에 해당하는 "까다로운 모양" 배수. minScore가 점수 이하인 마지막 구간을 쓴다.
 * @param {number} score
 * @param {typeof GENERATOR} cfg
 */
function hardMultiplier(score, cfg) {
  let mul = 1;
  for (const tier of cfg.scoreTiers) {
    if (score >= tier.minScore) mul = tier.hardMul;
  }
  return mul;
}

/**
 * SHAPE_LIST 순서에 맞춘 선택 가중치. 보드 채움 비율과 점수에 따라 조정된다.
 * fill < fill.low면 큰 블록을, fill > fill.high면 작은 블록을 키우고(나머지는 그대로),
 * 점수 구간이 높을수록 hardFamilies(S/Z, 큰 L)가 늘어난다.
 * @param {Board} board
 * @param {number} [score]
 * @param {typeof GENERATOR} [cfg]
 * @returns {number[]}
 */
export function weightsFor(board, score = 0, cfg = GENERATOR) {
  const fill = countFilled(board) / (BOARD_SIZE * BOARD_SIZE);
  const hardMul = hardMultiplier(score, cfg);
  return SHAPE_LIST.map((shape) => {
    let weight = baseWeight(shape, cfg);
    const big = shape.size >= cfg.bigMinSize;
    const small = shape.size <= cfg.smallMaxSize;
    if (fill < cfg.fill.low) {
      if (big) weight *= cfg.fill.lowBigMul;
      else if (small) weight *= cfg.fill.lowSmallMul;
    } else if (fill > cfg.fill.high) {
      if (big) weight *= cfg.fill.highBigMul;
      else if (small) weight *= cfg.fill.highSmallMul;
    }
    if (cfg.hardFamilies.includes(shape.family)) weight *= hardMul;
    return weight;
  });
}

/**
 * 모양 하나를 놓고(줄이 차면 지운 뒤) 다음 보드를 만든다. 색은 해결 가능성과 무관해 아무 값이나 쓴다.
 * @param {Board} board
 * @param {Shape} shape
 * @param {number} row
 * @param {number} col
 * @returns {Board}
 */
function simulatePlace(board, shape, row, col) {
  const placed = placeShape(board, shape, row, col, 1);
  const lines = findFullLines(placed);
  if (lines.rows.length === 0 && lines.cols.length === 0) return placed;
  return clearLines(placed, lines).board;
}

/**
 * 남은 모양을 어떤 순서/위치로든 전부 놓을 수 있는지 DFS로 확인한다.
 * 노드 예산을 다 쓰면 해결 가능으로 간주하고 멈춘다.
 * @param {Board} board
 * @param {Shape[]} shapes
 * @param {{ left: number }} budget
 * @returns {boolean}
 */
function solve(board, shapes, budget) {
  if (shapes.length === 0) return true;
  if (budget.left-- <= 0) return true;
  if (shapes.length === 1) return canPlaceAnywhere(board, shapes[0]);

  const seen = new Set();
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    if (seen.has(shape.id)) continue;
    seen.add(shape.id);
    const rest = shapes.filter((_, j) => j !== i);
    for (const [row, col] of listPlacements(board, shape)) {
      if (solve(simulatePlace(board, shape, row, col), rest, budget)) return true;
    }
  }
  return false;
}

/**
 * @param {Board} board
 * @param {Shape[]} shapes
 * @param {number} nodeBudget
 * @returns {boolean}
 */
function shapesSolvable(board, shapes, nodeBudget) {
  // 큰 블록부터 시도하면 막다른 가지를 빨리 만난다
  const ordered = [...shapes].sort((a, b) => b.size - a.size);
  return solve(board, ordered, { left: nodeBudget });
}

/**
 * 트레이의 모든 블록을 어떤 순서/위치로든 놓을 수 있는지(줄 제거로 칸이 비는 것까지 시뮬레이션) 확인한다.
 * nodeBudget만큼 탐색해도 결론이 안 나면 true(해결 가능)로 본다. 비어 있는 슬롯(null)은 무시한다.
 * @param {Board} board
 * @param {(TrayPiece | null)[]} pieces
 * @param {number} [nodeBudget]
 * @returns {boolean}
 */
export function isTraySolvable(board, pieces, nodeBudget = GENERATOR.nodeBudget) {
  const shapes = pieces.filter((piece) => piece != null).map((piece) => getShape(piece.shapeId));
  return shapesSolvable(board, shapes, nodeBudget);
}

/**
 * @param {ReturnType<typeof createRng>} rng
 * @param {number[]} weights SHAPE_LIST 순서
 * @returns {Shape[]}
 */
function drawShapes(rng, weights) {
  return Array.from({ length: TRAY_SIZE }, () => SHAPE_LIST[rng.weightedIndex(weights)]);
}

/**
 * 색 번호 TRAY_SIZE개를 서로 다르게 뽑는다(앞에서부터 부분 셔플).
 * @param {ReturnType<typeof createRng>} rng
 * @returns {number[]}
 */
function drawColors(rng) {
  const pool = Array.from({ length: COLOR_COUNT }, (_, i) => i + 1);
  for (let i = 0; i < TRAY_SIZE; i++) {
    const j = i + rng.int(COLOR_COUNT - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, TRAY_SIZE);
}

/**
 * @param {Shape[]} shapes
 * @param {ReturnType<typeof createRng>} rng
 * @returns {TrayPiece[]}
 */
function toTray(shapes, rng) {
  const colors = drawColors(rng);
  return shapes.map((shape, i) => ({ shapeId: shape.id, color: colors[i] }));
}

/**
 * 재뽑기가 모두 실패했을 때의 최후 수단. 작은 블록(smallMaxSize 이하)만으로
 * 해결 가능한 조합을 fallbackAttempts번 찾아보고, 그래도 없으면 점 블록 3개를 돌려준다.
 * @param {Board} board
 * @param {ReturnType<typeof createRng>} rng
 * @param {typeof GENERATOR} cfg
 * @returns {Shape[]}
 */
function smallPieceFallback(board, rng, cfg) {
  const pool = SHAPE_LIST.filter((shape) => shape.size <= cfg.smallMaxSize);
  for (let i = 0; i < cfg.fallbackAttempts; i++) {
    const shapes = Array.from({ length: TRAY_SIZE }, () => rng.pick(pool));
    if (shapesSolvable(board, shapes, cfg.nodeBudget)) return shapes;
  }
  return Array.from({ length: TRAY_SIZE }, () => pool.find((shape) => shape.size === 1));
}

/**
 * 새 트레이(블록 TRAY_SIZE개)를 만든다.
 *
 * - classic: 보드/점수에 맞춘 가중치로 뽑고, 해결 가능성(isTraySolvable)을 확인하며 최대 maxRerolls번
 *   다시 뽑는다. 모두 실패하면 작은 블록 폴백(해결 가능한 작은 조합 → 그래도 없으면 점 3개).
 *   rng를 소비하므로 호출 뒤 `rng.state()`를 저장해야 흐름이 이어진다.
 * - daily: 트레이는 (seed, trayIndex)만의 순수 함수다. 자체 rng(hashSeed(seed + ':' + trayIndex))를 쓰며
 *   보드·점수·전달된 rng와 무관하고 해결 가능성 검사도 하지 않는다.
 *
 * 색은 rng에서 1~COLOR_COUNT를 뽑되 한 트레이 안에서 서로 다르다.
 * @param {{
 *   board?: Board,
 *   rng?: ReturnType<typeof createRng>,
 *   mode?: 'classic' | 'daily',
 *   seed?: number | string,
 *   trayIndex?: number,
 *   score?: number,
 *   cfg?: typeof GENERATOR,
 * }} params classic은 board와 rng, daily는 seed가 필요하다
 * @returns {TrayPiece[]}
 */
export function generateTray({ board, rng, mode = 'classic', seed, trayIndex = 0, score = 0, cfg = GENERATOR }) {
  if (mode === 'daily') {
    const dailyRng = createRng(hashSeed(`${seed}:${trayIndex}`));
    const weights = SHAPE_LIST.map((shape) => baseWeight(shape, cfg));
    return toTray(drawShapes(dailyRng, weights), dailyRng);
  }

  const weights = weightsFor(board, score, cfg);
  for (let i = 0; i < cfg.maxRerolls; i++) {
    const shapes = drawShapes(rng, weights);
    if (shapesSolvable(board, shapes, cfg.nodeBudget)) return toTray(shapes, rng);
  }
  return toTray(smallPieceFallback(board, rng, cfg), rng);
}
