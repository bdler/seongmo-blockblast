// WebAudio 합성 효과음. 오디오 파일 없이 오실레이터 + 게인 엔벨로프만으로 소리를 만든다.
// 브라우저는 첫 사용자 제스처 이후에만 소리를 허용하므로 AudioContext는 unlock()에서 늦게 만든다.
// 소리 때문에 게임이 멈추면 안 되므로 오디오 관련 오류는 모두 삼킨다.

/** @typedef {{frequency: number, endFrequency?: number, start: number, duration: number}} NoteSpec 시간 단위는 초 */
/** @typedef {{waveform: OscillatorType, gain: number, notes: NoteSpec[]}} SoundSpec */

export const SOUND_NAMES = Object.freeze([
  'click',
  'pick',
  'place',
  'invalid',
  'clear',
  'combo',
  'perfect',
  'gameover',
  'newbest',
]);

const MAX_VOICES = 12;
const DEFAULT_VOLUME = 0.8;

const BASE_FREQUENCY = 440;
const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9];
const MAX_COMBO_INDEX = 9; // 콤보가 이만큼 쌓이면 음 상승을 멈춘다 (너무 높으면 귀가 아프다)
const MAX_CLEAR_LINES = 4;

const START_DELAY = 0.005; // 엔벨로프의 첫 지점이 과거가 되지 않도록 약간 앞에서 시작
const ATTACK = 0.005; // 급격한 시작은 딱 소리(클릭 노이즈)가 난다
const RELEASE_TAIL = 0.02;
const EVICT_FADE = 0.02;
const SILENCE = 0.0001; // exponentialRamp는 0을 목표로 할 수 없다

// 퍼펙트 팡파르(도미솔도)와 게임오버 하강음에 쓰는 고정 음높이 (Hz)
const NOTE = Object.freeze({
  C3: 130.81,
  G3: 196,
  C4: 261.63,
  E4: 329.63,
  G4: 392,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  C6: 1046.5,
});

// ---- 순수 헬퍼 (오디오 없이 테스트 가능) ----

function pentatonicFrequency(index) {
  const semitones = Math.floor(index / 5) * 12 + PENTATONIC_SEMITONES[index % 5];
  return BASE_FREQUENCY * 2 ** (semitones / 12);
}

function comboIndex(combo) {
  const value = Number.isFinite(combo) ? Math.floor(combo) : 1;
  return Math.min(Math.max(value, 1), MAX_COMBO_INDEX + 1) - 1;
}

/**
 * 콤보가 쌓일수록 올라가는 펜타토닉 음. 상한에서 멈춘다.
 * @param {number} combo 1 이상(그 미만/비정상 값은 1로 본다)
 * @returns {number} Hz
 */
export function noteForCombo(combo) {
  return pentatonicFrequency(comboIndex(combo));
}

/**
 * 줄 수가 많을수록 음이 많고 길며, 콤보가 높을수록 시작음이 높다.
 * @param {number} lines
 * @param {number} combo
 * @returns {SoundSpec}
 */
export function clearSoundSpec(lines, combo) {
  const count = Math.min(Math.max(Number.isFinite(lines) ? Math.floor(lines) : 1, 1), MAX_CLEAR_LINES);
  const root = comboIndex(combo);
  const duration = 0.16 + 0.04 * count;
  return {
    waveform: 'triangle',
    gain: 0.22 + 0.03 * count,
    notes: Array.from({ length: count + 1 }, (_, k) => ({
      frequency: pentatonicFrequency(root + k),
      start: k * 0.07,
      duration,
    })),
  };
}

function comboSoundSpec(combo) {
  const root = comboIndex(combo);
  return {
    waveform: 'sine',
    gain: 0.26,
    notes: [0, 1, 2].map((k) => ({
      frequency: pentatonicFrequency(root + k),
      start: k * 0.06,
      duration: 0.22,
    })),
  };
}

/**
 * 효과음 이름을 합성 명세로 바꾼다. 모르는 이름이면 null.
 * @param {string} name
 * @param {{lines?: number, combo?: number}} [params]
 * @returns {SoundSpec | null}
 */
export function soundSpec(name, params) {
  const { lines, combo } = params ?? {};
  switch (name) {
    case 'click':
      return { waveform: 'sine', gain: 0.2, notes: [{ frequency: 880, start: 0, duration: 0.05 }] };
    case 'pick':
      return { waveform: 'sine', gain: 0.14, notes: [{ frequency: 1568, start: 0, duration: 0.04 }] };
    case 'place':
      return {
        waveform: 'sine',
        gain: 0.32,
        notes: [{ frequency: 240, endFrequency: 150, start: 0, duration: 0.09 }],
      };
    case 'invalid':
      return {
        waveform: 'square',
        gain: 0.1,
        notes: [{ frequency: 140, endFrequency: 100, start: 0, duration: 0.16 }],
      };
    case 'clear':
      return clearSoundSpec(lines, combo);
    case 'combo':
      return comboSoundSpec(combo);
    case 'perfect':
      return {
        waveform: 'triangle',
        gain: 0.26,
        notes: [
          { frequency: NOTE.C5, start: 0, duration: 0.12 },
          { frequency: NOTE.E5, start: 0.1, duration: 0.12 },
          { frequency: NOTE.G5, start: 0.2, duration: 0.12 },
          { frequency: NOTE.C6, start: 0.3, duration: 0.5 },
        ],
      };
    case 'gameover':
      return {
        waveform: 'triangle',
        gain: 0.3,
        notes: [
          { frequency: NOTE.G4, start: 0, duration: 0.28 },
          { frequency: NOTE.E4, start: 0.24, duration: 0.28 },
          { frequency: NOTE.C4, start: 0.48, duration: 0.28 },
          { frequency: NOTE.G3, endFrequency: NOTE.C3, start: 0.72, duration: 0.7 },
        ],
      };
    case 'newbest':
      return {
        waveform: 'sine',
        gain: 0.28,
        notes: [2, 3, 4, 5, 6].map((index, k, all) => ({
          frequency: pentatonicFrequency(index),
          start: k * 0.08,
          duration: k === all.length - 1 ? 0.45 : 0.14,
        })),
      };
    default:
      return null;
  }
}

// ---- 엔진 ----

/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let master = null;
let enabled = true;
let volume = DEFAULT_VOLUME;
let paused = false; // 숨겨진 탭에서 예약한 소리가 복귀 때 한꺼번에 터지는 것을 막는다
let visibilityListening = false;
/** 재생 중이거나 예약된 음. 오래된 순서 */
let voices = [];

function ignoreRejection(result) {
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function disconnectQuietly(node) {
  try {
    node.disconnect();
  } catch {
    // 이미 끊긴 노드
  }
}

function applyMasterGain() {
  if (!master) return;
  try {
    // 제곱 곡선: 슬라이더 값과 체감 음량을 비슷하게 맞춘다
    master.gain.value = enabled ? volume * volume : 0;
  } catch {
    // 오디오 오류는 게임을 멈추지 않는다
  }
}

function resumeContext() {
  if (!ctx || ctx.state === 'running') return;
  ignoreRejection(ctx.resume());
}

function onVisibilityChange() {
  if (globalThis.document?.visibilityState === 'hidden') suspend();
  else resume();
}

function listenVisibility() {
  const doc = globalThis.document;
  if (visibilityListening || !doc || typeof doc.addEventListener !== 'function') return;
  doc.addEventListener('visibilitychange', onVisibilityChange);
  visibilityListening = true;
}

function removeVoice(voice) {
  const index = voices.indexOf(voice);
  if (index !== -1) voices.splice(index, 1);
}

function releaseVoice(voice, now) {
  try {
    const param = voice.gain.gain;
    const current = param.value;
    param.cancelScheduledValues(now);
    // 진행 중인 엔벨로프를 지우면 값이 튀므로 현재 값에서 짧게 페이드아웃한다
    param.setValueAtTime(current, now);
    param.linearRampToValueAtTime(SILENCE, now + EVICT_FADE);
    voice.osc.stop(now + EVICT_FADE + RELEASE_TAIL);
  } catch {
    // 이미 끝난 음
  }
}

function startVoice(spec, note, at) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = spec.waveform;
  osc.frequency.setValueAtTime(note.frequency, at);
  if (note.endFrequency) {
    osc.frequency.exponentialRampToValueAtTime(note.endFrequency, at + note.duration);
  }
  gain.gain.setValueAtTime(SILENCE, at);
  gain.gain.linearRampToValueAtTime(spec.gain, at + Math.min(ATTACK, note.duration / 4));
  gain.gain.exponentialRampToValueAtTime(SILENCE, at + note.duration);
  osc.connect(gain);
  gain.connect(master);

  const voice = { osc, gain };
  osc.onended = () => {
    removeVoice(voice);
    disconnectQuietly(osc);
    disconnectQuietly(gain);
  };
  osc.start(at);
  osc.stop(at + note.duration + RELEASE_TAIL);
  voices.push(voice);
}

function schedule(spec) {
  const now = ctx.currentTime;
  // 한도를 넘으면 가장 오래된 음을 내보낸다: 새 소리(퍼펙트, 게임오버 등)가 중요하다
  while (voices.length > 0 && voices.length + spec.notes.length > MAX_VOICES) {
    releaseVoice(voices.shift(), now);
  }
  for (const note of spec.notes) startVoice(spec, note, now + START_DELAY + note.start);
}

/**
 * 사용자 제스처 안에서 호출한다. 컨텍스트를 처음 만들고, 멈춰 있으면 재개한다. 여러 번 호출해도 안전하다.
 * @returns {boolean} 오디오를 쓸 수 있으면 true
 */
function unlock() {
  try {
    if (!ctx) {
      const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      const context = new AudioContextClass();
      const gain = context.createGain();
      gain.connect(context.destination);
      ctx = context;
      master = gain;
      applyMasterGain();
      listenVisibility();
    }
    resumeContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} name SOUND_NAMES 중 하나
 * @param {{lines?: number, combo?: number}} [params] clear는 lines/combo, combo는 combo를 쓴다
 * @returns {boolean} 소리를 예약했으면 true
 */
function play(name, params) {
  if (!enabled || volume <= 0 || paused || !ctx) return false;
  try {
    const spec = soundSpec(name, params);
    if (!spec) return false;
    schedule(spec);
    return true;
  } catch {
    return false;
  }
}

/** @param {boolean} value */
function setEnabled(value) {
  enabled = Boolean(value);
  applyMasterGain();
  if (enabled && !paused) {
    try {
      resumeContext();
    } catch {
      // 재개 실패는 다음 unlock()에서 다시 시도된다
    }
  }
}

function isEnabled() {
  return enabled;
}

/** @param {number} value 0..1로 보정한다. 숫자가 아니면 무시 */
function setVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  volume = Math.min(1, Math.max(0, value));
  applyMasterGain();
}

function getVolume() {
  return volume;
}

/** 컨텍스트를 만들었으면 true (재개가 아직 진행 중일 수 있다) */
function isUnlocked() {
  return ctx !== null;
}

function suspend() {
  paused = true;
  try {
    if (ctx) ignoreRejection(ctx.suspend());
  } catch {
    // 이미 닫힌 컨텍스트
  }
}

function resume() {
  paused = false;
  try {
    if (enabled) resumeContext();
  } catch {
    // 재개 실패는 다음 unlock()에서 다시 시도된다
  }
}

/** 컨텍스트를 닫고 초기 상태로 되돌린다. 이후 unlock()으로 다시 쓸 수 있다. */
function dispose() {
  if (visibilityListening) {
    try {
      globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
    } catch {
      // 문서가 사라진 환경
    }
    visibilityListening = false;
  }
  const closing = ctx;
  ctx = null;
  master = null;
  voices = [];
  paused = false;
  try {
    if (closing) ignoreRejection(closing.close());
  } catch {
    // 이미 닫힌 컨텍스트
  }
}

export const audio = {
  unlock,
  play,
  setEnabled,
  isEnabled,
  setVolume,
  getVolume,
  isUnlocked,
  suspend,
  resume,
  dispose,
};
