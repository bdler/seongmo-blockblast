// 블록 스프라이트: (종류, 칸 크기[기기 픽셀])마다 한 번만 그려 두고 프레임에서는 drawImage만 쓴다.
// 그라데이션 생성은 비싸서, 칸마다 매 프레임 만들면 모바일에서 프레임이 끊긴다.
import { PALETTE, THEMES, UI } from '../config.js';

export const SPRITE_DANGER = PALETTE.length + 1; // 놓을 수 없는 자리를 알리는 붉은 칸
export const SPRITE_WHITE = PALETTE.length + 2; // 번쩍임용 흰 칸(알파로 섞어 쓴다)
export const SPRITE_SHADOW = PALETTE.length + 3; // 들어 올린 블록 아래의 그림자

const MAX_CACHED = 240;
const KEY_STRIDE = 65536;

/** @param {string} hex '#rrggbb' */
export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * a에서 b 쪽으로 t만큼 섞은 색.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
export function mixRgb(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/** @param {number[]} rgb */
export function rgbaString(rgb, alpha = 1) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/**
 * 칸 크기(기기 픽셀)에서 칸 사이 간격과 블록 크기를 구한다. 간격은 짝수여서 양쪽에 똑같이 나뉜다.
 * @param {number} cellDev
 * @returns {{ gap: number, size: number }}
 */
export function cellMetrics(cellDev) {
  const gap = cellDev <= 4 ? 0 : 2 * Math.max(Math.round(UI.cellGapMin / 2), Math.round(cellDev * UI.cellGapRatio * 0.5));
  return { gap, size: Math.max(1, cellDev - gap) };
}

/** 구형 브라우저에도 있는 arcTo로 둥근 사각형 경로를 만든다. */
export function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const WHITE = [255, 255, 255];
const BLACK = [8, 6, 30];
const PALETTE_RGB = PALETTE.map(hexToRgb);

function drawBlock(ctx, s, rgb) {
  const radius = s * UI.blockRadius;
  const edge = Math.max(1, Math.round(s * 0.09)); // 아래쪽에 남기는 어두운 두께
  const bodyH = s - edge;

  // 아래쪽 어두운 면(입체감)
  roundRectPath(ctx, 0, 0, s, s, radius);
  ctx.fillStyle = rgbaString(mixRgb(rgb, BLACK, 0.34));
  ctx.fill();

  // 본체: 왼쪽 위가 밝고 오른쪽 아래가 살짝 진한 사탕 느낌
  roundRectPath(ctx, 0, 0, s, bodyH, radius);
  const body = ctx.createLinearGradient(0, 0, s * 0.7, bodyH);
  body.addColorStop(0, rgbaString(mixRgb(rgb, WHITE, 0.3)));
  body.addColorStop(0.5, rgbaString(rgb));
  body.addColorStop(1, rgbaString(mixRgb(rgb, BLACK, 0.1)));
  ctx.fillStyle = body;
  ctx.fill();

  ctx.save();
  roundRectPath(ctx, 0, 0, s, bodyH, radius);
  ctx.clip();

  // 부드러운 광택: 왼쪽 위의 넓은 빛 번짐
  const gloss = ctx.createRadialGradient(s * 0.3, s * 0.24, 0, s * 0.3, s * 0.24, s * 0.62);
  gloss.addColorStop(0, 'rgba(255,255,255,0.5)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, s, bodyH);

  // 위쪽에 얹은 작은 하이라이트 캡슐
  roundRectPath(ctx, s * 0.16, s * 0.1, s * 0.46, s * 0.1, s * 0.05);
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fill();
  ctx.restore();

  // 안쪽 1px 빛 테두리(위쪽이 더 밝다)
  const line = Math.max(1, Math.round(s * 0.03));
  roundRectPath(ctx, line / 2, line / 2, s - line, bodyH - line, radius - line / 2);
  const rim = ctx.createLinearGradient(0, 0, 0, bodyH);
  rim.addColorStop(0, 'rgba(255,255,255,0.5)');
  rim.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  rim.addColorStop(1, 'rgba(255,255,255,0.28)');
  ctx.lineWidth = line;
  ctx.strokeStyle = rim;
  ctx.stroke();
}

function drawDanger(ctx, s) {
  const danger = hexToRgb(THEMES.default.danger);
  const line = Math.max(1, Math.round(s * 0.04));
  roundRectPath(ctx, 0, 0, s, s, s * UI.blockRadius);
  ctx.fillStyle = rgbaString(danger, 0.42);
  ctx.fill();
  roundRectPath(ctx, line / 2, line / 2, s - line, s - line, s * UI.blockRadius - line / 2);
  ctx.lineWidth = line;
  ctx.strokeStyle = rgbaString(mixRgb(danger, WHITE, 0.2), 0.85);
  ctx.stroke();
}

function drawWhite(ctx, s) {
  roundRectPath(ctx, 0, 0, s, s, s * UI.blockRadius);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// 도형을 캔버스 밖(x < 0)에 그리고 그림자만 안으로 끌어와서, 몸체 없이 번진 그림자만 남긴다.
// shadowOffset은 변환의 영향을 받지 않으므로 변환 없이 기기 픽셀로 맞춘다
function drawShadow(ctx, s, pad) {
  const far = s * 4;
  ctx.shadowColor = 'rgba(4,4,24,0.62)';
  ctx.shadowBlur = pad * 0.8;
  ctx.shadowOffsetX = far + pad;
  ctx.shadowOffsetY = pad;
  roundRectPath(ctx, -far, 0, s, s, s * UI.blockRadius);
  ctx.fillStyle = '#000';
  ctx.fill();
}

function defaultCreateCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * @param {{ createCanvas?: (width: number, height: number) => HTMLCanvasElement }} [options]
 */
export function createSpriteCache({ createCanvas = defaultCreateCanvas } = {}) {
  /** @type {Map<number, HTMLCanvasElement>} */
  const cache = new Map();

  function build(kind, cellDev) {
    const { size } = cellMetrics(cellDev);
    if (kind === SPRITE_SHADOW) {
      const pad = Math.ceil(size * 0.4);
      const canvas = createCanvas(size + pad * 2, size + pad * 2);
      drawShadow(canvas.getContext('2d'), size, pad);
      return canvas;
    }
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (kind === SPRITE_DANGER) drawDanger(ctx, size);
    else if (kind === SPRITE_WHITE) drawWhite(ctx, size);
    else drawBlock(ctx, size, PALETTE_RGB[kind - 1]);
    return canvas;
  }

  /**
   * @param {number} kind 색 번호(1~) 또는 SPRITE_* 상수
   * @param {number} cellDev 칸 크기(기기 픽셀, 정수)
   */
  function get(kind, cellDev) {
    const key = kind * KEY_STRIDE + cellDev;
    let sprite = cache.get(key);
    if (sprite === undefined) {
      if (cache.size >= MAX_CACHED) cache.clear();
      sprite = build(kind, cellDev);
      cache.set(key, sprite);
    }
    return sprite;
  }

  return {
    get,
    size: () => cache.size,
    clear: () => cache.clear(),
  };
}
