/*
 * core 공개 API 계약. UI/모드 코드는 `src/core/index.js` 하나만 import한다.
 * core는 DOM/window/localStorage/Math.random/Date를 쓰지 않고, `../config.js`(순수 상수) 외에는 import하지 않는다.
 * 모든 함수는 순수하다: 입력(상태·보드·배열)을 수정하지 않고 새 값을 돌려준다. 좌표는 항상 [행, 열]이고 (0,0)이 좌상단이다.
 *
 * ── rng.js ──
 *   hashSeed(str) -> uint32                    FNV-1a(코드포인트 단위)
 *   seedToInt(seed: number|string) -> uint32   숫자는 `>>> 0`, 문자열은 hashSeed. 그 외는 TypeError
 *   mulberry32(seed) -> () => [0,1)
 *   createRng(seedOrState: number|string) -> { next(), int(maxExclusive), pick(arr), weightedIndex(weights), state() }
 *     state()는 uint32이며 createRng(rng.state())는 같은 흐름을 정확히 이어간다
 *
 * ── shapes.js ──
 *   SHAPES            id -> Shape (동결)
 *   SHAPE_LIST        Shape[] (동결, 카탈로그 순서, 37종, 회전 없이 방향별로 별도 모양)
 *   getShape(id)      Shape, 모르는 id면 Error
 *   hasShape(id)      boolean
 *
 * ── board.js ── (Board = number[8][8], 0 빈칸 / 1..COLOR_COUNT 색)
 *   createBoard() / cloneBoard(board)
 *   canPlace(board, shape, row, col)              boolean
 *   placeShape(board, shape, row, col, color)     새 Board (놓을 수 없으면 RangeError)
 *   findFullLines(board)                          { rows, cols } 오름차순. 지우기 전에 한꺼번에 찾는다
 *   clearLines(board, lines)                      { board, clearedCells: [{ r, c, color }] } 교차 칸은 한 번만, 행 우선 순서
 *   countFilled(board) / isBoardEmpty(board)
 *   canPlaceAnywhere(board, shape)                boolean
 *   listPlacements(board, shape)                  [[row, col], ...] 행 우선 순서
 *   hasAnyMove(board, shapes)                     boolean (null 슬롯은 무시)
 *
 * ── scoring.js ──
 *   scoreMove({ placedCells, linesCleared, combo, perfect }, cfg = SCORING) -> { total, place, clear, perfect, multiplier }
 *   nextCombo(prev, linesCleared) -> number
 *
 * ── generator.js ──
 *   generateTray({ board, rng, mode, seed, trayIndex, score, cfg }) -> TrayPiece[3]
 *   isTraySolvable(board, pieces, nodeBudget?) -> boolean
 *   weightsFor(board, score?, cfg?) -> number[]  (SHAPE_LIST 순서)
 *
 * ── game.js ──
 *   createGame({ mode = 'classic', seed = 1 }) -> GameState        mode: 'classic' | 'daily'
 *   applyMove(state, trayIndex, row, col) -> MoveResult
 *   previewMove(state, trayIndex, row, col) -> Preview
 *   listMoves(state) -> [{ trayIndex, row, col }]
 *   isGameOver(state) -> boolean
 *   restoreGame(saved) -> GameState | null
 *
 * 실패한 applyMove는 `{ ok: false, error, state(입력과 같은 객체), events: [] }`를 돌려주며
 * error는 'bad_args' | 'game_over' | 'empty_slot' | 'out_of_bounds' | 'overlap'이다.
 * previewMove의 `reason`도 같은 코드다.
 *
 * GameState는 순수 JSON이라 `JSON.stringify`로 저장하고 `restoreGame(JSON.parse(...))`로 복원한다.
 * 같은 (mode, seed)와 같은 수순이면 상태와 이벤트가 항상 똑같다.
 */

/**
 * 모양 하나(방향별로 별도). 동결된 객체다.
 * @typedef {object} Shape
 * @property {string} id 예: 'dot', 'h3', 'sq2', 'l5-tl'
 * @property {readonly (readonly [number, number])[]} cells [행, 열] 오프셋, 최소 행/열이 0이며 행 우선 순서
 * @property {number} width
 * @property {number} height
 * @property {number} size 칸 수
 * @property {'dot' | 'line' | 'square' | 'rect' | 'smallL' | 'bigL' | 'lTetro' | 'tee' | 'skew'} family
 */

/**
 * 보드. 0은 빈칸, 1~COLOR_COUNT는 색 번호(PALETTE[번호 - 1]).
 * @typedef {number[][]} Board
 */

/**
 * 트레이 슬롯에 놓인 블록.
 * @typedef {object} TrayPiece
 * @property {string} shapeId
 * @property {number} color 1~COLOR_COUNT
 */

/**
 * 게임 상태(순수 JSON). tray의 null은 이미 놓은 슬롯이다.
 * trayIndex는 현재 트레이의 번호로, 첫 트레이가 0이고 리필할 때마다 1씩 늘어난다.
 * rngState는 classic 모드의 난수 흐름이며 daily 모드는 트레이를 (seed, trayIndex)로만 만들어서 쓰지 않는다.
 * @typedef {object} GameState
 * @property {1} version
 * @property {'classic' | 'daily'} mode
 * @property {number | string} seed 만들 때 받은 값 그대로
 * @property {number} rngState
 * @property {Board} board
 * @property {(TrayPiece | null)[]} tray 길이 TRAY_SIZE
 * @property {number} trayIndex
 * @property {number} score
 * @property {number} combo 줄을 지운 연속 이동 횟수
 * @property {number} maxCombo
 * @property {number} lines 지금까지 지운 줄 수
 * @property {number} moves
 * @property {number} perfects
 * @property {'playing' | 'over'} status
 */

/**
 * applyMove가 돌려주는 이벤트. 아래 순서대로, 해당하는 것만 나온다.
 * `combo`는 줄을 지운 모든 이동에서 나오며(count >= 1) 언제 보여줄지는 UI가 정한다.
 * `comboBreak`는 콤보가 있던 상태에서 줄을 못 지운 이동에서만 나온다.
 * `perfect`는 줄을 지운 이동으로 보드가 완전히 비었을 때만 나온다.
 * `trayRefill`은 세 번째 블록을 놓아 트레이가 비었을 때 나오고, `gameover`는 리필 이후 둘 곳이 없을 때 마지막에 나온다.
 * @typedef {{ type: 'place', shapeId: string, color: number, cells: [number, number][] }
 *   | { type: 'clear', rows: number[], cols: number[], cells: { r: number, c: number, color: number }[], lines: number }
 *   | { type: 'combo', count: number, multiplier: number }
 *   | { type: 'comboBreak', previous: number }
 *   | { type: 'perfect', bonus: number }
 *   | { type: 'score', delta: number, total: number, breakdown: { place: number, clear: number, perfect: number } }
 *   | { type: 'trayRefill', tray: TrayPiece[] }
 *   | { type: 'gameover', score: number, stats: { lines: number, maxCombo: number, moves: number, perfects: number } }
 * } GameEvent
 */

/**
 * applyMove의 결과. 실패하면 ok=false이고 state는 입력 그대로, events는 빈 배열이다.
 * @typedef {{ ok: true, state: GameState, events: GameEvent[] }
 *   | { ok: false, error: 'bad_args' | 'game_over' | 'empty_slot' | 'out_of_bounds' | 'overlap', state: GameState, events: [] }
 * } MoveResult
 */

/**
 * previewMove의 결과(고스트/줄 강조용).
 * cells는 놓일 절대 좌표이고(유효하지 않아도 모양을 알면 채워지며 보드 밖일 수 있다),
 * clearCells는 지워질 모든 칸(기존 칸과 새로 놓는 칸 모두, 행 우선 순서)이다.
 * @typedef {object} Preview
 * @property {boolean} valid
 * @property {'bad_args' | 'game_over' | 'empty_slot' | 'out_of_bounds' | 'overlap'} [reason] valid가 false일 때만
 * @property {[number, number][]} cells
 * @property {number[]} clearRows
 * @property {number[]} clearCols
 * @property {[number, number][]} clearCells
 */

export {};
