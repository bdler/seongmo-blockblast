// 이펙트: 파티클 풀, 떠오르는 글자, 화면 흔들림, 줄 번쩍임, 퍼펙트 반짝임.
// 상태는 전부 update(dtMs)로만 진행시켜서(시계/난수는 주입) 테스트에서 결과가 항상 같다.
import { ANIM, EFFECTS, PALETTE, THEMES } from '../config.js';
import { clamp01, easeOutBack, easeOutCubic, lerp } from './easing.js';
import { hexToRgb, mixRgb, rgbaString, roundRectPath } from './block-sprites.js';

const TAU = Math.PI * 2;

export const PARTICLE_SQUARE = 0;
export const PARTICLE_DOT = 1;
export const PARTICLE_SPARKLE = 2;

// 파티클 색 번호: 0 = 흰색, 1~PALETTE.length = 블록 색, 마지막 = 강조(금색)
export const PARTICLE_WHITE = 0;
export const PARTICLE_GOLD = PALETTE.length + 1;
const PARTICLE_COLORS = ['#ffffff', ...PALETTE, THEMES.default.accent];

const MAX_LINE_FLASHES = 16;
const LABEL_OVERSAMPLE = 1.15; // 팝 연출에서 글자가 잠깐 커져도 흐려지지 않게 약간 크게 그려 둔다

function defaultCreateCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * 고정 크기 파티클 풀. 배열을 미리 잡아 두고 죽은 칸은 마지막 칸과 바꿔서 채우므로
 * 프레임마다 할당이 없고, 살아 있는 파티클은 항상 [0, count)에 모여 있다.
 * @param {number} max 동시에 살아 있을 수 있는 최대 수(하드 상한)
 */
export function createParticlePool(max) {
  const x = new Float32Array(max);
  const y = new Float32Array(max);
  const vx = new Float32Array(max);
  const vy = new Float32Array(max);
  const rot = new Float32Array(max);
  const spin = new Float32Array(max);
  const age = new Float32Array(max);
  const life = new Float32Array(max);
  const size = new Float32Array(max);
  const color = new Uint8Array(max);
  const kind = new Uint8Array(max);
  let count = 0;

  /** @returns {boolean} 풀이 가득 차서 못 만들면 false */
  function spawn(px, py, pvx, pvy, plife, psize, pcolor, pkind, prot, pspin) {
    if (count >= max) return false;
    const i = count;
    count += 1;
    x[i] = px;
    y[i] = py;
    vx[i] = pvx;
    vy[i] = pvy;
    life[i] = plife;
    size[i] = psize;
    color[i] = pcolor;
    kind[i] = pkind;
    rot[i] = prot;
    spin[i] = pspin;
    age[i] = 0;
    return true;
  }

  /**
   * @param {number} dtMs
   * @param {number} gravity px/s²
   * @param {number} drag 초당 속도 감쇠율
   */
  function update(dtMs, gravity, drag) {
    const dt = dtMs / 1000;
    const damping = Math.exp(-drag * dt);
    let i = 0;
    while (i < count) {
      age[i] += dtMs;
      if (age[i] >= life[i]) {
        const last = count - 1;
        if (i !== last) {
          x[i] = x[last];
          y[i] = y[last];
          vx[i] = vx[last];
          vy[i] = vy[last];
          rot[i] = rot[last];
          spin[i] = spin[last];
          age[i] = age[last];
          life[i] = life[last];
          size[i] = size[last];
          color[i] = color[last];
          kind[i] = kind[last];
        }
        count = last;
      } else {
        vx[i] *= damping;
        vy[i] = vy[i] * damping + gravity * dt;
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        rot[i] += spin[i] * dt;
        i += 1;
      }
    }
  }

  return {
    max,
    get count() {
      return count;
    },
    spawn,
    update,
    clear() {
      count = 0;
    },
    // 그리기용 읽기 전용 접근(렌더링 루프에서 할당 없이 훑는다)
    fields: { x, y, rot, age, life, size, color, kind },
  };
}

/**
 * @typedef {object} FxText
 * @property {boolean} active
 * @property {string} text
 * @property {number} x
 * @property {number} y 시작 위치(중심). 시간이 지나며 위로 떠오른다
 * @property {number} size px
 * @property {string} color
 * @property {HTMLCanvasElement | null} sprite 미리 그려 둔 글자(프레임마다 글자 경로를 다시 그리지 않는다)
 * @property {number} spriteW 스프라이트의 CSS 폭(기본 크기 기준)
 * @property {number} spriteH
 * @property {number} life ms
 * @property {number} delay ms
 * @property {number} rise px
 * @property {number} maxWidth px
 * @property {boolean} glow
 * @property {number} age
 */

function createTextSlot() {
  return { active: false, text: '', x: 0, y: 0, size: 0, color: '', sprite: null, spriteW: 0, spriteH: 0, life: 1, delay: 0, rise: 0, maxWidth: 0, glow: false, age: 0 };
}

/**
 * @param {{ reducedMotion?: boolean, rng?: () => number, createCanvas?: (width: number, height: number) => HTMLCanvasElement }} [options]
 *   rng는 [0,1)을 돌려주는 함수, createCanvas는 글자 스프라이트용 캔버스 팩토리
 */
export function createEffects({ reducedMotion = false, rng = Math.random, createCanvas = defaultCreateCanvas } = {}) {
  const pool = createParticlePool(EFFECTS.maxParticles);
  const texts = Array.from({ length: EFFECTS.maxTexts }, createTextSlot);
  const flashes = Array.from({ length: MAX_LINE_FLASHES }, () => ({ active: false, x: 0, y: 0, w: 0, h: 0, age: 0 }));
  const offset = { x: 0, y: 0 };
  const fx = THEMES.default;
  const tuning = EFFECTS.text;

  let reduced = reducedMotion;
  let cell = 40;
  let dpr = 1;
  let measureContext = null;
  let shakeAmp = 0;
  let shakeAge = 0;
  let shakeDur = 0;
  let shimmerAge = -1; // 음수면 꺼짐
  let lastColor = -1;

  /** @param {{ cell: number, dpr: number }} metrics 보드 한 칸의 CSS px과 기기 픽셀 비율 */
  function setMetrics(metrics) {
    cell = metrics.cell;
    dpr = metrics.dpr;
  }

  // 글자(그라데이션 + 외곽선 + 옅은 빛 번짐)를 한 번만 그려 둔 스프라이트로 만든다
  function renderLabel(text, size, color, maxWidth, glow) {
    const px = Math.round(size * dpr * LABEL_OVERSAMPLE);
    const font = `${tuning.weight} ${px}px ${fx.fontFamily}`;
    if (measureContext === null) measureContext = createCanvas(1, 1).getContext('2d');
    measureContext.font = font;
    const limit = maxWidth > 0 ? maxWidth * dpr * LABEL_OVERSAMPLE : Infinity;
    const textWidth = Math.min(measureContext.measureText(text).width, limit);
    const pad = Math.ceil(px * 0.55) + 2; // 외곽선과 빛 번짐이 잘리지 않을 여유
    const width = Math.ceil(textWidth) + pad * 2;
    const height = Math.ceil(px * 1.25) + pad * 2;
    const canvas = createCanvas(width, height);
    const g = canvas.getContext('2d');
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    const cx = width / 2;
    const cy = height / 2;
    const draw = (kind) => {
      if (limit === Infinity) g[kind](text, cx, cy);
      else g[kind](text, cx, cy, limit);
    };
    // 스프라이트는 한 번만 그리므로 shadowBlur를 써도 프레임 비용이 없다
    if (glow) {
      g.shadowColor = color;
      g.shadowBlur = px * 0.4;
    }
    g.lineWidth = px * tuning.outlineRatio;
    g.strokeStyle = fx.textOutline;
    draw('strokeText');
    g.shadowBlur = 0;
    g.shadowColor = 'transparent';
    const gradient = g.createLinearGradient(0, cy - px * 0.5, 0, cy + px * 0.5);
    gradient.addColorStop(0, rgbaString(mixRgb(hexToRgb(color), [255, 255, 255], 0.6)));
    gradient.addColorStop(0.55, color);
    gradient.addColorStop(1, color);
    g.fillStyle = gradient;
    draw('fillText');
    return canvas;
  }

  function setReducedMotion(value) {
    reduced = value;
    if (value) {
      pool.clear();
      shakeAmp = 0;
      shimmerAge = -1;
      for (const flash of flashes) flash.active = false;
      offset.x = 0;
      offset.y = 0;
    }
  }

  /**
   * (x, y)에서 colorId 색 파편을 터뜨린다. reducedMotion이면 아무것도 만들지 않는다.
   * @returns {number} 실제로 만든 파티클 수(풀이 가득 차면 요청보다 적다)
   */
  function burst(x, y, colorId, count) {
    if (reduced) return 0;
    let made = 0;
    for (let i = 0; i < count; i += 1) {
      const angle = rng() * TAU;
      const speed = lerp(EFFECTS.speedMin, EFFECTS.speedMax, rng()) * cell;
      const sparkle = rng() < EFFECTS.sparkleChance;
      const pkind = sparkle ? PARTICLE_SPARKLE : rng() < 0.5 ? PARTICLE_SQUARE : PARTICLE_DOT;
      const ok = pool.spawn(
        x + (rng() - 0.5) * cell * 0.5,
        y + (rng() - 0.5) * cell * 0.5,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed - cell * 1.2, // 위로 살짝 튀어 오르게
        lerp(EFFECTS.lifeMinMs, EFFECTS.lifeMaxMs, rng()),
        lerp(EFFECTS.sizeMin, EFFECTS.sizeMax, rng()) * cell,
        sparkle ? PARTICLE_WHITE : colorId,
        pkind,
        rng() * TAU,
        (rng() - 0.5) * 14,
      );
      if (!ok) break;
      made += 1;
    }
    return made;
  }

  /**
   * 사각형 영역 위쪽에서 흩날리는 반짝이(퍼펙트 클리어용)
   * @returns {number}
   */
  function sparkleRain(x, y, w, h, count) {
    if (reduced) return 0;
    let made = 0;
    for (let i = 0; i < count; i += 1) {
      const gold = rng() < 0.5;
      const ok = pool.spawn(
        x + rng() * w,
        y + rng() * h,
        (rng() - 0.5) * cell * 2.4,
        -rng() * cell * 3.2,
        lerp(EFFECTS.lifeMinMs, EFFECTS.lifeMaxMs * 1.6, rng()),
        lerp(EFFECTS.sizeMin, EFFECTS.sizeMax * 1.2, rng()) * cell,
        gold ? PARTICLE_GOLD : PARTICLE_WHITE,
        PARTICLE_SPARKLE,
        rng() * TAU,
        (rng() - 0.5) * 8,
      );
      if (!ok) break;
      made += 1;
    }
    return made;
  }

  /**
   * 떠오르는 글자를 하나 띄운다. 슬롯이 가득 차면 가장 오래된 글자를 덮어쓴다.
   * @param {{ text: string, x: number, y: number, size: number, color: string, life: number,
   *   delay?: number, rise?: number, maxWidth?: number, glow?: boolean }} options
   */
  function addText({ text, x, y, size, color, life, delay = 0, rise = 0, maxWidth = 0, glow = false }) {
    let slot = null;
    for (const candidate of texts) {
      if (!candidate.active) {
        slot = candidate;
        break;
      }
      if (slot === null || candidate.age > slot.age) slot = candidate;
    }
    slot.active = true;
    slot.text = text;
    slot.x = x;
    slot.y = y;
    slot.size = size;
    slot.color = color;
    slot.life = life;
    slot.delay = delay;
    slot.rise = reduced ? 0 : rise;
    slot.maxWidth = maxWidth;
    slot.glow = glow && !reduced;
    slot.age = 0;
    slot.sprite = renderLabel(text, size, color, maxWidth, slot.glow);
    slot.spriteW = slot.sprite.width / (dpr * LABEL_OVERSAMPLE);
    slot.spriteH = slot.sprite.height / (dpr * LABEL_OVERSAMPLE);
  }

  /**
   * 화면 흔들림을 시작한다. 이미 더 큰 흔들림이 진행 중이면 그대로 둔다.
   * @param {number} amplitudePx
   */
  function shake(amplitudePx, durationMs = EFFECTS.shake.durationMs) {
    if (reduced || amplitudePx <= 0) return;
    const remaining = shakeAge < shakeDur ? shakeAmp * (1 - shakeAge / shakeDur) ** 2 : 0;
    if (amplitudePx >= remaining) {
      shakeAmp = amplitudePx;
      shakeAge = 0;
      shakeDur = durationMs;
    }
  }

  /** 지워지는 줄 한 줄 전체에 퍼지는 빛(영역은 CSS px). */
  function lineFlash(x, y, w, h) {
    if (reduced) return;
    let slot = flashes[0];
    for (const candidate of flashes) {
      if (!candidate.active) {
        slot = candidate;
        break;
      }
      if (candidate.age > slot.age) slot = candidate;
    }
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.w = w;
    slot.h = h;
    slot.age = 0;
  }

  function startShimmer() {
    if (!reduced) shimmerAge = 0;
  }

  /** @param {number} dtMs */
  function update(dtMs) {
    pool.update(dtMs, EFFECTS.gravity * cell, EFFECTS.airDrag);

    for (const slot of texts) {
      if (!slot.active) continue;
      slot.age += dtMs;
      if (slot.age >= slot.delay + slot.life) slot.active = false;
    }
    for (const flash of flashes) {
      if (!flash.active) continue;
      flash.age += dtMs;
      if (flash.age >= ANIM.lineFlashMs) flash.active = false;
    }
    if (shimmerAge >= 0) {
      shimmerAge += dtMs;
      if (shimmerAge >= EFFECTS.perfect.shimmerMs) shimmerAge = -1;
    }

    if (shakeAge < shakeDur) {
      shakeAge += dtMs;
      const t = shakeAge / shakeDur;
      const envelope = t >= 1 ? 0 : (1 - t) * (1 - t);
      const phase = (shakeAge / 1000) * EFFECTS.shake.freqHz * TAU;
      offset.x = shakeAmp * envelope * Math.sin(phase);
      offset.y = shakeAmp * envelope * Math.cos(phase * 1.31 + 1.2) * 0.8;
    } else {
      offset.x = 0;
      offset.y = 0;
    }
  }

  function isActive() {
    if (pool.count > 0 || shimmerAge >= 0 || shakeAge < shakeDur) return true;
    for (const slot of texts) if (slot.active) return true;
    for (const flash of flashes) if (flash.active) return true;
    return false;
  }

  function clear() {
    pool.clear();
    for (const slot of texts) slot.active = false;
    for (const flash of flashes) flash.active = false;
    shakeAmp = 0;
    shakeAge = 0;
    shakeDur = 0;
    shimmerAge = -1;
    offset.x = 0;
    offset.y = 0;
  }

  /**
   * 화면 흔들림을 같이 받는 레이어(줄 번쩍임, 퍼펙트 반짝임). 변환은 호출한 쪽이 맞춰 둔다.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ boardX: number, boardY: number, boardSize: number, radius: number }} view
   */
  function drawWorld(ctx, view) {
    for (const flash of flashes) {
      if (!flash.active) continue;
      const t = flash.age / ANIM.lineFlashMs;
      ctx.globalAlpha = 0.55 * (1 - t) * (1 - t);
      roundRectPath(ctx, flash.x, flash.y, flash.w, flash.h, view.radius);
      ctx.fillStyle = fx.flash;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (shimmerAge < 0) return;
    const p = shimmerAge / EFFECTS.perfect.shimmerMs;
    const size = view.boardSize;
    ctx.save();
    roundRectPath(ctx, view.boardX, view.boardY, size, size, view.radius);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';

    const flash = 0.32 * (1 - clamp01(shimmerAge / 260));
    if (flash > 0) {
      ctx.globalAlpha = flash;
      ctx.fillStyle = fx.flash;
      ctx.fillRect(view.boardX, view.boardY, size, size);
    }

    // 대각선 빛줄기가 두 번 쓸고 지나간다. 회전한 좌표계에서 보드 대각선 밖에서 밖으로 가로지른다
    const sweep = (p * 2) % 1;
    const bandW = size * 0.2;
    const reach = size * 0.72 + bandW;
    const centerX = view.boardX + size / 2;
    const centerY = view.boardY + size / 2;
    const left = centerX + lerp(-reach, reach, sweep) - bandW / 2;
    const grad = ctx.createLinearGradient(left, 0, left + bandW, 0);
    grad.addColorStop(0, 'rgba(255,214,120,0)');
    grad.addColorStop(0.35, 'rgba(255,226,150,0.55)');
    grad.addColorStop(0.5, 'rgba(255,255,255,1)');
    grad.addColorStop(0.65, 'rgba(255,226,150,0.55)');
    grad.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.globalAlpha = EFFECTS.perfect.shimmerAlpha * (1 - clamp01((p - 0.7) / 0.3));
    ctx.translate(centerX, centerY);
    ctx.rotate(-0.42);
    ctx.translate(-centerX, -centerY);
    ctx.fillStyle = grad;
    ctx.fillRect(left, centerY - size, bandW, size * 2);
    ctx.restore();
  }

  /**
   * 흔들리지 않는 레이어(파티클, 글자). 변환은 dpr 배율이어야 한다.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} dpr
   */
  function drawOverlay(ctx, dpr) {
    const f = pool.fields;
    const count = pool.count;
    lastColor = -1;
    for (let i = 0; i < count; i += 1) {
      const u = f.age[i] / f.life[i];
      const alpha = u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45;
      const s = f.size[i] * (1 - 0.4 * u);
      if (f.color[i] !== lastColor) {
        lastColor = f.color[i];
        ctx.fillStyle = PARTICLE_COLORS[lastColor];
      }
      ctx.globalAlpha = alpha;
      const k = f.kind[i];
      if (k === PARTICLE_DOT) {
        ctx.setTransform(dpr, 0, 0, dpr, f.x[i] * dpr, f.y[i] * dpr);
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.5, 0, TAU);
        ctx.fill();
      } else {
        const cos = Math.cos(f.rot[i]) * dpr;
        const sin = Math.sin(f.rot[i]) * dpr;
        ctx.setTransform(cos, sin, -sin, cos, f.x[i] * dpr, f.y[i] * dpr);
        if (k === PARTICLE_SQUARE) {
          ctx.fillRect(-s * 0.5, -s * 0.35, s, s * 0.7);
        } else {
          // 네 갈래 별
          const r = s * 0.75;
          const w = s * 0.18;
          ctx.beginPath();
          ctx.moveTo(0, -r);
          ctx.lineTo(w, -w);
          ctx.lineTo(r, 0);
          ctx.lineTo(w, w);
          ctx.lineTo(0, r);
          ctx.lineTo(-w, w);
          ctx.lineTo(-r, 0);
          ctx.lineTo(-w, -w);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;

    for (const slot of texts) {
      if (!slot.active || slot.age < slot.delay) continue;
      const elapsed = slot.age - slot.delay;
      const t = elapsed / slot.life;
      const pop = reduced ? 1 : lerp(0.3, 1, easeOutBack(elapsed / EFFECTS.textPopMs, 2.4));
      const fade = t < EFFECTS.textFadeStart ? 1 : 1 - (t - EFFECTS.textFadeStart) / (1 - EFFECTS.textFadeStart);
      const w = slot.spriteW * pop;
      const h = slot.spriteH * pop;
      ctx.globalAlpha = clamp01(fade) * clamp01(elapsed / 60);
      ctx.drawImage(slot.sprite, slot.x - w / 2, slot.y - slot.rise * easeOutCubic(t) - h / 2, w, h);
    }
    ctx.globalAlpha = 1;
  }

  return {
    setMetrics,
    setReducedMotion,
    burst,
    sparkleRain,
    addText,
    shake,
    lineFlash,
    startShimmer,
    update,
    isActive,
    clear,
    drawWorld,
    drawOverlay,
    offset,
    get reducedMotion() {
      return reduced;
    },
    get particleCount() {
      return pool.count;
    },
    get activeTextCount() {
      let n = 0;
      for (const slot of texts) if (slot.active) n += 1;
      return n;
    },
    get shimmerActive() {
      return shimmerAge >= 0;
    },
  };
}
