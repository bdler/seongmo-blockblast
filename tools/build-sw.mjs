// sw.js의 PRECACHE 블록(캐시 버전 + 사전 캐시 목록)을 저장소 내용에서 다시 만든다.
// 사용법: node tools/build-sw.mjs [--check] [--root <dir>]
//   (기본)  sw.js의 마커 블록을 갱신한다. 이미 최신이면 아무것도 바꾸지 않는다.
//   --check 블록이 낡았으면 차이를 출력하고 종료 코드 1, 최신이면 0.
// 배포할 때마다 캐시 버전을 올리는 일을 사람이 아니라 파일 내용 해시가 맡는다.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const START_MARKER = '/* PRECACHE:START */';
export const END_MARKER = '/* PRECACHE:END */';

const ROOT_URL = './';
const INDEX_FILE = 'index.html';
const SW_FILE = 'sw.js';
// 배포되는 파일만 허용 목록으로 훑는다. tests, tools, docs, e2e, gas 등은 처음부터 보지 않는다
const SHIPPED_FILES = [INDEX_FILE, 'manifest.webmanifest'];
const SHIPPED_DIRS = ['styles', 'src', 'assets'];
const VERSION_LENGTH = 10;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function walk(root, relDir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, relDir), { withFileTypes: true });
  } catch {
    // 아직 없는 폴더는 건너뛴다(다른 작업자가 나중에 추가한다)
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/** 코드 유닛 순서로 정렬해 로캘이나 파일시스템 순서에 결과가 흔들리지 않게 한다 */
function sortPaths(paths) {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 사전 캐시 대상 파일을 모은다. 없는 파일/폴더는 조용히 건너뛰고, 점(.)으로 시작하는 이름은 제외한다.
 * @param {string} root 저장소 루트
 * @returns {string[]} 루트 기준 POSIX 상대 경로(정렬됨). './'는 포함하지 않는다
 */
export function collectFiles(root) {
  // 아직 없는 파일은 건너뛴다(다른 작업자가 나중에 추가한다)
  const found = SHIPPED_FILES.filter((file) => isFile(join(root, file)));
  for (const dir of SHIPPED_DIRS) walk(root, dir, found);
  return sortPaths(found);
}

/**
 * 캐시 버전: (경로 + 바이트) 전체의 sha256 앞 10자리. 배포 파일이 한 바이트라도 바뀌면 달라진다.
 * @param {string} root
 * @param {string[]} files collectFiles 결과
 * @returns {string}
 */
export function computeVersion(root, files) {
  const hash = createHash('sha256');
  for (const file of sortPaths(files)) {
    const bytes = readFileSync(join(root, file));
    // 길이를 함께 넣어 "a"+"bc"와 "ab"+"c" 같은 경계 모호함을 없앤다
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, VERSION_LENGTH);
}

/**
 * 파일 목록을 sw.js가 쓰는 URL 목록으로 바꾼다. index.html이 있을 때만 './'(디렉터리 요청)를 맨 앞에 둔다.
 * @param {string[]} files
 * @returns {string[]}
 */
export function toPrecacheUrls(files) {
  const urls = files.map((file) =>
    // 작은따옴표는 encodeURIComponent가 남겨 두므로 소스 문자열이 깨지지 않게 따로 인코딩한다
    file
      .split('/')
      .map((segment) => encodeURIComponent(segment).replace(/'/g, '%27'))
      .join('/')
  );
  return files.includes(INDEX_FILE) ? [ROOT_URL, ...urls] : urls;
}

/**
 * 마커 줄을 포함한 생성 블록 텍스트.
 * @param {string} version
 * @param {string[]} urls
 * @returns {string}
 */
export function renderBlock(version, urls) {
  const lines = urls.map((url) => `  '${url}',`);
  return [
    START_MARKER,
    `const CACHE_VERSION = '${version}';`,
    'const PRECACHE = [',
    ...lines,
    '];',
    END_MARKER,
  ].join('\n');
}

function markerRange(source) {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  const unique =
    start !== -1 &&
    end !== -1 &&
    start === source.lastIndexOf(START_MARKER) &&
    end === source.lastIndexOf(END_MARKER);
  if (!unique || start > end) {
    throw new Error(`sw.js에 ${START_MARKER} / ${END_MARKER} 마커가 한 쌍씩 있어야 한다`);
  }
  return { start, end: end + END_MARKER.length };
}

/**
 * sw.js 소스의 마커 사이만 새 블록으로 바꾼다. 마커 밖은 한 글자도 건드리지 않는다.
 * @param {string} source
 * @param {string} block renderBlock 결과
 * @returns {string}
 */
export function replaceBlock(source, block) {
  const { start, end } = markerRange(source);
  return source.slice(0, start) + block + source.slice(end);
}

/**
 * 소스에 들어 있는 블록에서 버전과 URL 목록을 읽는다(--check 차이 출력용).
 * @param {string} source
 * @returns {{ version: string, urls: string[] }}
 */
export function parseBlock(source) {
  const { start, end } = markerRange(source);
  const block = source.slice(start, end);
  const version = /CACHE_VERSION\s*=\s*['"]([^'"]*)['"]/.exec(block)?.[1] ?? '';
  const list = /PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? '';
  const urls = [...list.matchAll(/['"]([^'"]*)['"]/g)].map((match) => match[1]);
  return { version, urls };
}

/**
 * @param {{ version: string, urls: string[] }} current
 * @param {{ version: string, urls: string[] }} next
 * @returns {{ versionChanged: boolean, added: string[], removed: string[] }}
 */
export function diffBlocks(current, next) {
  const before = new Set(current.urls);
  const after = new Set(next.urls);
  return {
    versionChanged: current.version !== next.version,
    added: next.urls.filter((url) => !before.has(url)),
    removed: current.urls.filter((url) => !after.has(url)),
  };
}

/**
 * 저장소에서 새 블록을 계산한다.
 * @param {string} root
 * @returns {{ version: string, urls: string[], block: string }}
 */
export function buildBlock(root) {
  const files = collectFiles(root);
  const version = computeVersion(root, files);
  const urls = toPrecacheUrls(files);
  return { version, urls, block: renderBlock(version, urls) };
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {{ out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {number} 종료 코드
 */
export function main(argv, io = {}) {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  const check = argv.includes('--check');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1] ?? '');
  const swPath = join(root, SW_FILE);

  let source;
  try {
    source = readFileSync(swPath, 'utf8');
  } catch {
    err(`${SW_FILE}를 읽을 수 없다: ${swPath}`);
    return 2;
  }

  let next;
  let updated;
  try {
    next = buildBlock(root);
    updated = replaceBlock(source, next.block);
  } catch (error) {
    err(error.message);
    return 2;
  }

  const changed = updated !== source;
  if (check) {
    if (!changed) {
      out(`${SW_FILE}는 최신이다 (CACHE_VERSION ${next.version}, ${next.urls.length}개)`);
      return 0;
    }
    const current = parseBlock(source);
    const diff = diffBlocks(current, next);
    err(`${SW_FILE}의 PRECACHE 블록이 낡았다. node tools/build-sw.mjs 를 실행한다.`);
    if (diff.versionChanged) err(`  CACHE_VERSION: ${current.version} -> ${next.version}`);
    for (const url of diff.added) err(`  + ${url}`);
    for (const url of diff.removed) err(`  - ${url}`);
    return 1;
  }

  if (changed) writeFileSync(swPath, updated);
  out(
    `${SW_FILE} ${changed ? '갱신' : '변경 없음'}: CACHE_VERSION ${next.version}, ${next.urls.length}개`
  );
  return 0;
}

function isMainModule() {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.argv.slice(2));
}
