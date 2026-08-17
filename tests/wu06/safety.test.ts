// WU-06 T10 — SAV-704 유료 플레이 차단 5조건 (§12.4 · 계획 P-5)
//
// 판정 3축
//   ① 5조건 각각이 **단독으로** 유료 시작을 막는다
//   ② 차단 중에도 COIN은 적립되고 지갑은 줄지 않는다 (§12.4 "들어온 크레딧은 유지")
//   ③ 조건이 사라지면 다음 판정에서 곧바로 풀린다 (재부팅을 요구하지 않는다)

import { describe, expect, it } from 'vitest';
import {
  BLOCK_REASONS,
  BLOCK_TEXT,
  openPaidPlayGate,
  paidBlockedMessage,
  SafetyMonitor,
  SAVE_FAIL_STREAK_LIMIT,
  type BlockReason,
  type SafetyStoragePort,
} from '../../src/game/safety';
import { FILES } from '../../src/persist/csv';
import type { BootReportEntry } from '../../src/persist/storage';
import { fakeHealth } from './harness';

interface Rig {
  readonly monitor: SafetyMonitor;
  state: {
    backendKind: 'electron' | 'localStorage' | 'memory';
    saveFailStreak: number;
    boot: Map<string, BootReportEntry>;
    blockReason: 'credit_log_write' | null;
  };
}

function makeMonitor(): Rig {
  const state: Rig['state'] = {
    backendKind: 'electron',
    saveFailStreak: 0,
    boot: new Map<string, BootReportEntry>(),
    blockReason: null,
  };
  const storage: SafetyStoragePort = {
    get backendKind() {
      return state.backendKind;
    },
    get saveFailStreak() {
      return state.saveFailStreak;
    },
    bootOutcomeOf: (f) => state.boot.get(f) ?? null,
  };
  const monitor = new SafetyMonitor({
    storage,
    credits: {
      get blockReason() {
        return state.blockReason;
      },
    },
  });
  return { monitor, state };
}

describe('SAV-704 — 차단 5조건 정의', () => {
  it('조건은 정확히 5종이고 순서가 우선순위다', () => {
    expect([...BLOCK_REASONS]).toEqual([
      'io_disconnected',
      'storage_unavailable',
      'fatal_repeat',
      'credit_log_write',
      'params_unrecoverable',
    ]);
  });

  it('문구는 조건마다 있고 `PAID PLAY BLOCKED … SERVICE 호출` 형식이다', () => {
    for (const reason of BLOCK_REASONS) {
      const text = paidBlockedMessage(reason);
      expect(text.startsWith('PAID PLAY BLOCKED · ')).toBe(true);
      expect(text).toContain(BLOCK_TEXT[reason]);
      expect(text.endsWith('SERVICE 호출')).toBe(true);
    }
  });

  it('기본 게이트는 항상 통과다 (WU-03 동작 보존)', () => {
    expect(openPaidPlayGate().reason()).toBe(null);
  });

  it('아무 조건도 없으면 통과다', () => {
    const { monitor } = makeMonitor();
    expect(monitor.reason()).toBe(null);
    expect(monitor.blocked).toBe(false);
    expect(monitor.message()).toBe(null);
  });
});

describe('SAV-704 — ① I/O 미연결', () => {
  it('연결이 끊기면 차단하고 다시 연결하면 풀린다', () => {
    const { monitor } = makeMonitor();
    monitor.setIoConnected(false);
    expect(monitor.reason()).toBe<BlockReason>('io_disconnected');
    monitor.setIoConnected(true);
    expect(monitor.reason()).toBe(null);
  });

  it('기본값은 연결됨이다 (Serial 실물은 `[보류]`)', () => {
    expect(makeMonitor().monitor.ioConnected).toBe(true);
  });
});

describe('SAV-704 — ② 저장 불가', () => {
  it('메모리 백엔드로 강등되면 차단한다', () => {
    const rig = makeMonitor();
    rig.state.backendKind = 'memory';
    expect(rig.monitor.reason()).toBe<BlockReason>('storage_unavailable');
  });

  it('연속 저장 실패 3회면 차단하고 성공 1회로 풀린다 (가정 (다))', () => {
    const rig = makeMonitor();
    expect(SAVE_FAIL_STREAK_LIMIT).toBe(3);
    rig.state.saveFailStreak = 2;
    expect(rig.monitor.reason()).toBe(null);
    rig.state.saveFailStreak = 3;
    expect(rig.monitor.reason()).toBe<BlockReason>('storage_unavailable');
    rig.state.saveFailStreak = 0; // 저장 1회 성공
    expect(rig.monitor.reason()).toBe(null);
  });

  it('localStorage 백엔드는 그 자체로는 차단 사유가 아니다 (개발 모드)', () => {
    const rig = makeMonitor();
    rig.state.backendKind = 'localStorage';
    expect(rig.monitor.reason()).toBe(null);
  });
});

describe('SAV-704 — ③ 치명 오류 반복', () => {
  it('메인 프로세스가 SERVICE REQUIRED면 차단한다', () => {
    const rig = makeMonitor();
    rig.monitor.setHealth(fakeHealth({ serviceRequired: true, fatalCount: 3 }));
    expect(rig.monitor.reason()).toBe<BlockReason>('fatal_repeat');
  });

  it('health가 없으면(브라우저 모드) 이 조건은 서지 않는다', () => {
    const rig = makeMonitor();
    rig.monitor.setHealth(null);
    expect(rig.monitor.reason()).toBe(null);
  });

  it('정비 후 정상 부팅이면 풀린다', () => {
    const rig = makeMonitor();
    rig.monitor.setHealth(fakeHealth({ serviceRequired: true }));
    expect(rig.monitor.blocked).toBe(true);
    rig.monitor.setHealth(fakeHealth());
    expect(rig.monitor.reason()).toBe(null);
  });
});

describe('SAV-704 — ④ 크레딧 로그 기록 실패', () => {
  it('크레딧 서비스가 신호를 켜면 차단하고 끄면 풀린다', () => {
    const rig = makeMonitor();
    rig.state.blockReason = 'credit_log_write';
    expect(rig.monitor.reason()).toBe<BlockReason>('credit_log_write');
    rig.state.blockReason = null;
    expect(rig.monitor.reason()).toBe(null);
  });
});

describe('SAV-704 — ⑤ params 복구 불능 (가정 (가))', () => {
  function bootEntry(over: Partial<BootReportEntry>): BootReportEntry {
    return { file: FILES.params, outcome: 'factory', rewriteFailed: false, ...over };
  }

  it('공장값 재기록이 **실패**했을 때만 차단한다', () => {
    const rig = makeMonitor();
    rig.state.boot.set(FILES.params, bootEntry({ rewriteFailed: true }));
    expect(rig.monitor.reason()).toBe<BlockReason>('params_unrecoverable');
  });

  it('재기록이 성공했다면 경고로 끝난다 (차단하지 않는다)', () => {
    const rig = makeMonitor();
    rig.state.boot.set(FILES.params, bootEntry({ rewriteFailed: false }));
    expect(rig.monitor.reason()).toBe(null);
  });

  it('`backup_restored`는 차단 사유가 아니다', () => {
    const rig = makeMonitor();
    rig.state.boot.set(
      FILES.params,
      bootEntry({ outcome: 'backup_restored', rewriteFailed: true })
    );
    expect(rig.monitor.reason()).toBe(null);
  });
});

describe('SAV-704 — 우선순위와 동시 발생', () => {
  it('여러 조건이 겹치면 선언 순서가 이긴다', () => {
    const rig = makeMonitor();
    rig.state.blockReason = 'credit_log_write';
    rig.state.boot.set(FILES.params, {
      file: FILES.params,
      outcome: 'factory',
      rewriteFailed: true,
    });
    expect(rig.monitor.reason()).toBe<BlockReason>('credit_log_write');

    rig.monitor.setHealth(fakeHealth({ serviceRequired: true }));
    expect(rig.monitor.reason()).toBe<BlockReason>('fatal_repeat');

    rig.state.backendKind = 'memory';
    expect(rig.monitor.reason()).toBe<BlockReason>('storage_unavailable');

    rig.monitor.setIoConnected(false);
    expect(rig.monitor.reason()).toBe<BlockReason>('io_disconnected');
  });

  it('모든 조건을 해제하면 통과로 돌아온다', () => {
    const rig = makeMonitor();
    rig.state.backendKind = 'memory';
    rig.state.blockReason = 'credit_log_write';
    rig.monitor.setIoConnected(false);
    rig.monitor.setHealth(fakeHealth({ serviceRequired: true }));
    expect(rig.monitor.blocked).toBe(true);

    rig.state.backendKind = 'electron';
    rig.state.blockReason = null;
    rig.monitor.setIoConnected(true);
    rig.monitor.setHealth(fakeHealth());
    expect(rig.monitor.reason()).toBe(null);
  });
});

describe('§12.3 — 부팅 경고 목록', () => {
  it('복구 결과마다 코드가 붙는다', () => {
    const rig = makeMonitor();
    rig.state.boot.set(FILES.settings, {
      file: FILES.settings,
      outcome: 'backup_restored',
      rewriteFailed: false,
    });
    rig.state.boot.set(FILES.ranking, {
      file: FILES.ranking,
      outcome: 'factory',
      rewriteFailed: false,
    });
    rig.state.boot.set(FILES.stats, {
      file: FILES.stats,
      outcome: 'ok',
      rewriteFailed: false,
    });
    expect(rig.monitor.peekBootNotices().map((n) => n.code)).toEqual([
      'BACKUP RESTORED',
      'FACTORY DATA LOADED',
    ]);
  });

  it('`missing`(최초 부팅)은 경고가 아니다', () => {
    const rig = makeMonitor();
    for (const file of [FILES.settings, FILES.params, FILES.stats, FILES.ranking]) {
      rig.state.boot.set(file, { file, outcome: 'missing', rewriteFailed: false });
    }
    expect(rig.monitor.peekBootNotices()).toEqual([]);
  });

  it('STORAGE LOW·SERVICE REQUIRED도 경고 목록에 들어간다', () => {
    const rig = makeMonitor();
    rig.monitor.setHealth(fakeHealth({ storageLow: true, serviceRequired: true }));
    expect(rig.monitor.peekBootNotices().map((n) => n.code)).toEqual([
      'STORAGE LOW',
      'SERVICE REQUIRED',
    ]);
  });
});
