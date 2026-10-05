// DOM 화면: HUD와 오버레이(홈/일시정지/게임 오버/설정/게임 방법)와 토스트.
// 마크업은 index.html에 있고, 이 모듈은 문자열 채우기 · 이벤트 연결 · 열고 닫기 · 접근성만 맡는다.
// 버튼은 handlers만 부른다. 상태를 바꾸는 일(게임 시작, 일시정지 등)은 main.js가 정하고 show*/hide*를 호출한다.
// 예외로 설정 닫기와 게임 방법 닫기는 화면 안에서 끝나는 동작이라 스스로 닫는다.
import { APP_VERSION } from '../config.js';
import { ko } from '../i18n/ko.js';

/**
 * @typedef {object} ScreenHandlers 모두 선택 사항이다
 * @property {() => void} [onPlay]
 * @property {() => void} [onContinue]
 * @property {() => void} [onHowTo]
 * @property {() => void} [onOpenSettings]
 * @property {() => void} [onPause]
 * @property {() => void} [onResume]
 * @property {() => void} [onRestart]
 * @property {() => void} [onRetry]
 * @property {() => void} [onHome]
 * @property {(partial: Partial<ScreenSettings>) => void} [onSettingsChange] 바뀐 항목만 담아 즉시 부른다
 * @property {(reason: 'start' | 'dismiss') => void} [onHowToClose] 시작 버튼이면 'start', Esc/배경 탭이면 'dismiss'
 * @property {() => void} [onInstall]
 * @property {() => void} [onUpdateAccept]
 */

/**
 * @typedef {object} ScreenSettings
 * @property {boolean} sound
 * @property {boolean} haptics
 * @property {number} volume 0..1
 * @property {'auto' | boolean} reducedMotion true면 켜기, false면 끄기
 */

/**
 * @typedef {object} GameOverInfo
 * @property {number} score
 * @property {number} best
 * @property {boolean} isNewBest
 * @property {{ lines: number, maxCombo: number, moves: number }} stats
 */

// styles/main.css의 --dur-overlay와 같은 값
const OVERLAY_MS = 200;
const TOAST_MS = 3200;
const ANNOUNCE_GAP_MS = 1500;
const OVERLAY_NAMES = ['home', 'pause', 'gameover', 'settings', 'howto'];
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

// 버튼 → 핸들러 이름. 닫기 버튼처럼 화면 안에서 끝나는 동작은 아래에서 따로 연결한다
const CLICK_HANDLERS = {
  'btn-play': 'onPlay',
  'btn-continue': 'onContinue',
  'btn-howto': 'onHowTo',
  'btn-settings': 'onOpenSettings',
  'btn-pause': 'onPause',
  'btn-resume': 'onResume',
  'btn-restart': 'onRestart',
  'btn-pause-settings': 'onOpenSettings',
  'btn-pause-home': 'onHome',
  'btn-retry': 'onRetry',
  'btn-gameover-home': 'onHome',
  'btn-settings-howto': 'onHowTo',
  'btn-install': 'onInstall',
};

// 게임 방법 그림. 5×4 칸이다.
//   . 빈칸, 1~7 놓인 블록, a~g 끌려 오는 블록(색 1~7), A~G 놓일 자리 미리보기, h 채울 칸 힌트
// move는 끌려 오는 블록이 움직일 칸 수, flash는 놓인 블록이 줄 단위로 사라지는 연출이다.
const HOWTO_ART = [
  { rows: ['.e...', 'ee...', '....E', '444EE'], move: { dx: 3, dy: 2 } },
  { rows: ['..f..', '.....', '12h43', '.....'], move: { dx: 0, dy: 2 } },
  { rows: ['12345', '34567', '56712', '.....'], flash: true },
];

const numberFormat = new Intl.NumberFormat('ko-KR');

function toCount(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatNumber(value) {
  return numberFormat.format(toCount(value));
}

function lookup(path) {
  const value = path.split('.').reduce((node, key) => node?.[key], ko);
  if (typeof value !== 'string') throw new Error(`ko.js에 문자열이 없어요: ${path}`);
  return value;
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byTestId(id) {
  const node = document.querySelector(`[data-testid="${id}"]`);
  if (!node) throw new Error(`index.html에 data-testid="${id}" 요소가 없어요`);
  return node;
}

function bySelector(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`index.html에 ${selector} 요소가 없어요`);
  return node;
}

function buildMiniGrid(art, chipText) {
  const grid = el('div', 'mini');
  grid.style.setProperty('--cols', String(art.rows[0].length));
  if (art.move) {
    grid.style.setProperty('--dx', String(art.move.dx));
    grid.style.setProperty('--dy', String(art.move.dy));
  }
  art.rows.forEach((row, r) => {
    for (const ch of row) {
      const cell = el('i', 'mini__c');
      cell.style.setProperty('--r', String(r));
      if (ch >= '1' && ch <= '7') {
        cell.className = 'mini__c blk';
        cell.dataset.c = ch;
        if (art.flash) cell.dataset.fx = 'flash';
      } else if (ch >= 'a' && ch <= 'g') {
        cell.className = 'mini__c blk';
        cell.dataset.c = String(ch.charCodeAt(0) - 96);
        cell.dataset.fx = 'mover';
      } else if (ch >= 'A' && ch <= 'G') {
        cell.className = 'mini__c blk';
        cell.dataset.c = String(ch.charCodeAt(0) - 64);
        cell.dataset.fx = 'ghost';
      } else if (ch === 'h') {
        cell.dataset.fx = 'hint';
      }
      grid.append(cell);
    }
  });
  if (chipText) grid.append(el('span', 'chip mini__chip', chipText));
  grid.setAttribute('aria-hidden', 'true');
  return grid;
}

function buildNewBestBadge() {
  const badge = el('span', 'newbest');
  badge.dataset.testid = 'gameover-newbest';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', ko.a11y.newBest);
  badge.append(el('span', 'newbest__pill', ko.gameover.newBest));
  // 팔레트 7색에 하나를 더해 8방향으로 터뜨린다
  for (let i = 0; i < 8; i += 1) {
    const spark = el('i', 'newbest__spark');
    spark.style.setProperty('--a', `${i * 45 - 90}deg`);
    spark.style.setProperty('--d', i % 2 ? '58px' : '44px');
    spark.style.setProperty('--spark', `var(--c${(i % 7) + 1})`);
    badge.append(spark);
  }
  return badge;
}

/**
 * index.html의 마크업에 문자열과 동작을 연결한다. 한 페이지에서 한 번만 만든다.
 * @param {{ handlers?: ScreenHandlers }} [options]
 */
export function createScreens({ handlers = {} } = {}) {
  const root = document.documentElement;
  const hud = bySelector('.hud');
  const stage = bySelector('.stage');
  const live = bySelector('#live-score');

  const hudScore = byTestId('hud-score');
  const hudBest = byTestId('hud-best');
  const hudCombo = byTestId('hud-combo');
  const homeBest = byTestId('home-best');
  const continueButton = byTestId('btn-continue');
  const installButton = byTestId('btn-install');
  const gameOverScore = byTestId('gameover-score');
  const gameOverBest = byTestId('gameover-best');
  const gameOverStats = byTestId('gameover-stats');
  const toast = byTestId('toast');
  const toastAction = byTestId('toast-action');
  const toastMessage = bySelector('.toast__message');
  const soundToggle = byTestId('toggle-sound');
  const hapticsToggle = byTestId('toggle-haptics');
  const volumeRange = byTestId('range-volume');
  const volumeReadout = byTestId('volume-readout');
  const motionSelect = byTestId('select-motion');

  /** @type {Map<string, { el: HTMLElement, opener: Element | null, timer: number }>} */
  const overlays = new Map();
  for (const name of OVERLAY_NAMES) {
    overlays.set(name, { el: bySelector(`[data-overlay="${name}"]`), opener: null, timer: 0 });
  }
  /** 열린 순서대로 쌓는다. 마지막이 맨 위(포커스를 받는 창)다 */
  const stack = [];

  // ---------- 문자열 ----------

  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = lookup(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(';')) {
      const [attr, path] = pair.split(':');
      node.setAttribute(attr, lookup(path));
    }
  }

  const wordmark = bySelector('.wordmark');
  wordmark.setAttribute('aria-label', ko.home.title);
  for (const word of ko.home.title.split(' ')) {
    const line = el('span', 'wordmark__line');
    line.dataset.text = word;
    line.setAttribute('aria-hidden', 'true');
    line.append(el('span', 'wordmark__fill', word));
    wordmark.append(line);
  }

  for (const option of motionSelect.options) {
    option.textContent = ko.settings.motionOptions[option.value];
  }

  byTestId('settings-version').textContent = ko.settings.version(APP_VERSION);

  const steps = bySelector('.steps');
  ko.howto.steps.forEach((step, i) => {
    const item = el('li', 'step');
    const body = el('div', 'step__body');
    const title = el('h3', 'step__title');
    title.append(el('span', 'step__no', String(i + 1)), step.title);
    title.firstChild.setAttribute('aria-hidden', 'true');
    body.append(title, el('p', 'step__text', step.text));
    item.append(buildMiniGrid(HOWTO_ART[i], HOWTO_ART[i].flash ? ko.fx.combo(3) : ''), body);
    steps.append(item);
  });

  // ---------- 모션 줄이기 ----------

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** @type {'auto' | boolean} */
  let motionPreference = 'auto';

  function isReducedMotion() {
    return motionPreference === true || (motionPreference === 'auto' && motionQuery.matches);
  }

  // CSS는 이 속성 하나만 보면 되도록 사용자 설정과 OS 설정을 합쳐 둔다
  function syncMotionAttribute() {
    root.dataset.motion = isReducedMotion() ? 'reduce' : 'full';
  }

  /** @param {'auto' | boolean} value */
  function setMotionPreference(value) {
    motionPreference = value === true || value === false ? value : 'auto';
    syncMotionAttribute();
  }

  motionQuery.addEventListener('change', syncMotionAttribute);
  syncMotionAttribute();

  // ---------- 오버레이 열기/닫기 ----------

  function syncStack() {
    const modalOpen = stack.length > 0;
    hud.inert = modalOpen;
    stage.inert = modalOpen;
    stack.forEach((name, index) => {
      const node = overlays.get(name).el;
      const covered = index < stack.length - 1;
      node.inert = covered;
      node.dataset.covered = String(covered);
      node.dataset.stacked = String(index > 0);
    });
  }

  function visibleFocusables(scope) {
    return [...scope.querySelectorAll(FOCUSABLE)].filter(
      (node) => !node.disabled && !node.closest('[hidden], [inert]'),
    );
  }

  function focusInto(node) {
    const target = [...node.querySelectorAll('[data-autofocus]')].find((n) => !n.closest('[hidden]'));
    (target ?? node.querySelector('.panel')).focus({ preventScroll: true });
  }

  function openOverlay(name) {
    const overlay = overlays.get(name);
    if (stack.includes(name)) return;
    clearTimeout(overlay.timer);
    overlay.opener = document.activeElement;
    stack.push(name);
    overlay.el.hidden = false;
    overlay.el.dataset.open = 'true';
    overlay.el.setAttribute('aria-hidden', 'false');
    syncStack();
    focusInto(overlay.el);
  }

  function closeOverlay(name) {
    const index = stack.indexOf(name);
    if (index < 0) return;
    const overlay = overlays.get(name);
    const wasTop = index === stack.length - 1;
    stack.splice(index, 1);
    overlay.el.dataset.open = 'false';
    overlay.el.dataset.covered = 'false';
    overlay.el.setAttribute('aria-hidden', 'true');
    overlay.el.inert = true;
    syncStack();

    const hide = () => {
      overlay.el.hidden = true;
    };
    if (isReducedMotion()) hide();
    else overlay.timer = setTimeout(hide, OVERLAY_MS);

    if (wasTop) {
      const { opener } = overlay;
      if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
      else if (overlay.el.contains(document.activeElement)) document.activeElement.blur();
    }
    overlay.opener = null;
  }

  function topOverlayName() {
    return stack.at(-1) ?? null;
  }

  // 토스트의 버튼도 모달 안에서 키보드로 닿도록 Tab 순서에 넣는다
  function trapTab(event, overlayEl) {
    const items = visibleFocusables(overlayEl);
    if (!toast.hidden) items.push(...visibleFocusables(toast));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !items.includes(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !items.includes(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', (event) => {
    const name = topOverlayName();
    if (!name) return;
    if (event.key === 'Tab') {
      trapTab(event, overlays.get(name).el);
    } else if (event.key === 'Escape') {
      if (name === 'settings') {
        event.preventDefault();
        hideSettings();
      } else if (name === 'howto') {
        event.preventDefault();
        dismissHowTo('dismiss');
      }
    }
  });

  // 설정/게임 방법은 배경을 눌러도 닫는다. 슬라이더를 끌다가 패널 밖에서 손을 떼도 닫히지 않게 누른 위치도 본다
  for (const name of ['settings', 'howto']) {
    const node = overlays.get(name).el;
    let pressedOnBackdrop = false;
    node.addEventListener('pointerdown', (event) => {
      pressedOnBackdrop = !event.target.closest('.panel');
    });
    node.addEventListener('click', (event) => {
      if (!pressedOnBackdrop || event.target.closest('.panel')) return;
      if (name === 'settings') hideSettings();
      else dismissHowTo('dismiss');
    });
  }

  // ---------- 버튼 연결 ----------

  for (const [id, handlerName] of Object.entries(CLICK_HANDLERS)) {
    byTestId(id).addEventListener('click', () => handlers[handlerName]?.());
  }
  byTestId('btn-settings-close').addEventListener('click', () => hideSettings());
  byTestId('btn-howto-close').addEventListener('click', () => dismissHowTo('start'));
  toastAction.addEventListener('click', () => {
    const callback = toastActionCallback;
    hideToast();
    callback?.();
  });

  function dismissHowTo(reason) {
    hideHowTo();
    handlers.onHowToClose?.(reason);
  }

  // ---------- 점수 ----------

  let shownScore = 0;
  let shownLength = 0;
  let tweenFrame = 0;
  let announceTimer = 0;
  let announceAt = -Infinity;
  let pendingScore = 0;

  function renderScore(value) {
    shownScore = value;
    const text = formatNumber(value);
    if (hudScore.textContent === text) return;
    hudScore.textContent = text;
    if (text.length !== shownLength) {
      shownLength = text.length;
      hudScore.style.setProperty('--len', String(shownLength));
    }
  }

  // 점수가 연달아 올라가도 스크린 리더가 쏟아내지 않도록 일정 간격으로 가장 최근 값만 읽어 준다
  function announceScore(score) {
    pendingScore = score;
    if (announceTimer) return;
    const wait = Math.max(0, announceAt + ANNOUNCE_GAP_MS - performance.now());
    announceTimer = setTimeout(() => {
      announceTimer = 0;
      announceAt = performance.now();
      live.textContent = ko.a11y.score(formatNumber(pendingScore));
    }, wait);
  }

  /**
   * @param {number} score
   * @param {{ animate?: boolean }} [options] animate면 지금 값에서 새 값까지 숫자를 올리며 보여 준다
   */
  function setScore(score, { animate = false } = {}) {
    const target = toCount(score);
    const from = shownScore;
    cancelAnimationFrame(tweenFrame);
    tweenFrame = 0;
    if (animate && target > from) announceScore(target);
    if (!animate || target <= from || isReducedMotion()) {
      renderScore(target);
      return;
    }
    const duration = Math.min(700, 260 + Math.sqrt(target - from) * 36);
    const startedAt = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      renderScore(t === 1 ? target : Math.round(from + (target - from) * easeOutCubic(t)));
      tweenFrame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    tweenFrame = requestAnimationFrame(step);
    hudScore.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
      { duration: 280, easing: 'ease-out' },
    );
  }

  /** @param {number} best */
  function setBest(best) {
    hudBest.textContent = formatNumber(best);
  }

  let shownCombo = 0;

  /** @param {number} count 2 이상일 때만 칩을 보여 준다 */
  function setCombo(count) {
    const visible = count >= 2;
    // 사라지는 동안 글자가 먼저 비지 않게 마지막 글자를 남겨 둔다
    if (visible) hudCombo.textContent = ko.hud.combo(count);
    hudCombo.dataset.visible = String(visible);
    hudCombo.setAttribute('aria-hidden', String(!visible));
    if (visible && count !== shownCombo && !isReducedMotion()) {
      hudCombo.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }],
        { duration: 240, easing: 'ease-out' },
      );
    }
    shownCombo = visible ? count : 0;
  }

  // ---------- 화면별 메서드 ----------

  function setCanInstall(canInstall) {
    installButton.hidden = !canInstall;
  }

  /** @param {{ best: number, hasSave: boolean, canInstall?: boolean }} info */
  function showHome({ best, hasSave, canInstall }) {
    const hasBest = toCount(best) > 0;
    homeBest.textContent = hasBest ? formatNumber(best) : ko.home.noBest;
    homeBest.dataset.empty = String(!hasBest);
    continueButton.hidden = !hasSave;
    if (canInstall !== undefined) setCanInstall(canInstall);
    openOverlay('home');
  }

  function showPause() {
    openOverlay('pause');
  }

  /** @param {GameOverInfo} info */
  function showGameOver({ score, best, isNewBest, stats }) {
    const scoreText = formatNumber(score);
    gameOverScore.textContent = scoreText;
    gameOverScore.style.setProperty('--len', String(scoreText.length));
    gameOverBest.textContent = formatNumber(best);
    for (const node of gameOverStats.querySelectorAll('[data-stat]')) {
      node.textContent = formatNumber(stats[node.dataset.stat]);
    }
    const card = gameOverScore.closest('.scorecard');
    card.querySelector('.newbest')?.remove();
    card.dataset.newbest = String(Boolean(isNewBest));
    if (isNewBest) card.append(buildNewBestBadge());
    openOverlay('gameover');
  }

  /** @param {ScreenSettings} settings */
  function showSettings(settings) {
    setSwitch(soundToggle, settings.sound);
    setSwitch(hapticsToggle, settings.haptics);
    const percent = Math.round(Math.min(1, Math.max(0, Number(settings.volume))) * 100);
    volumeRange.value = String(percent);
    renderVolume();
    motionSelect.value = settings.reducedMotion === true ? 'on' : settings.reducedMotion === false ? 'off' : 'auto';
    setMotionPreference(settings.reducedMotion);
    openOverlay('settings');
  }

  function hideSettings() {
    closeOverlay('settings');
  }

  function showHowTo() {
    openOverlay('howto');
  }

  function hideHowTo() {
    closeOverlay('howto');
  }

  // ---------- 설정 컨트롤 ----------

  function setSwitch(toggle, checked) {
    toggle.setAttribute('aria-checked', String(Boolean(checked)));
    const state = toggle.closest('.setting').querySelector('.setting__state');
    state.textContent = checked ? ko.settings.on : ko.settings.off;
  }

  function renderVolume() {
    const percent = Number(volumeRange.value);
    volumeRange.style.setProperty('--fill', `${percent}%`);
    volumeRange.setAttribute('aria-valuetext', `${percent}%`);
    volumeReadout.textContent = `${percent}%`;
  }

  for (const [toggle, key] of [[soundToggle, 'sound'], [hapticsToggle, 'haptics']]) {
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-checked') !== 'true';
      setSwitch(toggle, next);
      handlers.onSettingsChange?.({ [key]: next });
    });
    // 행 어디를 눌러도 토글된다
    toggle.closest('.setting').addEventListener('click', (event) => {
      if (!toggle.contains(event.target)) toggle.click();
    });
  }

  volumeRange.addEventListener('input', () => {
    renderVolume();
    handlers.onSettingsChange?.({ volume: Number(volumeRange.value) / 100 });
  });

  motionSelect.addEventListener('change', () => {
    const value = motionSelect.value === 'on' ? true : motionSelect.value === 'off' ? false : 'auto';
    setMotionPreference(value);
    handlers.onSettingsChange?.({ reducedMotion: value });
  });

  // ---------- 토스트 ----------

  let toastTimer = 0;
  let toastHideTimer = 0;
  let toastDuration = TOAST_MS;
  let toastActionCallback = null;

  function armToastTimer() {
    clearTimeout(toastTimer);
    toastTimer = toastDuration > 0 ? setTimeout(hideToast, toastDuration) : 0;
  }

  // 읽거나 누르려는 동안에는 사라지지 않게 멈춘다
  toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
  toast.addEventListener('focusin', () => clearTimeout(toastTimer));
  toast.addEventListener('pointerleave', armToastTimer);
  toast.addEventListener('focusout', armToastTimer);

  /**
   * @param {string} message
   * @param {{ actionLabel?: string, onAction?: () => void, duration?: number }} [options] duration 0이면 직접 닫을 때까지 남는다
   */
  function showToast(message, { actionLabel, onAction, duration = TOAST_MS } = {}) {
    clearTimeout(toastHideTimer);
    toastMessage.textContent = message;
    toastAction.hidden = !actionLabel;
    toastAction.textContent = actionLabel ?? '';
    toastActionCallback = actionLabel ? (onAction ?? null) : null;
    toastDuration = duration;
    toast.hidden = false;
    toast.dataset.open = 'true';
    toast.setAttribute('aria-hidden', 'false');
    armToastTimer();
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = 0;
    if (toast.hidden) return;
    toast.dataset.open = 'false';
    toast.setAttribute('aria-hidden', 'true');
    const hide = () => {
      toast.hidden = true;
    };
    if (isReducedMotion()) hide();
    else toastHideTimer = setTimeout(hide, OVERLAY_MS);
  }

  function showUpdateToast() {
    showToast(ko.toast.updateReady, {
      actionLabel: ko.toast.update,
      onAction: () => handlers.onUpdateAccept?.(),
      duration: 0,
    });
  }

  return {
    showHome,
    hideHome: () => closeOverlay('home'),
    setScore,
    setBest,
    setCombo,
    showPause,
    hidePause: () => closeOverlay('pause'),
    showGameOver,
    hideGameOver: () => closeOverlay('gameover'),
    showSettings,
    hideSettings,
    showHowTo,
    hideHowTo,
    showToast,
    hideToast,
    showUpdateToast,
    setCanInstall,
    setMotionPreference,
    isReducedMotion,
    getOpenOverlay: topOverlayName,
  };
}
