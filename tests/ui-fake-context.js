// 캔버스 2D 컨텍스트 대역: 호출을 기록하고, 속성 대입은 저장하며, save/restore로 속성을 되돌린다.
export function createFakeContext() {
  const calls = [];
  const state = {};
  const stack = [];
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => {
        calls.push([prop, ...args]);
        if (prop === 'save') stack.push({ ...target });
        if (prop === 'restore' && stack.length > 0) {
          for (const key of Object.keys(target)) delete target[key];
          Object.assign(target, stack.pop());
        }
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return { addColorStop() {} };
        if (prop === 'measureText') return { width: String(args[0]).length * 10 };
        return undefined;
      };
    },
    set(target, prop, value) {
      calls.push([`set:${String(prop)}`, value]);
      target[prop] = value;
      return true;
    },
  });
  return { ctx, calls };
}

export function countCalls(calls, name) {
  return calls.filter((call) => call[0] === name).length;
}

// 캔버스 팩토리 대역: 만든 캔버스를 모두 기록하고, 각 캔버스는 자기 컨텍스트의 호출 기록을 가진다.
export function createFakeCanvasFactory() {
  const canvases = [];
  const createCanvas = (width, height) => {
    const fake = createFakeContext();
    const canvas = { width, height, getContext: () => fake.ctx, calls: fake.calls };
    canvases.push(canvas);
    return canvas;
  };
  return { createCanvas, canvases };
}

// 스프라이트 캔버스에 그려진 글자(fillText의 첫 인자)
export function labelOf(canvas) {
  const call = canvas.calls.find((entry) => entry[0] === 'fillText');
  return call ? call[1] : null;
}
