// 진동 피드백. navigator.vibrate가 없는 환경(iOS Safari 등)에서는 조용히 아무것도 하지 않는다.

/** 단위 ms. 홀수 번째는 진동, 짝수 번째는 쉬는 시간 */
export const PATTERNS = Object.freeze({
  place: Object.freeze([10]),
  clear: Object.freeze([20, 30, 20]),
  combo: Object.freeze([25, 40, 25, 40, 25]),
  perfect: Object.freeze([40, 60, 40, 60, 80]),
  gameover: Object.freeze([80]),
  invalid: Object.freeze([15]),
});

let enabled = true;

// 지원 여부는 호출 시점에 판단한다(모듈 로드 때는 navigator가 없을 수 있다)
function isSupported() {
  try {
    return typeof globalThis.navigator?.vibrate === 'function';
  } catch {
    return false;
  }
}

/** @param {boolean} value */
function setEnabled(value) {
  enabled = Boolean(value);
}

function isEnabled() {
  return enabled;
}

/**
 * @param {string} name PATTERNS의 키
 * @returns {boolean} 진동을 요청했으면 true
 */
function play(name) {
  if (!enabled || !Object.prototype.hasOwnProperty.call(PATTERNS, name) || !isSupported()) {
    return false;
  }
  try {
    return Boolean(globalThis.navigator.vibrate(PATTERNS[name]));
  } catch {
    return false;
  }
}

export const haptics = { isSupported, setEnabled, isEnabled, play };
