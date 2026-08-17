// WU-07 절차 합성 사운드 + Node용 무음 스텁 (§9.3)
//
// WU-03은 **무음**이다. 그런데 "거부음이 실제로 났는가"(HNT-506·CTL-003 열 1개 거부)는 자동으로
// 판정해야 하므로, 스텁이 호출 이름을 순서대로 기록한다. 테스트는 이 로그만 본다.
//
// 바이너리 음원을 싣지 않고 Web Audio oscillator로 독자 제작한다. 브라우저 자동재생 제한이나
// AudioContext 부재 시에는 조용히 무음으로 강등되며 게임 규칙은 영향을 받지 않는다.

import type { MachineParams } from '../core/adminParams';
import { FACTORY_ADMIN_PARAMS } from '../core/adminParams';
import { BgmScheduler, type AudioFrame } from './bgm';

/** §9.3 사운드 이름 — 레이어 5행을 개별 큐 11종으로 편 것 */
export const SFX_NAMES = [
  'select',
  'reject',
  'confirm',
  'coin',
  'pull',
  'slide',
  'block',
  'heart',
  'hint',
  'clear',
  'perfect',
  'gameover',
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

export interface SfxCue {
  /** 성공 콤보 음정. 100 = ×1.0 */
  readonly comboCentis?: number;
  /** 슬라이드 길이 비례 음가 */
  readonly segments?: number;
  /** 방향성 경고 -1(좌)~+1(우) */
  readonly pan?: number;
}

export interface Sfx {
  play(name: SfxName, cue?: SfxCue): void;
  /** §11.3 LIVE 설정. MOTION REDUCE는 오디오가 소비하지 않는다. */
  configure?(machine: MachineParams): void;
  /** 씬 프레임에서 BGM·10초 경고 레이어를 진행한다. */
  update?(frame: AudioFrame): void;
  dispose?(): void;
}

export interface SilentSfx extends Sfx {
  /** 호출된 순서 그대로 */
  readonly log: readonly SfxName[];
  /** 이름별 호출 횟수 */
  count(name: SfxName): number;
  clear(): void;
}

/** 무음 스텁 + 호출 카운터. 오디오 API를 건드리지 않으므로 Node 테스트에서도 그대로 돈다 */
export function createSilentSfx(): SilentSfx {
  const log: SfxName[] = [];
  return {
    play(name: SfxName): void {
      log.push(name);
    },
    get log(): readonly SfxName[] {
      return log;
    },
    count(name: SfxName): number {
      return log.filter((n) => n === name).length;
    },
    clear(): void {
      log.length = 0;
    },
  };
}

/** N12a~c. 어트랙트 음량은 마스터에 곱하고 야간에는 0이다. */
export function effectiveVolume(
  machine: Pick<
    MachineParams,
    'soundVolume' | 'attractVolume' | 'nightMuteOn' | 'nightMuteStart' | 'nightMuteEnd'
  >,
  screen: AudioFrame['screen'],
  at: Date
): number {
  if (machine.nightMuteOn && isNightMuted(machine.nightMuteStart, machine.nightMuteEnd, at)) {
    return 0;
  }
  const master = clamp(machine.soundVolume / 100, 0, 1);
  const attract =
    screen === 'ATTRACT' || screen === 'READY' ? clamp(machine.attractVolume / 100, 0, 0.6) : 1;
  return master * attract;
}

/** 시작 포함·종료 제외. 22:00~10:00처럼 자정을 넘는 창도 처리한다. */
export function isNightMuted(start: string, end: string, at: Date): boolean {
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  const now = at.getHours() * 60 + at.getMinutes();
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

interface WebAudioSfxOptions {
  readonly wallNow?: () => Date;
  readonly contextFactory?: () => AudioContext | null;
}

/** 실제 런타임 SFX/BGM. 첫 사용자 발화에서만 AudioContext를 만든다. */
export function createWebAudioSfx(options: WebAudioSfxOptions = {}): Sfx {
  let machine: MachineParams = FACTORY_ADMIN_PARAMS.machine;
  let context: AudioContext | null = null;
  let screen: AudioFrame['screen'] = 'ATTRACT';
  const scheduler = new BgmScheduler();
  const wallNow = options.wallNow ?? (() => new Date());

  function getContext(): AudioContext | null {
    if (context !== null) return context;
    try {
      context =
        options.contextFactory === undefined ? defaultAudioContext() : options.contextFactory();
      if (context?.state === 'suspended') void context.resume().catch(() => undefined);
      return context;
    } catch {
      context = null;
      return null;
    }
  }

  function gain(): number {
    return effectiveVolume(machine, screen, wallNow());
  }

  function tone(
    frequency: number,
    durationMs: number,
    level: number,
    wave: OscillatorType = 'sine',
    pan = 0,
    delayMs = 0
  ): void {
    const ctx = context;
    const volume = gain() * level;
    if (ctx === null || volume <= 0) return;
    const start = ctx.currentTime + delayMs / 1000;
    const end = start + Math.max(0.015, durationMs / 1000);
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(Math.max(30, frequency), start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(clamp(pan, -1, 1), start);
      oscillator.connect(envelope).connect(panner).connect(ctx.destination);
    } else {
      oscillator.connect(envelope).connect(ctx.destination);
    }
    oscillator.start(start);
    oscillator.stop(end + 0.01);
  }

  function play(name: SfxName, cue: SfxCue = {}): void {
    const ctx = getContext();
    if (ctx === null) return;
    const comboStep = Math.max(0, Math.floor(((cue.comboCentis ?? 100) - 100) / 15));
    // 8단계 뒤에는 같은 음급을 한 옥타브 위에서 반복한다 (§9.3).
    const semitone = (comboStep % 8) + Math.floor(comboStep / 8) * 12;
    const comboPitch = 2 ** (semitone / 12);
    const pan = clamp(cue.pan ?? 0, -1, 1);
    switch (name) {
      case 'select':
        tone(660, 45, 0.12, 'square');
        return;
      case 'reject':
        tone(185, 95, 0.19, 'sawtooth');
        return;
      case 'confirm':
        tone(520, 65, 0.13, 'triangle');
        tone(780, 75, 0.11, 'triangle', 0, 55);
        return;
      case 'coin':
        tone(988, 65, 0.16, 'square', 0, 0);
        tone(1319, 95, 0.14, 'square', 0, 70);
        return;
      case 'pull':
        tone(330, 55, 0.08, 'triangle');
        return;
      case 'slide': {
        const duration = clamp(90 + (cue.segments ?? 3) * 12, 100, 420);
        tone(440 * comboPitch, duration, 0.12, 'sine', pan);
        tone(660 * comboPitch, duration * 0.65, 0.07, 'triangle', pan, 25);
        return;
      }
      case 'block':
        tone(240, 115, 0.2, 'square', pan);
        tone(180, 90, 0.12, 'sawtooth', pan, 45);
        return;
      case 'heart':
        tone(392, 80, 0.18, 'triangle');
        tone(262, 130, 0.2, 'triangle', 0, 80);
        return;
      case 'hint':
        tone(740, 80, 0.1, 'sine');
        tone(988, 120, 0.08, 'sine', 0, 75);
        return;
      case 'clear':
        [523, 659, 784].forEach((frequency, i) =>
          tone(frequency, 180, 0.12, 'triangle', 0, i * 85)
        );
        return;
      case 'perfect':
        [659, 784, 988, 1319].forEach((frequency, i) =>
          tone(frequency, 220, 0.13, 'sine', 0, i * 70)
        );
        return;
      case 'gameover':
        [392, 330, 262].forEach((frequency, i) =>
          tone(frequency, 230, 0.14, 'triangle', 0, i * 130)
        );
        return;
    }
  }

  return {
    play,
    configure(next): void {
      machine = next;
    },
    update(frame): void {
      screen = frame.screen;
      if (context === null) return;
      for (const pulse of scheduler.tick(frame)) {
        const wave: OscillatorType = pulse.kind === 'warning' ? 'square' : 'sine';
        tone(pulse.frequency, pulse.durationMs, pulse.gain, wave);
      }
    },
    dispose(): void {
      scheduler.reset();
      const active = context;
      context = null;
      if (active !== null) void active.close().catch(() => undefined);
    },
  };
}

function defaultAudioContext(): AudioContext | null {
  const root = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Constructor = root.AudioContext ?? root.webkitAudioContext;
  return Constructor === undefined ? null : new Constructor();
}

function clockMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return 0;
  return clamp(Number(match[1]) * 60 + Number(match[2]), 0, 1439);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
