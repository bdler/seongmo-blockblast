// localStorage 래퍼. 모든 읽기/쓰기를 try/catch로 감싸고, 쓸 수 없으면 메모리로 대체한다.
//
// 스키마 버전: 키 접두어('bb:v1:')에 버전이 들어 있다. 저장 형식을 깨는 변경이 생기면
// STORAGE_SCHEMA_VERSION만 올려도 새 접두어('bb:v2:')가 적용되므로, 옛 형식 데이터를
// 새 코드가 잘못 해석하는 일이 없다. 옛 기록을 이어받으려면 이 파일에 마이그레이션 함수를
// 추가해 첫 사용 전에 한 번 실행한다.
//   1) 'bb:v1:' 키를 읽어 v2 형태로 변환 → 2) 'bb:v2:' 키로 저장
//   3) 저장이 모두 성공한 뒤에만 v1 키를 삭제 (중간에 실패해도 원본이 남아 재시도할 수 있다)

export const STORAGE_SCHEMA_VERSION = 1;
export const STORAGE_PREFIX = `bb:v${STORAGE_SCHEMA_VERSION}:`;

/**
 * @typedef {object} Settings
 * @property {boolean} sound
 * @property {boolean} haptics
 * @property {number} volume 0..1
 * @property {string} theme
 * @property {string} reducedMotion 'auto' | 'on' | 'off' (형식만 검사하고 값 종류는 UI가 정한다)
 * @property {boolean} tutorialSeen
 */

/**
 * @typedef {object} GameResult
 * @property {string} mode
 * @property {number} score
 * @property {number} lines
 * @property {number} maxCombo
 * @property {number} moves
 */

/**
 * @typedef {object} ModeStats
 * @property {number} gamesPlayed
 * @property {number} totalScore
 * @property {number} totalLines
 * @property {number} bestCombo
 * @property {number} totalMoves
 * @property {number} bestScore
 */

/**
 * @typedef {object} Stats
 * @property {number} gamesPlayed
 * @property {number} totalScore
 * @property {number} totalLines
 * @property {number} bestCombo
 * @property {number} totalMoves
 * @property {Object<string, ModeStats>} perMode
 */

/** localStorage를 쓸 수 없거나 쓰기에 실패한 값의 임시 보관소 (JSON 문자열로 저장) */
const memory = new Map();

function getBackend() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 쿠키/사이트 데이터 차단 시 접근만 해도 SecurityError가 난다
    return null;
  }
}

function readRaw(name) {
  // 쓰기에 실패해 메모리에 둔 값이 localStorage의 옛 값보다 최신이므로 먼저 본다
  if (memory.has(name)) return memory.get(name);
  try {
    return getBackend()?.getItem(name) ?? null;
  } catch {
    return null;
  }
}

function removeRaw(name) {
  memory.delete(name);
  try {
    getBackend()?.removeItem(name);
  } catch {
    // 지울 수 없어도 메모리 쪽은 이미 비웠다
  }
}

export const storage = {
  /**
   * 접두어를 뺀 키로 값을 읽는다. 없거나 JSON이 깨졌으면 fallback을 돌려준다(깨진 키는 삭제).
   * @param {string} key
   * @param {*} [fallback]
   */
  get(key, fallback) {
    const name = STORAGE_PREFIX + key;
    const raw = readRaw(name);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      removeRaw(name);
      return fallback;
    }
  },

  /**
   * 값을 JSON으로 저장한다.
   * localStorage에 기록했으면 true. 쓸 수 없어 메모리에만 보관했거나(이번 세션에서는 읽힌다)
   * 직렬화할 수 없는 값이라 저장하지 못했으면 false.
   * @param {string} key
   * @param {*} value
   * @returns {boolean}
   */
  set(key, value) {
    const name = STORAGE_PREFIX + key;
    let raw;
    try {
      raw = JSON.stringify(value);
    } catch {
      return false;
    }
    if (raw === undefined) return false;

    const backend = getBackend();
    if (backend) {
      try {
        backend.setItem(name, raw);
        memory.delete(name);
        return true;
      } catch {
        // 용량 초과/사생활 보호 모드: 메모리로 대체
      }
    }
    memory.set(name, raw);
    return false;
  },

  /** @param {string} key */
  remove(key) {
    removeRaw(STORAGE_PREFIX + key);
  },

  /** 모든 값이 실제로 localStorage에 있고 쓰기도 가능하면 true */
  isPersistent() {
    if (memory.size > 0) return false;
    const backend = getBackend();
    if (!backend) return false;
    const probe = `${STORAGE_PREFIX}__probe__`;
    try {
      backend.setItem(probe, '1');
      backend.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value) => (isCount(value) ? value : 0);
const isModeName = (value) => typeof value === 'string' && value.length > 0;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// ---- 설정 ----

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  haptics: true,
  volume: 0.8,
  theme: 'default',
  reducedMotion: 'auto',
  tutorialSeen: false,
});

/** 알려진 키만, 기본값과 같은 타입일 때만 남긴다. 저장 데이터와 호출 인자 모두에 쓴다. */
function sanitizeSettings(raw) {
  const clean = {};
  if (!isPlainObject(raw)) return clean;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!hasOwn(raw, key)) continue;
    const value = raw[key];
    if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
    if (key === 'volume') {
      if (!Number.isFinite(value)) continue;
      clean.volume = Math.min(1, Math.max(0, value));
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/** @returns {Settings} */
export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...sanitizeSettings(storage.get('settings', null)) };
}

/**
 * @param {Partial<Settings>} partial
 * @returns {Settings} 저장된 전체 설정
 */
export function saveSettings(partial) {
  const merged = { ...loadSettings(), ...sanitizeSettings(partial) };
  storage.set('settings', merged);
  return merged;
}

// ---- 최고 점수 ----

function readBestTable() {
  const raw = storage.get('best', null);
  if (!isPlainObject(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => isCount(value)));
}

/**
 * @param {string} mode
 * @returns {number}
 */
export function loadBest(mode) {
  const table = readBestTable();
  return hasOwn(table, mode) ? table[mode] : 0;
}

/**
 * 최고 점수는 절대 내려가지 않는다. 잘못된 점수(비유한수/음수)는 무시한다.
 * @param {string} mode
 * @param {number} score
 * @returns {{best: number, isNewBest: boolean}}
 */
export function saveBest(mode, score) {
  const table = readBestTable();
  const best = hasOwn(table, mode) ? table[mode] : 0;
  if (!isModeName(mode) || !isCount(score) || score <= best) {
    return { best, isNewBest: false };
  }
  storage.set('best', { ...table, [mode]: score });
  return { best: score, isNewBest: true };
}

// ---- 이어하기 ----

/**
 * 게임 규칙에 맞는 상태인지는 검사하지 않는다(core.restoreGame의 몫). 객체인지만 본다.
 * @param {object} state
 * @returns {boolean} localStorage에 기록했으면 true
 */
export function saveGame(state) {
  if (!isPlainObject(state)) return false;
  return storage.set('save', { state, savedAt: Date.now() });
}

/** @returns {{state: object, savedAt: number} | null} */
export function loadSavedGame() {
  const saved = storage.get('save', null);
  if (saved === null) return null;
  if (!isPlainObject(saved) || !isPlainObject(saved.state) || !isCount(saved.savedAt)) {
    storage.remove('save');
    return null;
  }
  return { state: saved.state, savedAt: saved.savedAt };
}

export function clearSavedGame() {
  storage.remove('save');
}

// ---- 누적 통계 ----

function readTotals(source) {
  const data = isPlainObject(source) ? source : {};
  return {
    gamesPlayed: count(data.gamesPlayed),
    totalScore: count(data.totalScore),
    totalLines: count(data.totalLines),
    bestCombo: count(data.bestCombo),
    totalMoves: count(data.totalMoves),
  };
}

function readModeStats(source) {
  const data = isPlainObject(source) ? source : {};
  return { ...readTotals(data), bestScore: count(data.bestScore) };
}

function addResult(totals, result) {
  return {
    gamesPlayed: totals.gamesPlayed + 1,
    totalScore: totals.totalScore + result.score,
    totalLines: totals.totalLines + result.lines,
    bestCombo: Math.max(totals.bestCombo, result.maxCombo),
    totalMoves: totals.totalMoves + result.moves,
  };
}

/** @returns {Stats} */
export function loadStats() {
  const raw = storage.get('stats', null);
  const perMode = isPlainObject(raw) && isPlainObject(raw.perMode) ? raw.perMode : {};
  return {
    ...readTotals(raw),
    perMode: Object.fromEntries(
      Object.entries(perMode).map(([mode, entry]) => [mode, readModeStats(entry)]),
    ),
  };
}

/**
 * 한 판의 결과를 누적 통계에 더한다. mode가 없는 결과는 무시한다.
 * @param {GameResult} result
 * @returns {Stats} 갱신된 통계
 */
export function recordGameResult(result) {
  const stats = loadStats();
  if (!isPlainObject(result) || !isModeName(result.mode)) return stats;

  const { mode } = result;
  const played = {
    score: count(result.score),
    lines: count(result.lines),
    maxCombo: count(result.maxCombo),
    moves: count(result.moves),
  };
  const previous = hasOwn(stats.perMode, mode) ? stats.perMode[mode] : readModeStats(null);
  const next = {
    ...addResult(stats, played),
    perMode: {
      ...stats.perMode,
      [mode]: {
        ...addResult(previous, played),
        bestScore: Math.max(previous.bestScore, played.score),
      },
    },
  };
  storage.set('stats', next);
  return next;
}
