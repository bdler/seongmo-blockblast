const UINT32_RANGE = 4294967296;

/**
 * 문자열을 32비트 부호 없는 정수로 해시한다(FNV-1a, 코드포인트 단위).
 * @param {string} str
 * @returns {number} 0 이상 2^32 미만의 정수
 */
export function hashSeed(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 시드(숫자 또는 문자열)를 uint32로 바꾼다. 숫자는 `>>> 0`으로 잘라 쓰므로
 * 소수는 버림, 음수는 2^32 기준으로 감긴다. 문자열은 hashSeed를 거친다.
 * @param {number | string} seed
 * @returns {number}
 */
export function seedToInt(seed) {
  if (typeof seed === 'string') return hashSeed(seed);
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  throw new TypeError('seed must be a finite number or a string');
}

/**
 * mulberry32 난수 생성기. 상태가 uint32 하나라서 저장/복원이 쉽다.
 * @param {number | string} seedOrState 시드, 또는 이전 `state()` 값(같은 흐름을 이어간다)
 * @returns {{
 *   next: () => number,
 *   int: (maxExclusive: number) => number,
 *   pick: <T>(items: readonly T[]) => T,
 *   weightedIndex: (weights: readonly number[]) => number,
 *   state: () => number,
 * }}
 */
export function createRng(seedOrState) {
  let a = seedToInt(seedOrState);

  // [0, 1) 균등 분포
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };

  // 0 이상 maxExclusive 미만의 정수
  const int = (maxExclusive) => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError('maxExclusive must be a positive integer');
    }
    return Math.floor(next() * maxExclusive);
  };

  const pick = (items) => {
    if (items.length === 0) throw new RangeError('cannot pick from an empty array');
    return items[int(items.length)];
  };

  // 가중치에 비례해 인덱스를 고른다. 가중치 0인 항목은 절대 뽑히지 않는다
  const weightedIndex = (weights) => {
    let total = 0;
    for (const w of weights) {
      if (!Number.isFinite(w) || w < 0) throw new RangeError('weights must be finite and >= 0');
      total += w;
    }
    if (total <= 0) throw new RangeError('at least one weight must be positive');
    let r = next() * total;
    let last = -1;
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] === 0) continue;
      last = i;
      if (r < weights[i]) return i;
      r -= weights[i];
    }
    // 부동소수점 오차로 루프를 빠져나온 경우
    return last;
  };

  const state = () => a;

  return { next, int, pick, weightedIndex, state };
}

/**
 * 숫자 시드 하나로 `() => [0, 1)` 함수를 만든다(가이드 6.4의 mulberry32).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  return createRng(seed).next;
}
