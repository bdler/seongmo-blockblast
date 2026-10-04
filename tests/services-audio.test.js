import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audio, SOUND_NAMES, noteForCombo, clearSoundSpec, soundSpec } from '../src/services/audio.js';

const MAX_VOICES = 12;
const WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'];

class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
    this.cancelled = false;
  }

  setValueAtTime(value, time) {
    this.events.push(['set', value, time]);
  }

  linearRampToValueAtTime(value, time) {
    this.events.push(['linear', value, time]);
  }

  exponentialRampToValueAtTime(value, time) {
    this.events.push(['exp', value, time]);
  }

  cancelScheduledValues() {
    this.cancelled = true;
  }
}

class FakeNode {
  connect(target) {
    this.target = target;
    return target;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam(440);
  onended = null;
  startedAt = null;
  stops = [];

  start(time) {
    this.startedAt = time;
  }

  stop(time) {
    this.stops.push(time);
  }
}

/** 만들어진 컨텍스트와 노드를 기록하는 가짜 AudioContext를 globalThis에 설치한다 */
function installFakeAudio({ key = 'AudioContext', failCreateOscillator = false } = {}) {
  const log = { contexts: [], oscillators: [], gains: [] };

  class FakeAudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = { isDestination: true };
    resumeCalls = 0;
    suspendCalls = 0;
    closeCalls = 0;

    constructor() {
      log.contexts.push(this);
    }

    createGain() {
      const node = new FakeGain();
      log.gains.push(node);
      return node;
    }

    createOscillator() {
      if (failCreateOscillator) throw new Error('boom');
      const node = new FakeOscillator();
      log.oscillators.push(node);
      return node;
    }

    resume() {
      this.resumeCalls += 1;
      this.state = 'running';
      return Promise.resolve();
    }

    suspend() {
      this.suspendCalls += 1;
      this.state = 'suspended';
      return Promise.resolve();
    }

    close() {
      this.closeCalls += 1;
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  globalThis[key] = FakeAudioContext;
  return log;
}

function installFakeDocument() {
  const listeners = new Map();
  const fake = {
    visibilityState: 'visible',
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    fire(state) {
      fake.visibilityState = state;
      listeners.get('visibilitychange')?.();
    },
    listeners,
  };
  globalThis.document = fake;
  return fake;
}

const releasedCount = (log) => log.gains.filter((gain) => gain.gain.cancelled).length;

beforeEach(() => {
  audio.dispose();
  audio.setEnabled(true);
  audio.setVolume(0.8);
});

afterEach(() => {
  audio.dispose();
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  delete globalThis.document;
});

// ---- 순수 헬퍼 ----

test('SOUND_NAMES는 명세의 아홉 가지 이름이다', () => {
  assert.deepEqual(SOUND_NAMES, [
    'click', 'pick', 'place', 'invalid', 'clear', 'combo', 'perfect', 'gameover', 'newbest',
  ]);
  assert.equal(Object.isFrozen(SOUND_NAMES), true);
});

test('noteForCombo: 콤보가 쌓일수록 올라가고 상한에서 멈춘다', () => {
  const frequencies = Array.from({ length: 10 }, (_, i) => noteForCombo(i + 1));
  assert.equal(frequencies[0], 440);
  for (let i = 1; i < frequencies.length; i += 1) {
    assert.ok(frequencies[i] > frequencies[i - 1], `combo ${i + 1} should be higher than ${i}`);
  }
  const cap = noteForCombo(10);
  for (const combo of [11, 25, 1000, Infinity]) {
    assert.ok(noteForCombo(combo) <= cap);
  }
  assert.equal(noteForCombo(11), cap);
  assert.equal(noteForCombo(1000), cap);
  assert.ok(cap < 4000, 'capped frequency stays in a comfortable range');
});

test('noteForCombo: 1 미만이나 비정상 값은 첫 음으로 본다', () => {
  for (const combo of [0, -3, NaN, undefined, null, 'x']) {
    assert.equal(noteForCombo(combo), 440, String(combo));
  }
  assert.equal(noteForCombo(2.9), noteForCombo(2));
});

test('noteForCombo: 펜타토닉 음정을 따른다 (장2도, 장3도, 완전5도, 장6도, 옥타브)', () => {
  const ratios = [1, 2, 3, 4, 5, 6].map((combo) => noteForCombo(combo) / 440);
  const expected = [0, 2, 4, 7, 9, 12].map((semitones) => 2 ** (semitones / 12));
  ratios.forEach((ratio, i) => assert.ok(Math.abs(ratio - expected[i]) < 1e-9, `step ${i}`));
});

test('clearSoundSpec: 모양이 올바르다', () => {
  const spec = clearSoundSpec(2, 1);
  assert.ok(WAVEFORMS.includes(spec.waveform));
  assert.ok(spec.gain > 0 && spec.gain <= 1);
  assert.ok(spec.notes.length > 0);
  for (const note of spec.notes) {
    assert.ok(Number.isFinite(note.frequency) && note.frequency > 0);
    assert.ok(Number.isFinite(note.start) && note.start >= 0);
    assert.ok(Number.isFinite(note.duration) && note.duration > 0);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec, 'plain data only');
});

test('clearSoundSpec: 줄이 많을수록 음이 많고 전체가 길어진다', () => {
  const end = (spec) => Math.max(...spec.notes.map((n) => n.start + n.duration));
  let previous = clearSoundSpec(1, 1);
  for (const lines of [2, 3, 4]) {
    const next = clearSoundSpec(lines, 1);
    assert.ok(next.notes.length > previous.notes.length, `lines ${lines}`);
    assert.ok(end(next) > end(previous), `lines ${lines}`);
    previous = next;
  }
});

test('clearSoundSpec: 줄 수 효과는 상한이 있다', () => {
  assert.deepEqual(clearSoundSpec(4, 1), clearSoundSpec(40, 1));
});

test('clearSoundSpec: 콤보가 높을수록 시작음이 높고 상한이 있다', () => {
  const first = (combo) => clearSoundSpec(1, combo).notes[0].frequency;
  assert.ok(first(2) > first(1));
  assert.ok(first(5) > first(2));
  assert.equal(first(10), first(99));
  assert.equal(first(1), noteForCombo(1));
});

test('clearSoundSpec: 음은 위로 올라가고 비정상 입력도 안전하다', () => {
  const { notes } = clearSoundSpec(3, 4);
  for (let i = 1; i < notes.length; i += 1) {
    assert.ok(notes[i].frequency > notes[i - 1].frequency);
    assert.ok(notes[i].start > notes[i - 1].start);
  }
  assert.deepEqual(clearSoundSpec(NaN, undefined), clearSoundSpec(1, 1));
  assert.deepEqual(clearSoundSpec(-5, -5), clearSoundSpec(1, 1));
});

test('clearSoundSpec은 호출마다 새 객체를 돌려준다', () => {
  const a = clearSoundSpec(1, 1);
  a.notes[0].frequency = 1;
  assert.notEqual(clearSoundSpec(1, 1).notes[0].frequency, 1);
});

test('soundSpec: 모든 효과음 이름에 유효한 명세가 있다', () => {
  for (const name of SOUND_NAMES) {
    const spec = soundSpec(name, { lines: 2, combo: 3 });
    assert.ok(spec, name);
    assert.ok(WAVEFORMS.includes(spec.waveform), name);
    assert.ok(spec.gain > 0 && spec.gain <= 0.5, `${name} gain keeps headroom`);
    assert.ok(spec.notes.length > 0 && spec.notes.length <= 6, name);
    for (const note of spec.notes) {
      assert.ok(note.frequency >= 50 && note.frequency <= 4000, `${name} frequency`);
      assert.ok(note.duration > 0 && note.duration <= 2, `${name} duration`);
      assert.ok(note.start >= 0, `${name} start`);
      if (note.endFrequency !== undefined) assert.ok(note.endFrequency > 0, `${name} endFrequency`);
    }
  }
});

test('soundSpec: 모르는 이름이나 Object.prototype 키는 null', () => {
  for (const name of ['nope', '', undefined, null, 'constructor', 'toString']) {
    assert.equal(soundSpec(name), null, String(name));
  }
});

test('soundSpec: params가 없어도 던지지 않는다', () => {
  for (const name of SOUND_NAMES) {
    assert.doesNotThrow(() => soundSpec(name));
    assert.doesNotThrow(() => soundSpec(name, null));
  }
});

test('soundSpec: 각 소리의 성격 (콤보 상승, 게임오버 하강, 틱의 높낮이, 퍼펙트 팡파르)', () => {
  const combo = soundSpec('combo', { combo: 2 }).notes.map((n) => n.frequency);
  assert.deepEqual([...combo].sort((a, b) => a - b), combo, 'combo chime rises');
  assert.ok(soundSpec('combo', { combo: 6 }).notes[0].frequency > soundSpec('combo', { combo: 2 }).notes[0].frequency);

  const over = soundSpec('gameover').notes;
  for (let i = 1; i < over.length; i += 1) assert.ok(over[i].frequency < over[i - 1].frequency);

  const lowest = (name) => Math.min(...soundSpec(name).notes.map((n) => n.frequency));
  assert.ok(lowest('place') < lowest('pick'), 'place is lower than pick');
  assert.ok(lowest('invalid') < lowest('place'), 'invalid buzz is the lowest');
  assert.equal(soundSpec('invalid').waveform, 'square');
  assert.ok(soundSpec('place').notes[0].duration < 0.15, 'place is a short tick');
  assert.ok(soundSpec('pick').notes[0].duration < 0.1, 'pick is a tiny tick');

  const perfect = soundSpec('perfect').notes;
  assert.ok(perfect.length >= 3);
  for (let i = 1; i < perfect.length; i += 1) assert.ok(perfect[i].frequency > perfect[i - 1].frequency);
});

test('soundSpec("clear")는 clearSoundSpec과 같다', () => {
  assert.deepEqual(soundSpec('clear', { lines: 3, combo: 4 }), clearSoundSpec(3, 4));
});

// ---- AudioContext가 없는 환경 ----

test('AudioContext가 없어도 모든 메서드가 던지지 않는다', () => {
  assert.equal(audio.unlock(), false);
  assert.equal(audio.isUnlocked(), false);
  for (const name of SOUND_NAMES) assert.equal(audio.play(name, { lines: 2, combo: 2 }), false);
  assert.doesNotThrow(() => {
    audio.setEnabled(false);
    audio.setEnabled(true);
    audio.setVolume(0.5);
    audio.suspend();
    audio.resume();
    audio.dispose();
  });
});

test('unlock 전에는 컨텍스트도 노드도 만들지 않는다', () => {
  const log = installFakeAudio();
  assert.equal(audio.play('click'), false);
  assert.equal(log.contexts.length, 0);
  assert.equal(log.oscillators.length, 0);
  assert.equal(audio.isUnlocked(), false);
});

test('AudioContext 생성자가 던지면 unlock은 false를 돌려준다', () => {
  globalThis.AudioContext = class {
    constructor() {
      throw new Error('not allowed');
    }
  };
  assert.equal(audio.unlock(), false);
  assert.equal(audio.isUnlocked(), false);
  assert.equal(audio.play('click'), false);
});

// ---- unlock ----

test('unlock은 컨텍스트를 한 번만 만들고 멈춰 있으면 재개한다', () => {
  const log = installFakeAudio();
  assert.equal(audio.unlock(), true);
  assert.equal(log.contexts.length, 1);
  assert.equal(log.contexts[0].resumeCalls, 1);
  assert.equal(log.contexts[0].state, 'running');
  assert.equal(audio.isUnlocked(), true);

  assert.equal(audio.unlock(), true);
  assert.equal(log.contexts.length, 1);
  assert.equal(log.contexts[0].resumeCalls, 1, 'already running: no extra resume');

  log.contexts[0].state = 'suspended';
  audio.unlock();
  assert.equal(log.contexts[0].resumeCalls, 2);
});

test('마스터 게인이 destination에 연결된다', () => {
  const log = installFakeAudio();
  audio.unlock();
  assert.equal(log.gains.length, 1);
  assert.equal(log.gains[0].target, log.contexts[0].destination);
});

test('webkitAudioContext로 대체한다', () => {
  const log = installFakeAudio({ key: 'webkitAudioContext' });
  assert.equal(audio.unlock(), true);
  assert.equal(log.contexts.length, 1);
});

test('AudioContext가 있으면 webkitAudioContext보다 우선한다', () => {
  const log = installFakeAudio();
  globalThis.webkitAudioContext = class {
    constructor() {
      throw new Error('should not be used');
    }
  };
  assert.equal(audio.unlock(), true);
  assert.equal(log.contexts.length, 1);
});

test('소리를 끈 상태에서도 unlock은 컨텍스트를 준비한다 (나중에 켤 때를 위해)', () => {
  const log = installFakeAudio();
  audio.setEnabled(false);
  assert.equal(audio.unlock(), true);
  assert.equal(log.contexts.length, 1);
  assert.equal(log.gains[0].gain.value, 0, 'master stays muted while disabled');
});

test('dispose는 컨텍스트를 닫고, 이후 unlock으로 새로 만들 수 있다', () => {
  const log = installFakeAudio();
  audio.unlock();
  audio.dispose();
  assert.equal(log.contexts[0].closeCalls, 1);
  assert.equal(audio.isUnlocked(), false);
  assert.equal(audio.play('click'), false);

  assert.equal(audio.unlock(), true);
  assert.equal(log.contexts.length, 2);
});

// ---- play ----

test('play는 음마다 오실레이터와 게인을 만들어 마스터에 연결하고 시작/정지를 예약한다', () => {
  const log = installFakeAudio();
  audio.unlock();
  const master = log.gains[0];
  const expected = soundSpec('perfect');

  assert.equal(audio.play('perfect'), true);
  assert.equal(log.oscillators.length, expected.notes.length);
  assert.equal(log.gains.length, 1 + expected.notes.length);

  log.oscillators.forEach((osc, i) => {
    const note = expected.notes[i];
    assert.equal(osc.type, expected.waveform);
    assert.equal(osc.frequency.events[0][1], note.frequency);
    assert.ok(osc.startedAt > 0, 'starts slightly in the future');
    assert.ok(osc.stops[0] > osc.startedAt + note.duration, 'stops after the envelope ends');
    assert.equal(osc.target, log.gains[i + 1]);
    assert.equal(log.gains[i + 1].target, master);
  });
});

test('엔벨로프는 무음에서 시작해 짧게 올라갔다가 무음으로 감쇠한다 (클릭 노이즈 방지)', () => {
  const log = installFakeAudio();
  audio.unlock();
  audio.play('place');

  const events = log.gains[1].gain.events;
  assert.equal(events[0][0], 'set');
  assert.ok(events[0][1] > 0 && events[0][1] < 0.001, 'starts near silence but not 0 (exp ramp)');
  assert.equal(events[1][0], 'linear');
  assert.ok(events[1][2] - events[0][2] <= 0.01, 'short attack');
  assert.equal(events[1][1], soundSpec('place').gain);
  assert.equal(events[2][0], 'exp');
  assert.ok(events[2][1] < 0.001, 'decays to near silence');
});

test('구간 음(endFrequency)은 주파수가 미끄러진다', () => {
  const log = installFakeAudio();
  audio.unlock();
  audio.play('invalid');

  const [first, ramp] = log.oscillators[0].frequency.events;
  assert.equal(first[0], 'set');
  assert.equal(ramp[0], 'exp');
  assert.equal(ramp[1], soundSpec('invalid').notes[0].endFrequency);
});

test('clear는 lines와 combo에 따라 음 개수와 높이가 달라진다', () => {
  const log = installFakeAudio();
  audio.unlock();

  audio.play('clear', { lines: 1, combo: 1 });
  const small = log.oscillators.length;
  audio.play('clear', { lines: 4, combo: 6 });
  const big = log.oscillators.length - small;

  assert.equal(small, clearSoundSpec(1, 1).notes.length);
  assert.equal(big, clearSoundSpec(4, 6).notes.length);
  assert.ok(big > small);
  assert.equal(log.oscillators[small].frequency.events[0][1], clearSoundSpec(4, 6).notes[0].frequency);
});

test('모르는 소리 이름은 아무 노드도 만들지 않는다', () => {
  const log = installFakeAudio();
  audio.unlock();
  const nodes = log.gains.length;

  for (const name of ['nope', '', undefined, null, 'constructor']) assert.equal(audio.play(name), false);
  assert.equal(log.oscillators.length, 0);
  assert.equal(log.gains.length, nodes);
});

test('소리를 끄면 노드를 하나도 만들지 않고, 다시 켜면 재생된다', () => {
  const log = installFakeAudio();
  audio.unlock();
  const nodesAfterUnlock = log.gains.length;

  audio.setEnabled(false);
  assert.equal(audio.isEnabled(), false);
  for (const name of SOUND_NAMES) assert.equal(audio.play(name, { lines: 3, combo: 3 }), false);
  assert.equal(log.oscillators.length, 0);
  assert.equal(log.gains.length, nodesAfterUnlock);

  audio.setEnabled(true);
  assert.equal(audio.isEnabled(), true);
  assert.equal(audio.play('click'), true);
  assert.equal(log.oscillators.length, 1);
});

test('볼륨이 0이면 노드를 하나도 만들지 않고, 올리면 재생된다', () => {
  const log = installFakeAudio();
  audio.unlock();
  const nodesAfterUnlock = log.gains.length;

  audio.setVolume(0);
  for (const name of SOUND_NAMES) assert.equal(audio.play(name, { lines: 3, combo: 3 }), false);
  assert.equal(log.oscillators.length, 0);
  assert.equal(log.gains.length, nodesAfterUnlock);

  audio.setVolume(0.5);
  assert.equal(audio.play('click'), true);
  assert.equal(log.oscillators.length, 1);
});

test('setVolume/getVolume: 0..1로 보정하고 숫자가 아니면 무시한다', () => {
  assert.equal(audio.getVolume(), 0.8);
  audio.setVolume(0.35);
  assert.equal(audio.getVolume(), 0.35);
  audio.setVolume(7);
  assert.equal(audio.getVolume(), 1);
  audio.setVolume(-1);
  assert.equal(audio.getVolume(), 0);
  audio.setVolume(0.6);
  for (const bad of [NaN, Infinity, '0.2', null, undefined]) {
    audio.setVolume(bad);
    assert.equal(audio.getVolume(), 0.6, String(bad));
  }
});

test('마스터 게인은 볼륨과 켜짐 상태를 따른다', () => {
  const log = installFakeAudio();
  audio.unlock();
  const master = log.gains[0];

  assert.ok(master.gain.value > 0 && master.gain.value <= 0.8);
  audio.setVolume(1);
  const loud = master.gain.value;
  audio.setVolume(0.5);
  assert.ok(master.gain.value < loud);
  audio.setEnabled(false);
  assert.equal(master.gain.value, 0);
  audio.setEnabled(true);
  assert.ok(master.gain.value > 0);
});

test('unlock 전에 정한 볼륨과 켜짐 상태가 컨텍스트 생성 때 반영된다', () => {
  const log = installFakeAudio();
  audio.setVolume(0.25);
  audio.unlock();
  const quiet = log.gains[0].gain.value;
  assert.ok(quiet > 0 && quiet < 0.25);
});

// ---- 폴리포니 ----

test('폴리포니 상한: 동시에 12음을 넘지 않고 가장 새 소리는 항상 재생된다', () => {
  const log = installFakeAudio();
  audio.unlock();
  const active = () => log.oscillators.length - releasedCount(log);

  for (let i = 0; i < 20; i += 1) {
    const before = log.oscillators.length;
    audio.play('perfect');
    assert.ok(active() <= MAX_VOICES, `after play ${i + 1}: ${active()} active`);
    const newest = log.oscillators.slice(before);
    assert.equal(newest.length, soundSpec('perfect').notes.length);
    for (const osc of newest) {
      assert.equal(osc.disconnected, undefined);
      assert.equal(osc.stops.length, 1, 'newest voices are never cut');
    }
  }
  assert.ok(releasedCount(log) > 0, 'oldest voices were released');
  assert.equal(active(), MAX_VOICES);
});

test('폴리포니: 내보내는 음은 가장 오래된 것부터이며 짧게 페이드아웃한다', () => {
  const log = installFakeAudio();
  audio.unlock();

  for (let i = 0; i < 4; i += 1) audio.play('perfect');
  // 4음짜리 3번 = 12음, 네 번째에서 앞의 4음이 밀려난다
  const oscillators = log.oscillators;
  assert.equal(oscillators.length, 16);
  oscillators.slice(0, 4).forEach((osc, i) => {
    assert.equal(osc.stops.length, 2, `oldest voice ${i} gets an early stop`);
    assert.ok(osc.stops[1] < osc.stops[0], 'early stop comes before the planned end');
    const fadeEvents = log.gains[i + 1].gain.events.slice(-1)[0];
    assert.equal(fadeEvents[0], 'linear');
    assert.ok(fadeEvents[1] < 0.001, 'fades to silence instead of cutting');
  });
  oscillators.slice(4).forEach((osc) => assert.equal(osc.stops.length, 1));
});

test('끝난 음(onended)은 자리를 비워 주므로 불필요하게 다른 음을 내보내지 않는다', () => {
  const log = installFakeAudio();
  audio.unlock();

  for (let i = 0; i < 3; i += 1) audio.play('perfect');
  for (const osc of log.oscillators) osc.onended();
  assert.ok(log.oscillators.every((osc) => osc.disconnected), 'nodes are disconnected when ended');

  for (let i = 0; i < 3; i += 1) audio.play('perfect');
  assert.equal(releasedCount(log), 0, 'nothing was evicted because the first voices already ended');
});

test('한 번의 이동(놓기+줄 제거+콤보+퍼펙트)이 한도에 가까워도 퍼펙트가 재생된다', () => {
  const log = installFakeAudio();
  audio.unlock();

  audio.play('place');
  audio.play('clear', { lines: 4, combo: 5 });
  audio.play('combo', { combo: 5 });
  audio.play('perfect');

  const perfectStart = log.oscillators.length - soundSpec('perfect').notes.length;
  for (const osc of log.oscillators.slice(perfectStart)) assert.equal(osc.stops.length, 1);
  assert.ok(log.oscillators.length - releasedCount(log) <= MAX_VOICES);
});

// ---- 오류 삼키기 ----

test('노드 생성이 던져도 play는 던지지 않고 false를 돌려준다', () => {
  installFakeAudio({ failCreateOscillator: true });
  audio.unlock();
  assert.doesNotThrow(() => audio.play('click'));
  assert.equal(audio.play('click'), false);
});

test('resume/suspend/close가 거부되어도(rejected promise) 처리되지 않은 거부를 만들지 않는다', async () => {
  const log = installFakeAudio();
  audio.unlock();
  const context = log.contexts[0];
  context.resume = () => Promise.reject(new Error('resume denied'));
  context.suspend = () => Promise.reject(new Error('suspend denied'));
  context.close = () => Promise.reject(new Error('close denied'));
  context.state = 'suspended';

  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    audio.unlock();
    audio.suspend();
    audio.resume();
    audio.dispose();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, 0);
});

test('컨텍스트 메서드가 동기적으로 던져도 삼킨다', () => {
  const log = installFakeAudio();
  audio.unlock();
  const context = log.contexts[0];
  context.suspend = () => {
    throw new Error('closed');
  };
  context.resume = () => {
    throw new Error('closed');
  };
  context.close = () => {
    throw new Error('closed');
  };
  context.state = 'suspended';

  assert.doesNotThrow(() => {
    audio.unlock();
    audio.suspend();
    audio.resume();
    audio.setEnabled(true);
    audio.dispose();
  });
});

// ---- suspend / resume / 가시성 ----

test('suspend 중에는 소리를 예약하지 않고, resume하면 다시 재생된다', () => {
  const log = installFakeAudio();
  audio.unlock();

  audio.suspend();
  assert.equal(log.contexts[0].state, 'suspended');
  assert.equal(audio.play('click'), false);
  assert.equal(log.oscillators.length, 0);

  audio.resume();
  assert.equal(log.contexts[0].state, 'running');
  assert.equal(audio.play('click'), true);
  assert.equal(log.oscillators.length, 1);
});

test('소리가 꺼져 있으면 resume해도 컨텍스트를 재개하지 않는다', () => {
  const log = installFakeAudio();
  audio.unlock();
  audio.suspend();
  audio.setEnabled(false);
  const resumes = log.contexts[0].resumeCalls;

  audio.resume();
  assert.equal(log.contexts[0].resumeCalls, resumes);
  assert.equal(log.contexts[0].state, 'suspended');
});

test('visibilitychange: unlock 때 리스너를 달고, 숨겨지면 멈추고 보이면 재개한다', () => {
  const doc = installFakeDocument();
  const log = installFakeAudio();
  assert.equal(doc.listeners.size, 0, 'nothing is attached before unlock');

  audio.unlock();
  audio.unlock();
  assert.equal(doc.listeners.size, 1);

  doc.fire('hidden');
  assert.equal(log.contexts[0].state, 'suspended');
  assert.equal(audio.play('click'), false);

  doc.fire('visible');
  assert.equal(log.contexts[0].state, 'running');
  assert.equal(audio.play('click'), true);
});

test('visibilitychange: 소리가 꺼져 있으면 다시 보여도 재개하지 않는다', () => {
  const doc = installFakeDocument();
  const log = installFakeAudio();
  audio.unlock();

  doc.fire('hidden');
  audio.setEnabled(false);
  const resumes = log.contexts[0].resumeCalls;
  doc.fire('visible');
  assert.equal(log.contexts[0].resumeCalls, resumes);
  assert.equal(log.contexts[0].state, 'suspended');

  audio.setEnabled(true);
  assert.equal(log.contexts[0].state, 'running');
});

test('dispose는 visibilitychange 리스너를 제거한다', () => {
  const doc = installFakeDocument();
  installFakeAudio();
  audio.unlock();
  assert.equal(doc.listeners.size, 1);
  audio.dispose();
  assert.equal(doc.listeners.size, 0);
});

test('document가 없는 환경에서도 unlock은 동작한다', () => {
  installFakeAudio();
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(audio.unlock(), true);
});
