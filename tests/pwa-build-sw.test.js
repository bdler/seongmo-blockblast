import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  END_MARKER,
  START_MARKER,
  buildBlock,
  collectFiles,
  computeVersion,
  diffBlocks,
  main,
  parseBlock,
  renderBlock,
  replaceBlock,
  toPrecacheUrls,
} from '../tools/build-sw.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(REPO_ROOT, 'tools', 'build-sw.mjs');
const REAL_SW = readFileSync(join(REPO_ROOT, 'sw.js'), 'utf8');

const tempDirs = [];

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'bb-sw-'));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const SHIPPED = {
  'index.html': '<!doctype html>',
  'manifest.webmanifest': '{}',
  'styles/main.css': 'body{}',
  'src/main.js': 'export {};',
  'src/core/game.js': 'export {};',
  'src/data/levels.json': '[]',
  'assets/icons/icon-192.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
  'assets/sounds/pop.mp3': Buffer.from([0xff, 0xfb, 0x90]),
};

const FORBIDDEN = {
  'sw.js': '// sw',
  'package.json': '{}',
  'README.md': '# readme',
  '.nojekyll': '',
  '.gitignore': 'x',
  '.github/workflows/ci.yml': 'on: push',
  'tests/pwa-x.test.js': '// test',
  'tools/build-sw.mjs': '// tool',
  'docs/DEVELOPMENT_GUIDE.md': '# doc',
  'e2e/run.mjs': '// e2e',
  'gas/Code.gs': '// gas',
  'src/.hidden.js': '// hidden',
  'src/.cache/x.js': '// hidden dir',
  'assets/.DS_Store': 'x',
};

test('collectFiles는 배포 파일만 정렬해서 돌려주고 금지 경로를 제외한다', () => {
  const root = makeTree({ ...FORBIDDEN, ...SHIPPED });
  assert.deepEqual(collectFiles(root), [
    'assets/icons/icon-192.png',
    'assets/sounds/pop.mp3',
    'index.html',
    'manifest.webmanifest',
    'src/core/game.js',
    'src/data/levels.json',
    'src/main.js',
    'styles/main.css',
  ]);
});

test('collectFiles는 아직 없는 파일과 폴더가 있어도 실패하지 않는다', () => {
  assert.deepEqual(collectFiles(makeTree({})), []);
  assert.deepEqual(collectFiles(makeTree({ 'src/a.js': 'a' })), ['src/a.js']);
});

test('파일을 만든 순서가 달라도 목록과 버전이 같다', () => {
  const entries = Object.entries(SHIPPED);
  const forward = makeTree(Object.fromEntries(entries));
  const backward = makeTree(Object.fromEntries([...entries].reverse()));
  const filesA = collectFiles(forward);
  const filesB = collectFiles(backward);
  assert.deepEqual(filesA, filesB);
  assert.equal(computeVersion(forward, filesA), computeVersion(backward, filesB));
});

test('computeVersion은 10자리 hex이고 같은 내용이면 같다', () => {
  const rootA = makeTree(SHIPPED);
  const rootB = makeTree(SHIPPED);
  const version = computeVersion(rootA, collectFiles(rootA));
  assert.match(version, /^[0-9a-f]{10}$/);
  assert.equal(version, computeVersion(rootB, collectFiles(rootB)));
});

test('computeVersion은 파일 바이트가 하나만 달라져도 바뀐다', () => {
  const root = makeTree(SHIPPED);
  const files = collectFiles(root);
  const before = computeVersion(root, files);
  writeFileSync(join(root, 'assets/icons/icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 3]));
  assert.notEqual(computeVersion(root, files), before);
});

test('computeVersion은 경로 변경과 파일 경계 이동도 구분한다', () => {
  const original = makeTree({ 'src/a.js': 'x', 'src/b.js': 'y' });
  const renamed = makeTree({ 'src/a.js': 'x', 'src/c.js': 'y' });
  const shifted = makeTree({ 'src/a.js': 'xy', 'src/b.js': '' });
  const versionOf = (root) => computeVersion(root, collectFiles(root));
  assert.notEqual(versionOf(original), versionOf(renamed));
  assert.notEqual(versionOf(original), versionOf(shifted));
});

test('배포 대상이 아닌 파일은 버전에 영향을 주지 않는다', () => {
  const root = makeTree({ ...SHIPPED, ...FORBIDDEN });
  const before = buildBlock(root).version;
  writeFileSync(join(root, 'tests/pwa-x.test.js'), '// changed');
  writeFileSync(join(root, 'sw.js'), '// changed');
  writeFileSync(join(root, 'docs/DEVELOPMENT_GUIDE.md'), '# changed');
  assert.equal(buildBlock(root).version, before);
});

test('toPrecacheUrls는 index.html이 있을 때만 ./를 맨 앞에 둔다', () => {
  assert.deepEqual(toPrecacheUrls(['index.html', 'src/a.js']), ['./', 'index.html', 'src/a.js']);
  assert.deepEqual(toPrecacheUrls(['src/a.js']), ['src/a.js']);
  assert.deepEqual(toPrecacheUrls([]), []);
});

test('toPrecacheUrls는 URL로 안전하게 인코딩하고 루트 절대 경로를 만들지 않는다', () => {
  const urls = toPrecacheUrls(['assets/sounds/my pop.mp3', "assets/it's.png", 'assets/효과음.ogg']);
  assert.deepEqual(urls, [
    'assets/sounds/my%20pop.mp3',
    'assets/it%27s.png',
    `assets/${encodeURIComponent('효과음')}.ogg`,
  ]);
  for (const url of urls) assert.ok(!url.startsWith('/') && !url.includes("'"));
});

test('renderBlock은 마커로 감싼 유효한 자바스크립트를 만든다', () => {
  const urls = ['./', 'index.html', 'assets/it%27s.png'];
  const block = renderBlock('0123456789', urls);
  const lines = block.split('\n');
  assert.equal(lines[0], START_MARKER);
  assert.equal(lines.at(-1), END_MARKER);
  assert.ok(block.includes("const CACHE_VERSION = '0123456789';"));
  const evaluated = new Function(`${block}\nreturn { CACHE_VERSION, PRECACHE };`)();
  assert.equal(evaluated.CACHE_VERSION, '0123456789');
  assert.deepEqual(evaluated.PRECACHE, urls);
});

test('replaceBlock은 마커 사이만 바꾸고 두 번 해도 결과가 같다', () => {
  const next = renderBlock('aaaaaaaaaa', ['./', 'index.html']);
  const once = replaceBlock(REAL_SW, next);
  assert.equal(replaceBlock(once, next), once);
  const [headBefore, rest] = REAL_SW.split(START_MARKER);
  const tailBefore = rest.split(END_MARKER)[1];
  assert.ok(once.startsWith(headBefore + next));
  assert.ok(once.endsWith(tailBefore));
});

test('replaceBlock은 마커가 없거나 중복이거나 거꾸로면 던진다', () => {
  const block = renderBlock('aaaaaaaaaa', []);
  assert.throws(() => replaceBlock('const a = 1;', block), /마커/);
  assert.throws(() => replaceBlock(`${START_MARKER}\n${START_MARKER}\n${END_MARKER}`, block), /마커/);
  assert.throws(() => replaceBlock(`${END_MARKER}\n${START_MARKER}`, block), /마커/);
});

test('parseBlock과 diffBlocks는 버전과 목록 차이를 알려준다', () => {
  const current = parseBlock(replaceBlock(REAL_SW, renderBlock('1111111111', ['./', 'a.js', 'b.js'])));
  assert.deepEqual(current, { version: '1111111111', urls: ['./', 'a.js', 'b.js'] });
  const diff = diffBlocks(current, { version: '2222222222', urls: ['./', 'b.js', 'c.js'] });
  assert.deepEqual(diff, { versionChanged: true, added: ['c.js'], removed: ['a.js'] });
  assert.equal(diffBlocks(current, current).versionChanged, false);
});

test('실제 저장소에서 계산한 목록에도 금지 경로가 없다', () => {
  const { urls } = buildBlock(REPO_ROOT);
  const forbidden = /^(sw\.js|package\.json|tests\/|tools\/|docs\/|e2e\/|gas\/|\.[^/]|.*\/\.)/;
  for (const url of urls) {
    assert.ok(!forbidden.test(url), `${url}은 사전 캐시 대상이 아니다`);
    assert.ok(!url.startsWith('/'), `${url}은 상대 경로여야 한다`);
  }
});

function runCli(root, ...args) {
  return spawnSync(process.execPath, [TOOL, '--root', root, ...args], { encoding: 'utf8' });
}

test('CLI: 갱신은 멱등이고 --check는 낡았을 때만 1을 돌려준다', () => {
  const root = makeTree({ ...SHIPPED, 'sw.js': REAL_SW });
  const swPath = join(root, 'sw.js');

  const stale = runCli(root, '--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /CACHE_VERSION/);
  assert.equal(readFileSync(swPath, 'utf8'), REAL_SW, '--check는 파일을 바꾸지 않는다');

  const first = runCli(root);
  assert.equal(first.status, 0);
  const generated = readFileSync(swPath, 'utf8');
  assert.notEqual(generated, REAL_SW);
  assert.ok(generated.includes(`const CACHE_VERSION = '${buildBlock(root).version}';`));

  const second = runCli(root);
  assert.equal(second.status, 0);
  assert.equal(readFileSync(swPath, 'utf8'), generated, '두 번째 실행은 아무것도 바꾸지 않는다');

  const fresh = runCli(root, '--check');
  assert.equal(fresh.status, 0);
  assert.equal(readFileSync(swPath, 'utf8'), generated);
});

test('CLI: 배포 파일이 바뀌면 --check가 새 URL과 버전 변화를 출력한다', () => {
  const root = makeTree({ ...SHIPPED, 'sw.js': REAL_SW });
  assert.equal(runCli(root).status, 0);
  writeFileSync(join(root, 'src/extra.js'), 'export {};');
  const result = runCli(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\+ src\/extra\.js/);
  assert.match(result.stderr, /CACHE_VERSION: [0-9a-f]{10} -> [0-9a-f]{10}/);

  writeFileSync(join(root, 'src/extra.js'), 'export const a = 1;');
  assert.equal(runCli(root, '--check').status, 1, '내용만 바뀌어도 낡은 것으로 본다');
  assert.equal(runCli(root).status, 0);
  assert.equal(runCli(root, '--check').status, 0);
});

test('CLI: sw.js가 없거나 마커가 없으면 2로 끝난다', () => {
  assert.equal(runCli(makeTree(SHIPPED)).status, 2);
  assert.equal(runCli(makeTree({ ...SHIPPED, 'sw.js': '// no markers' })).status, 2);
});

test('main은 입출력을 주입받아 종료 코드를 돌려준다', () => {
  const root = makeTree({ ...SHIPPED, 'sw.js': REAL_SW });
  const lines = [];
  const code = main(['--check', '--root', root], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes('낡았다')));
});
