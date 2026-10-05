// Canvas 렌더러. 게임 상태(GameState)와 드래그/미리보기를 받아 그리고, core 이벤트를 연출로 바꾼다.
// 시간은 render(now)가 넘겨주는 dt로만 흐르는 내부 시간선(time)을 쓴다: 연출이 프레임 단위로 결정적이다.
import { ANIM, BOARD_SIZE, EFFECTS, THEMES, TRAY_SIZE, UI } from '../config.js';
import { canPlaceAnywhere, getShape } from '../core/index.js';
import { ko } from '../i18n/ko.js';
import { SPRITE_DANGER, SPRITE_SHADOW, SPRITE_WHITE, cellMetrics, createSpriteCache, roundRectPath } from './block-sprites.js';
import { clamp01, easeInBack, easeOutBack, easeOutCubic, lerp, pulse } from './easing.js';
import { createEffects } from './effects.js';
import { anchorFraction, computeLayout, slotIndexAt } from './layout.js';

/**
 * @typedef {import('../core/types.js').GameState} GameState
 * @typedef {import('../core/types.js').GameEvent} GameEvent
 * @typedef {import('../core/types.js').Preview} Preview
 * @typedef {import('./layout.js').Layout} Layout
 * @typedef {{ trayIndex: number, x: number, y: number, pointerType: 'touch' | 'mouse' | 'pen' }} Drag
 */

const CELLS = BOARD_SIZE * BOARD_SIZE;
const NEVER = -1e9;
const TAU = Math.PI * 2;
const theme = THEMES.default;
const SHADOW_DROP = 0.14; // 들어 올린 블록 그림자가 아래로 처지는 정도(칸)

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ reducedMotion?: boolean, rng?: () => number }} [options]
 */
export function createRenderer(canvas, { reducedMotion = false, rng = Math.random } = {}) {
  const ctx = canvas.getContext('2d');
  const view = canvas.ownerDocument.defaultView;
  const sprites = createSpriteCache();
  const effects = createEffects({ reducedMotion, rng });

  let reduced = reducedMotion;
  let destroyed = false;
  /** @type {Layout | null} */
  let layout = null;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let cellDev = 0; // 보드 한 칸(기기 픽셀)
  let dragCellDev = 0; // 들어 올린 블록 한 칸
  /** @type {{ canvas: HTMLCanvasElement, x: number, y: number } | null} */
  let staticLayer = null;

  /** @type {GameState | null} */
  let state = null;
  let time = 0;
  let lastNow = -1;
  let dirty = true;
  let wasAnimating = false;
  let busyUntil = 0;
  let blockUntil = 0;
  let overStart = -1;

  // 칸별 연출(보드 칸 번호 = 행 * 8 + 열)
  const placeStart = new Float64Array(CELLS).fill(NEVER);
  const clearStart = new Float64Array(CELLS).fill(NEVER);
  const clearColor = new Uint8Array(CELLS);
  const clearActive = new Uint8Array(CELLS);
  const clearBurst = new Uint8Array(CELLS);
  let clearingCount = 0;
  let burstPerCell = EFFECTS.perCellMax;

  // 트레이 슬롯별 값
  const trayShapes = new Array(TRAY_SIZE).fill(null);
  const trayFitDev = new Int32Array(TRAY_SIZE); // 슬롯에 맞춘 블록의 칸 크기(기기 픽셀)
  const trayPlaceable = new Array(TRAY_SIZE).fill(true);
  const trayStart = new Float64Array(TRAY_SIZE).fill(NEVER);

  const drag = { active: false, trayIndex: -1, x: 0, y: 0, pointerType: 'mouse', start: 0 };
  let lastPointerType = 'mouse';
  const drop = { active: false, trayIndex: -1, fromX: 0, fromY: 0, fromScale: 1, start: 0 };
  const preview = { active: false, valid: false, color: 1, ghost: new Uint8Array(CELLS), clear: new Uint8Array(CELLS), rows: [], cols: [] };
  const snap = { valid: false, trayIndex: -1, row: 0, col: 0 };

  // 칸 하나를 그릴 때 squash 계산 결과를 담는 임시 값(할당을 피한다)
  let scaleX = 1;
  let scaleY = 1;

  function hold(until) {
    if (until > busyUntil) busyUntil = until;
  }

  function pointerKey(type) {
    return type === 'touch' || type === 'pen' ? type : 'mouse';
  }

  // ───────── 레이아웃 / 정적 레이어 ─────────

  function pixelAligned(value) {
    return Math.round(value * dpr) / dpr;
  }

  function buildStaticLayer() {
    const l = layout;
    const pad = pixelAligned(UI.wellPadCells * l.cell);
    const wellX = l.boardX - pad;
    const wellY = l.boardY - pad;
    const wellSize = l.boardSize + 2 * pad;

    // 그림자까지 담도록 여유를 두되 캔버스 밖은 자른다
    const bleed = Math.ceil(l.cell * 0.9);
    let left = wellX;
    let top = wellY;
    let right = wellX + wellSize;
    let bottom = wellY + wellSize;
    for (const slot of l.slots) {
      left = Math.min(left, slot.x);
      top = Math.min(top, slot.y);
      right = Math.max(right, slot.x + slot.w);
      bottom = Math.max(bottom, slot.y + slot.h);
    }
    const x = Math.max(0, Math.floor((left - bleed) * dpr) / dpr);
    const y = Math.max(0, Math.floor((top - bleed) * dpr) / dpr);
    const w = Math.min(cssW, Math.ceil((right + bleed) * dpr) / dpr) - x;
    const h = Math.min(cssH, Math.ceil((bottom + bleed) * dpr) / dpr) - y;

    const layer = canvas.ownerDocument.createElement('canvas');
    layer.width = Math.max(1, Math.round(w * dpr));
    layer.height = Math.max(1, Math.round(h * dpr));
    const g = layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, -x * dpr, -y * dpr);

    // 보드 우물: 살짝 떠 있는 느낌의 그림자 + 안쪽 1px 테두리
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.38)';
    g.shadowBlur = l.cell * 0.55;
    g.shadowOffsetY = l.cell * 0.14;
    roundRectPath(g, wellX, wellY, wellSize, wellSize, UI.wellRadiusCells * l.cell);
    g.fillStyle = theme.well;
    g.fill();
    g.restore();
    roundRectPath(g, wellX + 0.5, wellY + 0.5, wellSize - 1, wellSize - 1, UI.wellRadiusCells * l.cell);
    g.lineWidth = 1;
    g.strokeStyle = theme.wellBorder;
    g.stroke();

    // 빈 칸(체커 무늬)
    const { gap, size } = cellMetrics(cellDev);
    const inset = gap / 2 / dpr;
    const emptySize = size / dpr;
    for (let r = 0; r < BOARD_SIZE; r += 1) {
      for (let c = 0; c < BOARD_SIZE; c += 1) {
        roundRectPath(g, l.boardX + c * l.cell + inset, l.boardY + r * l.cell + inset, emptySize, emptySize, emptySize * UI.emptyRadius);
        g.fillStyle = (r + c) % 2 === 0 ? theme.cell : theme.cellAlt;
        g.fill();
      }
    }

    // 트레이 슬롯
    for (const slot of l.slots) {
      roundRectPath(g, slot.x, slot.y, slot.w, slot.h, UI.slotRadiusCells * l.cell);
      g.fillStyle = theme.panel;
      g.fill();
      roundRectPath(g, slot.x + 0.5, slot.y + 0.5, slot.w - 1, slot.h - 1, UI.slotRadiusCells * l.cell);
      g.lineWidth = 1;
      g.strokeStyle = theme.panelBorder;
      g.stroke();
    }
    staticLayer = { canvas: layer, x, y };
  }

  function computeTrayFits() {
    for (let i = 0; i < TRAY_SIZE; i += 1) {
      const shape = trayShapes[i];
      if (shape === null || !layout) {
        trayFitDev[i] = 0;
        continue;
      }
      const slot = layout.slots[i];
      const pad = UI.slotPadCells * layout.cell;
      const cell = Math.min(layout.trayCell, (slot.w - 2 * pad) / shape.width, (slot.h - 2 * pad) / shape.height);
      trayFitDev[i] = Math.max(1, Math.floor(cell * dpr + 1e-6));
    }
  }

  function resize() {
    if (destroyed) return layout;
    const rect = canvas.getBoundingClientRect();
    const nextDpr = view && view.devicePixelRatio > 0 ? view.devicePixelRatio : 1;
    if (layout !== null && rect.width === cssW && rect.height === cssH && nextDpr === dpr) return layout;

    cssW = rect.width;
    cssH = rect.height;
    dpr = nextDpr;
    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;

    layout = computeLayout({ width: cssW, height: cssH, dpr });
    cellDev = Math.max(1, Math.round(layout.cell * dpr));
    dragCellDev = Math.max(1, Math.round(layout.cell * UI.dragScale * dpr));
    effects.setMetrics({ cell: layout.cell, dpr });
    computeTrayFits();
    buildStaticLayer();
    snap.valid = false;
    dirty = true;
    if (cssW > 0 && cssH > 0) draw(); // 크기가 바뀐 직후에 빈 프레임이 비치지 않게 바로 그린다
    return layout;
  }

  // ───────── 상태 ─────────

  function resetAnimations() {
    placeStart.fill(NEVER);
    clearStart.fill(NEVER);
    clearActive.fill(0);
    clearBurst.fill(0);
    clearingCount = 0;
    drop.active = false;
    overStart = -1;
    blockUntil = 0;
    effects.clear();
  }

  function refreshTray(animateIn) {
    for (let i = 0; i < TRAY_SIZE; i += 1) {
      const piece = state === null ? null : state.tray[i];
      trayShapes[i] = piece ? getShape(piece.shapeId) : null;
      trayPlaceable[i] = trayShapes[i] === null || canPlaceAnywhere(state.board, trayShapes[i]);
      if (animateIn) trayStart[i] = trayShapes[i] === null ? NEVER : time + i * ANIM.trayInStaggerMs;
    }
    computeTrayFits();
    if (animateIn) hold(time + ANIM.trayInMs + (TRAY_SIZE - 1) * ANIM.trayInStaggerMs);
  }

  /** @param {GameState | null} next */
  function setState(next) {
    if (next === state) return;
    const prev = state;
    state = next;
    dirty = true;
    if (next === null) {
      resetAnimations();
      refreshTray(false);
      return;
    }
    const newGame = prev === null || next.moves < prev.moves;
    if (newGame) resetAnimations();
    refreshTray(newGame || next.trayIndex !== prev.trayIndex);
    if (next.status === 'over') {
      if (prev === null || prev.status !== 'over') {
        overStart = time + ANIM.overDimDelayMs;
        hold(overStart + ANIM.overDimMs);
      }
    } else {
      overStart = -1;
    }
  }

  // ───────── 드래그 / 미리보기 ─────────

  /** @param {Drag | null} next */
  function setDrag(next) {
    if (next === null || next === undefined) {
      drag.active = false;
      snap.valid = false;
      dirty = true;
      return;
    }
    if (!drag.active || drag.trayIndex !== next.trayIndex) {
      drag.start = time;
      drop.active = false;
      snap.valid = false;
    }
    drag.active = true;
    drag.trayIndex = next.trayIndex;
    drag.x = next.x;
    drag.y = next.y;
    drag.pointerType = pointerKey(next.pointerType);
    lastPointerType = drag.pointerType;
    dirty = true;
  }

  /** @param {{ anchor: { row: number, col: number }, preview: Preview } | null} next */
  function setPreview(next) {
    dirty = true;
    const piece = state !== null && drag.active ? state.tray[drag.trayIndex] : null;
    if (!next || !piece) {
      preview.active = false;
      return;
    }
    preview.active = true;
    preview.valid = next.preview.valid;
    preview.color = piece.color;
    preview.ghost.fill(0);
    preview.clear.fill(0);
    const cells = next.preview.cells;
    for (let i = 0; i < cells.length; i += 1) {
      const r = cells[i][0];
      const c = cells[i][1];
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) preview.ghost[r * BOARD_SIZE + c] = 1;
    }
    preview.rows = next.preview.valid ? next.preview.clearRows : [];
    preview.cols = next.preview.valid ? next.preview.clearCols : [];
    if (next.preview.valid) {
      const clearCells = next.preview.clearCells;
      for (let i = 0; i < clearCells.length; i += 1) preview.clear[clearCells[i][0] * BOARD_SIZE + clearCells[i][1]] = 1;
    }
  }

  /**
   * 드래그 중인 블록이 놓일 좌상단 칸. 보드 근처가 아니면 null.
   * 칸 경계에서는 직전 칸을 조금 더 붙들어서(히스테리시스) 고스트가 떨리지 않는다.
   * @param {Drag} d
   * @returns {{ row: number, col: number } | null}
   */
  function anchorForDrag(d) {
    if (!layout || state === null) return null;
    const shape = trayShapes[d.trayIndex];
    if (!shape) return null;
    const offset = layout.fingerOffset[pointerKey(d.pointerType)];
    const centerX = d.x;
    const centerY = d.y - offset;

    // 블록 중심이 보드 위에 있어야 보드에 올려 놓으려는 것으로 본다(집어 올리는 순간 트레이 위쪽에서 붉은 고스트가 깜빡이지 않게)
    if (
      centerX < layout.boardX ||
      centerX > layout.boardX + layout.boardSize ||
      centerY < layout.boardY ||
      centerY > layout.boardY + layout.boardSize
    ) {
      snap.valid = false;
      return null;
    }

    const fraction = anchorFraction(layout, shape, centerX, centerY);
    let col = Math.round(fraction.col) + 0;
    let row = Math.round(fraction.row) + 0;
    if (snap.valid && snap.trayIndex === d.trayIndex) {
      const keep = 0.5 + UI.snapHysteresis;
      if (Math.abs(fraction.col - snap.col) < keep) col = snap.col;
      if (Math.abs(fraction.row - snap.row) < keep) row = snap.row;
    }
    snap.valid = true;
    snap.trayIndex = d.trayIndex;
    snap.col = col;
    snap.row = row;
    return { row, col };
  }

  function trayIndexAt(x, y) {
    if (!layout || state === null) return -1;
    const index = slotIndexAt(layout, x, y);
    return index >= 0 && trayShapes[index] !== null ? index : -1;
  }

  /** 드래그 중이던 블록이 (fromX, fromY)에서 자기 슬롯으로 튕겨 돌아간다. 드래그와 미리보기도 함께 끝낸다. */
  function returnToTray(trayIndex, fromX, fromY) {
    if (!layout || trayShapes[trayIndex] === null) {
      setDrag(null);
      setPreview(null);
      return;
    }
    const offset = layout.fingerOffset[drag.active ? drag.pointerType : lastPointerType];
    drop.active = true;
    drop.trayIndex = trayIndex;
    drop.fromX = fromX;
    drop.fromY = fromY - offset;
    drop.fromScale = drag.active ? dragScaleNow() : 1;
    drop.start = time;
    hold(time + (reduced ? ANIM.reducedFadeMs : ANIM.returnMs));
    setDrag(null);
    setPreview(null);
  }

  // ───────── core 이벤트 → 연출 ─────────

  function cellX(col) {
    return layout.boardX + (col + 0.5) * layout.cell;
  }

  function cellY(row) {
    return layout.boardY + (row + 0.5) * layout.cell;
  }

  /** @param {readonly GameEvent[]} events */
  function playEvents(events) {
    if (!layout || !events || events.length === 0) return;
    let place = null;
    let clear = null;
    let combo = null;
    let perfect = null;
    let score = null;
    for (const event of events) {
      if (event.type === 'place') place = event;
      else if (event.type === 'clear') clear = event;
      else if (event.type === 'combo') combo = event;
      else if (event.type === 'perfect') perfect = event;
      else if (event.type === 'score') score = event;
    }
    const l = layout;
    dirty = true;

    // 놓은 칸의 중심(연출의 기준점)
    let originRow = (BOARD_SIZE - 1) / 2;
    let originCol = (BOARD_SIZE - 1) / 2;
    const source = place ? place.cells : clear ? clear.cells.map((cell) => [cell.r, cell.c]) : null;
    if (source && source.length > 0) {
      originRow = source.reduce((sum, cell) => sum + cell[0], 0) / source.length;
      originCol = source.reduce((sum, cell) => sum + cell[1], 0) / source.length;
    }

    if (place && !reduced) {
      for (const [r, c] of place.cells) placeStart[r * BOARD_SIZE + c] = time;
      hold(time + ANIM.placeMs);
    }

    if (clear) {
      const n = clear.cells.length;
      burstPerCell = Math.min(EFFECTS.perCellMax, Math.max(EFFECTS.perCellMin, Math.floor(EFFECTS.burstBudget / n)));
      const totalMs = reduced ? ANIM.reducedFadeMs : ANIM.clearFlashMs + ANIM.clearShrinkMs;
      for (const cell of clear.cells) {
        const index = cell.r * BOARD_SIZE + cell.c;
        const distance = Math.min(7, Math.hypot(cell.r - originRow, cell.c - originCol));
        const delay = reduced ? 0 : distance * ANIM.clearStaggerMs;
        if (clearActive[index] === 0) clearingCount += 1;
        clearActive[index] = 1;
        clearBurst[index] = 0;
        clearColor[index] = cell.color;
        clearStart[index] = time + delay;
        placeStart[index] = NEVER;
        hold(time + delay + totalMs);
      }
      for (const row of clear.rows) effects.lineFlash(l.boardX, l.boardY + row * l.cell, l.boardSize, l.cell);
      for (const col of clear.cols) effects.lineFlash(l.boardX + col * l.cell, l.boardY, l.cell, l.boardSize);
      const shake = Math.min(EFFECTS.shake.maxCells, EFFECTS.shake.baseCells + EFFECTS.shake.perLineCells * clear.lines);
      effects.shake(shake * l.cell);
      blockUntil = time + ANIM.clearLockMs;
    }

    if (perfect) {
      effects.startShimmer();
      effects.sparkleRain(l.boardX, l.boardY, l.boardSize, l.boardSize, EFFECTS.perfect.sparkleCount);
      effects.shake(EFFECTS.shake.perfectCells * l.cell, EFFECTS.shake.durationMs * 1.6);
    }

    spawnTexts(clear, combo, perfect, score, originRow, originCol);
  }

  function spawnTexts(clear, combo, perfect, score, originRow, originCol) {
    const l = layout;
    const tuning = EFFECTS.text;
    const maxWidth = l.boardSize * 0.92;
    const stack = [];
    if (perfect) {
      stack.push({ text: ko.fx.perfect, size: tuning.perfectCells, color: theme.fx.perfect, life: tuning.perfectLifeMs });
    }
    const praise = clear ? ko.fx.praise(clear.lines) : '';
    if (praise) stack.push({ text: praise, size: tuning.praiseCells, color: theme.fx.praise, life: tuning.praiseLifeMs });
    if (combo && combo.count >= 2) {
      const size = tuning.comboCells * (1 + 0.07 * Math.min(combo.count - 2, 4));
      stack.push({ text: ko.fx.combo(combo.count), size, color: theme.fx.combo, life: tuning.comboLifeMs });
    }

    // 글자들을 보드 가운데에 세로로 쌓는다
    let total = 0;
    for (const item of stack) total += item.size * 1.2 * l.cell;
    let y = l.boardY + l.boardSize * 0.42 - total / 2;
    for (let i = 0; i < stack.length; i += 1) {
      const item = stack[i];
      const height = item.size * 1.2 * l.cell;
      effects.addText({
        text: item.text,
        x: l.boardX + l.boardSize / 2,
        y: y + height / 2,
        size: item.size * l.cell,
        color: item.color,
        life: item.life,
        delay: EFFECTS.textDelayMs + i * 90,
        rise: tuning.stackRiseCells * l.cell,
        maxWidth,
        glow: true,
      });
      y += height;
    }

    if (score && score.delta > 0) {
      const big = score.breakdown.clear > 0;
      const size = (big ? tuning.scoreCells : tuning.scoreSmallCells) * l.cell;
      const margin = size * 1.6;
      const x = Math.min(l.boardX + l.boardSize - margin, Math.max(l.boardX + margin, cellX(originCol)));
      effects.addText({
        text: ko.fx.scoreDelta(score.delta),
        x,
        y: cellY(originRow) - l.cell * 0.35,
        size,
        color: big ? theme.fx.score : theme.fx.scoreSmall,
        life: big ? tuning.scoreLifeMs : tuning.scoreSmallLifeMs,
        delay: big ? EFFECTS.textDelayMs : 0,
        rise: EFFECTS.textRiseCells * l.cell,
        maxWidth: l.boardSize * 0.5,
        glow: false,
      });
    }
  }

  // ───────── 시간 진행 ─────────

  function isAnimating() {
    return dirty || drag.active || time < busyUntil || effects.isActive();
  }

  function isBlocking() {
    return time < blockUntil;
  }

  function advance(nowMs) {
    const now = nowMs === undefined ? performance.now() : nowMs;
    let dt = lastNow < 0 ? 1000 / 60 : now - lastNow;
    lastNow = now;
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, ANIM.maxFrameMs);
    time += dt;
    effects.update(dt);

    if (drop.active && time >= drop.start + (reduced ? ANIM.reducedFadeMs : ANIM.returnMs)) drop.active = false;

    if (clearingCount > 0) {
      const endMs = reduced ? ANIM.reducedFadeMs : ANIM.clearFlashMs + ANIM.clearShrinkMs;
      for (let i = 0; i < CELLS; i += 1) {
        if (clearActive[i] === 0) continue;
        const age = time - clearStart[i];
        if (age >= endMs) {
          clearActive[i] = 0;
          clearingCount -= 1;
        } else if (clearBurst[i] === 0 && age >= ANIM.clearFlashMs * 0.6 && !reduced) {
          clearBurst[i] = 1;
          effects.burst(cellX(i % BOARD_SIZE), cellY((i / BOARD_SIZE) | 0), clearColor[i], burstPerCell);
        }
      }
    }
  }

  /**
   * 한 프레임을 진행하고, 그릴 것이 있으면 그린다. 매 requestAnimationFrame에서 불러도 된다.
   * @param {number} [nowMs] requestAnimationFrame의 타임스탬프
   * @returns {boolean} 실제로 그렸으면 true
   */
  function render(nowMs) {
    if (destroyed) return false;
    advance(nowMs);
    if (!layout || cssW === 0 || cssH === 0) return false;
    const animating = isAnimating();
    // 애니메이션이 막 끝난 프레임에도 마지막 상태를 한 번 더 그린다
    if (!animating && !wasAnimating) return false;
    draw();
    dirty = false;
    wasAnimating = animating;
    return true;
  }

  // ───────── 그리기 ─────────

  function blit(sprite, centerX, centerY, sx, sy, alpha) {
    const w = (sprite.width / dpr) * sx;
    const h = (sprite.height / dpr) * sy;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, Math.round((centerX - w / 2) * dpr) / dpr, Math.round((centerY - h / 2) * dpr) / dpr, w, h);
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  // 놓은 직후: 납작하게 눌렸다가 위로 튕기며 제자리를 찾는다
  function squash(t) {
    const a = ANIM.placeSquash * Math.exp(-6 * t) * Math.cos(t * TAU * 1.6);
    scaleX = 1 + a;
    scaleY = 1 - a;
  }

  function drawBoardCells() {
    const l = layout;
    const board = state.board;
    for (let r = 0; r < BOARD_SIZE; r += 1) {
      const row = board[r];
      for (let c = 0; c < BOARD_SIZE; c += 1) {
        const color = row[c];
        if (color === 0) continue;
        const sprite = sprites.get(color, cellDev);
        const x = l.boardX + (c + 0.5) * l.cell;
        const y = l.boardY + (r + 0.5) * l.cell;
        const age = time - placeStart[r * BOARD_SIZE + c];
        if (age >= 0 && age < ANIM.placeMs) {
          const t = age / ANIM.placeMs;
          squash(t);
          blit(sprite, x, y, scaleX, scaleY, 1);
          if (t < 0.45) blit(sprites.get(SPRITE_WHITE, cellDev), x, y, scaleX, scaleY, 0.5 * (1 - t / 0.45));
        } else {
          blit(sprite, x, y, 1, 1, 1);
        }
      }
    }
  }

  function drawClearingCells() {
    if (clearingCount === 0) return;
    const white = sprites.get(SPRITE_WHITE, cellDev);
    for (let i = 0; i < CELLS; i += 1) {
      if (clearActive[i] === 0) continue;
      const x = cellX(i % BOARD_SIZE);
      const y = cellY((i / BOARD_SIZE) | 0);
      const age = time - clearStart[i];
      const sprite = sprites.get(clearColor[i], cellDev);
      if (age < 0) {
        blit(sprite, x, y, 1, 1, 1);
      } else if (reduced) {
        blit(sprite, x, y, 1, 1, 1 - clamp01(age / ANIM.reducedFadeMs));
      } else if (age < ANIM.clearFlashMs) {
        const p = easeOutCubic(age / ANIM.clearFlashMs);
        const s = 1 + ANIM.clearFlashScale * p;
        blit(sprite, x, y, s, s, 1);
        blit(white, x, y, s, s, p);
      } else {
        const q = (age - ANIM.clearFlashMs) / ANIM.clearShrinkMs;
        const s = (1 + ANIM.clearFlashScale) * (1 - easeInBack(q, 1.2));
        if (s > 0.01) {
          // 흰색에서 원래 색으로 돌아오며 사라진다(흰색만 흐려지면 칙칙한 회색으로 보인다)
          const fade = 1 - q * q * q;
          blit(sprite, x, y, s, s, fade);
          blit(white, x, y, s, s, fade * (1 - q));
        }
      }
    }
  }

  // 지워질 줄 전체를 금색 테두리로 감싸서 어느 줄이 터질지 한눈에 보이게 한다
  function drawLineOutline(x, y, w, h, level) {
    const l = layout;
    const inset = l.cell * 0.04;
    roundRectPath(ctx, x + inset, y + inset, w - 2 * inset, h - 2 * inset, l.cell * UI.blockRadius);
    ctx.globalAlpha = 0.08 + 0.1 * level;
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.globalAlpha = 0.45 + 0.45 * level;
    ctx.lineWidth = Math.max(2, l.cell * 0.06);
    ctx.strokeStyle = theme.accent;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawPreview() {
    if (!preview.active) return;
    const l = layout;
    const level = reduced ? 0.5 : pulse((time % ANIM.previewPulseMs) / ANIM.previewPulseMs);
    const ghostKind = preview.valid ? preview.color : SPRITE_DANGER;
    const white = sprites.get(SPRITE_WHITE, cellDev);
    for (let i = 0; i < CELLS; i += 1) {
      const clearing = preview.clear[i] === 1;
      if (!clearing && preview.ghost[i] === 0) continue;
      const r = (i / BOARD_SIZE) | 0;
      const x = cellX(i % BOARD_SIZE);
      const y = cellY(r);
      if (clearing) {
        // 지워질 칸: 부풀며 하얗게 깜빡인다
        const existing = state.board[r][i % BOARD_SIZE];
        const s = 1 + 0.06 * level;
        blit(sprites.get(existing > 0 ? existing : preview.color, cellDev), x, y, s, s, 1);
        blit(white, x, y, s, s, 0.14 + 0.36 * level);
      } else if (preview.valid) {
        blit(sprites.get(ghostKind, cellDev), x, y, 1, 1, 0.5);
      } else {
        blit(sprites.get(ghostKind, cellDev), x, y, 1, 1, 1);
      }
    }
    for (let i = 0; i < preview.rows.length; i += 1) drawLineOutline(l.boardX, l.boardY + preview.rows[i] * l.cell, l.boardSize, l.cell, level);
    for (let i = 0; i < preview.cols.length; i += 1) drawLineOutline(l.boardX + preview.cols[i] * l.cell, l.boardY, l.cell, l.boardSize, level);
  }

  function drawPiece(shape, kind, baseDev, centerX, centerY, scale, alpha) {
    const cellCss = (baseDev / dpr) * scale;
    const originX = Math.round((centerX - (shape.width * cellCss) / 2) * dpr) / dpr;
    const originY = Math.round((centerY - (shape.height * cellCss) / 2) * dpr) / dpr;
    const sprite = sprites.get(kind, baseDev);
    const cells = shape.cells;
    for (let i = 0; i < cells.length; i += 1) {
      blit(sprite, originX + (cells[i][1] + 0.5) * cellCss, originY + (cells[i][0] + 0.5) * cellCss, scale, scale, alpha);
    }
  }

  function drawPieceShadow(shape, baseDev, centerX, centerY, scale, alpha) {
    const cellCss = (baseDev / dpr) * scale;
    const originX = centerX - (shape.width * cellCss) / 2;
    const originY = centerY - (shape.height * cellCss) / 2 + SHADOW_DROP * cellCss;
    const sprite = sprites.get(SPRITE_SHADOW, baseDev);
    const cells = shape.cells;
    for (let i = 0; i < cells.length; i += 1) {
      blit(sprite, originX + (cells[i][1] + 0.5) * cellCss, originY + (cells[i][0] + 0.5) * cellCss, scale, scale, alpha);
    }
  }

  function drawTray() {
    for (let i = 0; i < TRAY_SIZE; i += 1) {
      const shape = trayShapes[i];
      if (shape === null || (drag.active && drag.trayIndex === i) || (drop.active && drop.trayIndex === i)) continue;
      const slot = layout.slots[i];
      const piece = state.tray[i];
      let scale = 1;
      let alpha = trayPlaceable[i] ? 1 : 0.38;
      let y = slot.cy;
      const age = time - trayStart[i];
      if (age < ANIM.trayInMs) {
        if (age < 0) continue;
        const t = age / ANIM.trayInMs;
        if (reduced) {
          alpha *= clamp01(age / ANIM.reducedFadeMs);
        } else {
          scale = lerp(0.4, 1, easeOutBack(t, 1.6));
          alpha *= clamp01(t * 2.5);
          y += (1 - easeOutCubic(t)) * layout.cell * 0.7;
        }
      }
      drawPiece(shape, piece.color, trayFitDev[i], slot.cx, y, scale, alpha);
    }
  }

  // 드래그 블록의 크기: 트레이 크기에서 들어 올린 크기로(보드 칸 크기 기준 배율)
  function dragScaleNow() {
    const from = trayFitDev[drag.trayIndex] / dragCellDev;
    const t = reduced ? 1 : easeOutCubic((time - drag.start) / ANIM.pickupMs);
    return lerp(from, 1, t);
  }

  function drawDragged() {
    const shape = trayShapes[drag.trayIndex];
    if (shape === null) return;
    const piece = state.tray[drag.trayIndex];
    const slot = layout.slots[drag.trayIndex];
    const t = reduced ? 1 : easeOutCubic((time - drag.start) / ANIM.pickupMs);
    const targetY = drag.y - layout.fingerOffset[drag.pointerType];
    const x = lerp(slot.cx, drag.x, t);
    const y = lerp(slot.cy, targetY, t);
    const scale = dragScaleNow();
    drawPieceShadow(shape, dragCellDev, x, y, scale, 0.85 * t);
    drawPiece(shape, piece.color, dragCellDev, x, y, scale, 1);
    // 놓을 수 없는 자리에서는 블록 자체를 붉게 물들여, 마우스처럼 고스트가 블록에 가려져도 알아보게 한다
    if (preview.active && !preview.valid) drawPiece(shape, SPRITE_DANGER, dragCellDev, x, y, scale, 0.9);
  }

  function drawReturning() {
    const shape = trayShapes[drop.trayIndex];
    if (shape === null) return;
    const piece = state.tray[drop.trayIndex];
    const slot = layout.slots[drop.trayIndex];
    const t = clamp01((time - drop.start) / (reduced ? ANIM.reducedFadeMs : ANIM.returnMs));
    const e = reduced ? t : easeOutBack(t, 1.3);
    const toScale = trayFitDev[drop.trayIndex] / dragCellDev;
    const scale = Math.max(0.05, lerp(drop.fromScale, toScale, e));
    const x = lerp(drop.fromX, slot.cx, e);
    const y = lerp(drop.fromY, slot.cy, e);
    drawPieceShadow(shape, dragCellDev, x, y, scale, 0.85 * (1 - t));
    drawPiece(shape, piece.color, dragCellDev, x, y, scale, 1);
  }

  function drawOverDim() {
    if (overStart < 0 || time < overStart) return;
    const l = layout;
    const alpha = clamp01((time - overStart) / ANIM.overDimMs);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = theme.dim;
    const pad = UI.wellPadCells * l.cell;
    roundRectPath(ctx, l.boardX - pad, l.boardY - pad, l.boardSize + 2 * pad, l.boardSize + 2 * pad, UI.wellRadiusCells * l.cell);
    ctx.fill();
    for (const slot of l.slots) {
      roundRectPath(ctx, slot.x, slot.y, slot.w, slot.h, UI.slotRadiusCells * l.cell);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    const l = layout;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.setTransform(dpr, 0, 0, dpr, effects.offset.x * dpr, effects.offset.y * dpr);

    if (staticLayer !== null) ctx.drawImage(staticLayer.canvas, staticLayer.x, staticLayer.y, staticLayer.canvas.width / dpr, staticLayer.canvas.height / dpr);

    if (state !== null) {
      drawBoardCells();
      drawClearingCells();
      drawPreview();
      effects.drawWorld(ctx, { boardX: l.boardX, boardY: l.boardY, boardSize: l.boardSize, radius: UI.blockRadius * l.cell });
      drawTray();
      if (drop.active) drawReturning();
      if (drag.active) drawDragged();
      drawOverDim();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    effects.drawOverlay(ctx, dpr);
  }

  // ───────── 설정 / 정리 ─────────

  function setReducedMotion(value) {
    reduced = Boolean(value);
    effects.setReducedMotion(reduced);
    dirty = true;
  }

  const onWindowResize = () => resize();
  /** @type {ResizeObserver | null} */
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onWindowResize) : null;
  if (observer) observer.observe(canvas);
  if (view) {
    view.addEventListener('resize', onWindowResize);
    view.addEventListener('orientationchange', onWindowResize);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (observer) observer.disconnect();
    if (view) {
      view.removeEventListener('resize', onWindowResize);
      view.removeEventListener('orientationchange', onWindowResize);
    }
    sprites.clear();
    effects.clear();
    staticLayer = null;
    state = null;
  }

  resize();

  return {
    resize,
    get layout() {
      return layout;
    },
    setState,
    setDrag,
    setPreview,
    anchorForDrag,
    trayIndexAt,
    returnToTray,
    playEvents,
    isBlocking,
    isAnimating,
    render,
    setReducedMotion,
    destroy,
  };
}
