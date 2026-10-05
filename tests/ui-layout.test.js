import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_SIZE, TRAY_SIZE, UI } from '../src/config.js';
import { SHAPE_LIST } from '../src/core/index.js';
import { anchorFraction, anchorFromPoint, computeLayout, slotIndexAt } from '../src/ui/layout.js';

const VIEWPORTS = [
  { width: 320, height: 480, dpr: 1 },
  { width: 360, height: 640, dpr: 2 },
  { width: 375, height: 667, dpr: 2 },
  { width: 390, height: 844, dpr: 3 },
  { width: 412, height: 915, dpr: 2.625 },
  { width: 768, height: 1024, dpr: 2 },
  { width: 820, height: 1180, dpr: 2 },
  { width: 844, height: 390, dpr: 3 },
  { width: 667, height: 375, dpr: 2 },
  { width: 480, height: 320, dpr: 1 },
  { width: 1024, height: 768, dpr: 1 },
  { width: 1440, height: 900, dpr: 1 },
  { width: 600, height: 600, dpr: 1 },
  { width: 1000, height: 1000, dpr: 1.5 },
];

const EPS = 1e-6;

function rectOfBoard(l) {
  return { x: l.boardX, y: l.boardY, w: l.boardSize, h: l.boardSize };
}

function inside(canvas, r) {
  return r.x >= -EPS && r.y >= -EPS && r.x + r.w <= canvas.width + EPS && r.y + r.h <= canvas.height + EPS;
}

function overlaps(a, b) {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

function isAligned(value, dpr) {
  return Math.abs(value * dpr - Math.round(value * dpr)) < EPS;
}

for (const viewport of VIEWPORTS) {
  const name = `${viewport.width}x${viewport.height}@${viewport.dpr}`;

  test(`computeLayout ${name}: 보드와 슬롯이 캔버스 안에 있고 서로 겹치지 않는다`, () => {
    const layout = computeLayout(viewport);
    assert.equal(layout.slots.length, TRAY_SIZE);
    assert.equal(layout.boardSize, layout.cell * BOARD_SIZE);
    assert.ok(layout.cell >= 1 / viewport.dpr);
    assert.ok(layout.cell <= UI.maxCell);

    const board = rectOfBoard(layout);
    assert.ok(inside(viewport, board), 'board inside canvas');
    for (const slot of layout.slots) {
      assert.ok(inside(viewport, slot), 'slot inside canvas');
      assert.ok(!overlaps(board, slot), 'slot does not overlap board');
      assert.ok(slot.w > 0 && slot.h > 0);
      assert.ok(Math.abs(slot.cx - (slot.x + slot.w / 2)) < EPS);
      assert.ok(Math.abs(slot.cy - (slot.y + slot.h / 2)) < EPS);
    }
    for (let i = 0; i < layout.slots.length; i += 1) {
      for (let j = i + 1; j < layout.slots.length; j += 1) {
        assert.ok(!overlaps(layout.slots[i], layout.slots[j]), `slots ${i} and ${j} overlap`);
      }
    }
  });

  test(`computeLayout ${name}: 모든 좌표가 기기 픽셀 경계에 맞는다`, () => {
    const layout = computeLayout(viewport);
    const values = [layout.cell, layout.boardX, layout.boardY, layout.boardSize, layout.trayCell];
    for (const slot of layout.slots) values.push(slot.x, slot.y, slot.w, slot.h);
    for (const offset of Object.values(layout.fingerOffset)) values.push(offset);
    for (const value of values) assert.ok(isAligned(value, viewport.dpr), `${value} is not device-pixel aligned`);
  });

  test(`computeLayout ${name}: 방향에 맞게 트레이가 놓이고 손가락 오프셋이 정해진다`, () => {
    const layout = computeLayout(viewport);
    const [a, b, c] = layout.slots;
    if (layout.orientation === 'portrait') {
      assert.ok(a.y >= layout.boardY + layout.boardSize, 'tray below board');
      assert.ok(a.x < b.x && b.x < c.x);
      assert.equal(a.y, b.y);
    } else {
      assert.ok(a.x >= layout.boardX + layout.boardSize, 'tray right of board');
      assert.ok(a.y < b.y && b.y < c.y);
      assert.equal(a.x, b.x);
    }
    assert.equal(layout.fingerOffset.mouse, 0);
    assert.ok(Math.abs(layout.fingerOffset.touch - UI.fingerOffsetCells.touch * layout.cell) <= 1 / viewport.dpr);
    assert.ok(layout.fingerOffset.pen > 0 && layout.fingerOffset.pen < layout.fingerOffset.touch);
  });
}

test('computeLayout: 세로 화면은 portrait, 가로 화면은 landscape이다', () => {
  assert.equal(computeLayout({ width: 390, height: 844, dpr: 3 }).orientation, 'portrait');
  assert.equal(computeLayout({ width: 820, height: 1180, dpr: 2 }).orientation, 'portrait');
  assert.equal(computeLayout({ width: 844, height: 390, dpr: 3 }).orientation, 'landscape');
  assert.equal(computeLayout({ width: 1440, height: 900, dpr: 1 }).orientation, 'landscape');
});

test('computeLayout: dpr 생략/비정상 값은 1로 본다', () => {
  const base = computeLayout({ width: 390, height: 844, dpr: 1 });
  assert.deepEqual(computeLayout({ width: 390, height: 844 }), base);
  assert.deepEqual(computeLayout({ width: 390, height: 844, dpr: 0 }), base);
  assert.deepEqual(computeLayout({ width: 390, height: 844, dpr: Number.NaN }), base);
});

test('computeLayout: 같은 입력이면 같은 결과다(동결된 설정을 건드리지 않는다)', () => {
  const a = computeLayout({ width: 390, height: 844, dpr: 3 });
  const b = computeLayout({ width: 390, height: 844, dpr: 3 });
  assert.deepEqual(a, b);
  assert.notEqual(a.slots, b.slots);
});

test('computeLayout: 퇴화한 크기(0x0)에서도 예외 없이 유한한 값을 돌려준다', () => {
  const layout = computeLayout({ width: 0, height: 0, dpr: 2 });
  for (const value of [layout.cell, layout.boardX, layout.boardY, layout.boardSize, layout.trayCell]) {
    assert.ok(Number.isFinite(value));
  }
});

test('computeLayout: 화면이 커져도 칸 크기는 상한을 넘지 않고 가운데에 놓인다', () => {
  const layout = computeLayout({ width: 1920, height: 1200, dpr: 1 });
  assert.equal(layout.cell, UI.maxCell);
  const groupLeft = layout.boardX;
  const groupRight = layout.slots[0].x + layout.slots[0].w;
  assert.ok(Math.abs(groupLeft - (1920 - groupRight)) <= 1, 'horizontally centered');
});

test('anchorFromPoint: 모든 모양/위치에서 칸 중심을 넣으면 같은 좌상단이 돌아온다', () => {
  for (const viewport of [{ width: 390, height: 844, dpr: 3 }, { width: 844, height: 390, dpr: 2 }]) {
    const layout = computeLayout(viewport);
    for (const shape of SHAPE_LIST) {
      for (let row = -1; row <= BOARD_SIZE; row += 1) {
        for (let col = -1; col <= BOARD_SIZE; col += 1) {
          const centerX = layout.boardX + (col + shape.width / 2) * layout.cell;
          const centerY = layout.boardY + (row + shape.height / 2) * layout.cell;
          assert.deepEqual(anchorFromPoint(layout, shape, centerX, centerY), { row, col }, `${shape.id} @ ${row},${col}`);
        }
      }
    }
  }
});

test('anchorFromPoint: 칸 안에서 조금 벗어나도 가장 가까운 칸으로 스냅하고 -0을 만들지 않는다', () => {
  const layout = computeLayout({ width: 390, height: 844, dpr: 1 });
  const shape = { width: 1, height: 1 };
  const centerOf = (n) => layout.boardX + (n + 0.5) * layout.cell;
  const nudge = layout.cell * 0.45;
  assert.deepEqual(anchorFromPoint(layout, shape, centerOf(3) + nudge, layout.boardY + 0.5 * layout.cell - nudge), { row: 0, col: 3 });
  assert.deepEqual(anchorFromPoint(layout, shape, centerOf(3) - nudge, layout.boardY + 0.5 * layout.cell + nudge), { row: 0, col: 3 });
  assert.ok(Object.is(anchorFromPoint(layout, shape, centerOf(0) - layout.cell * 0.5, centerOf(0)).col, 0));
});

test('anchorFromPoint: 보드 밖 점은 범위 밖 칸을 돌려준다', () => {
  const layout = computeLayout({ width: 390, height: 844, dpr: 1 });
  const dot = { width: 1, height: 1 };
  const centerOf = (origin, n) => origin + (n + 0.5) * layout.cell;
  assert.deepEqual(anchorFromPoint(layout, dot, centerOf(layout.boardX, -4), centerOf(layout.boardY, -3)), { row: -3, col: -4 });
  assert.deepEqual(anchorFromPoint(layout, dot, centerOf(layout.boardX, 19), centerOf(layout.boardY, 19)), { row: 19, col: 19 });
});

test('anchorFraction: 반올림 전 소수 좌표이며 anchorFromPoint와 일치한다', () => {
  const layout = computeLayout({ width: 390, height: 844, dpr: 2 });
  const shape = { width: 3, height: 2 };
  const x = layout.boardX + 2.3 * layout.cell + (shape.width * layout.cell) / 2;
  const y = layout.boardY + 4.7 * layout.cell + (shape.height * layout.cell) / 2;
  const fraction = anchorFraction(layout, shape, x, y);
  assert.ok(Math.abs(fraction.col - 2.3) < 1e-9);
  assert.ok(Math.abs(fraction.row - 4.7) < 1e-9);
  assert.deepEqual(anchorFromPoint(layout, shape, x, y), { row: 5, col: 2 });
});

test('slotIndexAt: 슬롯 안쪽은 번호를, 바깥은 -1을 돌려준다', () => {
  for (const viewport of VIEWPORTS) {
    const layout = computeLayout(viewport);
    layout.slots.forEach((slot, index) => {
      assert.equal(slotIndexAt(layout, slot.cx, slot.cy), index);
      assert.equal(slotIndexAt(layout, slot.x + 0.5, slot.y + 0.5), index);
      assert.equal(slotIndexAt(layout, slot.x + slot.w - 0.5, slot.y + slot.h - 0.5), index);
    });
    assert.equal(slotIndexAt(layout, layout.boardX + layout.boardSize / 2, layout.boardY + layout.boardSize / 2), -1);
    assert.equal(slotIndexAt(layout, -10, -10), -1);
    assert.equal(slotIndexAt(layout, viewport.width + 10, viewport.height + 10), -1);
  }
});

test('slotIndexAt: 슬롯 사이 틈은 가까운 슬롯으로 갈리고 한 점은 한 슬롯에만 속한다', () => {
  for (const viewport of VIEWPORTS) {
    const layout = computeLayout(viewport);
    const [a, b] = layout.slots;
    const portrait = layout.orientation === 'portrait';
    const gapStart = portrait ? a.x + a.w : a.y + a.h;
    const gapEnd = portrait ? b.x : b.y;
    const at = (along) => (portrait ? slotIndexAt(layout, along, a.cy) : slotIndexAt(layout, a.cx, along));
    assert.equal(at(gapStart + 0.01), 0);
    assert.equal(at(gapEnd - 0.01), 1);
    for (let along = gapStart; along < gapEnd; along += 0.25) assert.ok(at(along) === 0 || at(along) === 1);
  }
});
