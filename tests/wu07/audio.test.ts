// WU-07 — §9.3 BGM/SFX·N12a~c 음량 정책

import { describe, expect, it } from 'vitest';
import { BGM_BPM, BgmScheduler, warningSecondOf, type AudioFrame } from '../../src/game/bgm';
import { FACTORY_ADMIN_PARAMS } from '../../src/core/adminParams';
import {
  SFX_NAMES,
  createSilentSfx,
  createWebAudioSfx,
  effectiveVolume,
  isNightMuted,
} from '../../src/game/sfx';

const day = new Date(2026, 7, 17, 15, 0, 0);

describe('N12a~c — 마스터·어트랙트·야간 음량', () => {
  it('게임은 SOUND 80%, 어트랙트는 80% × 30%다', () => {
    const machine = FACTORY_ADMIN_PARAMS.machine;
    expect(effectiveVolume(machine, 'RUN', day)).toBeCloseTo(0.8);
    expect(effectiveVolume(machine, 'ATTRACT', day)).toBeCloseTo(0.24);
    expect(effectiveVolume(machine, 'READY', day)).toBeCloseTo(0.24);
  });

  it('22:00 포함·10:00 제외의 자정 횡단 창이다', () => {
    expect(isNightMuted('22:00', '10:00', new Date(2026, 7, 17, 21, 59))).toBe(false);
    expect(isNightMuted('22:00', '10:00', new Date(2026, 7, 17, 22, 0))).toBe(true);
    expect(isNightMuted('22:00', '10:00', new Date(2026, 7, 18, 9, 59))).toBe(true);
    expect(isNightMuted('22:00', '10:00', new Date(2026, 7, 18, 10, 0))).toBe(false);
  });

  it('NIGHT MUTE OFF면 야간에도 마스터 음량을 유지한다', () => {
    const machine = { ...FACTORY_ADMIN_PARAMS.machine, nightMuteOn: false };
    expect(effectiveVolume(machine, 'RUN', new Date(2026, 7, 17, 23, 0))).toBeCloseTo(0.8);
  });
});

describe('§9.3 — 절차 합성 큐 계약', () => {
  it('SFX 12종이 중복 없이 정의되고 cue를 받아도 호출 순서를 보존한다', () => {
    expect(new Set(SFX_NAMES).size).toBe(12);
    const sfx = createSilentSfx();
    sfx.play('slide', { comboCentis: 250, segments: 12, pan: 1 });
    sfx.play('block', { pan: -1 });
    expect(sfx.log).toEqual(['slide', 'block']);
  });

  it('falls back to silence safely when no audio device is available', () => {
    const sfx = createWebAudioSfx({ contextFactory: () => null });
    expect(() => {
      for (const name of SFX_NAMES) sfx.play(name);
      sfx.dispose?.();
    }).not.toThrow();
  });

  it('BGM 템포 4단계가 엄격히 상승한다', () => {
    expect(BGM_BPM).toHaveLength(4);
    for (let i = 1; i < BGM_BPM.length; i += 1) expect(BGM_BPM[i]).toBeGreaterThan(BGM_BPM[i - 1]);
  });

  it('10초 이하에서 같은 초는 경고 1회, 다음 초에 다시 1회다', () => {
    const scheduler = new BgmScheduler();
    const at10 = frame(0, 10000);
    expect(scheduler.tick(at10).filter((pulse) => pulse.kind === 'warning')).toHaveLength(1);
    expect(
      scheduler.tick(frame(100, 9950)).filter((pulse) => pulse.kind === 'warning')
    ).toHaveLength(0);
    expect(
      scheduler.tick(frame(1000, 9000)).filter((pulse) => pulse.kind === 'warning')
    ).toHaveLength(1);
    expect(warningSecondOf(frame(2000, 10001))).toBeNull();
  });
});

function frame(nowMs: number, timeRemainingMs: number): AudioFrame {
  return { screen: 'RUN', nowMs, tierIndex: 2, timeRemainingMs };
}
