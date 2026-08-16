// 현장 진단 모델 (§11.7 · admin §6.3·§10 — 작업 계획 §8)
//
// 화면이 아니라 **모델**이다. Phaser도 DOM도 시계도 모르고 `nowMs`를 인자로 받는다.
// 그래서 `INPUT TEST`의 5초 STUCK(ADM-305)·Serial 10회 실패 전이(ADM-304)·저장소 프로브
// (ADM-301 준비)가 전부 Node 테스트로 판정된다.

import type { InputAction, PlayerId } from '../../core/types';
import type { BackendKind } from '../../persist/storage';
import type { InputStatus, PhaseEvent } from '../input';
import { STUCK_HOLD_MS } from '../input';

// ── INPUT TEST (admin §10.1 · ADM-305) ────────────────────────────────────

/** admin §10.1이 개별 표시를 요구하는 입력 9종 (P1·P2 각각) */
export const INPUT_TEST_ACTIONS: readonly InputAction[] = [
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'BUTTON1',
  'BUTTON2',
  'START',
  'COIN',
  'SERVICE',
];

/** 동시에 눌리면 경고를 내는 반대 방향 쌍 (admin §10.1) */
export const OPPOSING_PAIRS: readonly (readonly [InputAction, InputAction])[] = [
  ['UP', 'DOWN'],
  ['LEFT', 'RIGHT'],
];

interface InputSignal {
  readonly player: PlayerId;
  readonly action: InputAction;
  readonly pressed: boolean;
  readonly presses: number;
  /** 마지막 입력 시각(ms). 한 번도 없으면 null */
  readonly lastAtMs: number | null;
  /** 지금 눌린 상태면 유지 시간, 아니면 마지막 유지 시간 */
  readonly holdMs: number;
  /** admin §10.1 — 5초 이상 유지되면 `STUCK INPUT` */
  readonly stuck: boolean;
}

interface SignalState {
  pressed: boolean;
  presses: number;
  lastAtMs: number | null;
  downAtMs: number;
  holdMs: number;
}

function emptySignal(): SignalState {
  return { pressed: false, presses: 0, lastAtMs: null, downAtMs: 0, holdMs: 0 };
}

function signalKey(player: PlayerId, action: InputAction): string {
  return `${String(player)}:${action}`;
}

/**
 * `PhaseSource`가 주는 누름/뗌만 먹는다. P2도 **별도로 표시**한다 (admin §4.1 —
 * 관리자 화면은 P2를 무시하지만 INPUT TEST에서는 보여 준다).
 */
export class InputTestModel {
  private readonly states = new Map<string, SignalState>();

  handle(e: PhaseEvent, nowMs: number): void {
    const key = signalKey(e.player, e.action);
    const s = this.states.get(key) ?? emptySignal();
    if (e.phase === 'down') {
      s.pressed = true;
      s.presses += 1;
      s.lastAtMs = nowMs;
      s.downAtMs = nowMs;
      s.holdMs = 0;
    } else {
      s.pressed = false;
      s.holdMs = Math.max(0, nowMs - s.downAtMs);
    }
    this.states.set(key, s);
  }

  /** 누른 채로 시간이 흐르면 홀드 시간이 자란다 */
  signalOf(player: PlayerId, action: InputAction, nowMs: number): InputSignal {
    const s = this.states.get(signalKey(player, action)) ?? emptySignal();
    const holdMs = s.pressed ? Math.max(0, nowMs - s.downAtMs) : s.holdMs;
    return {
      player,
      action,
      pressed: s.pressed,
      presses: s.presses,
      lastAtMs: s.lastAtMs,
      holdMs,
      stuck: s.pressed && holdMs >= STUCK_HOLD_MS,
    };
  }

  signals(player: PlayerId, nowMs: number): readonly InputSignal[] {
    return INPUT_TEST_ACTIONS.map((a) => this.signalOf(player, a, nowMs));
  }

  /** 고착된 입력 전량 (P1·P2) — `STUCK INPUT · P1 LEFT` 문구의 입력 */
  stuckSignals(nowMs: number): readonly InputSignal[] {
    const out: InputSignal[] = [];
    for (const player of [1, 2] as const) {
      for (const signal of this.signals(player, nowMs)) if (signal.stuck) out.push(signal);
    }
    return out;
  }

  /** 반대 방향 동시 입력 — 배선·스위치 이상 신호 */
  opposing(player: PlayerId, nowMs: number): readonly (readonly [InputAction, InputAction])[] {
    return OPPOSING_PAIRS.filter(
      ([a, b]) => this.signalOf(player, a, nowMs).pressed && this.signalOf(player, b, nowMs).pressed
    );
  }

  reset(): void {
    this.states.clear();
  }
}

// ── SERIAL I/O TEST (admin §10.4 · ADM-304) ───────────────────────────────

/** §12.3 — 1초 간격 재연결, 10회 실패 시 `SERVICE REQUIRED` */
export const SERIAL_FAIL_LIMIT = 10;
export const SERIAL_RETRY_MS = 1000;

/**
 * 어댑터 상태 모델. 실물 포트·펌웨어·패킷 원문은 §17 `[보류]` #1이므로 **상태 전이만** 갖는다.
 */
export class SerialState {
  private current: InputStatus = 'connected';
  private failures = 0;
  private lastPacketAtMs: number | null = null;

  get status(): InputStatus {
    return this.current;
  }

  get reconnectAttempts(): number {
    return this.failures;
  }

  /** ADM-304 — 10회 재연결 실패면 서비스 필요 상태로 굳는다 */
  get serviceRequired(): boolean {
    return this.failures >= SERIAL_FAIL_LIMIT;
  }

  get lastPacketMs(): number | null {
    return this.lastPacketAtMs;
  }

  setStatus(next: InputStatus): void {
    this.current = next;
    if (next === 'connected') this.failures = 0;
  }

  /** 재연결 1회 실패 */
  noteReconnectFailure(): void {
    this.current = 'disconnected';
    this.failures += 1;
  }

  notePacket(nowMs: number): void {
    this.lastPacketAtMs = nowMs;
  }
}

// ── STORAGE TEST (admin §10.5) ────────────────────────────────────────────

/** `Storage.backend`가 그대로 만족하는 최소 표면 */
interface StorageProbePort {
  readonly kind: BackendKind;
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string | null>;
}

export const STORAGE_PROBE_FILE = '__probe.tmp';

export interface StorageProbeResult {
  readonly backend: BackendKind;
  /** 임시 파일 쓰기 → 읽기 → 비우기가 전부 성공했는가 */
  readonly writable: boolean;
  readonly readBackOk: boolean;
  readonly error: string | null;
}

/** 쓰기 권한 검사 — 실제로 써 보고 읽어 본다 (admin §10.5) */
export async function probeStorage(port: StorageProbePort): Promise<StorageProbeResult> {
  const token = `probe-${String(Date.now())}`;
  try {
    await port.write(STORAGE_PROBE_FILE, token);
    const back = await port.read(STORAGE_PROBE_FILE);
    await port.write(STORAGE_PROBE_FILE, '');
    return {
      backend: port.kind,
      writable: true,
      readBackOk: back === token,
      error: null,
    };
  } catch (err) {
    return { backend: port.kind, writable: false, readBackOk: false, error: String(err) };
  }
}

// ── OVERVIEW 종합 상태 (admin §6.3) ───────────────────────────────────────

export type OverallStatus = 'READY' | 'CHECK' | 'SERVICE_REQUIRED';

export interface StatusInput {
  /** Serial(입력 어댑터) 연결 여부 */
  readonly ioConnected: boolean;
  readonly storageWritable: boolean;
  /** 메모리 백엔드로 강등됐는가 — 출시 기기에서는 유료 플레이 차단 사유다 (§12.4) */
  readonly memoryBackend: boolean;
  /** 60초 내 치명 오류 수 (§12.3) */
  readonly fatalErrorsIn60s: number;
  readonly backupRestored: boolean;
  readonly clockChanged: boolean;
  /** `PARAM_DATA_VERSION` 불일치로 편집분을 폐기했는가 (§12.1) */
  readonly paramsVersionMismatch: boolean;
  /** `COIN UNIT PRICE` 미설정 — OVERVIEW 경고 (§11.3) */
  readonly coinPriceUnset: boolean;
  /** 고착된 입력이 있는가 */
  readonly stuckInput: boolean;
}

export const OVERALL_GLYPH: Readonly<Record<OverallStatus, string>> = {
  READY: '●',
  CHECK: '▲',
  SERVICE_REQUIRED: '×',
};

/** admin §6.3 3단계 — 빨강 조건이 하나라도 있으면 빨강, 없으면 노랑 조건을 본다 */
export function overallStatus(i: StatusInput): OverallStatus {
  if (!i.ioConnected || !i.storageWritable || i.memoryBackend || i.fatalErrorsIn60s >= 3) {
    return 'SERVICE_REQUIRED';
  }
  if (
    i.backupRestored ||
    i.clockChanged ||
    i.paramsVersionMismatch ||
    i.coinPriceUnset ||
    i.stuckInput
  ) {
    return 'CHECK';
  }
  return 'READY';
}

/** 상태를 만든 사유 목록 — OVERVIEW `최근 장애` 카드가 그대로 그린다 */
export function statusReasons(i: StatusInput): readonly string[] {
  const out: string[] = [];
  if (!i.ioConnected) out.push('I/O DISCONNECTED · 코인/조작 불가');
  if (!i.storageWritable) out.push('STORAGE UNWRITABLE · 저장 경로 확인');
  if (i.memoryBackend) out.push('MEMORY BACKEND · 유료 플레이 차단');
  if (i.fatalErrorsIn60s >= 3) out.push('FATAL ERROR ×3 · 자동 재실행 중지');
  if (i.backupRestored) out.push('BACKUP RESTORED · 마지막 정상 설정을 불러왔습니다');
  if (i.clockChanged) out.push('CLOCK CHANGED · 시간 변경 감지');
  if (i.paramsVersionMismatch) out.push('PARAM DATA VERSION 불일치 · 공장값 적용');
  if (i.coinPriceUnset) out.push('COIN UNIT PRICE 미설정 · ESTIMATED GROSS 숨김');
  if (i.stuckInput) out.push('STUCK INPUT · 배선/스위치 확인');
  return out;
}
