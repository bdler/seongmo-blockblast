// 화면에 보이는 문자열은 이 파일 한 곳에서만 관리한다. 새 섹션은 아래에 추가한다.

// Canvas 연출(src/ui/effects.js)이 쓰는 문자열
export const ko = {
  fx: {
    combo: (count) => `콤보 ×${count}`,
    perfect: '퍼펙트!',
    scoreDelta: (delta) => `+${delta}`,
    praise: (lines) => (lines >= 4 ? '대단해요!' : lines === 3 ? '멋져요!' : lines === 2 ? '좋아요!' : ''),
  },
};
