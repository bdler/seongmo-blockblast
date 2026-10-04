import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const GLOBAL_KEYS = ['window', 'navigator', 'location', 'matchMedia'];
const originals = new Map(GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

let importCount = 0;

// 모듈 상태(한 번만 새로고침 등)가 테스트 사이에 새지 않도록 매번 새 인스턴스를 가져온다
function loadModule() {
  importCount += 1;
  return import(`../src/pwa.js?case=${importCount}`);
}

function setGlobal(key, value) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

beforeEach(() => {
  // 기본은 서비스 워커도 window도 없는 Node 환경
  for (const key of ['window', 'location', 'matchMedia']) delete globalThis[key];
  setGlobal('navigator', {});
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function fakeWorker(state = 'installing') {
  const worker = new EventTarget();
  worker.state = state;
  worker.messages = [];
  worker.postMessage = (message) => worker.messages.push(message);
  return worker;
}

// 페이지 환경: https 위치, window 이벤트 대상, 서비스 워커 컨테이너와 등록 객체를 만든다
function installBrowser({ protocol = 'https:', controller = {}, waiting = null } = {}) {
  const window = new EventTarget();
  const reloads = [];
  const registration = Object.assign(new EventTarget(), { installing: null, waiting });
  const container = Object.assign(new EventTarget(), {
    controller,
    registerCalls: [],
    async register(url, options) {
      this.registerCalls.push([url, options]);
      return registration;
    },
    async getRegistration() {
      return registration;
    },
  });
  setGlobal('window', window);
  setGlobal('location', { protocol, reload: () => reloads.push('reload') });
  setGlobal('navigator', { serviceWorker: container });
  const updateEvents = [];
  window.addEventListener('pwa:update-ready', (event) => updateEvents.push(event));
  return { window, registration, container, reloads, updateEvents };
}

function startInstall(registration, worker) {
  registration.installing = worker;
  registration.dispatchEvent(new Event('updatefound'));
}

function setState(worker, state) {
  worker.state = state;
  worker.dispatchEvent(new Event('statechange'));
}

test('공개 API가 모두 내보내진다', async () => {
  const pwa = await loadModule();
  assert.equal(typeof pwa.registerServiceWorker, 'function');
  assert.equal(typeof pwa.applyUpdate, 'function');
  assert.equal(typeof pwa.isStandalone, 'function');
  assert.equal(typeof pwa.onInstallPrompt, 'function');
  assert.equal(pwa.UPDATE_READY_EVENT, 'pwa:update-ready');
});

test('Node처럼 브라우저 API가 없으면 모든 함수가 조용히 아무것도 하지 않는다', async () => {
  const pwa = await loadModule();
  assert.equal(await pwa.registerServiceWorker(), null);
  assert.equal(await pwa.applyUpdate(), false);
  assert.equal(pwa.isStandalone(), false);
  const promptInstall = pwa.onInstallPrompt(() => assert.fail('호출되면 안 된다'));
  assert.equal(await promptInstall(), 'unavailable');
});

test('registerServiceWorker: http(s)가 아니면 등록하지 않는다', async () => {
  const env = installBrowser({ protocol: 'file:' });
  const pwa = await loadModule();
  assert.equal(await pwa.registerServiceWorker(), null);
  assert.equal(env.container.registerCalls.length, 0);
});

test('registerServiceWorker: ./sw.js를 ./ 스코프로 등록한다', async () => {
  for (const protocol of ['https:', 'http:']) {
    const env = installBrowser({ protocol });
    const pwa = await loadModule();
    assert.equal(await pwa.registerServiceWorker(), env.registration);
    assert.deepEqual(env.container.registerCalls, [['./sw.js', { scope: './' }]]);
  }
});

test('registerServiceWorker: 실패는 삼키고 console.warn으로만 남긴다', async () => {
  const env = installBrowser();
  env.container.register = async () => {
    throw new Error('등록 거부');
  };
  const warn = mock.method(console, 'warn', () => {});
  const pwa = await loadModule();
  assert.equal(await pwa.registerServiceWorker(), null);
  assert.equal(warn.mock.callCount(), 1);
});

test('새 워커가 설치되면 pwa:update-ready를 한 번 발생시키고 detail.apply를 준다', async () => {
  const env = installBrowser();
  const pwa = await loadModule();
  await pwa.registerServiceWorker();
  const worker = fakeWorker();
  startInstall(env.registration, worker);
  setState(worker, 'installing');
  assert.equal(env.updateEvents.length, 0, '설치가 끝나기 전에는 알리지 않는다');
  setState(worker, 'installed');
  assert.equal(env.updateEvents.length, 1);
  assert.ok(env.updateEvents[0] instanceof CustomEvent);
  assert.equal(env.updateEvents[0].detail.apply, pwa.applyUpdate);
  assert.equal(env.reloads.length, 0, '스스로 새로고침하지 않는다');
});

test('첫 설치(제어 중인 워커 없음)에서는 업데이트 알림을 보내지 않는다', async () => {
  const env = installBrowser({ controller: null });
  const pwa = await loadModule();
  await pwa.registerServiceWorker();
  const worker = fakeWorker();
  startInstall(env.registration, worker);
  setState(worker, 'installed');
  env.container.dispatchEvent(new Event('controllerchange'));
  assert.equal(env.updateEvents.length, 0);
  assert.equal(env.reloads.length, 0);
});

test('이미 대기 중인 워커가 있는 채로 열면 등록 직후 알린다', async () => {
  const env = installBrowser({ waiting: fakeWorker('installed') });
  const pwa = await loadModule();
  await pwa.registerServiceWorker();
  assert.equal(env.updateEvents.length, 1);
});

test('applyUpdate: 대기 워커에 SKIP_WAITING을 보내고 controllerchange에서 정확히 한 번 새로고침한다', async () => {
  const waiting = fakeWorker('installed');
  const env = installBrowser({ waiting });
  const pwa = await loadModule();
  assert.equal(await pwa.applyUpdate(), true);
  assert.deepEqual(waiting.messages, [{ type: 'SKIP_WAITING' }]);
  assert.equal(env.reloads.length, 0, '교체가 끝나기 전에는 새로고침하지 않는다');
  env.container.dispatchEvent(new Event('controllerchange'));
  env.container.dispatchEvent(new Event('controllerchange'));
  assert.equal(env.reloads.length, 1);

  // 중복 호출해도 새로고침 루프가 생기지 않는다
  await pwa.applyUpdate();
  env.container.dispatchEvent(new Event('controllerchange'));
  assert.equal(env.reloads.length, 1);
});

test('applyUpdate: 대기 워커가 없으면 false이고 이후 controllerchange에도 새로고침하지 않는다', async () => {
  const env = installBrowser();
  const pwa = await loadModule();
  assert.equal(await pwa.applyUpdate(), false);
  env.container.dispatchEvent(new Event('controllerchange'));
  assert.equal(env.reloads.length, 0);
});

test('applyUpdate를 부르지 않으면 controllerchange가 와도 새로고침하지 않는다', async () => {
  const env = installBrowser();
  const pwa = await loadModule();
  await pwa.registerServiceWorker();
  env.container.dispatchEvent(new Event('controllerchange'));
  assert.equal(env.reloads.length, 0);
});

test('isStandalone: display-mode와 iOS navigator.standalone을 모두 인식한다', async () => {
  const pwa = await loadModule();
  assert.equal(pwa.isStandalone(), false);

  setGlobal('matchMedia', (query) => ({ matches: query === '(display-mode: standalone)' }));
  assert.equal(pwa.isStandalone(), true);

  setGlobal('matchMedia', () => ({ matches: false }));
  assert.equal(pwa.isStandalone(), false);

  setGlobal('navigator', { standalone: true });
  assert.equal(pwa.isStandalone(), true);

  setGlobal('matchMedia', () => {
    throw new Error('지원하지 않음');
  });
  setGlobal('navigator', {});
  assert.equal(pwa.isStandalone(), false);
});

function installPromptEvent(outcome = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  event.promptCalls = 0;
  event.prompt = async () => {
    event.promptCalls += 1;
  };
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

test('onInstallPrompt: 기본 배너를 막고 이벤트를 보관해 prompt()를 대신 호출한다', async () => {
  const window = new EventTarget();
  setGlobal('window', window);
  const pwa = await loadModule();
  const received = [];
  const promptInstall = pwa.onInstallPrompt((fn) => received.push(fn));
  assert.equal(await promptInstall(), 'unavailable', '이벤트 전에는 쓸 수 없다');

  const event = installPromptEvent('accepted');
  window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(received, [promptInstall]);

  assert.equal(await promptInstall(), 'accepted');
  assert.equal(event.promptCalls, 1);
  assert.equal(await promptInstall(), 'unavailable', '이벤트는 한 번만 쓴다');
  assert.equal(event.promptCalls, 1);
});

test('onInstallPrompt: 거절은 dismissed, 설치 완료 후에는 unavailable', async () => {
  const window = new EventTarget();
  setGlobal('window', window);
  const pwa = await loadModule();
  const promptInstall = pwa.onInstallPrompt();

  window.dispatchEvent(installPromptEvent('dismissed'));
  assert.equal(await promptInstall(), 'dismissed');

  window.dispatchEvent(installPromptEvent('accepted'));
  window.dispatchEvent(new Event('appinstalled'));
  assert.equal(await promptInstall(), 'unavailable');
});

test('onInstallPrompt: prompt()가 거부되면 unavailable을 돌려주고 이벤트를 남겨 다시 시도할 수 있다', async () => {
  const window = new EventTarget();
  setGlobal('window', window);
  const pwa = await loadModule();
  const promptInstall = pwa.onInstallPrompt();
  const event = installPromptEvent('accepted');
  let attempts = 0;
  event.prompt = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('사용자 제스처 필요');
  };
  window.dispatchEvent(event);
  assert.equal(await promptInstall(), 'unavailable');
  assert.equal(await promptInstall(), 'accepted');
});
