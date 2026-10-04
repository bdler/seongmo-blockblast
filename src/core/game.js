import { BOARD_SIZE, COLOR_COUNT, TRAY_SIZE } from '../config.js';
import {
  clearLines,
  createBoard,
  findFullLines,
  hasAnyMove,
  isBoardEmpty,
  listPlacements,
  placeShape,
} from './board.js';
import { generateTray } from './generator.js';
import { createRng, seedToInt } from './rng.js';
import { nextCombo, scoreMove } from './scoring.js';
import { getShape, hasShape } from './shapes.js';

/**
 * @typedef {import('./types.js').GameState} GameState
 * @typedef {import('./types.js').GameEvent} GameEvent
 * @typedef {import('./types.js').MoveResult} MoveResult
 * @typedef {import('./types.js').Preview} Preview
 * @typedef {import('./types.js').TrayPiece} TrayPiece
 */

const STATE_VERSION = 1;
const MODES = ['classic', 'daily'];
const STATUSES = ['playing', 'over'];
const COUNTER_KEYS = ['score', 'combo', 'maxCombo', 'lines', 'moves', 'perfects'];

/** @param {(TrayPiece | null)[]} tray */
function cloneTray(tray) {
  return tray.map((piece) => (piece === null ? null : { shapeId: piece.shapeId, color: piece.color }));
}

/** @param {(TrayPiece | null)[]} tray */
function trayShapes(tray) {
  return tray.map((piece) => (piece === null ? null : getShape(piece.shapeId)));
}

/**
 * 새 게임을 만든다. 시드가 문자열이면 hashSeed를 거치고, 숫자는 uint32로 잘라 쓴다.
 * 첫 트레이는 trayIndex 0이다.
 * @param {{ mode?: 'classic' | 'daily', seed?: number | string }} [options]
 * @returns {GameState}
 */
export function createGame({ mode = 'classic', seed = 1 } = {}) {
  if (!MODES.includes(mode)) throw new RangeError(`unknown mode: ${String(mode)}`);
  const rng = createRng(seedToInt(seed));
  const board = createBoard();
  const tray = generateTray({ board, rng, mode, seed, trayIndex: 0, score: 0 });
  return {
    version: STATE_VERSION,
    mode,
    seed,
    rngState: rng.state(),
    board,
    tray,
    trayIndex: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    lines: 0,
    moves: 0,
    perfects: 0,
    status: 'playing',
  };
}

/**
 * 이동의 유효성을 검사한다. applyMove와 previewMove가 같은 판정을 쓰도록 한 곳에 둔다.
 * @param {GameState} state
 * @param {number} trayIndex
 * @param {number} row
 * @param {number} col
 * @returns {{ error: string | null, shape?: import('./types.js').Shape, piece?: TrayPiece }}
 *   error가 null이면 shape와 piece가 항상 있다
 */
function checkMove(state, trayIndex, row, col) {
  const validArgs =
    state != null &&
    Array.isArray(state.tray) &&
    Number.isInteger(trayIndex) &&
    trayIndex >= 0 &&
    trayIndex < TRAY_SIZE &&
    Number.isInteger(row) &&
    Number.isInteger(col);
  if (!validArgs) return { error: 'bad_args' };
  if (state.status === 'over') return { error: 'game_over' };

  const piece = state.tray[trayIndex];
  if (piece == null) return { error: 'empty_slot' };

  const shape = getShape(piece.shapeId);
  const inBounds = row >= 0 && col >= 0 && row + shape.height <= BOARD_SIZE && col + shape.width <= BOARD_SIZE;
  if (!inBounds) return { error: 'out_of_bounds', shape, piece };
  for (const [dr, dc] of shape.cells) {
    if (state.board[row + dr][col + dc] !== 0) return { error: 'overlap', shape, piece };
  }
  return { error: null, shape, piece };
}

/** @returns {[number, number][]} */
function absoluteCells(shape, row, col) {
  return shape.cells.map(([dr, dc]) => [row + dr, col + dc]);
}

/**
 * 블록을 놓기 전에 결과를 미리 본다(고스트/줄 강조용). 상태는 바뀌지 않는다.
 * 유효하지 않아도 모양을 알 수 있으면 cells는 놓으려던 절대 좌표(보드 밖일 수 있음)를 담는다.
 * @param {GameState} state
 * @param {number} trayIndex
 * @param {number} row 블록 좌상단이 놓일 행
 * @param {number} col 블록 좌상단이 놓일 열
 * @returns {Preview}
 */
export function previewMove(state, trayIndex, row, col) {
  const check = checkMove(state, trayIndex, row, col);
  if (check.error !== null) {
    return {
      valid: false,
      reason: check.error,
      cells: check.shape ? absoluteCells(check.shape, row, col) : [],
      clearRows: [],
      clearCols: [],
      clearCells: [],
    };
  }

  const placed = placeShape(state.board, check.shape, row, col, check.piece.color);
  const { rows, cols } = findFullLines(placed);
  const clearCells = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (rows.includes(r) || cols.includes(c)) clearCells.push([r, c]);
    }
  }
  return {
    valid: true,
    cells: absoluteCells(check.shape, row, col),
    clearRows: rows,
    clearCols: cols,
    clearCells,
  };
}

/**
 * 블록을 놓는다. 유효성 검사 → 배치 → 줄 탐색 → 제거 → 콤보/점수 → 퍼펙트 →
 * (트레이가 비었으면) 리필 → 게임오버 판정(리필 이후) 순으로 처리하고, 입력 상태는 수정하지 않는다.
 * 실패하면 `{ ok: false, error, state(입력 그대로), events: [] }`이며 error는
 * 'bad_args' | 'game_over' | 'empty_slot' | 'out_of_bounds' | 'overlap' 중 하나다.
 * @param {GameState} state
 * @param {number} trayIndex 0~TRAY_SIZE-1
 * @param {number} row 블록 좌상단이 놓일 행
 * @param {number} col 블록 좌상단이 놓일 열
 * @returns {MoveResult}
 */
export function applyMove(state, trayIndex, row, col) {
  const check = checkMove(state, trayIndex, row, col);
  if (check.error !== null) return { ok: false, error: check.error, state, events: [] };
  const { shape, piece } = check;

  /** @type {GameEvent[]} */
  const events = [];

  const placed = placeShape(state.board, shape, row, col, piece.color);
  events.push({ type: 'place', shapeId: shape.id, color: piece.color, cells: absoluteCells(shape, row, col) });

  const fullLines = findFullLines(placed);
  const linesCleared = fullLines.rows.length + fullLines.cols.length;
  let board = placed;
  if (linesCleared > 0) {
    const cleared = clearLines(placed, fullLines);
    board = cleared.board;
    events.push({
      type: 'clear',
      rows: fullLines.rows,
      cols: fullLines.cols,
      cells: cleared.clearedCells,
      lines: linesCleared,
    });
  }

  const combo = nextCombo(state.combo, linesCleared);
  const perfect = linesCleared > 0 && isBoardEmpty(board);
  const points = scoreMove({ placedCells: shape.size, linesCleared, combo, perfect });
  if (linesCleared > 0) events.push({ type: 'combo', count: combo, multiplier: points.multiplier });
  else if (state.combo > 0) events.push({ type: 'comboBreak', previous: state.combo });
  if (perfect) events.push({ type: 'perfect', bonus: points.perfect });

  const score = state.score + points.total;
  events.push({
    type: 'score',
    delta: points.total,
    total: score,
    breakdown: { place: points.place, clear: points.clear, perfect: points.perfect },
  });

  let tray = cloneTray(state.tray);
  tray[trayIndex] = null;
  let { trayIndex: currentTrayIndex, rngState } = state;
  if (tray.every((slot) => slot === null)) {
    currentTrayIndex += 1;
    const rng = createRng(rngState);
    tray = generateTray({
      board,
      rng,
      mode: state.mode,
      seed: state.seed,
      trayIndex: currentTrayIndex,
      score,
    });
    rngState = rng.state();
    events.push({ type: 'trayRefill', tray: cloneTray(tray) });
  }

  const next = {
    version: state.version,
    mode: state.mode,
    seed: state.seed,
    rngState,
    board,
    tray,
    trayIndex: currentTrayIndex,
    score,
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
    lines: state.lines + linesCleared,
    moves: state.moves + 1,
    perfects: state.perfects + (perfect ? 1 : 0),
    status: 'playing',
  };

  // 게임오버는 반드시 리필 이후에 판정한다(막 비운 빈 트레이로 판정하면 안 된다)
  if (!hasAnyMove(board, trayShapes(tray))) {
    next.status = 'over';
    events.push({
      type: 'gameover',
      score,
      stats: { lines: next.lines, maxCombo: next.maxCombo, moves: next.moves, perfects: next.perfects },
    });
  }

  return { ok: true, state: next, events };
}

/**
 * 지금 둘 수 있는 모든 수. trayIndex 순서, 같은 슬롯 안에서는 행 우선 순서다.
 * 게임이 끝났으면 빈 배열이다.
 * @param {GameState} state
 * @returns {{ trayIndex: number, row: number, col: number }[]}
 */
export function listMoves(state) {
  if (state.status === 'over') return [];
  const moves = [];
  state.tray.forEach((piece, trayIndex) => {
    if (piece === null) return;
    for (const [row, col] of listPlacements(state.board, getShape(piece.shapeId))) {
      moves.push({ trayIndex, row, col });
    }
  });
  return moves;
}

/**
 * @param {GameState} state
 * @returns {boolean}
 */
export function isGameOver(state) {
  return state.status === 'over';
}

/** @param {unknown} value */
function isCount(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/** @param {unknown} board */
function isValidBoard(board) {
  return (
    Array.isArray(board) &&
    board.length === BOARD_SIZE &&
    board.every(
      (row) =>
        Array.isArray(row) &&
        row.length === BOARD_SIZE &&
        row.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= COLOR_COUNT),
    )
  );
}

/** @param {unknown} piece */
function isValidTrayPiece(piece) {
  return (
    piece !== null &&
    typeof piece === 'object' &&
    typeof piece.shapeId === 'string' &&
    hasShape(piece.shapeId) &&
    Number.isInteger(piece.color) &&
    piece.color >= 1 &&
    piece.color <= COLOR_COUNT
  );
}

/**
 * 저장된 상태(JSON.parse 결과 등)를 엄격하게 검증해 새 GameState로 복원한다.
 * 구조가 조금이라도 어긋나거나(8x8 정수 보드, 길이 3의 트레이, 유한한 음이 아닌 카운터, 올바른 status 등),
 * status가 보드/트레이 상황과 모순되면(진행 중인데 둘 곳이 없거나, 종료인데 둘 곳이 있음) null을 돌려준다.
 * @param {unknown} saved
 * @returns {GameState | null}
 */
export function restoreGame(saved) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const s = /** @type {Record<string, any>} */ (saved);

  const validSeed = typeof s.seed === 'string' || (typeof s.seed === 'number' && Number.isFinite(s.seed));
  const validRngState = Number.isInteger(s.rngState) && s.rngState >= 0 && s.rngState <= 0xffffffff;
  const validTray =
    Array.isArray(s.tray) &&
    s.tray.length === TRAY_SIZE &&
    s.tray.every((piece) => piece === null || isValidTrayPiece(piece));
  const valid =
    s.version === STATE_VERSION &&
    MODES.includes(s.mode) &&
    STATUSES.includes(s.status) &&
    validSeed &&
    validRngState &&
    isValidBoard(s.board) &&
    validTray &&
    COUNTER_KEYS.every((key) => isCount(s[key])) &&
    isCount(s.trayIndex);
  if (!valid) return null;

  const board = s.board.map((row) => row.slice());
  const tray = cloneTray(s.tray);
  if ((s.status === 'over') === hasAnyMove(board, trayShapes(tray))) return null;

  return {
    version: STATE_VERSION,
    mode: s.mode,
    seed: s.seed,
    rngState: s.rngState,
    board,
    tray,
    trayIndex: s.trayIndex,
    score: s.score,
    combo: s.combo,
    maxCombo: s.maxCombo,
    lines: s.lines,
    moves: s.moves,
    perfects: s.perfects,
    status: s.status,
  };
}
