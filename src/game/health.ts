// 메인 프로세스 상태 조회 (§12.3 STORAGE LOW · SERVICE REQUIRED · §12.1 machine.json)
//
// 렌더러는 디스크 여유도 치명 오류 횟수도 직접 알 수 없다. preload가 노출한 `gameFS.health()`
// 하나가 유일한 창구이며, 브라우저 개발 모드에서는 **null**이다 (작업 계획 P-8).
//
// 형태 검사를 여기서 한 번만 한다 — IPC는 `unknown`을 돌려주므로 타입을 믿을 수 없다.

import type { Storage } from '../persist/storage';

/** §12.1 `machine.json` 본문 (electron/safe-write.cjs `machineInfo`와 같은 필드) */
export interface MachineInfo {
  readonly machineId: string;
  readonly appVersion: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly ioBoard: string;
  readonly updatedAt: string;
}

export interface HealthReport {
  /** 60초 창에 남아 있는 치명 오류 수 (§12.3) */
  readonly fatalCount: number;
  /** ADM-306 — 자동 재실행이 중지된 상태인가 */
  readonly serviceRequired: boolean;
  /** 남은 디스크 바이트. 측정 불가면 null */
  readonly freeBytes: number | null;
  /** §12.3 — 남은 공간 200MB 미만 */
  readonly storageLow: boolean;
  readonly machine: MachineInfo | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toMachine(raw: unknown): MachineInfo | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (str(m.machineId) === '') return null;
  return {
    machineId: str(m.machineId),
    appVersion: str(m.appVersion),
    electron: str(m.electron),
    chrome: str(m.chrome),
    node: str(m.node),
    platform: str(m.platform),
    arch: str(m.arch),
    osRelease: str(m.osRelease),
    ioBoard: str(m.ioBoard),
    updatedAt: str(m.updatedAt),
  };
}

/** IPC가 돌려준 임의 값을 `HealthReport`로 좁힌다. 형태가 아니면 null */
export function toHealthReport(raw: unknown): HealthReport | null {
  if (raw === null || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  const free = typeof h.freeBytes === 'number' && Number.isFinite(h.freeBytes) ? h.freeBytes : null;
  return {
    fatalCount: typeof h.fatalCount === 'number' ? h.fatalCount : 0,
    serviceRequired: h.serviceRequired === true,
    freeBytes: free,
    storageLow: h.storageLow === true,
    machine: toMachine(h.machine),
  };
}

/** `Storage`가 들고 있는 preload API로 상태를 읽는다. 브라우저 모드는 null */
export async function readHealth(storage: Storage): Promise<HealthReport | null> {
  const fs = storage.gameFs;
  if (fs?.health === undefined) return null;
  try {
    return toHealthReport(await fs.health());
  } catch {
    return null;
  }
}
