// WU-06 T10 — SAV-702 · ADM-302 저장 실패 복구 UI (계획 P-13)
//
// WU-05는 `SAVE FAILED` **상태**까지였다. 재시도 경로도, 오류 로그도, "화면을 닫지 않는다"의
// 실체도 없었다. 여기서 셋 다 판정한다.

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS } from '../../src/core/adminParams';
import { StatsModel, type AuditEvent, type WallClock } from '../../src/core/stats';
import type { Clock, InputAction } from '../../src/core/types';
import {
  AdminController,
  type AdminControllerDeps,
  type AdminCreditsPort,
} from '../../src/game/admin/controller';
import { ParamsStore } from '../../src/game/admin/paramsDoc';
import { ADMIN_TEXT } from '../../src/game/admin/view';
import { SettingsStore } from '../../src/game/settingsDoc';
import { createSilentSfx } from '../../src/game/sfx';
import { FILES } from '../../src/persist/csv';
import { memoryStorage } from './harness';

const wall: WallClock = {
  nowMs: () => Date.parse('2026-08-17T09:12:03.114Z'),
  localDate: () => '2026-08-17',
  nowIso: () => '2026-08-17T09:12:03.114Z',
};

function fakeCredits(stats: StatsModel): AdminCreditsPort {
  let price: number | null = null;
  return {
    view: () => stats.view(price),
    balance: () => ({ paid: 0, event: 0 }),
    grantEvent: () => 0,
    resetPaidStatistics: () => undefined,
    resetEventStatistics: () => undefined,
    setCoinUnitPrice: (p) => {
      price = p;
    },
    setCoinsPerPlay: () => undefined,
    setContinueCoins: () => undefined,
    coinsPerPlay: 1,
    continueCoins: 1,
    coinUnitPrice: price,
  };
}

function makeRig(failWrites = { on: false }, systemCalls?: string[]) {
  let ms = 0;
  const clock: Clock = { now: () => ms };
  const storage = memoryStorage({ failWrites });
  const audits: AuditEvent[] = [];
  const stats = new StatsModel({ wall });
  const params = new ParamsStore();
  const settings = new SettingsStore();
  params.set(FACTORY_ADMIN_PARAMS);
  settings.set(FACTORY_ADMIN_PARAMS.machine);
  storage.storage.register(params.asSaveDocument());
  storage.storage.register(settings.asSaveDocument());

  const deps: AdminControllerDeps = {
    clock,
    nowIso: () => wall.nowIso(),
    params,
    settings,
    storage: storage.storage,
    solverGate: {
      validate: () => ({ ok: true, failures: [], elapsedMs: 10, boardsChecked: 15 }),
    },
    credits: fakeCredits(stats),
    ranking: { size: 0, clear: () => undefined },
    audit: (e) => audits.push(e),
    sfx: createSilentSfx(),
    applyParams: () => undefined,
    leaveAdmin: () => undefined,
    // FIX 사이클 1 (검증 F-1) — 실행 여부를 기록하는 가짜 OS 채널
    ...(systemCalls === undefined
      ? {}
      : {
          system: {
            restart: () => {
              systemCalls.push('restart');
              return Promise.resolve('ok');
            },
            reboot: () => {
              systemCalls.push('reboot');
              return Promise.resolve('ok');
            },
            shutdown: () => {
              systemCalls.push('shutdown');
              return Promise.resolve('ok');
            },
          },
        }),
  };
  const admin = new AdminController(deps);
  admin.enter();
  return {
    admin,
    storage,
    audits,
    failWrites,
    press: (a: InputAction) => admin.handle(a),
    advance: (by: number) => {
      ms += by;
    },
    /** 위험 작업 확인 — `H`를 ms만큼 누른다 (wu05 harness `holdConfirm`과 동일) */
    holdConfirm(hold: number): void {
      admin.handle('BUTTON1');
      ms += hold;
      admin.tick();
      admin.phase({ player: 1, action: 'BUTTON1', phase: 'up', sourceId: 'k:H' });
    },
    focus(rowId: string): boolean {
      for (let i = 0; i <= admin.view().rows.length; i += 1) {
        const view = admin.view();
        if (view.rows[view.cursor]?.id === rowId) return true;
        admin.handle('DOWN');
      }
      return false;
    },
  };
}

describe('SAV-702 · ADM-302 — 저장 실패 복구 화면', () => {
  it('저장이 실패하면 복구 화면이 열린다', async () => {
    const rig = makeRig({ on: true });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(false);
    expect(rig.admin.saveState).toBe('SAVE FAILED');
    expect(rig.admin.isSaveFailedPrompt).toBe(true);
    const ids = rig.admin.view().rows.map((r) => r.id);
    expect(ids).toEqual([
      'savefailed.head',
      'savefailed.stay',
      'savefailed.test',
      'savefailed.retry',
    ]);
  });

  it('복구 화면이 `RUN STORAGE TEST` 경로를 안내한다', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    const test = rig.admin.view().rows.find((r) => r.id === 'savefailed.test');
    expect(test?.value).toBe(ADMIN_TEXT.storageTestHint);
    expect(test?.value).toContain('RUN STORAGE TEST');
  });

  it('`G`(BUTTON2)로는 화면을 벗어나지 못한다 (ADM-302)', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    rig.press('BUTTON2');
    rig.press('BUTTON2');
    expect(rig.admin.isSaveFailedPrompt).toBe(true);
    expect(rig.admin.isEntered).toBe(true);
  });

  it('`H`(BUTTON1) RETRY가 성공하면 화면이 닫히고 SAVED가 된다', async () => {
    const rig = makeRig({ on: true });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    expect(rig.admin.isSaveFailedPrompt).toBe(true);

    rig.failWrites.on = false; // 저장 경로가 되살아났다
    expect(await rig.admin.retrySave()).toBe(true);
    expect(rig.admin.saveState).toBe('SAVED');
    expect(rig.admin.isSaveFailedPrompt).toBe(false);
    expect(rig.storage.kv.dump(FILES.params)).not.toBe(null);
  });

  it('RETRY가 다시 실패하면 화면을 유지한다 (재시도 횟수 제한 없음)', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    expect(await rig.admin.retrySave()).toBe(false);
    expect(await rig.admin.retrySave()).toBe(false);
    expect(rig.admin.isSaveFailedPrompt).toBe(true);
    expect(rig.admin.saveState).toBe('SAVE FAILED');
  });

  it('행에서 `H`를 눌러도 RETRY가 돈다 (레버+2버튼 경로)', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    rig.failWrites.on = false;
    expect(rig.focus('savefailed.retry')).toBe(true);
    rig.press('BUTTON1');
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.admin.saveState).toBe('SAVED');
  });
});

describe('SAV-702 — 오류 로그 기록', () => {
  it('저장 실패가 `app:logError`로 나간다', async () => {
    const rig = makeRig({ on: true });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    expect(rig.storage.logged.some((m) => m.startsWith('SAVE FAILED'))).toBe(true);
  });

  it('`EXIT & SAVE` 실패도 로그를 남긴다 (ADM-307)', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    expect(rig.storage.logged).toContain('SAVE FAILED EXIT & SAVE');
  });

  it('RETRY 실패도 감사 로그에 남는다', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    await rig.admin.retrySave();
    expect(rig.audits.some((e) => e.kind === 'PARAM_SAVE' && e.target === 'RETRY SAVE')).toBe(true);
  });

  it('성공 경로에서는 오류 로그가 없다', async () => {
    const rig = makeRig({ on: false });
    expect(await rig.admin.exitAndSave()).toBe(true);
    expect(rig.storage.logged).toEqual([]);
    expect(rig.admin.isSaveFailedPrompt).toBe(false);
  });
});

describe('ADM-302 — 상태 문구', () => {
  it('`SAVE FAILED` 문구가 H 재시도 / G 취소를 안내한다', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    expect(rig.admin.view().saveState).toBe(ADMIN_TEXT.saveFailed);
    expect(ADMIN_TEXT.saveFailed).toContain('H 재시도');
  });

  it('토스트는 저장 경로 확인을 말한다 (§12.3 다음 행동)', async () => {
    const rig = makeRig({ on: true });
    await rig.admin.exitAndSave();
    expect(rig.admin.view().toast?.text).toBe(ADMIN_TEXT.savePathHint);
    expect(rig.admin.view().toast?.level).toBe('error');
  });

  it('MACHINE SETTINGS 디바운스 저장 실패도 복구 화면을 연다', async () => {
    const rig = makeRig({ on: false });
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT'); // 값 1개 변경 → 800ms 디바운스 예약
    rig.failWrites.on = true;
    rig.advance(1000);
    rig.admin.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.admin.saveState).toBe('SAVE FAILED');
    expect(rig.admin.isSaveFailedPrompt).toBe(true);
  });
});

// ── FIX 사이클 1 (검증 F-1) — ADM-307 시스템 액션 저장 가드 ────────────────

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ADM-307 — 저장 성공 뒤에만 OS 액션이 실행된다 (검증 F-1)', () => {
  it('저장이 실패하면 RESTART GAME이 실행되지 않고 복구 화면이 열린다', async () => {
    const calls: string[] = [];
    const rig = makeRig({ on: true }, calls);
    rig.admin.goTo(['MAINTENANCE', 'M_SYSTEM']);
    rig.press('BUTTON1'); // RESTART GAME (HIGH — 2초 홀드)
    rig.holdConfirm(2000);
    await flush();

    expect(calls).toEqual([]); // OS 액션이 실행되지 않았다
    expect(rig.admin.saveState).toBe('SAVE FAILED');
    expect(rig.admin.isSaveFailedPrompt).toBe(true); // 화면이 유지된다 (ADM-302)
    const action = rig.audits.find((e) => e.kind === 'SYSTEM_ACTION');
    expect(action?.result).toBe('save_failed'); // 감사 로그가 실패를 정직하게 남긴다
  });

  it('REBOOT · SHUTDOWN도 같은 가드를 통과한다', async () => {
    // 첫 실패가 복구 화면을 열어 메뉴를 잠그므로(ADM-302) 액션마다 새 rig로 판정한다
    for (const rows of [1, 2] as const) {
      const calls: string[] = [];
      const rig = makeRig({ on: true }, calls);
      rig.admin.goTo(['MAINTENANCE', 'M_SYSTEM']);
      for (let i = 0; i < rows; i += 1) rig.press('DOWN'); // REBOOT(1) · SHUTDOWN(2)
      rig.press('BUTTON1'); // CRITICAL — 3초 홀드
      rig.holdConfirm(3000);
      await flush();

      expect(calls).toEqual([]);
      expect(rig.admin.isSaveFailedPrompt).toBe(true);
      expect(rig.audits.find((e) => e.kind === 'SYSTEM_ACTION')?.result).toBe('save_failed');
    }
  });

  it('저장이 성공하면 RESTART GAME이 실행되고 결과가 ok로 남는다', async () => {
    const calls: string[] = [];
    const rig = makeRig({ on: false }, calls);
    rig.admin.goTo(['MAINTENANCE', 'M_SYSTEM']);
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flush();

    expect(calls).toEqual(['restart']);
    expect(rig.admin.isSaveFailedPrompt).toBe(false);
    const action = rig.audits.find((e) => e.kind === 'SYSTEM_ACTION');
    expect(action?.result).toBe('ok');
  });
});
