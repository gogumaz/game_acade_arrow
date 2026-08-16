// `settings.csv` 코덱 + `SaveDocument` (§11.3 · §12.1 — 작업 계획 P-5 · 실측 제약 F-d)
//
// **WU-01 v1 두 줄을 그대로 둔다.** `tests/wu01/csv.test.ts`가 `csv.split('\n')[0]`을
// `SETTINGS_HEADER`로 단언하고 `parseSettingsCsv()`는 `lines[0..1]`만 읽는다. 그래서 3줄째부터
// `#machine` 섹션을 덧붙여도 WU-01 27건이 그대로 통과한다 (WU-04 `statsDoc.ts`와 동일 구조).
//
//   schema,soundVolume,coinsPerPlay,initialHearts    ← v1 헤더 (불변)
//   1,80,1,3                                          ← v1 본행. initialHearts는 **거울값**이다
//   #machine,attractVolume,nightMuteStart,nightMuteEnd,nightMuteOn,continueCoins,coinUnitPrice,motionReduce
//   1,30,22:00,10:00,1,1,,0                           ← coinUnitPrice 빈 칸 = 미설정
//
// `initialHearts`는 `GAME PARAMETERS`(params.csv)가 권위를 갖고 여기에는 기록만 한다.
// 읽을 때도 무시한다 — 두 파일이 어긋나면 params.csv가 이긴다 (부록 A.2 그룹 이동).

import type { MachineParams } from '../core/adminParams';
import { FACTORY_ADMIN_PARAMS } from '../core/adminParams';
import {
  FILES,
  SCHEMA_VERSION,
  parseSettingsCsv,
  sanitizeField,
  settingsToCsv,
} from '../persist/csv';
import type { SaveDocument } from '../persist/storage';

export const MACHINE_SECTION = '#machine';

export const MACHINE_HEADER = [
  MACHINE_SECTION,
  'attractVolume',
  'nightMuteStart',
  'nightMuteEnd',
  'nightMuteOn',
  'continueCoins',
  'coinUnitPrice',
  'motionReduce',
].join(',');

interface SettingsDocument {
  readonly machine: MachineParams;
  /** v1 머리행에 거울로 기록하는 값 (권위는 `params.csv`) */
  readonly initialHearts: number;
}

function bit(on: boolean): string {
  return on ? '1' : '0';
}

export function settingsDocToCsv(doc: SettingsDocument): string {
  const m = doc.machine;
  const head = settingsToCsv({
    soundVolume: m.soundVolume,
    coinsPerPlay: m.coinsPerPlay,
    initialHearts: doc.initialHearts,
  });
  const row = [
    SCHEMA_VERSION,
    m.attractVolume,
    sanitizeField(m.nightMuteStart),
    sanitizeField(m.nightMuteEnd),
    bit(m.nightMuteOn),
    m.continueCoins,
    m.coinUnitPrice === null ? '' : m.coinUnitPrice,
    bit(m.motionReduce),
  ].join(',');
  return [head, MACHINE_HEADER, row].join('\n');
}

function col(cols: readonly string[], i: number): string {
  return cols.length > i ? cols[i].trim() : '';
}

function num(cols: readonly string[], i: number, fallback: number): number {
  const raw = col(cols, i);
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function flag(cols: readonly string[], i: number, fallback: boolean): boolean {
  const raw = col(cols, i);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

function text(cols: readonly string[], i: number, fallback: string): string {
  const raw = col(cols, i);
  return raw === '' ? fallback : raw;
}

/** 손상 관용 — 읽을 수 없는 칸은 공장값을 유지한다. 절대 throw 하지 않는다 */
export function parseSettingsDocCsv(csv: string): MachineParams {
  const factory = FACTORY_ADMIN_PARAMS.machine;
  const base = parseSettingsCsv(csv);
  const lines = csv.split(/\r?\n/);
  let machineRow: string[] | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith(MACHINE_SECTION) && i + 1 < lines.length) {
      machineRow = lines[i + 1].split(',');
      break;
    }
  }
  const c = machineRow ?? [];
  const priceRaw = col(c, 6);
  const price = priceRaw === '' ? null : Number(priceRaw);
  return {
    soundVolume: base === null ? factory.soundVolume : base.soundVolume,
    attractVolume: num(c, 1, factory.attractVolume),
    nightMuteStart: text(c, 2, factory.nightMuteStart),
    nightMuteEnd: text(c, 3, factory.nightMuteEnd),
    nightMuteOn: flag(c, 4, factory.nightMuteOn),
    coinsPerPlay: base === null ? factory.coinsPerPlay : base.coinsPerPlay,
    continueCoins: num(c, 5, factory.continueCoins),
    coinUnitPrice: price === null || !Number.isFinite(price) ? null : price,
    motionReduce: flag(c, 7, factory.motionReduce),
  };
}

/** `settings.csv`의 메모리 소유자 */
export class SettingsStore {
  private current: MachineParams = FACTORY_ADMIN_PARAMS.machine;
  private hearts = FACTORY_ADMIN_PARAMS.core.initialHearts;

  get machine(): MachineParams {
    return this.current;
  }

  set(next: MachineParams): void {
    this.current = next;
  }

  /** `params.csv`의 현재 `INITIAL HEARTS`를 거울로 받아 둔다 */
  mirrorInitialHearts(hearts: number): void {
    this.hearts = hearts;
  }

  serialize(): string {
    return settingsDocToCsv({ machine: this.current, initialHearts: this.hearts });
  }

  apply(csv: string): void {
    this.current = parseSettingsDocCsv(csv);
  }

  asSaveDocument(): SaveDocument {
    return {
      file: FILES.settings,
      serialize: () => this.serialize(),
      apply: (csv) => {
        this.apply(csv);
      },
    };
  }
}
