// 화면에 보이는 문자열은 이 파일 한 곳에서만 관리한다. 새 섹션은 아래에 추가한다.

// Canvas 연출(src/ui/effects.js)이 쓰는 문자열
export const ko = {
  fx: {
    combo: (count) => `콤보 ×${count}`,
    perfect: '퍼펙트!',
    scoreDelta: (delta) => `+${delta}`,
    praise: (lines) => (lines >= 4 ? '대단해요!' : lines === 3 ? '멋져요!' : lines === 2 ? '좋아요!' : ''),
  },

  // 상단 HUD(src/ui/screens.js)
  hud: {
    score: '점수',
    best: '최고',
    pause: '일시정지',
    combo: (count) => `콤보 ×${count}`,
  },

  home: {
    title: '블록 블라스트', // 공백 기준으로 줄을 나눠 로고로 그린다
    tagline: '줄을 채워 블록을 터뜨려요',
    best: '최고 기록',
    noBest: '아직 기록이 없어요',
    play: '시작하기',
    continue: '이어하기',
    howto: '게임 방법',
    settings: '설정',
    install: '앱 설치',
  },

  pause: {
    title: '일시정지',
    hint: '잠깐 쉬었다 가요',
    resume: '계속하기',
    restart: '다시 시작',
    settings: '설정',
    home: '홈으로',
  },

  gameover: {
    title: '게임 오버',
    hint: '더 놓을 곳이 없어요',
    score: '점수',
    best: '최고 기록',
    newBest: 'NEW BEST',
    stats: {
      lines: '지운 줄',
      maxCombo: '최대 콤보',
      moves: '이동',
    },
    retry: '다시 하기',
    home: '홈으로',
  },

  settings: {
    title: '설정',
    sound: '소리',
    volume: '볼륨',
    haptics: '진동',
    hapticsHint: '기기가 지원할 때만 진동해요',
    motion: '모션 줄이기',
    motionHint: '움직임과 효과를 줄여요',
    motionOptions: {
      auto: '자동',
      on: '켜기',
      off: '끄기',
    },
    howto: '게임 방법',
    on: '켜짐',
    off: '꺼짐',
    version: (version) => `버전 ${version}`,
    close: '닫기',
  },

  howto: {
    title: '게임 방법',
    steps: [
      { title: '끌어서 놓기', text: '아래 블록을 손가락으로 끌어 보드 위에 놓아요' },
      { title: '한 줄 채우기', text: '가로나 세로 한 줄을 가득 채우면 줄이 사라져요' },
      { title: '콤보 이어가기', text: '연속으로 줄을 지우면 콤보가 쌓여 점수가 쑥쑥 올라요' },
    ],
    start: '시작',
  },

  toast: {
    updateReady: '새 버전이 준비됐어요',
    update: '업데이트',
  },

  a11y: {
    board: '블록 퍼즐 보드',
    score: (score) => `점수 ${score}점`,
    newBest: '새로운 최고 기록이에요',
  },
};
