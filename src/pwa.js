// PWA 연결부: 서비스 워커 등록, 업데이트 알림, 설치 안내.
// 페이지를 스스로 새로고침하지 않는다. 새로고침은 사용자가 확인해 applyUpdate()를 부른 뒤에만 일어난다.

const SW_URL = './sw.js';
const SW_SCOPE = './';

/** 새 버전이 설치되어 대기 중일 때 window에 발생하는 이벤트. detail은 { apply }다 */
export const UPDATE_READY_EVENT = 'pwa:update-ready';

let reloadScheduled = false;
let installEvent = null;

function getServiceWorkerContainer() {
  try {
    return globalThis.navigator?.serviceWorker ?? null;
  } catch {
    return null;
  }
}

// file:// 이나 확장 프로그램 페이지에서는 등록할 수 없다. https와 localhost(http)만 통과한다
function canRegister() {
  const protocol = globalThis.location?.protocol;
  return Boolean(getServiceWorkerContainer()) && (protocol === 'http:' || protocol === 'https:');
}

function announceUpdate() {
  window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT, { detail: { apply: applyUpdate } }));
}

function watchForUpdates(registration, container) {
  // controller가 없으면 첫 설치라서 알릴 업데이트가 아니다
  const hasController = () => Boolean(container.controller);

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && hasController()) announceUpdate();
    });
  });

  // 안내를 무시하고 새로고침한 경우 대기 중인 워커가 이미 있어 updatefound가 다시 오지 않는다
  if (registration.waiting && hasController()) announceUpdate();
}

/**
 * 서비스 워커를 등록한다. 지원하지 않는 환경에서는 아무것도 하지 않는다.
 * 업데이트 안내를 받으려면 이 함수를 부르기 전에 UPDATE_READY_EVENT 리스너를 달아 둔다.
 * @returns {Promise<ServiceWorkerRegistration | null>} 등록하지 않았거나 실패하면 null
 */
export async function registerServiceWorker() {
  if (!canRegister()) return null;
  try {
    const container = getServiceWorkerContainer();
    const registration = await container.register(SW_URL, { scope: SW_SCOPE });
    watchForUpdates(registration, container);
    return registration;
  } catch (error) {
    console.warn('서비스 워커 등록에 실패했다', error);
    return null;
  }
}

/**
 * 대기 중인 새 워커를 활성화하고, 교체가 끝나면(controllerchange) 정확히 한 번 새로고침한다.
 * @returns {Promise<boolean>} 대기 중인 워커에 요청을 보냈으면 true
 */
export async function applyUpdate() {
  const container = getServiceWorkerContainer();
  if (!container) return false;
  try {
    const registration = await container.getRegistration();
    const waiting = registration?.waiting;
    if (!waiting) return false;
    container.addEventListener('controllerchange', reloadOnce, { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  } catch (error) {
    console.warn('업데이트 적용에 실패했다', error);
    return false;
  }
}

// controllerchange가 여러 번 오거나 applyUpdate가 중복 호출돼도 새로고침 반복이 생기지 않게 막는다
function reloadOnce() {
  if (reloadScheduled) return;
  reloadScheduled = true;
  globalThis.location.reload();
}

/** 홈 화면에 설치된 독립 실행(standalone) 상태인지. iOS Safari는 navigator.standalone을 쓴다 */
export function isStandalone() {
  try {
    const mediaMatch = globalThis.matchMedia?.('(display-mode: standalone)')?.matches;
    return Boolean(mediaMatch) || globalThis.navigator?.standalone === true;
  } catch {
    return false;
  }
}

/**
 * beforeinstallprompt를 가로채 브라우저 기본 설치 배너를 막고, 이벤트를 보관한다.
 * 이벤트는 페이지 로드 초기에 한 번만 오므로 앱 시작 때 바로 부른다.
 * @param {(promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>) => void} [callback]
 *   설치할 수 있게 되었을 때 호출된다(설치 버튼을 보여줄 시점)
 * @returns {() => Promise<'accepted' | 'dismissed' | 'unavailable'>} 설치 창을 띄우는 함수.
 *   설치 이벤트가 없거나 이미 썼으면 'unavailable'
 */
export function onInstallPrompt(callback) {
  async function promptInstall() {
    const event = installEvent;
    if (!event) return 'unavailable';
    try {
      await event.prompt();
      // 이벤트는 한 번만 쓸 수 있다. 사용자 제스처가 없어 prompt()가 거부되면 다시 쓸 수 있게 남겨 둔다
      installEvent = null;
      const choice = await event.userChoice;
      return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
    } catch {
      return 'unavailable';
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installEvent = event;
      callback?.(promptInstall);
    });
    window.addEventListener('appinstalled', () => {
      installEvent = null;
    });
  }
  return promptInstall;
}
