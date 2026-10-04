import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let instanceCounter = 0;

// 모듈 안의 메모리 대체 저장소가 테스트 사이에 새지 않도록 매번 새 인스턴스를 불러온다
async function loadModule() {
  instanceCounter += 1;
  return import(`../src/services/storage.js?instance=${instanceCounter}`);
}

function installLocalStorage(value) {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

function removeLocalStorage() {
  if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
  else delete globalThis.localStorage;
}

function createFakeStorage({ failGet = false, failSet = false, failRemove = false } = {}) {
  const fake = {
    data: new Map(),
    failGet,
    failSet,
    failRemove,
    getItem(key) {
      if (fake.failGet) throw new Error('getItem blocked');
      return fake.data.has(key) ? fake.data.get(key) : null;
    },
    setItem(key, value) {
      if (fake.failSet) throw new DOMException('quota', 'QuotaExceededError');
      fake.data.set(key, String(value));
    },
    removeItem(key) {
      if (fake.failRemove) throw new Error('removeItem blocked');
      fake.data.delete(key);
    },
  };
  return fake;
}

beforeEach(() => removeLocalStorage());
afterEach(() => {
  removeLocalStorage();
  mock.restoreAll();
});

test('키 접두어는 스키마 버전에서 만들어진다', async () => {
  const { STORAGE_SCHEMA_VERSION, STORAGE_PREFIX } = await loadModule();
  assert.equal(STORAGE_SCHEMA_VERSION, 1);
  assert.equal(STORAGE_PREFIX, 'bb:v1:');
});

test('정상 경로: 접두어가 붙은 키에 JSON으로 저장하고 읽는다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { storage } = await loadModule();

  assert.equal(storage.set('thing', { a: [1, 2], b: 'x' }), true);
  assert.equal(fake.data.get('bb:v1:thing'), '{"a":[1,2],"b":"x"}');
  assert.deepEqual(storage.get('thing', null), { a: [1, 2], b: 'x' });
  assert.equal(storage.isPersistent(), true);
});

test('없는 키는 fallback을 돌려주고, 인자를 생략하면 undefined다', async () => {
  installLocalStorage(createFakeStorage());
  const { storage } = await loadModule();

  assert.equal(storage.get('missing', 42), 42);
  assert.equal(storage.get('missing'), undefined);
});

test('null, 0, false, 빈 문자열도 값으로 저장된다', async () => {
  installLocalStorage(createFakeStorage());
  const { storage } = await loadModule();

  for (const value of [null, 0, false, '']) {
    storage.set('v', value);
    assert.equal(storage.get('v', 'fallback'), value);
  }
});

test('remove는 키를 지운다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { storage } = await loadModule();

  storage.set('gone', 1);
  storage.remove('gone');
  assert.equal(fake.data.has('bb:v1:gone'), false);
  assert.equal(storage.get('gone', 'none'), 'none');
});

test('읽은 객체를 바꿔도 저장된 값은 영향받지 않는다', async () => {
  installLocalStorage(createFakeStorage());
  const { storage } = await loadModule();

  storage.set('obj', { n: 1 });
  storage.get('obj').n = 99;
  assert.deepEqual(storage.get('obj'), { n: 1 });
});

test('직렬화할 수 없는 값은 저장하지 않고 false를 돌려준다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { storage } = await loadModule();

  const circular = {};
  circular.self = circular;
  assert.equal(storage.set('c', circular), false);
  assert.equal(storage.set('u', undefined), false);
  assert.equal(storage.set('f', () => {}), false);
  assert.equal(fake.data.size, 0);
  assert.equal(storage.get('c', 'none'), 'none');
});

test('깨진 JSON은 fallback을 돌려주고 해당 키를 지운다', async () => {
  const fake = createFakeStorage();
  fake.data.set('bb:v1:broken', '{not json');
  installLocalStorage(fake);
  const { storage } = await loadModule();

  assert.equal(storage.get('broken', 'safe'), 'safe');
  assert.equal(fake.data.has('bb:v1:broken'), false);
});

test('깨진 JSON을 지우지 못해도 던지지 않는다', async () => {
  const fake = createFakeStorage({ failRemove: true });
  fake.data.set('bb:v1:broken', '{');
  installLocalStorage(fake);
  const { storage } = await loadModule();

  assert.equal(storage.get('broken', 'safe'), 'safe');
});

test('localStorage가 없으면 메모리로 동작한다', async () => {
  const { storage } = await loadModule();

  assert.equal(storage.isPersistent(), false);
  assert.equal(storage.set('k', { n: 1 }), false);
  assert.deepEqual(storage.get('k', null), { n: 1 });
  storage.remove('k');
  assert.equal(storage.get('k', 'none'), 'none');
});

test('localStorage 접근 자체가 던져도(사생활 보호 모드) 메모리로 동작한다', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    get() {
      throw new DOMException('denied', 'SecurityError');
    },
    configurable: true,
  });
  const { storage, saveBest, loadBest } = await loadModule();

  assert.equal(storage.isPersistent(), false);
  assert.equal(storage.set('k', 7), false);
  assert.equal(storage.get('k', null), 7);
  assert.deepEqual(saveBest('classic', 120), { best: 120, isNewBest: true });
  assert.equal(loadBest('classic'), 120);
});

test('getItem/setItem/removeItem이 모두 던져도 메모리로 계속 동작한다', async () => {
  installLocalStorage(createFakeStorage({ failGet: true, failSet: true, failRemove: true }));
  const { storage } = await loadModule();

  assert.equal(storage.set('k', 'v'), false);
  assert.equal(storage.get('k', null), 'v');
  assert.equal(storage.isPersistent(), false);
  storage.remove('k');
  assert.equal(storage.get('k', 'none'), 'none');
});

test('쓰기 용량 초과: 메모리에 보관해 읽히고, 옛 값보다 최신이 우선한다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { storage } = await loadModule();

  assert.equal(storage.set('score', 10), true);
  fake.failSet = true;
  assert.equal(storage.set('score', 20), false);

  assert.equal(fake.data.get('bb:v1:score'), '10');
  assert.equal(storage.get('score', null), 20);
  assert.equal(storage.isPersistent(), false);
});

test('용량 초과 뒤 저장소가 복구되면 다시 localStorage에 기록한다', async () => {
  const fake = createFakeStorage({ failSet: true });
  installLocalStorage(fake);
  const { storage } = await loadModule();

  storage.set('score', 20);
  fake.failSet = false;
  assert.equal(storage.set('score', 30), true);
  assert.equal(fake.data.get('bb:v1:score'), '30');
  assert.equal(storage.get('score', null), 30);
  assert.equal(storage.isPersistent(), true);
});

test('다른 모듈 인스턴스(새로고침)도 같은 localStorage 값을 읽는다', async () => {
  installLocalStorage(createFakeStorage());
  const first = await loadModule();
  first.saveBest('classic', 500);

  const second = await loadModule();
  assert.equal(second.loadBest('classic'), 500);
});

// ---- 설정 ----

test('DEFAULT_SETTINGS는 명세와 같고 변경할 수 없다', async () => {
  const { DEFAULT_SETTINGS } = await loadModule();

  assert.deepEqual(DEFAULT_SETTINGS, {
    sound: true,
    haptics: true,
    volume: 0.8,
    theme: 'default',
    reducedMotion: 'auto',
    tutorialSeen: false,
  });
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
});

test('loadSettings: 저장된 것이 없으면 기본값이고 매번 새 객체다', async () => {
  installLocalStorage(createFakeStorage());
  const { loadSettings, DEFAULT_SETTINGS } = await loadModule();

  const settings = loadSettings();
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  settings.sound = false;
  assert.equal(loadSettings().sound, true);
});

test('loadSettings: 기본값 위에 병합하고 모르는 키/타입이 틀린 값은 버린다', async () => {
  const fake = createFakeStorage();
  fake.data.set(
    'bb:v1:settings',
    JSON.stringify({
      sound: false,
      haptics: 'yes',
      volume: '0.5',
      theme: 'dark',
      reducedMotion: 3,
      tutorialSeen: true,
      unknownKey: 1,
    }),
  );
  installLocalStorage(fake);
  const { loadSettings } = await loadModule();

  assert.deepEqual(loadSettings(), {
    sound: false,
    haptics: true,
    volume: 0.8,
    theme: 'dark',
    reducedMotion: 'auto',
    tutorialSeen: true,
  });
});

test('loadSettings: volume은 0..1로 보정하고 유한하지 않으면 기본값', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { loadSettings } = await loadModule();

  for (const [stored, expected] of [[1.5, 1], [-2, 0], [0, 0], [1, 1], [0.25, 0.25], [null, 0.8]]) {
    fake.data.set('bb:v1:settings', JSON.stringify({ volume: stored }));
    assert.equal(loadSettings().volume, expected, `stored ${stored}`);
  }
});

test('loadSettings: 객체가 아닌 저장값이면 기본값', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { loadSettings, DEFAULT_SETTINGS } = await loadModule();

  for (const stored of ['"text"', '[1,2]', '7', 'null', '{broken']) {
    fake.data.set('bb:v1:settings', stored);
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS, stored);
  }
});

test('saveSettings: 일부만 넘기면 병합해서 저장하고 전체를 돌려준다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { saveSettings, loadSettings } = await loadModule();

  const merged = saveSettings({ sound: false });
  assert.equal(merged.sound, false);
  assert.equal(merged.volume, 0.8);

  const next = saveSettings({ volume: 0.3 });
  assert.deepEqual(next, { ...merged, volume: 0.3 });
  assert.deepEqual(loadSettings(), next);
  assert.deepEqual(JSON.parse(fake.data.get('bb:v1:settings')), next);
});

test('saveSettings: 모르는 키와 잘못된 값은 저장하지 않고 volume은 보정한다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { saveSettings } = await loadModule();

  const merged = saveSettings({ volume: 9, theme: 5, extra: true, haptics: false, __proto__: { x: 1 } });
  assert.equal(merged.volume, 1);
  assert.equal(merged.theme, 'default');
  assert.equal(merged.haptics, false);
  assert.equal('extra' in merged, false);
  assert.equal('extra' in JSON.parse(fake.data.get('bb:v1:settings')), false);
});

test('saveSettings: 객체가 아닌 인자는 현재 설정을 그대로 돌려준다', async () => {
  installLocalStorage(createFakeStorage());
  const { saveSettings, DEFAULT_SETTINGS } = await loadModule();

  for (const bad of [undefined, null, 'x', 5, [1]]) {
    assert.deepEqual(saveSettings(bad), DEFAULT_SETTINGS);
  }
});

test('saveSettings: 저장이 불가능해도 병합 결과를 돌려주고 이번 세션에서는 유지된다', async () => {
  installLocalStorage(createFakeStorage({ failSet: true }));
  const { saveSettings, loadSettings } = await loadModule();

  const merged = saveSettings({ sound: false, theme: 'dark' });
  assert.equal(merged.sound, false);
  assert.deepEqual(loadSettings(), merged);
});

// ---- 최고 점수 ----

test('loadBest: 기록이 없으면 0', async () => {
  installLocalStorage(createFakeStorage());
  const { loadBest } = await loadModule();

  assert.equal(loadBest('classic'), 0);
  assert.equal(loadBest('toString'), 0);
});

test('saveBest: 첫 점수는 신기록이고 이후에는 더 높을 때만 올라간다', async () => {
  installLocalStorage(createFakeStorage());
  const { saveBest, loadBest } = await loadModule();

  assert.deepEqual(saveBest('classic', 100), { best: 100, isNewBest: true });
  assert.deepEqual(saveBest('classic', 60), { best: 100, isNewBest: false });
  assert.deepEqual(saveBest('classic', 100), { best: 100, isNewBest: false });
  assert.deepEqual(saveBest('classic', 101), { best: 101, isNewBest: true });
  assert.equal(loadBest('classic'), 101);
});

test('saveBest: 0점은 신기록이 아니다', async () => {
  installLocalStorage(createFakeStorage());
  const { saveBest, loadBest } = await loadModule();

  assert.deepEqual(saveBest('classic', 0), { best: 0, isNewBest: false });
  assert.equal(loadBest('classic'), 0);
});

test('saveBest: 유한하지 않거나 음수이거나 숫자가 아닌 점수는 무시한다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { saveBest, loadBest } = await loadModule();

  saveBest('classic', 50);
  for (const bad of [NaN, Infinity, -Infinity, -1, '999', null, undefined, {}]) {
    assert.deepEqual(saveBest('classic', bad), { best: 50, isNewBest: false });
  }
  assert.equal(loadBest('classic'), 50);
});

test('saveBest: 잘못된 모드 이름은 저장하지 않는다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { saveBest } = await loadModule();

  for (const bad of ['', undefined, null, 7]) {
    assert.deepEqual(saveBest(bad, 100), { best: 0, isNewBest: false });
  }
  assert.equal(fake.data.size, 0);
});

test('최고 점수는 모드별로 독립적이다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { saveBest, loadBest } = await loadModule();

  saveBest('classic', 300);
  saveBest('daily', 120);
  assert.equal(loadBest('classic'), 300);
  assert.equal(loadBest('daily'), 120);
  assert.deepEqual(JSON.parse(fake.data.get('bb:v1:best')), { classic: 300, daily: 120 });
});

test('최고 점수 표에서 잘못된 항목은 버리고 나머지는 살린다', async () => {
  const fake = createFakeStorage();
  fake.data.set('bb:v1:best', JSON.stringify({ classic: 90, daily: 'x', adventure: -5, weird: null }));
  installLocalStorage(fake);
  const { loadBest, saveBest } = await loadModule();

  assert.equal(loadBest('classic'), 90);
  assert.equal(loadBest('daily'), 0);
  assert.equal(loadBest('adventure'), 0);
  assert.deepEqual(saveBest('daily', 10), { best: 10, isNewBest: true });
  assert.deepEqual(JSON.parse(fake.data.get('bb:v1:best')), { classic: 90, daily: 10 });
});

test('최고 점수 표 전체가 깨져 있으면 0에서 다시 시작한다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { loadBest, saveBest } = await loadModule();

  for (const stored of ['[1,2]', '12', '"x"', '{oops']) {
    fake.data.set('bb:v1:best', stored);
    assert.equal(loadBest('classic'), 0, stored);
  }
  assert.deepEqual(saveBest('classic', 5), { best: 5, isNewBest: true });
});

// ---- 이어하기 ----

test('saveGame/loadSavedGame: 상태와 저장 시각을 돌려준다', async () => {
  installLocalStorage(createFakeStorage());
  mock.method(Date, 'now', () => 1_700_000_000_000);
  const { saveGame, loadSavedGame } = await loadModule();

  const state = { mode: 'classic', board: [[0, 1], [2, 0]], score: 40 };
  assert.equal(saveGame(state), true);
  assert.deepEqual(loadSavedGame(), { state, savedAt: 1_700_000_000_000 });
});

test('saveGame은 게임 규칙을 검사하지 않는다(객체이기만 하면 된다)', async () => {
  installLocalStorage(createFakeStorage());
  const { saveGame, loadSavedGame } = await loadModule();

  assert.equal(saveGame({ whatever: 'shape' }), true);
  assert.deepEqual(loadSavedGame().state, { whatever: 'shape' });
});

test('saveGame은 객체가 아닌 값을 거부하고 기존 저장을 건드리지 않는다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { saveGame, loadSavedGame } = await loadModule();

  saveGame({ score: 1 });
  for (const bad of [null, undefined, 5, 'state', true, [1, 2]]) {
    assert.equal(saveGame(bad), false);
  }
  assert.deepEqual(loadSavedGame().state, { score: 1 });
});

test('clearSavedGame 이후에는 null', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { saveGame, loadSavedGame, clearSavedGame } = await loadModule();

  saveGame({ score: 1 });
  clearSavedGame();
  assert.equal(loadSavedGame(), null);
  assert.equal(fake.data.has('bb:v1:save'), false);
});

test('loadSavedGame: 저장된 것이 없으면 null', async () => {
  installLocalStorage(createFakeStorage());
  const { loadSavedGame } = await loadModule();

  assert.equal(loadSavedGame(), null);
});

test('loadSavedGame: 모양이 깨진 저장은 null을 돌려주고 지운다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { loadSavedGame } = await loadModule();

  const broken = [
    '{"state":5,"savedAt":1}',
    '{"state":{"a":1}}',
    '{"state":{"a":1},"savedAt":"now"}',
    '[1,2]',
    '"text"',
    '{not json',
  ];
  for (const stored of broken) {
    fake.data.set('bb:v1:save', stored);
    assert.equal(loadSavedGame(), null, stored);
    assert.equal(fake.data.has('bb:v1:save'), false, stored);
  }
});

test('이어하기 저장이 불가능해도 메모리에서 이어하기가 된다', async () => {
  installLocalStorage(createFakeStorage({ failSet: true }));
  const { saveGame, loadSavedGame } = await loadModule();

  assert.equal(saveGame({ score: 7 }), false);
  assert.deepEqual(loadSavedGame().state, { score: 7 });
});

// ---- 통계 ----

const EMPTY_STATS = {
  gamesPlayed: 0,
  totalScore: 0,
  totalLines: 0,
  bestCombo: 0,
  totalMoves: 0,
  perMode: {},
};

test('loadStats: 기록이 없으면 0으로 채워진 통계', async () => {
  installLocalStorage(createFakeStorage());
  const { loadStats } = await loadModule();

  assert.deepEqual(loadStats(), EMPTY_STATS);
});

test('recordGameResult: 판마다 합계가 누적되고 bestCombo는 최댓값이다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { recordGameResult, loadStats } = await loadModule();

  recordGameResult({ mode: 'classic', score: 100, lines: 5, maxCombo: 3, moves: 20 });
  const stats = recordGameResult({ mode: 'classic', score: 250, lines: 8, maxCombo: 2, moves: 31 });

  assert.equal(stats.gamesPlayed, 2);
  assert.equal(stats.totalScore, 350);
  assert.equal(stats.totalLines, 13);
  assert.equal(stats.bestCombo, 3);
  assert.equal(stats.totalMoves, 51);
  assert.deepEqual(loadStats(), stats);
  assert.deepEqual(JSON.parse(fake.data.get('bb:v1:stats')), stats);
});

test('recordGameResult: 모드별 통계가 따로 쌓인다', async () => {
  installLocalStorage(createFakeStorage());
  const { recordGameResult } = await loadModule();

  recordGameResult({ mode: 'classic', score: 100, lines: 5, maxCombo: 3, moves: 20 });
  recordGameResult({ mode: 'daily', score: 40, lines: 2, maxCombo: 1, moves: 9 });
  const stats = recordGameResult({ mode: 'classic', score: 60, lines: 1, maxCombo: 4, moves: 6 });

  assert.deepEqual(stats.perMode, {
    classic: { gamesPlayed: 2, totalScore: 160, totalLines: 6, bestCombo: 4, totalMoves: 26, bestScore: 100 },
    daily: { gamesPlayed: 1, totalScore: 40, totalLines: 2, bestCombo: 1, totalMoves: 9, bestScore: 40 },
  });
  assert.equal(stats.gamesPlayed, 3);
});

test('recordGameResult: 비정상 숫자는 0으로 보고, mode가 없거나 객체가 아닌 결과는 무시한다', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { recordGameResult, loadStats } = await loadModule();

  const stats = recordGameResult({ mode: 'classic', score: NaN, lines: -4, maxCombo: 'x', moves: Infinity });
  assert.deepEqual(stats.perMode.classic, {
    gamesPlayed: 1,
    totalScore: 0,
    totalLines: 0,
    bestCombo: 0,
    totalMoves: 0,
    bestScore: 0,
  });

  const before = loadStats();
  for (const bad of [null, undefined, 'x', [], {}, { mode: '', score: 5 }, { score: 5 }]) {
    assert.deepEqual(recordGameResult(bad), before);
  }
  assert.deepEqual(loadStats(), before);
});

test('loadStats: 깨진 통계는 항목별로 복구한다', async () => {
  const fake = createFakeStorage();
  fake.data.set(
    'bb:v1:stats',
    JSON.stringify({
      gamesPlayed: 4,
      totalScore: 'many',
      totalLines: -1,
      bestCombo: 6,
      perMode: { classic: { gamesPlayed: 2, bestScore: 90, totalScore: null }, daily: 'broken' },
    }),
  );
  installLocalStorage(fake);
  const { loadStats } = await loadModule();

  assert.deepEqual(loadStats(), {
    gamesPlayed: 4,
    totalScore: 0,
    totalLines: 0,
    bestCombo: 6,
    totalMoves: 0,
    perMode: {
      classic: { gamesPlayed: 2, totalScore: 0, totalLines: 0, bestCombo: 0, totalMoves: 0, bestScore: 90 },
      daily: { gamesPlayed: 0, totalScore: 0, totalLines: 0, bestCombo: 0, totalMoves: 0, bestScore: 0 },
    },
  });
});

test('loadStats: 통계 전체가 깨져 있으면 빈 통계', async () => {
  const fake = createFakeStorage();
  installLocalStorage(fake);
  const { loadStats } = await loadModule();

  for (const stored of ['[1]', '"x"', '5', '{oops']) {
    fake.data.set('bb:v1:stats', stored);
    assert.deepEqual(loadStats(), EMPTY_STATS, stored);
  }
});

test('통계도 localStorage 없이 메모리에서 누적된다', async () => {
  const { recordGameResult, loadStats } = await loadModule();

  recordGameResult({ mode: 'classic', score: 10, lines: 1, maxCombo: 1, moves: 3 });
  recordGameResult({ mode: 'classic', score: 20, lines: 2, maxCombo: 2, moves: 4 });
  assert.equal(loadStats().totalScore, 30);
  assert.equal(loadStats().gamesPlayed, 2);
});
