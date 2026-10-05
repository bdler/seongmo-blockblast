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

// === UI (Canvas 레이아웃/입력) ===

// 길이 단위는 따로 적지 않으면 "보드 한 칸 크기"의 배수다(화면이 달라져도 비율이 유지된다)
export const UI = deepFreeze({
  marginRatio: 0.03, // 캔버스 짧은 변 대비 바깥 여백
  marginMin: 8, // px
  marginMax: 20, // px
  maxCell: 84, // px. 태블릿/데스크톱에서 보드가 지나치게 커지지 않게 하는 상한
  trayGapCells: 0.5, // 보드와 트레이 사이
  slotGapCells: 0.25, // 트레이 슬롯 사이
  portraitSlotHeightCells: 3,
  landscapeSlotWidthCells: 3.2,
  verticalBias: 0.3, // 세로로 남는 공간 중 위쪽에 두는 비율(보드를 위로 붙이고 아래를 더 비운다)
  trayCellRatio: 0.6, // 트레이 블록의 칸 크기(슬롯에 안 맞으면 더 줄어든다)
  slotPadCells: 0.2, // 슬롯 안쪽 여백
  fingerOffsetCells: { touch: 1.6, pen: 0.6, mouse: 0 }, // 블록을 포인터보다 위에 그리는 거리
  dragScale: 1.04, // 들어 올린 블록의 확대(보드 칸 크기 대비)
  snapHysteresis: 0.08, // 칸 경계에서 고스트가 떨리지 않게 하는 여유(칸)
  cellGapRatio: 0.045, // 칸 사이 간격(칸 크기 대비). 기기 픽셀로 반올림한다
  cellGapMin: 2, // 기기 픽셀
  blockRadius: 0.22, // 블록 모서리 반경(칸 크기 대비)
  emptyRadius: 0.18, // 빈 칸 모서리 반경
  wellPadCells: 0.12, // 보드 우물이 격자 밖으로 나오는 두께
  wellRadiusCells: 0.35,
  slotRadiusCells: 0.3,
});

// === 애니메이션(ms) ===

export const ANIM = deepFreeze({
  pickupMs: 90, // 트레이 → 드래그 크기로 커지는 시간
  returnMs: 240, // 잘못 놓았을 때 트레이로 돌아가는 시간
  placeMs: 260, // 놓은 칸이 눌렸다 펴지는 시간
  placeSquash: 0.16, // 놓는 순간의 찌그러짐 정도
  trayInMs: 340,
  trayInStaggerMs: 70,
  clearLockMs: 180, // 줄을 지운 직후 입력을 잠그는 시간
  clearFlashMs: 70, // 흰색으로 번쩍이는 시간
  clearShrinkMs: 260, // 줄어들며 사라지는 시간
  clearFlashScale: 0.05, // 번쩍일 때 칸이 부푸는 정도(너무 크면 옆 칸과 붙어 흰 띠가 된다)
  clearStaggerMs: 22, // 놓은 자리에서 칸 하나 멀어질 때마다 늘어나는 지연
  lineFlashMs: 300, // 지워지는 줄 전체에 퍼지는 빛
  previewPulseMs: 640, // 지워질 줄 강조가 한 번 깜빡이는 주기
  overDimDelayMs: 380, // 게임오버 직후 마지막 연출을 보여 주고 어두워지기까지
  overDimMs: 450,
  reducedFadeMs: 160, // reducedMotion에서 쓰는 단순 페이드
  maxFrameMs: 50, // 탭이 숨겨졌다 돌아와도 한 프레임에 이만큼만 진행
});

// === 이펙트 ===

export const EFFECTS = deepFreeze({
  maxParticles: 320,
  burstBudget: 180, // 한 번의 줄 제거에서 쓸 파티클 수(칸이 많으면 칸당 수를 줄인다)
  perCellMin: 2,
  perCellMax: 6,
  speedMin: 2.5, // 칸/초
  speedMax: 7.5,
  gravity: 16, // 칸/초²
  airDrag: 1.6, // 초당 속도 감쇠
  lifeMinMs: 420,
  lifeMaxMs: 860,
  sizeMin: 0.1, // 칸
  sizeMax: 0.26,
  sparkleChance: 0.28, // 흰 반짝이 비율
  maxTexts: 8,
  textRiseCells: 1.1,
  textPopMs: 140,
  textFadeStart: 0.68, // 수명의 이 지점부터 사라진다
  textDelayMs: 50,
  text: {
    praiseCells: 0.95,
    comboCells: 1.1,
    perfectCells: 1.7,
    scoreCells: 0.62,
    scoreSmallCells: 0.46, // 줄을 못 지운 이동의 점수
    stackRiseCells: 0.5, // 칭찬/콤보/퍼펙트 글자가 떠오르는 거리
    praiseLifeMs: 1000,
    comboLifeMs: 1000,
    perfectLifeMs: 1700,
    scoreLifeMs: 800,
    scoreSmallLifeMs: 560,
    outlineRatio: 0.2, // 글자 크기 대비 외곽선 두께
    weight: 900,
  },
  shake: {
    baseCells: 0.035,
    perLineCells: 0.03,
    maxCells: 0.2,
    perfectCells: 0.22,
    durationMs: 300,
    freqHz: 26,
  },
  perfect: {
    shimmerMs: 1200,
    shimmerAlpha: 0.55,
    sparkleCount: 90,
  },
});

// === 테마 ===

// 디자인 토큰 표. CSS와 같은 값을 쓰는 공유 토큰(pageBackground, themeColor, text, muted, success 등)도 함께 둔다.
// 캔버스는 투명하게 두고 페이지 배경을 비춘다
export const THEMES = deepFreeze({
  default: {
    pageBackground: { top: '#1a2060', bottom: '#0b0e2a' },
    themeColor: '#10143a',
    panel: 'rgba(255,255,255,0.06)',
    panelBorder: 'rgba(255,255,255,0.05)',
    well: '#0d1030',
    wellBorder: 'rgba(255,255,255,0.08)',
    cell: '#1b2152',
    cellAlt: '#1e2557',
    text: '#f4f6ff',
    muted: '#9aa3d6',
    accent: '#ffcf3f',
    danger: '#ff5c6c',
    success: '#3ddc84',
    textOutline: '#0b0e2a',
    flash: '#ffffff',
    dim: 'rgba(8,10,30,0.55)',
    fontFamily: '"Pretendard", system-ui, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
    fx: {
      praise: '#ffcf3f',
      combo: '#ff9a3c',
      perfect: '#ffffff',
      score: '#f4f6ff',
      scoreSmall: '#c9d0ff',
    },
  },
});
