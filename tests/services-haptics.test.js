import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { haptics, PATTERNS } from '../src/services/haptics.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function installNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function installVibrate(result = true) {
  const calls = [];
  installNavigator({
    vibrate(pattern) {
      calls.push(pattern);
      return typeof result === 'function' ? result() : result;
    },
  });
  return calls;
}

beforeEach(() => haptics.setEnabled(true));
afterEach(() => {
  haptics.setEnabled(true);
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
});

test('PATTERNS는 명세와 같다', () => {
  assert.deepEqual(PATTERNS, {
    place: [10],
    clear: [20, 30, 20],
    combo: [25, 40, 25, 40, 25],
    perfect: [40, 60, 40, 60, 80],
    gameover: [80],
    invalid: [15],
  });
});

test('PATTERNS는 바꿀 수 없다', () => {
  assert.equal(Object.isFrozen(PATTERNS), true);
  for (const pattern of Object.values(PATTERNS)) assert.equal(Object.isFrozen(pattern), true);
});

test('지원 환경: 이름에 맞는 패턴으로 vibrate를 호출한다', () => {
  const calls = installVibrate();

  assert.equal(haptics.isSupported(), true);
  for (const name of Object.keys(PATTERNS)) assert.equal(haptics.play(name), true, name);
  assert.deepEqual(calls, Object.values(PATTERNS));
});

test('vibrate는 navigator를 this로 호출된다', () => {
  let receiver = null;
  const fake = {
    vibrate() {
      receiver = this;
      return true;
    },
  };
  installNavigator(fake);
  haptics.play('place');
  assert.equal(receiver, fake);
});

test('모르는 이름이나 Object.prototype 키는 vibrate를 호출하지 않는다', () => {
  const calls = installVibrate();

  for (const name of ['nope', '', undefined, null, 'constructor', 'toString', '__proto__']) {
    assert.equal(haptics.play(name), false, String(name));
  }
  assert.deepEqual(calls, []);
});

test('꺼져 있으면 vibrate를 호출하지 않고, 다시 켜면 동작한다', () => {
  const calls = installVibrate();

  assert.equal(haptics.isEnabled(), true);
  haptics.setEnabled(false);
  assert.equal(haptics.isEnabled(), false);
  assert.equal(haptics.play('clear'), false);
  assert.deepEqual(calls, []);
  assert.equal(haptics.isSupported(), true, 'support is independent from the flag');

  haptics.setEnabled(true);
  assert.equal(haptics.play('clear'), true);
  assert.deepEqual(calls, [[20, 30, 20]]);
});

test('setEnabled는 불리언으로 바꿔 저장한다', () => {
  haptics.setEnabled(0);
  assert.equal(haptics.isEnabled(), false);
  haptics.setEnabled('yes');
  assert.equal(haptics.isEnabled(), true);
});

test('navigator.vibrate가 없으면(iOS Safari) 조용히 아무것도 하지 않는다', () => {
  installNavigator({ userAgent: 'iPhone' });

  assert.equal(haptics.isSupported(), false);
  for (const name of Object.keys(PATTERNS)) assert.equal(haptics.play(name), false);
});

test('navigator 자체가 없어도 던지지 않는다', () => {
  installNavigator(undefined);
  assert.equal(haptics.isSupported(), false);
  assert.equal(haptics.play('place'), false);

  installNavigator(null);
  assert.equal(haptics.isSupported(), false);
  assert.equal(haptics.play('place'), false);

  delete globalThis.navigator;
  assert.equal(haptics.isSupported(), false);
  assert.equal(haptics.play('place'), false);
});

test('vibrate가 함수가 아니면 미지원으로 본다', () => {
  installNavigator({ vibrate: true });
  assert.equal(haptics.isSupported(), false);
  assert.equal(haptics.play('place'), false);
});

test('navigator 접근이 던져도 삼킨다', () => {
  Object.defineProperty(globalThis, 'navigator', {
    get() {
      throw new Error('blocked');
    },
    configurable: true,
  });
  assert.equal(haptics.isSupported(), false);
  assert.equal(haptics.play('place'), false);
});

test('vibrate가 던지면 false를 돌려주고 던지지 않는다', () => {
  installVibrate(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  assert.doesNotThrow(() => haptics.play('place'));
  assert.equal(haptics.play('place'), false);
});

test('vibrate가 false를 돌려주면(사용자 제스처 전 등) play도 false', () => {
  const calls = installVibrate(false);
  assert.equal(haptics.play('place'), false);
  assert.equal(calls.length, 1);
});

test('지원 여부는 호출 시점에 판단한다 (import 이후에 navigator가 바뀌어도 반영)', () => {
  installNavigator({});
  assert.equal(haptics.isSupported(), false);
  installVibrate();
  assert.equal(haptics.isSupported(), true);
});

test('일반 Node 환경(진짜 navigator, vibrate 없음)에서도 안전하다', () => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  assert.equal(haptics.isSupported(), false);
  assert.equal(haptics.play('place'), false);
});
