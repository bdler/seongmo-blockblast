// 밸런스·상수는 이 파일 한 곳에서만 바꾼다. 섹션 단위로 나누어 두었으니 새 항목은 해당 섹션 아래에 추가한다.

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

// === 앱 ===

// 배포마다 올린다(서버의 minVersion 검사에 사용)
export const APP_VERSION = '0.1.0';

// === 보드 / 트레이 ===

export const BOARD_SIZE = 8;
export const TRAY_SIZE = 3;
export const COLOR_COUNT = 7;

// 색 번호(1~COLOR_COUNT)의 색은 PALETTE[번호 - 1]
export const PALETTE = deepFreeze([
  '#ff5c6c',
  '#ff9a3c',
  '#ffd23f',
  '#3ddc84',
  '#2ec5ff',
  '#5b7cff',
  '#b86bff',
]);

// === 점수 ===

export const SCORING = deepFreeze({
  cellPoint: 1, // 배치한 칸 하나당 점수
  lineBase: 10, // 줄 제거 점수 = lineBase × L² × 콤보 배율
  comboStep: 0.5, // 콤보가 1 늘 때마다 배율에 더하는 값
  maxMultiplier: 5, // 콤보 배율 상한
  perfectBonus: 300, // 보드를 완전히 비웠을 때 보너스
});

// === 블록 생성 ===

export const GENERATOR = deepFreeze({
  maxRerolls: 12, // 해결 불가능한 조합을 버리고 다시 뽑는 최대 횟수
  nodeBudget: 1500, // 해결 가능성 DFS가 방문할 수 있는 최대 노드 수(초과하면 해결 가능으로 간주)
  fallbackAttempts: 6, // 작은 블록 폴백에서 해결 가능한 조합을 찾아볼 횟수

  // 계열별 기본 비중. 계열 전체의 합이며 계열 안의 모양끼리는 균등하게 나눈다
  familyWeights: {
    dot: 0.5,
    line: 3,
    square: 0.6,
    rect: 0.5,
    smallL: 1.6,
    bigL: 0.4,
    lTetro: 1.6,
    tee: 1,
    skew: 1,
  },

  bigMinSize: 5, // 이 칸 수 이상이면 큰 블록
  smallMaxSize: 3, // 이 칸 수 이하이면 작은 블록

  // 보드 채움 비율(채운 칸 / 전체 칸)에 따른 큰/작은 블록 가중치 배수
  fill: {
    low: 0.3,
    high: 0.6,
    lowBigMul: 2,
    lowSmallMul: 0.5,
    highBigMul: 0.1,
    highSmallMul: 3,
  },

  // 점수가 높아질수록 가중치를 키우는 까다로운 계열과, 점수 구간별 배수
  hardFamilies: ['skew', 'bigL'],
  scoreTiers: [
    { minScore: 0, hardMul: 0.6 },
    { minScore: 1000, hardMul: 1 },
    { minScore: 3000, hardMul: 2 },
    { minScore: 6000, hardMul: 3.5 },
  ],
});
