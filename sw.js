// 서비스 워커. 클래식 스크립트이며 모든 URL은 이 파일 기준 상대 경로라 하위 경로 배포에서도 동작한다.
// 아래 PRECACHE 블록은 tools/build-sw.mjs가 생성한다. 손으로 고치지 않는다.

/* PRECACHE:START */
const CACHE_VERSION = '73844ab3b4';
const PRECACHE = [
  'assets/icons/apple-touch-icon.png',
  'assets/icons/favicon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/icons/icon.svg',
  'manifest.webmanifest',
  'src/config.js',
  'src/core/board.js',
  'src/core/game.js',
  'src/core/generator.js',
  'src/core/index.js',
  'src/core/rng.js',
  'src/core/scoring.js',
  'src/core/shapes.js',
  'src/core/types.js',
  'src/pwa.js',
  'src/services/audio.js',
  'src/services/haptics.js',
  'src/services/storage.js',
];
/* PRECACHE:END */

const CACHE_NAME = 'bb-' + CACHE_VERSION;
const INDEX_URL = 'index.html';
const NAVIGATION_TIMEOUT_MS = 3000;

// 설치만 하고 대기한다. 플레이 중 갑자기 교체되지 않도록 skipWaiting은 페이지의 요청(message)으로만 호출한다
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 브라우저 HTTP 캐시에 남은 옛 파일이 새 캐시에 섞이지 않게 항상 서버에서 받는다
      return cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => {
        return Promise.all(
          names
            .filter((name) => name.startsWith('bb-') && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // 점수 제출용 GAS 등 교차 출처 요청과 GET이 아닌 요청은 가로채지 않는다(캐시되면 안 된다)
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    request.mode === 'navigate' ? handleNavigation(request) : handleAsset(event, request)
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 탐색 응답은 캐시에 쓰지 않는다. 새 index.html이 옛 캐시의 스크립트와 섞이는 것을 막기 위해서다
async function handleNavigation(request) {
  let timerId;
  const timeout = new Promise((resolve) => {
    timerId = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
  });
  const network = fetch(request).catch(() => null);
  const response = await Promise.race([network, timeout]);
  clearTimeout(timerId);
  if (response) {
    return response;
  }
  const cache = await caches.open(CACHE_NAME);
  // 쿼리(?debug=1, ?utm=...)가 붙어도 같은 index.html을 쓴다
  const fallback = await cache.match(INDEX_URL, { ignoreSearch: true });
  // 캐시가 비어 있으면 느리더라도 네트워크 결과를 끝까지 기다린다
  return fallback || (await network) || Response.error();
}

async function handleAsset(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  // 206(부분 응답)은 cache.put이 거부하므로 완전한 200 응답만 저장한다
  if (response.status === 200 && response.type === 'basic') {
    // 저장은 응답 전달을 막지 않는다. 저장 실패(용량 부족 등)도 요청 자체를 실패시키지 않는다
    event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
  }
  return response;
}
