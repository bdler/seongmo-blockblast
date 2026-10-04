/**
 * @typedef {import('./types.js').Shape} Shape
 */

// 회전이 없으므로 모든 방향을 따로 등록한다. '#'이 채워진 칸이며 그림은 빈 줄/열 없이 딱 맞게 쓴다.
// l3/l5의 접미사는 모서리가 있는 위치(tl 좌상, tr 우상, bl 좌하, br 우하),
// l4/j4/t의 숫자는 기본 모양에서 시계 방향으로 90도씩 돌린 횟수다.
const DEFINITIONS = [
  ['dot', 'dot', ['#']],

  ['h2', 'line', ['##']],
  ['h3', 'line', ['###']],
  ['h4', 'line', ['####']],
  ['h5', 'line', ['#####']],
  ['v2', 'line', ['#', '#']],
  ['v3', 'line', ['#', '#', '#']],
  ['v4', 'line', ['#', '#', '#', '#']],
  ['v5', 'line', ['#', '#', '#', '#', '#']],

  ['sq2', 'square', ['##', '##']],
  ['sq3', 'square', ['###', '###', '###']],

  // r{행}x{열}
  ['r2x3', 'rect', ['###', '###']],
  ['r3x2', 'rect', ['##', '##', '##']],

  ['l3-tl', 'smallL', ['##', '#.']],
  ['l3-tr', 'smallL', ['##', '.#']],
  ['l3-bl', 'smallL', ['#.', '##']],
  ['l3-br', 'smallL', ['.#', '##']],

  ['l5-tl', 'bigL', ['###', '#..', '#..']],
  ['l5-tr', 'bigL', ['###', '..#', '..#']],
  ['l5-bl', 'bigL', ['#..', '#..', '###']],
  ['l5-br', 'bigL', ['..#', '..#', '###']],

  ['l4-0', 'lTetro', ['#.', '#.', '##']],
  ['l4-1', 'lTetro', ['###', '#..']],
  ['l4-2', 'lTetro', ['##', '.#', '.#']],
  ['l4-3', 'lTetro', ['..#', '###']],
  ['j4-0', 'lTetro', ['.#', '.#', '##']],
  ['j4-1', 'lTetro', ['#..', '###']],
  ['j4-2', 'lTetro', ['##', '#.', '#.']],
  ['j4-3', 'lTetro', ['###', '..#']],

  ['t-0', 'tee', ['###', '.#.']],
  ['t-1', 'tee', ['.#', '##', '.#']],
  ['t-2', 'tee', ['.#.', '###']],
  ['t-3', 'tee', ['#.', '##', '#.']],

  ['s-h', 'skew', ['.##', '##.']],
  ['s-v', 'skew', ['#.', '##', '.#']],
  ['z-h', 'skew', ['##', '.##']],
  ['z-v', 'skew', ['.#', '##', '#.']],
];

/**
 * @param {string} id
 * @param {string} family
 * @param {string[]} picture
 * @returns {Shape}
 */
function buildShape(id, family, picture) {
  const cells = [];
  picture.forEach((line, r) => {
    [...line].forEach((ch, c) => {
      if (ch === '#') cells.push(Object.freeze([r, c]));
    });
  });
  const height = Math.max(...cells.map(([r]) => r)) + 1;
  const width = Math.max(...cells.map(([, c]) => c)) + 1;
  return Object.freeze({ id, cells: Object.freeze(cells), width, height, size: cells.length, family });
}

/** 카탈로그 순서대로의 모든 모양(깊게 동결됨). */
export const SHAPE_LIST = Object.freeze(DEFINITIONS.map((def) => buildShape(...def)));

/** id로 찾는 모양 사전(깊게 동결됨). */
export const SHAPES = Object.freeze(Object.fromEntries(SHAPE_LIST.map((shape) => [shape.id, shape])));

/**
 * @param {string} id
 * @returns {boolean}
 */
export function hasShape(id) {
  return Object.prototype.hasOwnProperty.call(SHAPES, id);
}

/**
 * @param {string} id
 * @returns {Shape}
 * @throws {Error} 알 수 없는 id
 */
export function getShape(id) {
  if (!hasShape(id)) throw new Error(`unknown shape id: ${String(id)}`);
  return SHAPES[id];
}
