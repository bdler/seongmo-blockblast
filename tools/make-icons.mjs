// 앱 아이콘을 만든다. 원본 아트는 이 파일의 SVG 생성 코드이고, 결과물은 assets/icons/ 에 쓴다.
// 사용법: node tools/make-icons.mjs
// PNG 변환에는 전역 설치된 Playwright의 chromium을 쓴다(브라우저 설치는 하지 않는다).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');

const BACKGROUND = '#10143a';
const BACKGROUND_GLOW = '#272f7a';
const GOLD = '#ffcf3f';
const ORANGE = '#ff9a3c';
const GREEN = '#3ddc84';
const CYAN = '#2ec5ff';

const VIEW = 512;
const CORNER_RADIUS = 112;
const BLOCK = 116;
const GAP = 12;
const PITCH = BLOCK + GAP;
const GRID = 3;
const BLOCK_RADIUS = 26;
const BLOCK_LIP = 9;

// 3x3 판을 T(주황), L(하늘), 낱칸(초록)이 맞물려 채우고, 오른쪽 위 모서리에서 불꽃이 튄다
const CELLS = [
  { col: 0, row: 0, color: ORANGE },
  { col: 1, row: 0, color: ORANGE },
  { col: 2, row: 0, color: ORANGE },
  { col: 1, row: 1, color: ORANGE },
  { col: 0, row: 1, color: CYAN },
  { col: 0, row: 2, color: CYAN },
  { col: 1, row: 2, color: CYAN },
  { col: 2, row: 2, color: CYAN },
  { col: 2, row: 1, color: GREEN },
];
const SPARK_RADIUS = 54;
// 불꽃 중심을 블록 판 오른쪽 위 모서리에서 안쪽으로 들인 거리
const SPARK_INSET = 8;
const WELL_MARGIN = 16;
const WELL_RADIUS = 44;

// maskable 안전 영역은 중앙 지름 80% 원이라 모서리 블록과 불꽃 끝이 잘리지 않게 아트를 줄인다.
// favicon은 16px까지 줄어들므로 보드 틀과 불꽃 같은 잔 장식을 빼고 블록을 키운다
const VARIANTS = {
  any: { rounded: true, scale: 1, detailed: true },
  maskable: { rounded: false, scale: 0.7, detailed: true },
  apple: { rounded: false, scale: 0.9, detailed: true },
  favicon: { rounded: true, scale: 1.12, detailed: false },
};

const PNG_TARGETS = [
  { file: 'icon-192.png', variant: 'any', size: 192 },
  { file: 'icon-512.png', variant: 'any', size: 512 },
  { file: 'icon-maskable-512.png', variant: 'maskable', size: 512 },
  { file: 'apple-touch-icon.png', variant: 'apple', size: 180 },
];

const SVG_TARGETS = [
  { file: 'icon.svg', variant: 'any' },
  { file: 'favicon.svg', variant: 'favicon' },
];

function mix(hex, target, amount) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mixed = channels.map((value) => Math.round(value + (target - value) * amount));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

const lighten = (hex, amount) => mix(hex, 255, amount);
const darken = (hex, amount) => mix(hex, 0, amount);

function gradientId(color) {
  return `face-${color.slice(1)}`;
}

function defs(colors, detailed) {
  const faces = colors.map(
    (color) => `    <linearGradient id="${gradientId(color)}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${lighten(color, 0.32)}"/>
      <stop offset="1" stop-color="${color}"/>
    </linearGradient>`
  );
  const extras = detailed
    ? `    <radialGradient id="flare" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${GOLD}" stop-opacity="0.75"/>
      <stop offset="1" stop-color="${GOLD}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="star" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffbe6"/>
      <stop offset="1" stop-color="${GOLD}"/>
    </linearGradient>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="12" stdDeviation="10" flood-color="#04061a" flood-opacity="0.55"/>
    </filter>
`
    : '';
  return `  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.32" r="0.75">
      <stop offset="0" stop-color="${BACKGROUND_GLOW}"/>
      <stop offset="1" stop-color="${BACKGROUND}"/>
    </radialGradient>
${extras}${faces.join('\n')}
  </defs>`;
}

function block({ col, row, color }, origin) {
  const x = origin + col * PITCH;
  const y = origin + row * PITCH;
  const face = BLOCK - BLOCK_LIP;
  return `    <g>
      <rect x="${x}" y="${y}" width="${BLOCK}" height="${BLOCK}" rx="${BLOCK_RADIUS}" fill="${darken(color, 0.38)}"/>
      <rect x="${x}" y="${y}" width="${BLOCK}" height="${face}" rx="${BLOCK_RADIUS}" fill="url(#${gradientId(color)})"/>
      <rect x="${x + 16}" y="${y + 10}" width="${BLOCK - 32}" height="14" rx="7" fill="#fff" fill-opacity="0.42"/>
    </g>`;
}

// 오목한 네 꼭짓점 별. 제어점을 중심에서 띄워 가운데가 너무 가늘어지지 않게 한다
function spark(cx, cy, radius) {
  const k = radius * 0.2;
  const path = [
    `M${cx} ${cy - radius}`,
    `Q${cx + k} ${cy - k} ${cx + radius} ${cy}`,
    `Q${cx + k} ${cy + k} ${cx} ${cy + radius}`,
    `Q${cx - k} ${cy + k} ${cx - radius} ${cy}`,
    `Q${cx - k} ${cy - k} ${cx} ${cy - radius}`,
    'Z',
  ].join(' ');
  return `    <circle cx="${cx}" cy="${cy}" r="${radius * 1.15}" fill="url(#flare)"/>
    <path d="${path}" fill="url(#star)"/>`;
}

// 블록 아래에 깔리는 어두운 보드 틀
function well(origin, span) {
  const x = origin - WELL_MARGIN;
  const size = span + WELL_MARGIN * 2;
  return `    <rect x="${x}" y="${x}" width="${size}" height="${size}" rx="${WELL_RADIUS}" fill="#080b26" fill-opacity="0.5" stroke="#3b4392" stroke-opacity="0.55" stroke-width="3"/>`;
}

/**
 * @param {'any' | 'maskable' | 'apple' | 'favicon'} variantName
 * @param {number} [size] 화면에 그릴 한 변의 픽셀 수(viewBox는 항상 512)
 * @returns {string} 독립 SVG 문서
 */
export function renderIconSvg(variantName, size = VIEW) {
  const { rounded, scale, detailed } = VARIANTS[variantName];
  const span = GRID * BLOCK + (GRID - 1) * GAP;
  const origin = (VIEW - span) / 2;
  const colors = [...new Set(CELLS.map((cell) => cell.color))];
  const center = VIEW / 2;
  const blocks = CELLS.map((cell) => block(cell, origin)).join('\n');
  const art = detailed
    ? [
        well(origin, span),
        `    <g filter="url(#lift)">\n${blocks}\n    </g>`,
        spark(origin + span - SPARK_INSET, origin + SPARK_INSET, SPARK_RADIUS),
      ]
    : [blocks];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEW} ${VIEW}">
${defs(colors, detailed)}
  <rect width="${VIEW}" height="${VIEW}" rx="${rounded ? CORNER_RADIUS : 0}" fill="url(#glow)"/>
  <g transform="translate(${center} ${center}) scale(${scale}) translate(${-center} ${-center})">
${art.join('\n')}
  </g>
</svg>
`;
}

async function renderPngs(targets) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  // root로 실행하는 환경에서는 chromium 샌드박스가 뜨지 않아 끈다. 로컬 SVG만 그리므로 안전하다
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const { file, variant, size } of targets) {
      const svg = renderIconSvg(variant, size);
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`
      );
      // 둥근 모서리 바깥은 투명하게 둔다. 꽉 찬 아이콘은 배경이 모서리까지 채운다
      const buffer = await page.screenshot({ type: 'png', omitBackground: true });
      writeFileSync(join(OUT_DIR, file), buffer);
    }
  } finally {
    await browser.close();
  }
}

export async function makeIcons() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const { file, variant } of SVG_TARGETS) {
    writeFileSync(join(OUT_DIR, file), renderIconSvg(variant));
  }
  await renderPngs(PNG_TARGETS);
  return [...SVG_TARGETS, ...PNG_TARGETS].map((target) => join('assets/icons', target.file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  makeIcons().then(
    (files) => console.log(files.join('\n')),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}
