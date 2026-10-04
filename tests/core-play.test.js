import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SIZE, COLOR_COUNT, TRAY_SIZE } from '../src/config.js';
import { countFilled, findFullLines } from '../src/core/board.js';
import { generateTray } from '../src/core/generator.js';
import { applyMove, createGame, isGameOver, listMoves, previewMove, restoreGame } from '../src/core/game.js';
import { createRng } from '../src/core/rng.js';
import { getShape } from '../src/core/shapes.js';

const MAX_MOVES = 3000;
const EVENT_ORDER = ['place', 'clear', 'combo', 'comboBreak', 'perfect', 'score', 'trayRefill', 'gameover'];

const filledSlots = (tray) => tray.filter((slot) => slot !== null).length;

function assertValidBoard(board, label) {
  assert.equal(board.length, BOARD_SIZE, label);
  for (const row of board) {
    assert.equal(row.length, BOARD_SIZE, label);
    for (const cell of row) assert.ok(Number.isInteger(cell) && cell >= 0 && cell <= COLOR_COUNT, label);
  }
}

// 한 수가 끝난 뒤 상태/이벤트가 규칙을 지키는지 확인한다
function assertMoveInvariants(before, move, after, events, label) {
  const shape = getShape(before.tray[move.trayIndex].shapeId);
  const byType = Object.fromEntries(events.map((event) => [event.type, event]));

  // 이벤트는 정해진 순서로, 해당하는 것만 나온다
  const order = events.map((event) => EVENT_ORDER.indexOf(event.type));
  assert.ok(order.every((index) => index >= 0), label);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `${label}: 이벤트 순서`);
  assert.equal(new Set(order).size, order.length, `${label}: 이벤트 중복`);
  assert.equal(events[0].type, 'place', label);
  assert.ok(byType.score, label);

  assertValidBoard(after.board, label);
  assert.deepEqual(findFullLines(after.board), { rows: [], cols: [] }, `${label}: 가득 찬 줄이 남음`);

  // 점수는 줄어들지 않고 배치한 칸 수만큼은 반드시 늘어난다
  assert.ok(after.score >= before.score + shape.size, `${label}: 점수`);
  assert.equal(byType.score.delta, after.score - before.score, label);
  assert.equal(byType.score.total, after.score, label);
  const { place, clear, perfect } = byType.score.breakdown;
  assert.equal(place + clear + perfect, byType.score.delta, label);
  assert.equal(place, shape.size, label);

  const cleared = byType.clear ? byType.clear.lines : 0;
  assert.equal(after.moves, before.moves + 1, label);
  assert.equal(after.lines, before.lines + cleared, label);
  assert.equal(after.combo, cleared > 0 ? before.combo + 1 : 0, label);
  assert.equal(after.maxCombo, Math.max(before.maxCombo, after.combo), label);
  assert.equal(Boolean(byType.combo), cleared > 0, label);
  assert.equal(Boolean(byType.comboBreak), cleared === 0 && before.combo > 0, label);
  assert.equal(after.perfects, before.perfects + (byType.perfect ? 1 : 0), label);
  if (byType.perfect) {
    assert.equal(countFilled(after.board), 0, label);
    assert.ok(cleared > 0, label);
  }

  // 채워진 칸 수는 배치한 만큼 늘고 지운 만큼 준다
  const clearedCells = byType.clear ? byType.clear.cells.length : 0;
  assert.equal(countFilled(after.board), countFilled(before.board) + shape.size - clearedCells, label);

  // 트레이: 한 칸이 비고, 다 비면 리필되고 trayIndex가 1 오른다
  const wasLast = filledSlots(before.tray) === 1;
  assert.equal(Boolean(byType.trayRefill), wasLast, label);
  if (wasLast) {
    assert.equal(filledSlots(after.tray), TRAY_SIZE, label);
    assert.equal(after.trayIndex, before.trayIndex + 1, label);
  } else {
    assert.equal(after.trayIndex, before.trayIndex, label);
    assert.equal(after.tray[move.trayIndex], null, label);
    assert.equal(filledSlots(after.tray), filledSlots(before.tray) - 1, label);
  }

  // 게임오버는 새 상태에서 놓을 곳이 없을 때만, 그리고 마지막 이벤트로만 나온다
  const noMoves = listMoves({ ...after, status: 'playing' }).length === 0;
  assert.equal(after.status === 'over', noMoves, `${label}: 게임오버 판정`);
  assert.equal(Boolean(byType.gameover), after.status === 'over', label);
  if (byType.gameover) {
    assert.equal(events.at(-1).type, 'gameover', label);
    assert.deepEqual(byType.gameover, {
      type: 'gameover',
      score: after.score,
      stats: { lines: after.lines, maxCombo: after.maxCombo, moves: after.moves, perfects: after.perfects },
    });
  }
}

function playToEnd(options, botSeed) {
  let state = createGame(options);
  const rng = createRng(botSeed);
  const label = `${options.mode}/${options.seed}/bot${botSeed}`;
  let scoreSum = 0;
  let perfectEvents = 0;

  while (state.status === 'playing') {
    assert.ok(state.moves < MAX_MOVES, `${label}: ${MAX_MOVES}수 안에 끝나야 한다`);
    const moves = listMoves(state);
    assert.ok(moves.length > 0, `${label}: 진행 중인데 둘 곳이 없다`);
    assert.equal(isGameOver(state), false);

    const move = rng.pick(moves);
    const preview = previewMove(state, move.trayIndex, move.row, move.col);
    const result = applyMove(state, move.trayIndex, move.row, move.col);
    assert.equal(result.ok, true, label);

    // 미리보기와 실제 결과가 일치한다
    assert.equal(preview.valid, true, label);
    const clear = result.events.find((event) => event.type === 'clear');
    assert.deepEqual(preview.clearRows, clear ? clear.rows : [], label);
    assert.deepEqual(preview.clearCols, clear ? clear.cols : [], label);
    assert.deepEqual(preview.clearCells, clear ? clear.cells.map(({ r, c }) => [r, c]) : [], label);
    assert.deepEqual(preview.cells, result.events[0].cells, label);

    assertMoveInvariants(state, move, result.state, result.events, `${label} #${state.moves}`);
    scoreSum += result.state.score - state.score;
    perfectEvents += result.events.filter((event) => event.type === 'perfect').length;

    if (options.mode === 'daily' && result.state.trayIndex !== state.trayIndex) {
      assert.deepEqual(
        result.state.tray,
        generateTray({ mode: 'daily', seed: options.seed, trayIndex: result.state.trayIndex }),
        label,
      );
    }
    state = result.state;
  }

  assert.equal(state.score, scoreSum, label);
  assert.equal(state.perfects, perfectEvents, label);
  assert.deepEqual(listMoves(state), [], label);
  assert.equal(isGameOver(state), true, label);
  assert.equal(applyMove(state, 0, 0, 0).error, 'game_over', label);
  assert.deepEqual(restoreGame(JSON.parse(JSON.stringify(state))), state, label);
  return state;
}

test('무작위로 끝까지 두어도 규칙이 지켜지고 게임오버는 놓을 곳이 없을 때만 온다(classic 60판)', () => {
  const lengths = [];
  for (let seed = 1; seed <= 60; seed++) {
    lengths.push(playToEnd({ mode: 'classic', seed }, seed * 31).moves);
  }
  assert.ok(Math.max(...lengths) > 20, `가장 긴 판 ${Math.max(...lengths)}수`);
});

test('무작위로 끝까지 두어도 규칙이 지켜진다(daily 20판, 문자열 시드)', () => {
  for (let day = 1; day <= 20; day++) {
    playToEnd({ mode: 'daily', seed: `blockblast:2026-10-${String(day).padStart(2, '0')}` }, day * 17);
  }
});

test('줄을 지우는 수를 우선하는 수순에서도 불변식이 유지된다(콤보 경로 확인)', () => {
  // 지울 수 있으면 가장 많이 지우는 수를, 아니면 무작위 수를 둔다
  let clearingMoves = 0;
  let maxCombo = 0;
  for (let seed = 1; seed <= 40; seed++) {
    let state = createGame({ seed });
    const rng = createRng(seed);
    while (state.status === 'playing') {
      let best = [];
      let bestLines = 0;
      for (const move of listMoves(state)) {
        const { clearRows, clearCols } = previewMove(state, move.trayIndex, move.row, move.col);
        const lines = clearRows.length + clearCols.length;
        if (lines > bestLines) {
          bestLines = lines;
          best = [move];
        } else if (lines === bestLines && lines > 0) {
          best.push(move);
        }
      }
      const move = bestLines > 0 ? rng.pick(best) : rng.pick(listMoves(state));
      const result = applyMove(state, move.trayIndex, move.row, move.col);
      assertMoveInvariants(state, move, result.state, result.events, `clearing-first ${seed} #${state.moves}`);
      if (bestLines > 0) clearingMoves++;
      state = result.state;
    }
    maxCombo = Math.max(maxCombo, state.maxCombo);
  }
  assert.ok(clearingMoves >= 100, `줄을 지운 수 ${clearingMoves}`);
  assert.ok(maxCombo >= 2, `최대 콤보 ${maxCombo}`);
});
