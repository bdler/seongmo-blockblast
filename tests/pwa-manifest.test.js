import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME_COLOR = '#10143a';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// maskable 안전 영역: 중앙 지름 80% 원
const SAFE_RADIUS_RATIO = 0.4;

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));

function readPng(path) {
  const buffer = readFileSync(join(ROOT, path));
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), `${path}는 PNG여야 한다`);
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
  return { buffer, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// 필터를 풀어 픽셀을 읽는 최소 PNG 디코더(8비트, 비인터레이스, RGB/RGBA만)
function decodePng(path) {
  const { buffer, width, height } = readPng(path);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  assert.equal(bitDepth, 8);
  assert.equal(buffer[28], 0, '인터레이스 PNG는 지원하지 않는다');
  const channels = { 2: 3, 6: 4 }[colorType];
  assert.ok(channels, `지원하지 않는 색상 유형 ${colorType}`);

  const chunks = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  const pixelAt = (x, y) => {
    const i = y * stride + x * channels;
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: channels === 4 ? pixels[i + 3] : 255 };
  };
  return { width, height, pixelAt };
}

function isRelative(url) {
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    !url.startsWith('/') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
    !url.split('/').includes('..')
  );
}

test('매니페스트는 명세의 기본 필드를 갖는다', () => {
  assert.equal(manifest.name, '블록 블라스트');
  assert.equal(manifest.short_name, '블록 블라스트');
  assert.equal(manifest.lang, 'ko');
  assert.equal(manifest.id, './');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  assert.equal(manifest.theme_color, THEME_COLOR);
  assert.equal(manifest.background_color, THEME_COLOR);
  assert.deepEqual(manifest.categories, ['games', 'puzzle']);
});

test('매니페스트의 모든 경로는 하위 경로 배포에서도 쓸 수 있는 상대 경로다', () => {
  for (const key of ['id', 'start_url', 'scope']) {
    assert.ok(isRelative(manifest[key]), `${key}=${manifest[key]}`);
  }
  for (const icon of manifest.icons) assert.ok(isRelative(icon.src), icon.src);
});

test('아이콘은 192/512(any)와 512(maskable)를 선언한다', () => {
  const declared = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`).sort();
  assert.deepEqual(declared, ['192x192:any', '512x512:any', '512x512:maskable']);
});

test('선언한 아이콘 파일이 있고 PNG 헤더의 크기가 선언과 같다', () => {
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    assert.ok(existsSync(join(ROOT, icon.src)), `${icon.src}가 없다`);
    const { width, height } = readPng(icon.src);
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
});

test('apple-touch-icon은 180x180 PNG이고 SVG 원본과 파비콘이 있다', () => {
  const { width, height } = readPng('assets/icons/apple-touch-icon.png');
  assert.deepEqual([width, height], [180, 180]);
  for (const file of ['assets/icons/icon.svg', 'assets/icons/favicon.svg']) {
    const svg = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(svg.startsWith('<svg'), file);
    assert.match(svg, /viewBox="0 0 512 512"/);
  }
});

test('any 아이콘은 모서리가 투명하고 중앙은 불투명하다', () => {
  for (const file of ['icon-192.png', 'icon-512.png']) {
    const { width, height, pixelAt } = decodePng(`assets/icons/${file}`);
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
      assert.equal(pixelAt(x, y).a, 0, `${file} (${x},${y})`);
    }
    assert.equal(pixelAt(width >> 1, height >> 1).a, 255);
  }
});

test('maskable과 apple-touch 아이콘은 모서리까지 배경이 꽉 찬다', () => {
  for (const file of ['icon-maskable-512.png', 'apple-touch-icon.png']) {
    const { width, height, pixelAt } = decodePng(`assets/icons/${file}`);
    const last = [width - 1, height - 1];
    for (const [x, y] of [[0, 0], [last[0], 0], [0, last[1]], last]) {
      const pixel = pixelAt(x, y);
      assert.equal(pixel.a, 255, `${file} (${x},${y})`);
      // 배경색(짙은 남색) 계열: 어두운 파랑
      assert.ok(pixel.b > pixel.r && Math.max(pixel.r, pixel.g, pixel.b) < 0x60, `${file} (${x},${y})`);
    }
  }
});

test('maskable 아이콘의 그림은 중앙 80% 안전 영역 안에만 있다', () => {
  const { width, height, pixelAt } = decodePng('assets/icons/icon-maskable-512.png');
  const safe = width * SAFE_RADIUS_RATIO;
  let artPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { r, g, b } = pixelAt(x, y);
      const bright = Math.max(r, g, b) > 0x96;
      if (!bright) continue;
      artPixels += 1;
      const distance = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2);
      assert.ok(distance <= safe + 1, `(${x},${y}) 밝은 픽셀이 안전 영역 밖에 있다`);
    }
  }
  assert.ok(artPixels > width * height * 0.1, '그림이 실제로 그려져 있어야 한다');
});
