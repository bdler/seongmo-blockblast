import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { END_MARKER, START_MARKER, renderBlock, replaceBlock } from '../tools/build-sw.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW_PATH = join(ROOT, 'sw.js');
const SW_SOURCE = readFileSync(SW_PATH, 'utf8');

const VERSION = 'abc1234567';
const CACHE_NAME = `bb-${VERSION}`;
const PRECACHE_URLS = ['./', 'index.html', 'src/main.js'];
const FIXTURE_SOURCE = replaceBlock(SW_SOURCE, renderBlock(VERSION, PRECACHE_URLS));
const BASES = ['https://example.test/', 'https://example.test/seongmo-blockblast/'];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('sw.js에는 PRECACHE 마커 줄이 한 쌍 있다', () => {
  const lines = SW_SOURCE.split('\n');
  assert.equal(lines.filter((line) => line === START_MARKER).length, 1);
  assert.equal(lines.filter((line) => line === END_MARKER).length, 1);
  assert.ok(lines.indexOf(START_MARKER) < lines.indexOf(END_MARKER));
});

test('sw.js는 문법 오류가 없고 생성 블록을 파싱할 수 있다', () => {
  const result = spawnSync(process.execPath, ['--check', SW_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const block = SW_SOURCE.slice(SW_SOURCE.indexOf(START_MARKER), SW_SOURCE.indexOf(END_MARKER));
  const { CACHE_VERSION, PRECACHE } = new Function(`${block}\nreturn { CACHE_VERSION, PRECACHE };`)();
  assert.match(CACHE_VERSION, /^[0-9a-f]{10}$/);
  assert.ok(Array.isArray(PRECACHE));
});

test('skipWaiting은 message 핸들러 안에서만 한 번 호출된다', () => {
  const code = stripComments(SW_SOURCE);
  assert.equal(code.match(/skipWaiting/g).length, 1);
  const handlerStart = code.indexOf("addEventListener('message'");
  assert.ok(handlerStart !== -1);
  const handlerEnd = code.indexOf('\n});', handlerStart);
  const position = code.indexOf('skipWaiting');
  assert.ok(position > handlerStart && position < handlerEnd);
});

test('sw.js에는 루트 절대 경로와 절대 URL 문자열이 없다', () => {
  const code = stripComments(SW_SOURCE);
  assert.doesNotMatch(code, /(['"`])\/[^'"`]*\1/, '루트 절대 경로 문자열');
  assert.doesNotMatch(code, /https?:\/\//, '절대 URL');
  const block = SW_SOURCE.slice(SW_SOURCE.indexOf(START_MARKER), SW_SOURCE.indexOf(END_MARKER));
  assert.doesNotMatch(block, /['"]\//);
});

class FakeCache {
  constructor(base) {
    this.base = base;
    this.entries = new Map();
    this.addAllRequests = [];
  }

  resolve(request) {
    return typeof request === 'string' ? new URL(request, this.base).href : request.url;
  }

  async addAll(requests) {
    this.addAllRequests.push(...requests);
    for (const request of requests) this.entries.set(request.url, new Response(`precached ${request.url}`));
  }

  async match(request, options = {}) {
    const target = new URL(this.resolve(request));
    for (const [url, response] of this.entries) {
      const candidate = new URL(url);
      if (options.ignoreSearch) candidate.search = target.search = '';
      // 실제 Cache처럼 매번 새 응답을 돌려줘 본문을 여러 번 읽을 수 있게 한다
      if (candidate.href === target.href) return response.clone();
    }
    return undefined;
  }

  async put(request, response) {
    this.entries.set(request.url, response);
  }
}

function loadWorker({ base = BASES[0], source = FIXTURE_SOURCE } = {}) {
  const listeners = new Map();
  const timers = [];
  const store = new Map();
  const state = { skipWaiting: 0, claim: 0, fetchCalls: [], fetchImpl: async () => { throw new Error('offline'); } };

  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache(base));
      return store.get(name);
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
  };
  // 실제 워커처럼 상대 URL을 sw.js 위치 기준으로 해석한다(Node의 Request는 절대 URL만 받는다)
  class WorkerRequest extends Request {
    constructor(input, init) {
      super(typeof input === 'string' ? new URL(input, base).href : input, init);
    }
  }
  const self = {
    location: new URL('sw.js', base),
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: () => { state.skipWaiting += 1; return Promise.resolve(); },
    clients: { claim: () => { state.claim += 1; return Promise.resolve(); } },
  };
  const context = vm.createContext({
    self,
    caches,
    Request: WorkerRequest,
    Response,
    URL,
    fetch: (request) => {
      state.fetchCalls.push(request);
      return state.fetchImpl(request);
    },
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: (id) => {
      if (timers[id]) timers[id].cleared = true;
    },
  });
  vm.runInContext(source, context, { filename: 'sw.js' });

  function dispatch(type, init = {}) {
    const waits = [];
    const event = {
      ...init,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => { event.response = promise; },
    };
    listeners.get(type)(event);
    return { event, settled: () => Promise.all(waits) };
  }

  const request = (path, extra = {}) => ({ url: new URL(path, base).href, method: 'GET', mode: 'no-cors', ...extra });
  return { dispatch, caches, store, state, timers, request, base, listeners };
}

for (const base of BASES) {
  const label = new URL(base).pathname;

  test(`install: 모든 사전 캐시 URL을 reload 요청으로 bb-<버전> 캐시에 넣는다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const { settled } = worker.dispatch('install');
    await settled();
    const cache = worker.store.get(CACHE_NAME);
    assert.ok(cache, `${CACHE_NAME} 캐시를 만든다`);
    assert.deepEqual(
      cache.addAllRequests.map((req) => req.url),
      PRECACHE_URLS.map((url) => new URL(url, base).href)
    );
    for (const req of cache.addAllRequests) assert.equal(req.cache, 'reload');
    assert.equal(worker.state.skipWaiting, 0, 'install에서 skipWaiting을 부르지 않는다');
  });

  test(`activate: 이전 bb- 캐시만 지우고 claim한다 (${label})`, async () => {
    const worker = loadWorker({ base });
    for (const name of ['bb-old', CACHE_NAME, 'bb-older', 'other-cache']) await worker.caches.open(name);
    const { settled } = worker.dispatch('activate');
    await settled();
    assert.deepEqual([...worker.store.keys()].sort(), [CACHE_NAME, 'other-cache']);
    assert.equal(worker.state.claim, 1);
    assert.equal(worker.state.skipWaiting, 0, 'activate에서 skipWaiting을 부르지 않는다');
  });

  test(`fetch: 탐색은 네트워크 우선이고 응답을 캐시에 쓰지 않는다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const network = new Response('fresh');
    worker.state.fetchImpl = async () => network;
    const cache = await worker.caches.open(CACHE_NAME);
    const { event } = worker.dispatch('fetch', { request: worker.request('', { mode: 'navigate' }) });
    assert.equal(await event.response, network);
    assert.equal(cache.entries.size, 0);
    assert.equal(worker.timers[0].ms, 3000);
    assert.ok(worker.timers[0].cleared, '응답이 오면 타임아웃을 정리한다');
  });

  test(`fetch: 탐색이 오프라인이면 쿼리와 무관하게 캐시된 index.html로 대체한다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const cache = await worker.caches.open(CACHE_NAME);
    cache.entries.set(new URL('index.html', base).href, new Response('cached index'));
    for (const path of ['', '?debug=1', '?utm=abc', 'index.html?x=1']) {
      const { event } = worker.dispatch('fetch', { request: worker.request(path, { mode: 'navigate' }) });
      assert.equal(await (await event.response).text(), 'cached index', path);
    }
  });

  test(`fetch: 네트워크가 3초 안에 답하지 않으면 캐시된 index.html을 쓴다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const cache = await worker.caches.open(CACHE_NAME);
    cache.entries.set(new URL('index.html', base).href, new Response('cached index'));
    worker.state.fetchImpl = () => new Promise(() => {});
    const { event } = worker.dispatch('fetch', { request: worker.request('', { mode: 'navigate' }) });
    assert.equal(worker.timers.length, 1);
    worker.timers[0].callback();
    assert.equal(await (await event.response).text(), 'cached index');
  });

  test(`fetch: 캐시도 네트워크도 없는 탐색은 네트워크 오류 응답이 된다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const { event } = worker.dispatch('fetch', { request: worker.request('', { mode: 'navigate' }) });
    assert.equal((await event.response).type, 'error');
  });

  test(`fetch: 정적 자산은 캐시 우선이다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const cache = await worker.caches.open(CACHE_NAME);
    cache.entries.set(new URL('src/main.js', base).href, new Response('cached js'));
    const { event } = worker.dispatch('fetch', { request: worker.request('src/main.js') });
    assert.equal(await (await event.response).text(), 'cached js');
    assert.equal(worker.state.fetchCalls.length, 0);
  });

  test(`fetch: 캐시에 없는 자산은 네트워크에서 받아 200 응답만 저장한다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const cache = await worker.caches.open(CACHE_NAME);
    const ok = { status: 200, type: 'basic', clone() { return this; } };
    const partial = { status: 206, type: 'basic', clone() { return this; } };
    const missing = { status: 404, type: 'basic', clone() { return this; } };
    const cases = [['assets/a.png', ok, true], ['assets/b.mp3', partial, false], ['assets/c.png', missing, false]];
    for (const [path, response, stored] of cases) {
      worker.state.fetchImpl = async () => response;
      const { event, settled } = worker.dispatch('fetch', { request: worker.request(path) });
      assert.equal(await event.response, response, path);
      await settled();
      assert.equal(cache.entries.has(new URL(path, base).href), stored, path);
    }
  });

  test(`fetch: 오프라인에서 캐시에 없는 자산 요청은 실패한다 (${label})`, async () => {
    const worker = loadWorker({ base });
    const { event } = worker.dispatch('fetch', { request: worker.request('assets/none.png') });
    await assert.rejects(event.response, /offline/);
  });

  test(`fetch: 교차 출처와 GET이 아닌 요청은 가로채지 않는다 (${label})`, () => {
    const worker = loadWorker({ base });
    const cases = [
      { url: 'https://script.google.com/macros/s/ID/exec?action=ping', method: 'GET', mode: 'cors' },
      { url: 'https://script.google.com/macros/s/ID/exec', method: 'POST', mode: 'cors' },
      { url: new URL('api/score', base).href, method: 'POST', mode: 'same-origin' },
      { url: new URL('', base).href, method: 'POST', mode: 'navigate' },
    ];
    for (const request of cases) {
      const { event } = worker.dispatch('fetch', { request });
      assert.equal(event.response, undefined, `${request.method} ${request.url}`);
    }
    assert.equal(worker.state.fetchCalls.length, 0);
  });
}

test('message: SKIP_WAITING일 때만 skipWaiting을 호출한다', () => {
  const worker = loadWorker();
  worker.dispatch('message', { data: { type: 'SOMETHING_ELSE' } });
  worker.dispatch('message', { data: null });
  worker.dispatch('message', {});
  assert.equal(worker.state.skipWaiting, 0);
  worker.dispatch('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(worker.state.skipWaiting, 1);
});
