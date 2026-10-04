import { BOARD_SIZE, COLOR_COUNT } from '../config.js';

/**
 * @typedef {import('./types.js').Shape} Shape
 * @typedef {import('./types.js').Board} Board
 */

/** @returns {Board} 빈 보드 */
export function createBoard() {
  return Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE).fill(0));
}

/**
 * @param {Board} board
 * @returns {Board}
 */
export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

/**
 * 모든 칸이 보드 안이고 비어 있으면 true. 정수가 아닌 좌표는 false.
 * @param {Board} board
 * @param {Shape} shape
 * @param {number} row 모양의 좌상단이 놓일 행
 * @param {number} col 모양의 좌상단이 놓일 열
 * @returns {boolean}
 */
export function canPlace(board, shape, row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
  const { cells } = shape;
  for (let i = 0; i < cells.length; i++) {
    const r = row + cells[i][0];
    const c = col + cells[i][1];
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== 0) return false;
  }
  return true;
}

/**
 * 모양을 놓은 새 보드를 돌려준다(입력은 수정하지 않는다).
 * @param {Board} board
 * @param {Shape} shape
 * @param {number} row
 * @param {number} col
 * @param {number} color 1~COLOR_COUNT
 * @returns {Board}
 * @throws {RangeError} 놓을 수 없는 위치이거나 색 번호가 범위 밖
 */
export function placeShape(board, shape, row, col, color) {
  if (!Number.isInteger(color) || color < 1 || color > COLOR_COUNT) {
    throw new RangeError(`color out of range: ${color}`);
  }
  if (!canPlace(board, shape, row, col)) {
    throw new RangeError(`cannot place ${shape.id} at (${row}, ${col})`);
  }
  const next = cloneBoard(board);
  for (const [dr, dc] of shape.cells) next[row + dr][col + dc] = color;
  return next;
}

/**
 * 가득 찬 행/열을 모두 찾는다. 지우기 전에 한꺼번에 찾아야 교차하는 줄이 함께 처리된다.
 * @param {Board} board
 * @returns {{ rows: number[], cols: number[] }} 각각 오름차순
 */
export function findFullLines(board) {
  const rows = [];
  const cols = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (board[i].every((v) => v !== 0)) rows.push(i);
    if (board.every((row) => row[i] !== 0)) cols.push(i);
  }
  return { rows, cols };
}

/**
 * 지정한 행/열을 한꺼번에 지운다. 교차 칸은 한 번만 보고하고, 색은 지우기 전 값이다.
 * @param {Board} board
 * @param {{ rows: number[], cols: number[] }} lines
 * @returns {{ board: Board, clearedCells: { r: number, c: number, color: number }[] }}
 *   clearedCells는 행 우선(row-major) 순서이며 실제로 블록이 있던 칸만 담긴다
 */
export function clearLines(board, lines) {
  const rowSet = new Set(lines.rows);
  const colSet = new Set(lines.cols);
  const next = cloneBoard(board);
  const clearedCells = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if ((rowSet.has(r) || colSet.has(c)) && board[r][c] !== 0) {
        clearedCells.push({ r, c, color: board[r][c] });
        next[r][c] = 0;
      }
    }
  }
  return { board: next, clearedCells };
}

/**
 * @param {Board} board
 * @returns {number} 채워진 칸 수
 */
export function countFilled(board) {
  let count = 0;
  for (const row of board) {
    for (const v of row) if (v !== 0) count++;
  }
  return count;
}

/**
 * @param {Board} board
 * @returns {boolean}
 */
export function isBoardEmpty(board) {
  return board.every((row) => row.every((v) => v === 0));
}

/**
 * @param {Board} board
 * @param {Shape} shape
 * @returns {boolean} 놓을 수 있는 자리가 하나라도 있는지
 */
export function canPlaceAnywhere(board, shape) {
  for (let r = 0; r <= BOARD_SIZE - shape.height; r++) {
    for (let c = 0; c <= BOARD_SIZE - shape.width; c++) {
      if (canPlace(board, shape, r, c)) return true;
    }
  }
  return false;
}

/**
 * @param {Board} board
 * @param {Shape} shape
 * @returns {[number, number][]} 놓을 수 있는 [행, 열] 목록(행 우선 순서)
 */
export function listPlacements(board, shape) {
  const placements = [];
  for (let r = 0; r <= BOARD_SIZE - shape.height; r++) {
    for (let c = 0; c <= BOARD_SIZE - shape.width; c++) {
      if (canPlace(board, shape, r, c)) placements.push([r, c]);
    }
  }
  return placements;
}

/**
 * 게임오버 판정용. null/undefined(이미 놓은 슬롯)는 건너뛴다.
 * @param {Board} board
 * @param {(Shape | null | undefined)[]} shapes
 * @returns {boolean} 하나라도 놓을 수 있으면 true
 */
export function hasAnyMove(board, shapes) {
  return shapes.some((shape) => shape != null && canPlaceAnywhere(board, shape));
}
