// 드래그 입력: Pointer Events로 마우스/터치/펜을 통일해서 트레이 블록을 집어 보드에 놓는다.
// 렌더러 호출(setDrag/setPreview/returnToTray)까지 이 모듈이 맡고, 게임 규칙은 core의 previewMove로만 판정한다.
import { previewMove } from '../core/index.js';

/**
 * @typedef {import('../core/types.js').GameState} GameState
 * @typedef {object} InputOptions
 * @property {HTMLCanvasElement} canvas
 * @property {ReturnType<typeof import('./renderer.js').createRenderer>} renderer
 * @property {() => GameState | null} getState
 * @property {() => boolean} isLocked 연출 중 입력을 잠가야 하면 true
 * @property {(trayIndex: number) => void} [onPickup]
 * @property {(move: { trayIndex: number, row: number, col: number }) => void} [onDrop] core가 유효하다고 한 위치에서만 호출
 * @property {(info: { trayIndex: number, overBoard: boolean }) => void} [onInvalidDrop] 이미 블록을 트레이로 돌려보낸 뒤에 호출
 * @property {() => void} [onCancel]
 */

/**
 * @param {InputOptions} options
 * @returns {{ destroy(): void }}
 */
export function createInput({ canvas, renderer, getState, isLocked, onPickup, onDrop, onInvalidDrop, onCancel }) {
  const doc = canvas.ownerDocument;
  const view = doc.defaultView;

  /** @type {{ pointerId: number, trayIndex: number, pointerType: string, x: number, y: number } | null} */
  let active = null;
  let frameId = 0;
  let computedThisFrame = false;
  let pending = false;
  let hasPreview = false;
  let lastState = null;
  let lastTray = -1;
  let lastRow = 0;
  let lastCol = 0;

  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  canvas.style.webkitUserSelect = 'none';
  canvas.style.webkitTouchCallout = 'none';

  function toCanvas(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function currentDrag() {
    return { trayIndex: active.trayIndex, x: active.x, y: active.y, pointerType: active.pointerType };
  }

  function clearPreview() {
    if (hasPreview) renderer.setPreview(null);
    hasPreview = false;
    lastState = null;
  }

  // 고스트/줄 강조는 칸이 바뀔 때만 다시 계산한다
  function updatePreview() {
    const state = getState();
    if (active === null || state === null) return;
    const anchor = renderer.anchorForDrag(currentDrag());
    if (anchor === null) {
      clearPreview();
      return;
    }
    if (hasPreview && state === lastState && active.trayIndex === lastTray && anchor.row === lastRow && anchor.col === lastCol) return;
    renderer.setPreview({ anchor, preview: previewMove(state, active.trayIndex, anchor.row, anchor.col) });
    hasPreview = true;
    lastState = state;
    lastTray = active.trayIndex;
    lastRow = anchor.row;
    lastCol = anchor.col;
  }

  // 프레임당 한 번만 계산한다. 프레임의 첫 움직임은 바로 처리해서 한 프레임 늦게 따라오지 않게 하고, 같은 프레임의 나머지는 모아서 마지막 위치만 쓴다
  function onFrame() {
    frameId = 0;
    computedThisFrame = false;
    if (pending && active !== null) {
      pending = false;
      updatePreview();
      computedThisFrame = true;
      frameId = view.requestAnimationFrame(onFrame);
    }
  }

  function scheduleFrame() {
    if (frameId === 0) frameId = view.requestAnimationFrame(onFrame);
  }

  function stopFrame() {
    if (frameId !== 0) view.cancelAnimationFrame(frameId);
    frameId = 0;
    computedThisFrame = false;
    pending = false;
  }

  function release(pointerId) {
    try {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch {
      // 이미 놓친 포인터이면 무시한다
    }
  }

  function onPointerDown(event) {
    if (active !== null || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isLocked()) return;
    const state = getState();
    if (state === null || state.status !== 'playing') return;
    const point = toCanvas(event);
    const trayIndex = renderer.trayIndexAt(point.x, point.y);
    if (trayIndex < 0 || state.tray[trayIndex] == null) return;

    if (event.cancelable) event.preventDefault();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // 캡처에 실패해도 window 리스너로 계속 받는다
    }
    active = { pointerId: event.pointerId, trayIndex, pointerType: event.pointerType, x: point.x, y: point.y };
    hasPreview = false;
    lastState = null;
    renderer.setDrag(currentDrag());
    updatePreview();
    computedThisFrame = true;
    scheduleFrame();
    if (onPickup) onPickup(trayIndex);
  }

  function onPointerMove(event) {
    if (active === null || event.pointerId !== active.pointerId) return;
    const point = toCanvas(event);
    active.x = point.x;
    active.y = point.y;
    renderer.setDrag(currentDrag());
    if (computedThisFrame) {
      pending = true;
      return;
    }
    updatePreview();
    computedThisFrame = true;
    scheduleFrame();
  }

  function onPointerUp(event) {
    if (active === null || event.pointerId !== active.pointerId) return;
    const point = toCanvas(event);
    active.x = point.x;
    active.y = point.y;
    const finished = active;
    const drag = currentDrag();
    release(finished.pointerId);
    active = null;
    stopFrame();
    hasPreview = false;
    lastState = null;

    const state = getState();
    const anchor = state === null ? null : renderer.anchorForDrag(drag);
    const result = anchor === null ? null : previewMove(state, finished.trayIndex, anchor.row, anchor.col);
    if (result !== null && result.valid) {
      renderer.setDrag(null);
      renderer.setPreview(null);
      if (onDrop) onDrop({ trayIndex: finished.trayIndex, row: anchor.row, col: anchor.col });
    } else {
      renderer.returnToTray(finished.trayIndex, finished.x, finished.y);
      if (onInvalidDrop) onInvalidDrop({ trayIndex: finished.trayIndex, overBoard: anchor !== null });
    }
  }

  // 포인터 취소, 캡처 상실, 창 이탈 등: 블록을 트레이로 돌려보내고 알린다
  function cancel() {
    if (active === null) return;
    const finished = active;
    release(finished.pointerId);
    active = null;
    stopFrame();
    hasPreview = false;
    lastState = null;
    renderer.returnToTray(finished.trayIndex, finished.x, finished.y);
    if (onCancel) onCancel();
  }

  function onPointerCancel(event) {
    if (active !== null && event.pointerId === active.pointerId) cancel();
  }

  function onLostCapture(event) {
    if (active !== null && event.pointerId === active.pointerId) cancel();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') cancel();
  }

  function onVisibility() {
    if (doc.hidden) cancel();
  }

  // 스크롤/확대/길게 눌러 메뉴 같은 브라우저 기본 동작을 막는다(iOS Safari는 touch-action만으로 부족하다)
  function preventDefault(event) {
    if (event.cancelable) event.preventDefault();
  }

  const listeners = [
    [canvas, 'pointerdown', onPointerDown],
    [view, 'pointermove', onPointerMove],
    [view, 'pointerup', onPointerUp],
    [view, 'pointercancel', onPointerCancel],
    [canvas, 'lostpointercapture', onLostCapture],
    [view, 'blur', cancel],
    [view, 'keydown', onKeyDown],
    [doc, 'visibilitychange', onVisibility],
    [canvas, 'touchstart', preventDefault, { passive: false }],
    [canvas, 'touchmove', preventDefault, { passive: false }],
    [canvas, 'contextmenu', preventDefault],
    [canvas, 'gesturestart', preventDefault],
  ];
  for (const [target, type, handler, options] of listeners) target.addEventListener(type, handler, options);

  function destroy() {
    for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
    stopFrame();
    if (active !== null) {
      release(active.pointerId);
      active = null;
      renderer.setDrag(null);
      renderer.setPreview(null);
    }
  }

  return { destroy };
}
