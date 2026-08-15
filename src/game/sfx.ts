// 사운드 스텁 (§9.3 — 작업 계획 P-8. 실물은 WU-07이 교체)
//
// WU-03은 **무음**이다. 그런데 "거부음이 실제로 났는가"(HNT-506·CTL-003 열 1개 거부)는 자동으로
// 판정해야 하므로, 스텁이 호출 이름을 순서대로 기록한다. 테스트는 이 로그만 본다.
//
// 실제 오디오 자산·볼륨·NIGHT MUTE(§9.3 N12a~c)는 WU-07 소관이며, 그때 `Sfx` 구현만 갈아 끼운다.

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

export interface Sfx {
  play(name: SfxName): void;
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
