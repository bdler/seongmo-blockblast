// 연출에 쓰는 이징 함수 모음. 모두 t를 0~1로 받아 값을 돌려주는 순수 함수다.

export function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function easeOutCubic(t) {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInCubic(t) {
  const u = clamp01(t);
  return u * u * u;
}

// 목표를 살짝 넘었다가 돌아온다(팝/스프링 느낌)
export function easeOutBack(t, overshoot = 1.70158) {
  const u = clamp01(t) - 1;
  return 1 + u * u * ((overshoot + 1) * u + overshoot);
}

// 처음에 살짝 뒤로 당겼다가 줄어든다(사라지는 칸용)
export function easeInBack(t, overshoot = 1.70158) {
  const u = clamp01(t);
  return u * u * ((overshoot + 1) * u - overshoot);
}

// 0 → 1 → 0으로 부드럽게 오가는 값(깜빡이는 강조용)
export function pulse(phase) {
  return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
}
