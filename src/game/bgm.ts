// WU-07 — 절차 합성 BGM/시간 경고 스케줄러 (§9.3, EFX-802·808)
// 실제 Web Audio 노드 생성은 `sfx.ts`가 맡고, 이 파일은 언제 어떤 음을 낼지만 결정한다.

type AudioScreen =
  'ATTRACT' | 'READY' | 'TUTORIAL' | 'RUN' | 'CONTINUE' | 'RESULT' | 'NAME_ENTRY' | 'ADMIN';

export interface AudioFrame {
  readonly screen: AudioScreen;
  readonly nowMs: number;
  readonly tierIndex: number;
  readonly timeRemainingMs: number | null;
}

interface BgmPulse {
  readonly kind: 'beat' | 'tension' | 'warning';
  readonly frequency: number;
  readonly durationMs: number;
  readonly gain: number;
}

/** 워밍업 → 엔드리스 4단계. MASTER와 ENDLESS는 같은 최고 단계다. */
export const BGM_BPM = [92, 108, 124, 140] as const;

export class BgmScheduler {
  private nextBeatAt: number | null = null;
  private lastScreen: AudioScreen | null = null;
  private lastWarningSecond: number | null = null;
  private beatIndex = 0;

  tick(frame: AudioFrame): readonly BgmPulse[] {
    const pulses: BgmPulse[] = [];
    const active = isMusicScreen(frame.screen);
    if (!active) {
      this.reset(frame.screen);
      return pulses;
    }

    if (this.lastScreen !== frame.screen) {
      this.nextBeatAt = frame.nowMs;
      this.lastScreen = frame.screen;
      this.beatIndex = 0;
      this.lastWarningSecond = null;
    }

    const bpm = bpmFor(frame);
    const beatMs = 60000 / bpm;
    let emitted = 0;
    while (this.nextBeatAt !== null && frame.nowMs >= this.nextBeatAt && emitted < 4) {
      const root = rootFor(frame);
      const accent = this.beatIndex % 4 === 0;
      pulses.push({
        kind: 'beat',
        frequency: root * (accent ? 1 : this.beatIndex % 2 === 0 ? 1.5 : 1.25),
        durationMs: Math.min(110, beatMs * 0.22),
        gain: accent ? 0.12 : 0.07,
      });
      if (isTension(frame)) {
        pulses.push({ kind: 'tension', frequency: root * 2, durationMs: 70, gain: 0.055 });
      }
      this.beatIndex += 1;
      this.nextBeatAt += beatMs;
      emitted += 1;
    }
    // 장시간 탭 비활성화 뒤 수십 비트를 몰아서 내지 않는다.
    if (emitted === 4 && this.nextBeatAt !== null && frame.nowMs >= this.nextBeatAt) {
      this.nextBeatAt = frame.nowMs + beatMs;
    }

    const warningSecond = warningSecondOf(frame);
    if (warningSecond !== null && warningSecond !== this.lastWarningSecond) {
      pulses.push({ kind: 'warning', frequency: 880, durationMs: 85, gain: 0.18 });
      this.lastWarningSecond = warningSecond;
    }
    if (warningSecond === null) this.lastWarningSecond = null;
    return pulses;
  }

  reset(screen: AudioScreen | null = null): void {
    this.nextBeatAt = null;
    this.lastScreen = screen;
    this.lastWarningSecond = null;
    this.beatIndex = 0;
  }
}

export function warningSecondOf(frame: AudioFrame): number | null {
  if (frame.screen !== 'RUN' || frame.timeRemainingMs === null) return null;
  if (frame.timeRemainingMs <= 0 || frame.timeRemainingMs > 10000) return null;
  return Math.ceil(frame.timeRemainingMs / 1000);
}

function isMusicScreen(screen: AudioScreen): boolean {
  return screen === 'ATTRACT' || screen === 'READY' || screen === 'TUTORIAL' || screen === 'RUN';
}

function bpmFor(frame: AudioFrame): number {
  if (frame.screen === 'ATTRACT' || frame.screen === 'READY') return 78;
  if (frame.screen === 'TUTORIAL') return 86;
  return BGM_BPM[Math.max(0, Math.min(BGM_BPM.length - 1, frame.tierIndex))];
}

function rootFor(frame: AudioFrame): number {
  if (frame.screen === 'ATTRACT' || frame.screen === 'READY') return 110;
  return 130.81 * 2 ** (Math.max(0, Math.min(3, frame.tierIndex)) / 12);
}

function isTension(frame: AudioFrame): boolean {
  return frame.screen === 'RUN' && frame.timeRemainingMs !== null && frame.timeRemainingMs <= 10000;
}
