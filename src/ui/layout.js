// 캔버스 레이아웃 계산(순수 함수). 모든 좌표는 캔버스 CSS px이고, 기기 픽셀 경계(1/dpr)에 맞춘다.
import { BOARD_SIZE, TRAY_SIZE, UI } from '../config.js';

/**
 * @typedef {object} Slot
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} cx 슬롯 중심(기기 픽셀 경계에 맞추지 않는다)
 * @property {number} cy
 *
 * @typedef {object} Layout
 * @property {number} width
 * @property {number} height
 * @property {number} dpr
 * @property {'portrait' | 'landscape'} orientation
 * @property {number} cell 보드 한 칸 크기
 * @property {number} boardX 보드 격자의 좌상단
 * @property {number} boardY
 * @property {number} boardSize
 * @property {number} trayCell 트레이 블록의 기본 칸 크기(슬롯에 안 맞으면 렌더러가 더 줄인다)
 * @property {Slot[]} slots
 * @property {{ touch: number, mouse: number, pen: number }} fingerOffset 블록 중심을 포인터보다 위로 올리는 거리
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {{ width: number, height: number, dpr?: number }} size
 * @returns {Layout}
 */
export function computeLayout({ width, height, dpr = 1 }) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const round = (v) => Math.round(v * scale) / scale;
  const floor = (v) => Math.floor(v * scale + 1e-6) / scale;
  const minCell = 1 / scale;

  const margin = round(clamp(Math.min(width, height) * UI.marginRatio, UI.marginMin, UI.marginMax));
  const availW = Math.max(0, width - 2 * margin);
  const availH = Math.max(0, height - 2 * margin);
  const slotGaps = 2 * UI.slotGapCells;

  // 두 방향 중 칸이 더 크게 나오는 쪽을 고른다(정사각형에 가까운 창에서도 자연스럽다)
  const portraitCell = Math.min(availW / BOARD_SIZE, availH / (BOARD_SIZE + UI.trayGapCells + UI.portraitSlotHeightCells));
  const landscapeCell = Math.min(availH / BOARD_SIZE, availW / (BOARD_SIZE + UI.trayGapCells + UI.landscapeSlotWidthCells));
  const orientation = landscapeCell > portraitCell ? 'landscape' : 'portrait';
  const rawCell = orientation === 'landscape' ? landscapeCell : portraitCell;

  const cell = Math.max(minCell, floor(Math.min(rawCell, UI.maxCell)));
  const boardSize = cell * BOARD_SIZE;
  const gap = round(UI.trayGapCells * cell);
  const slotGap = round(UI.slotGapCells * cell);

  let boardX;
  let boardY;
  /** @type {Slot[]} */
  const slots = [];

  if (orientation === 'portrait') {
    const slotH = round(UI.portraitSlotHeightCells * cell);
    const slotW = floor((boardSize - slotGaps * cell) / TRAY_SIZE);
    const groupH = boardSize + gap + slotH;
    boardX = round((width - boardSize) / 2);
    boardY = round(margin + Math.max(0, height - 2 * margin - groupH) * UI.verticalBias);
    const trayX = round(boardX + (boardSize - (TRAY_SIZE * slotW + (TRAY_SIZE - 1) * slotGap)) / 2);
    const trayY = boardY + boardSize + gap;
    for (let i = 0; i < TRAY_SIZE; i += 1) {
      const x = round(trayX + i * (slotW + slotGap));
      slots.push({ x, y: trayY, w: slotW, h: slotH, cx: x + slotW / 2, cy: trayY + slotH / 2 });
    }
  } else {
    const slotW = round(UI.landscapeSlotWidthCells * cell);
    const slotH = floor((boardSize - slotGaps * cell) / TRAY_SIZE);
    const groupW = boardSize + gap + slotW;
    boardX = round((width - groupW) / 2);
    boardY = round((height - boardSize) / 2);
    const trayX = boardX + boardSize + gap;
    const trayY = round(boardY + (boardSize - (TRAY_SIZE * slotH + (TRAY_SIZE - 1) * slotGap)) / 2);
    for (let i = 0; i < TRAY_SIZE; i += 1) {
      const y = round(trayY + i * (slotH + slotGap));
      slots.push({ x: trayX, y, w: slotW, h: slotH, cx: trayX + slotW / 2, cy: y + slotH / 2 });
    }
  }

  return {
    width,
    height,
    dpr: scale,
    orientation,
    cell,
    boardX,
    boardY,
    boardSize,
    trayCell: Math.max(minCell, floor(UI.trayCellRatio * cell)),
    slots,
    fingerOffset: {
      touch: round(UI.fingerOffsetCells.touch * cell),
      mouse: round(UI.fingerOffsetCells.mouse * cell),
      pen: round(UI.fingerOffsetCells.pen * cell),
    },
  };
}

/**
 * 모양의 중심이 (centerX, centerY)에 놓이도록 한 좌상단 칸의 "소수" 좌표.
 * 정수로 반올림하기 전 값이라 렌더러가 칸 경계의 떨림을 막는 데 쓴다.
 * @param {Layout} layout
 * @param {{ width: number, height: number }} shape
 * @returns {{ row: number, col: number }}
 */
export function anchorFraction(layout, shape, centerX, centerY) {
  return {
    row: (centerY - layout.boardY) / layout.cell - shape.height / 2,
    col: (centerX - layout.boardX) / layout.cell - shape.width / 2,
  };
}

/**
 * 모양의 중심이 점에 가장 가까운 좌상단 칸. 보드 밖일 수 있다.
 * @param {Layout} layout
 * @param {{ width: number, height: number }} shape
 * @returns {{ row: number, col: number }}
 */
export function anchorFromPoint(layout, shape, centerX, centerY) {
  const fraction = anchorFraction(layout, shape, centerX, centerY);
  // + 0은 Math.round가 만드는 -0을 0으로 바꾼다
  return { row: Math.round(fraction.row) + 0, col: Math.round(fraction.col) + 0 };
}

/**
 * 점이 속한 트레이 슬롯 번호(없으면 -1). 슬롯 사이 틈의 절반까지 포함해서 손가락이 조금 빗나가도 잡힌다.
 * @param {Layout} layout
 * @returns {number}
 */
export function slotIndexAt(layout, x, y) {
  const pad = (layout.orientation === 'portrait' ? layout.slots[1].x - layout.slots[0].x - layout.slots[0].w : layout.slots[1].y - layout.slots[0].y - layout.slots[0].h) / 2;
  for (let i = 0; i < layout.slots.length; i += 1) {
    const s = layout.slots[i];
    if (x >= s.x - pad && x < s.x + s.w + pad && y >= s.y - pad && y < s.y + s.h + pad) return i;
  }
  return -1;
}
