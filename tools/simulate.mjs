// 코어 공개 API만으로 봇이 한 판을 끝까지 두게 해 밸런스를 점검하는 CLI.
// 사용법: node tools/simulate.mjs [--games N] [--seed S]
import {
  applyMove,
  canPlaceAnywhere,
  clearLines,
  createGame,
  createRng,
  findFullLines,
  generateTray,
  getShape,
  isBoardEmpty,
  listMoves,
  placeShape,
} from '../src/core/index.js';
import { BOARD_SIZE } from '../src/config.js';

const DEFAULT_GAMES = 100;
const DEFAULT_SEED = 1;
// 이 수에 도달하면 살아 있어도 판을 멈춘다(실행 시간 보호). 표에는 "capped"로 따로 센다
const MAX_MOVES = 1000;
const EARLY_END_MARKS = [10, 30, 100];

// 탐욕 봇의 평가 가중치: 남은 블록이 갇히지 않게 하는 것과 줄 제거가 우선이고,
// 그다음 고립된 빈칸과 빈칸/채운칸 경계를 줄인다
const WEIGHT_STUCK = 200;
const WEIGHT_LINE = 100;
const WEIGHT_PERFECT = 500;
const WEIGHT_ISOLATED = 12;
const WEIGHT_BOUNDARY = 1;
const TIE_JITTER = 0.01;

function parseArgs(argv) {
  const options = { games: DEFAULT_GAMES, seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i += 2) {
    const value = Number(argv[i + 1]);
    if (argv[i] === '--games' && Number.isInteger(value) && value > 0) options.games = value;
    else if (argv[i] === '--seed' && Number.isInteger(value)) options.seed = value;
    else {
      console.error('usage: node tools/simulate.mjs [--games N] [--seed S]');
      process.exit(1);
    }
  }
  return options;
}

// 빈칸의 위/아래/왼쪽/오른쪽 이웃이 모두 막힌(또는 보드 끝인) 칸 수와,
// 빈칸과 채운 칸이 맞닿은 경계 수를 센다. 둘 다 작을수록 빈 공간이 한 덩어리로 모여 있다
function measureHoles(board) {
  let isolated = 0;
  let boundary = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const empty = board[r][c] === 0;
      if (r + 1 < BOARD_SIZE && (board[r + 1][c] === 0) !== empty) boundary++;
      if (c + 1 < BOARD_SIZE && (board[r][c + 1] === 0) !== empty) boundary++;
      if (!empty) continue;
      const hasEmptyNeighbor =
        (r > 0 && board[r - 1][c] === 0) ||
        (r + 1 < BOARD_SIZE && board[r + 1][c] === 0) ||
        (c > 0 && board[r][c - 1] === 0) ||
        (c + 1 < BOARD_SIZE && board[r][c + 1] === 0);
      if (!hasEmptyNeighbor) isolated++;
    }
  }
  return { isolated, boundary };
}

function randomBot(state, rng) {
  return rng.pick(listMoves(state));
}

function greedyBot(state, rng) {
  let best = null;
  let bestScore = -Infinity;
  for (const move of listMoves(state)) {
    const shape = getShape(state.tray[move.trayIndex].shapeId);
    const placed = placeShape(state.board, shape, move.row, move.col, 1);
    const lines = findFullLines(placed);
    const cleared = lines.rows.length + lines.cols.length;
    const board = cleared > 0 ? clearLines(placed, lines).board : placed;
    const { isolated, boundary } = measureHoles(board);
    const stuck = state.tray.filter(
      (piece, i) => piece !== null && i !== move.trayIndex && !canPlaceAnywhere(board, getShape(piece.shapeId)),
    ).length;
    const score =
      cleared * WEIGHT_LINE -
      stuck * WEIGHT_STUCK +
      (cleared > 0 && isBoardEmpty(board) ? WEIGHT_PERFECT : 0) -
      isolated * WEIGHT_ISOLATED -
      boundary * WEIGHT_BOUNDARY +
      rng.next() * TIE_JITTER;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}

function playGame(bot, seed, trayTimes) {
  let state = createGame({ mode: 'classic', seed });
  const botRng = createRng(seed ^ 0x9e3779b9);
  while (state.status === 'playing' && state.moves < MAX_MOVES) {
    const move = bot(state, botRng);
    const result = applyMove(state, move.trayIndex, move.row, move.col);
    if (!result.ok) throw new Error(`bot made an invalid move: ${result.error}`);
    if (result.events.some((event) => event.type === 'trayRefill')) {
      // 리필에 쓰인 것과 같은 입력으로 generateTray만 따로 재서 생성 시간을 구한다
      const rng = createRng(state.rngState);
      const t0 = performance.now();
      generateTray({
        board: result.state.board,
        rng,
        mode: state.mode,
        seed: state.seed,
        trayIndex: result.state.trayIndex,
        score: result.state.score,
      });
      trayTimes.push(performance.now() - t0);
    }
    state = result.state;
  }
  return { state, capped: state.status === 'playing' };
}

const sum = (values) => values.reduce((total, v) => total + v, 0);
const mean = (values) => (values.length === 0 ? 0 : sum(values) / values.length);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function simulate(bot, games, seed) {
  const trayTimes = [];
  const results = Array.from({ length: games }, (_, i) => playGame(bot, seed + i, trayTimes));
  const states = results.map((result) => result.state);
  const share = (mark) =>
    (results.filter((r) => !r.capped && r.state.moves < mark).length / games) * 100;
  return {
    'games': games,
    'avg score': mean(states.map((s) => s.score)),
    'median score': median(states.map((s) => s.score)),
    'max score': Math.max(...states.map((s) => s.score)),
    'avg moves': mean(states.map((s) => s.moves)),
    'avg lines': mean(states.map((s) => s.lines)),
    'avg maxCombo': mean(states.map((s) => s.maxCombo)),
    ...Object.fromEntries(EARLY_END_MARKS.map((mark) => [`ended before move ${mark} (%)`, share(mark)])),
    [`capped at ${MAX_MOVES} moves`]: results.filter((r) => r.capped).length,
    'generateTray avg (ms)': mean(trayTimes),
    'generateTray worst (ms)': trayTimes.length === 0 ? 0 : Math.max(...trayTimes),
  };
}

function formatValue(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function printTable(columns) {
  const names = Object.keys(columns);
  const rows = Object.keys(columns[names[0]]);
  const labelWidth = Math.max(...rows.map((row) => row.length));
  const widths = names.map((name) => Math.max(name.length, 10));
  const line = (label, cells) =>
    [label.padEnd(labelWidth), ...cells.map((cell, i) => cell.padStart(widths[i]))].join('  ');
  console.log(line('', names));
  for (const row of rows) {
    console.log(line(row, names.map((name) => formatValue(columns[name][row]))));
  }
}

const { games, seed } = parseArgs(process.argv.slice(2));
const started = performance.now();
printTable({
  random: simulate(randomBot, games, seed),
  greedy: simulate(greedyBot, games, seed),
});
console.log(`\n${games} games per bot, seeds ${seed}..${seed + games - 1}, ${((performance.now() - started) / 1000).toFixed(1)}s`);
