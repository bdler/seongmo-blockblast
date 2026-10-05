// 앱 진입점: 서비스·렌더러·화면·입력을 만들어 서로 잇고, 홈 → 플레이 → 일시정지 → 게임 오버 흐름을 이끈다.
import { applyMove, createGame, restoreGame } from './core/index.js';
import { UPDATE_READY_EVENT, applyUpdate, onInstallPrompt, registerServiceWorker } from './pwa.js';
import { audio } from './services/audio.js';
import { haptics } from './services/haptics.js';
import {
  clearSavedGame,
  loadBest,
  loadSavedGame,
  loadSettings,
  recordGameResult,
  saveBest,
  saveGame,
  saveSettings,
} from './services/storage.js';
import { createInput } from './ui/input.js';
import { createRenderer } from './ui/renderer.js';
import { createScreens } from './ui/screens.js';

/**
 * @typedef {import('./core/types.js').GameState} GameState
 * @typedef {import('./core/types.js').GameEvent} GameEvent
 * @typedef {'home' | 'playing' | 'paused' | 'gameover'} Phase
 */

// === 상수 ===

const DEFAULT_MODE = 'classic';
const GAME_OVER_DELAY_MS = 700; // 마지막 줄 지우기 연출이 끝난 뒤 결과 화면까지 뜸을 들이는 시간
const GAME_OVER_POLL_MS = 50;
const NEW_BEST_SOUND_DELAY_MS = 900; // 게임 오버 효과음(약 1.4초)이 끝나갈 때쯤 이어서 울린다
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// === 상태 ===

/** @type {GameState | null} */
let state = null;
/** @type {Phase} */
let phase = 'home';
let settings = loadSettings();
let startAfterHowTo = false; // 처음 실행의 게임 방법을 닫으면 곧바로 게임을 시작한다
let gameOverPending = false; // 마지막 수를 둔 뒤 결과 화면이 뜨기 전까지
let gameOverTimer = 0;
let newBestTimer = 0;
let frameId = 0;
let requestInstall = async () => 'unavailable';

/** @type {ReturnType<typeof createRenderer>} */
let renderer;
/** @type {ReturnType<typeof createScreens>} */
let screens;

// === 설정 ===

// 저장소는 모션 설정을 'auto' | 'on' | 'off' 문자열로, 화면은 'auto' | true | false로 다룬다
const toStoredMotion = (value) => (value === true ? 'on' : value === false ? 'off' : 'auto');
const toScreenMotion = (value) => (value === 'on' ? true : value === 'off' ? false : 'auto');

function applyMotion() {
  screens.setMotionPreference(toScreenMotion(settings.reducedMotion));
  renderer.setReducedMotion(screens.isReducedMotion());
  wake();
}

function applySettings() {
  audio.setEnabled(settings.sound);
  audio.setVolume(settings.volume);
  haptics.setEnabled(settings.haptics);
  applyMotion();
}

function changeSettings(partial) {
  const patch = { ...partial };
  if ('reducedMotion' in patch) patch.reducedMotion = toStoredMotion(patch.reducedMotion);
  settings = saveSettings(patch);
  applySettings();
}

function openSettings() {
  screens.showSettings({
    sound: settings.sound,
    haptics: settings.haptics,
    volume: settings.volume,
    reducedMotion: toScreenMotion(settings.reducedMotion),
  });
}

// 게임 방법은 한 번이라도 보여 주면 본 것으로 친다
function openHowTo() {
  if (!settings.tutorialSeen) settings = saveSettings({ tutorialSeen: true });
  screens.showHowTo();
}

// === 렌더 루프 ===

// 그릴 것이 있을 때만 프레임을 요청한다. 숨겨진 탭에서는 요청하지 않고, 다시 보이면 wake()로 깨운다
function wake() {
  if (frameId !== 0 || document.hidden) return;
  frameId = requestAnimationFrame(frame);
}

function frame(now) {
  frameId = 0;
  try {
    renderer.render(now);
  } finally {
    // 입력 잠금(isBlocking)은 렌더러 시간이 흘러야 풀리므로, 연출이 끝난 듯 보여도 잠겨 있는 동안은 루프를 이어 간다
    if (renderer.isAnimating() || renderer.isBlocking()) wake();
  }
}

function handleResize() {
  renderer.resize();
  wake();
}

// === 게임 흐름 ===

const isInputLocked = () => renderer.isBlocking() || gameOverPending;

function randomSeed() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    return cryptoApi.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 2 ** 32);
}

/** 저장된 판을 복원한다. 깨졌거나 이미 끝난 판이면 지우고 null을 돌려준다 */
function readSavedGame() {
  const saved = loadSavedGame();
  if (saved === null) return null;
  const restored = restoreGame(saved.state);
  if (restored === null || restored.status !== 'playing') {
    clearSavedGame();
    return null;
  }
  return restored;
}

function syncHud(animate) {
  screens.setScore(state === null ? 0 : state.score, { animate });
  screens.setCombo(state === null ? 0 : state.combo);
}

function cancelPendingGameOver() {
  clearTimeout(gameOverTimer);
  clearTimeout(newBestTimer);
  gameOverPending = false;
}

/** 주어진 판으로 플레이를 시작한다(새 판, 이어하기, 디버그 스테이징 모두 이 길을 지난다) */
function beginGame(game) {
  cancelPendingGameOver();
  state = game;
  phase = 'playing';
  screens.hideHome();
  screens.hidePause();
  screens.hideGameOver();
  // 비웠다가 다시 넣어 이전 판의 연출·어두워짐이 남지 않게 하고 트레이가 새로 들어오게 한다
  renderer.setState(null);
  renderer.setState(state);
  screens.setBest(loadBest(state.mode));
  syncHud(false);
  saveGame(state);
  wake();
}

// 나중에 다른 모드(daily 등)를 붙일 수 있도록 mode를 인자로 받는다
function startGame({ mode = DEFAULT_MODE, seed = randomSeed() } = {}) {
  beginGame(createGame({ mode, seed }));
}

function restartGame() {
  startGame({ mode: state?.mode });
}

function continueGame() {
  const saved = readSavedGame();
  if (saved === null) startGame();
  else beginGame(saved);
}

function playFromHome() {
  if (settings.tutorialSeen) {
    startGame();
    return;
  }
  startAfterHowTo = true;
  openHowTo();
}

function finishHowTo() {
  if (!startAfterHowTo) return;
  startAfterHowTo = false;
  startGame();
}

// 진행 중인 판은 저장돼 있으므로 홈으로 나가도 이어하기로 돌아올 수 있다
function goHome() {
  cancelPendingGameOver();
  phase = 'home';
  state = null;
  screens.hidePause();
  screens.hideGameOver();
  renderer.setState(null);
  syncHud(false);
  const best = loadBest(DEFAULT_MODE);
  screens.setBest(best);
  screens.showHome({ best, hasSave: readSavedGame() !== null });
  wake();
}

function pauseGame() {
  if (phase !== 'playing' || gameOverPending) return;
  phase = 'paused';
  screens.showPause();
}

function resumeGame() {
  if (phase !== 'paused') return;
  phase = 'playing';
  screens.hidePause();
  wake();
}

// === 이동 처리 ===

/** @param {GameEvent[]} events */
function playMoveFeedback(events) {
  const found = {};
  for (const event of events) found[event.type] = event;
  const comboCount = found.combo ? found.combo.count : 0;

  audio.play('place');
  if (found.clear) audio.play('clear', { lines: found.clear.lines, combo: comboCount });
  if (comboCount >= 2) audio.play('combo', { combo: comboCount });
  if (found.perfect) audio.play('perfect');

  // 진동은 호출할 때마다 앞의 패턴을 덮어쓰므로 가장 큰 사건 하나만 울린다
  haptics.play(found.perfect ? 'perfect' : comboCount >= 2 ? 'combo' : found.clear ? 'clear' : 'place');
}

function handleDrop({ trayIndex, row, col }) {
  wake();
  if (phase !== 'playing' || state === null) return;
  const result = applyMove(state, trayIndex, row, col);
  if (!result.ok) return;

  state = result.state;
  renderer.setState(state);
  renderer.playEvents(result.events);
  screens.setScore(state.score, { animate: true });
  screens.setCombo(state.combo);
  playMoveFeedback(result.events);

  if (state.status === 'over') concludeGame();
  else saveGame(state);
  wake();
}

function handleInvalidDrop({ overBoard }) {
  wake();
  // 트레이 근처에서 놓은 것은 실패가 아니라 취소로 본다
  if (!overBoard) return;
  audio.play('invalid');
  haptics.play('invalid');
}

// === 게임 오버 ===

// 결과는 마지막 수를 두는 즉시 저장한다. 결과 화면이 뜨기 전에 새로고침해도 기록이 남고 끝난 판을 이어하기로 열지 않는다
function concludeGame() {
  const { mode, score, lines, maxCombo, moves } = state;
  recordGameResult({ mode, score, lines, maxCombo, moves });
  const { best, isNewBest } = saveBest(mode, score);
  clearSavedGame();

  gameOverPending = true;
  const info = { score, best, isNewBest, stats: { lines, maxCombo, moves } };
  afterClearAnimation(() => showGameOver(info));
}

// 마지막 줄 지우기 연출(입력 잠금)이 끝나길 기다린 뒤 한 박자 더 쉬고 실행한다.
// 렌더러 시간이 멈추는 숨겨진 탭에서도 다시 보일 때 이어서 끝나도록 실제 시간이 아니라 isBlocking()을 본다
function afterClearAnimation(callback) {
  gameOverTimer = setTimeout(() => {
    if (renderer.isBlocking()) afterClearAnimation(callback);
    else gameOverTimer = setTimeout(callback, GAME_OVER_DELAY_MS);
  }, GAME_OVER_POLL_MS);
}

function showGameOver(info) {
  gameOverPending = false;
  phase = 'gameover';
  screens.setBest(info.best);
  screens.showGameOver(info);
  audio.play('gameover');
  haptics.play('gameover');
  if (info.isNewBest) newBestTimer = setTimeout(() => audio.play('newbest'), NEW_BEST_SOUND_DELAY_MS);
}

// === 전역 이벤트 ===

function installGlobalListeners() {
  window.addEventListener('error', (event) => console.error('처리되지 않은 오류', event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => console.error('처리되지 않은 Promise 거부', event.reason));

  // 브라우저는 사용자 제스처 안에서만 소리를 허용한다. 키보드로만 눌러도, iOS처럼 손을 뗄 때 풀리는 경우에도 열리도록 여러 입력에 건다
  for (const type of ['pointerdown', 'pointerup', 'keydown']) {
    document.addEventListener(type, () => audio.unlock(), { capture: true, passive: true });
  }
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) audio.play('click');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseGame();
    else wake();
  });
  // 설정·게임 방법을 Esc로 닫는 입력은 screens가 처리하며 기본 동작을 막아 둔다. 그 입력이 일시정지로 번지지 않게 한다
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) pauseGame();
  });

  const motionQuery = window.matchMedia(MOTION_QUERY);
  motionQuery.addEventListener('change', applyMotion);
}

// === PWA ===

function setUpPwa(params) {
  requestInstall = onInstallPrompt(() => screens.setCanInstall(true));
  if (params.get('nosw') === '1') return;
  // 업데이트 알림을 놓치지 않도록 등록 전에 리스너를 단다. 판은 매 수마다 저장되므로 새로고침해도 안전하다
  window.addEventListener(UPDATE_READY_EVENT, () => screens.showUpdateToast());
  registerServiceWorker();
}

async function installApp() {
  await requestInstall();
  screens.setCanInstall(false);
}

// === 디버그 훅(e2e용, ?debug=1일 때만) ===

function installDebugHook() {
  window.__bb = {
    getState: () => (state === null ? null : structuredClone(state)),
    getLayout: () => structuredClone(renderer.layout),
    getPhase: () => phase,
    isBusy: isInputLocked,
    getSettings: () => ({ ...settings }),
    newGame(seed) {
      startGame({ mode: DEFAULT_MODE, seed });
    },
    // 검증을 통과한 진행 중인 판으로 현재 판을 바꾼다. 끝난 판이나 잘못된 상태는 false
    setState(next) {
      const restored = restoreGame(next);
      if (restored === null || restored.status !== 'playing') return false;
      beginGame(restored);
      return true;
    },
  };
}

// === 시작 ===

function boot() {
  const params = new URLSearchParams(window.location.search);
  const canvas = document.getElementById('game');

  screens = createScreens({
    handlers: {
      onPlay: playFromHome,
      onContinue: continueGame,
      onHowTo: openHowTo,
      onOpenSettings: openSettings,
      onPause: pauseGame,
      onResume: resumeGame,
      onRestart: restartGame,
      onRetry: restartGame,
      onHome: goHome,
      onSettingsChange: changeSettings,
      onHowToClose: finishHowTo,
      onInstall: installApp,
      onUpdateAccept: applyUpdate,
    },
  });
  renderer = createRenderer(canvas);
  createInput({
    canvas,
    renderer,
    getState: () => (phase === 'playing' ? state : null),
    isLocked: isInputLocked,
    onPickup: () => {
      audio.play('pick');
      wake();
    },
    onDrop: handleDrop,
    onInvalidDrop: handleInvalidDrop,
    onCancel: wake,
  });

  installGlobalListeners();
  applySettings();
  new ResizeObserver(handleResize).observe(document.querySelector('.stage'));
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);

  setUpPwa(params);
  if (params.get('debug') === '1') installDebugHook();
  goHome();
}

boot();
