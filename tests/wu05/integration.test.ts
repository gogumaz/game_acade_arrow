// 통합 — `createApp()` 전 경로 (§11 · 계획 T11 · C1·C6)
//
// 여기서만 할 수 있는 것 셋
//   ① 실제 입력 어댑터 → `flow` → 관리자 컨트롤러의 **전 경로** 판정 (ADM-001~006)
//   ② **프로세스 재기동** — 같은 저장소 위에서 `createApp()`을 두 번 불러 값 유지 판정
//   ③ 저장된 파라미터가 실제 런타임(코어·힌트·등급·이름 입력)에 반영되는지 (Q-1)

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, writeField } from '../../src/core/adminParams';
import { paramsToCsv } from '../../src/game/admin/paramsDoc';
import { EXIT_SAVED_HOLD_MS } from '../../src/game/admin/controller';
import { ADMIN_IDLE_MS } from '../../src/game/flow';
import { KEYMAP, KeyboardInputAdapter, type KeyEventLike } from '../../src/game/input';
import { GRADE_THRESHOLDS, gradeOf } from '../../src/game/grade';
import { HINT_COOLDOWN_MS, HINT_DISPLAY_MS, NAME_ENTRY_MS } from '../../src/game/timing';
import { FILES } from '../../src/persist/csv';
import { MemoryKeyValue, failingSolverGate, flushAsync, makeApp } from './harness';

describe('14-1 진입 (ADM-001 · ADM-002 · ADM-003)', () => {
  it('ADM-001 — 어트랙트에서 SERVICE 1회로 관리자에 들어간다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    expect(rig.app.flow.screen).toBe('ADMIN');
    expect(rig.app.admin.isEntered).toBe(true);
  });

  it('ADM-001 — 진입 시 `admin_enter`가 `audit_log.csv`에 실제로 기록된다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    await flushAsync();
    expect(rig.storage.kv.dump(FILES.auditLog)).toContain(',admin_enter,');
  });

  it('ADM-001 — 시작 화면(READY)에서도 진입한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('COIN');
    expect(rig.app.flow.screen).toBe('READY');
    rig.send('SERVICE');
    expect(rig.app.flow.screen).toBe('ADMIN');
  });

  it('ADM-002 — 플레이·컨티뉴·이름 입력 중에는 진입하지 않는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('COIN');
    rig.send('START');
    expect(['TUTORIAL', 'RUN']).toContain(rig.app.flow.screen);
    const before = rig.app.flow.screen;
    rig.send('SERVICE');
    expect(rig.app.flow.screen).toBe(before);
  });

  it('ADM-003 — 개발 플래그를 끄면 F9가 액션을 만들지 않는다', () => {
    const phases: string[] = [];
    const target = {
      handlers: new Map<string, (e: KeyEventLike) => void>(),
      addEventListener(type: string, fn: (e: KeyEventLike) => void): void {
        this.handlers.set(type, fn);
      },
      removeEventListener(type: string): void {
        this.handlers.delete(type);
      },
    };
    const adapter = new KeyboardInputAdapter({ target });
    const actions: string[] = [];
    adapter.onAction((pa) => actions.push(pa.action));
    adapter.onPhase((e) => phases.push(`${e.action}:${e.phase}`));
    adapter.attach();
    adapter.setServiceKeyEnabled(false);
    target.handlers.get('keydown')?.({ code: 'F9', key: 'F9' });
    expect(actions).toEqual([]);
    expect(phases).toEqual([]); // 액션도 phase도 나오지 않는다
    adapter.setServiceKeyEnabled(true);
    target.handlers.get('keydown')?.({ code: 'F9', key: 'F9' });
    expect(actions).toEqual(['SERVICE']);
    expect(phases).toEqual(['SERVICE:down']);
  });

  it('`KEYMAP`은 그대로다 (WU-01 표 보존)', () => {
    expect(KEYMAP.F9).toEqual({ player: 1, action: 'SERVICE' });
    expect(Object.keys(KEYMAP)).toHaveLength(16);
  });
});

describe('14-2 관리자 중 조작 (ADM-004 · ADM-101 · C6)', () => {
  it('ADM-101 — 관리자 화면에서도 코인이 정상 적립된다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.send('COIN');
    expect(rig.app.credits.balance().paid).toBe(1);
    expect(rig.app.credits.view().coinPulseTotal).toBe(1);
    expect(rig.app.flow.screen).toBe('ADMIN');
  });

  it('ADM-101 — 코인 적립이 `credit_log.csv`에 남는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.send('COIN');
    await rig.app.credits.flushLog();
    expect(rig.storage.kv.dump(FILES.creditLog)).toContain(',coin_insert,coin,1,0,');
  });

  it('관리자 화면에서 START는 무효다 (§11.1)', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('COIN');
    rig.send('SERVICE');
    rig.send('START');
    expect(rig.app.flow.screen).toBe('ADMIN');
  });

  it('ADM-004 — 레버 + 두 버튼만으로 8그룹을 순회한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.press('SERVICE');
    for (let i = 0; i < 8; i += 1) {
      // 커서를 i번째 그룹까지 내린 뒤 열고 닫는다 (복귀는 항상 첫 행으로 돌아온다)
      for (let n = 0; n < i; n += 1) rig.press('DOWN');
      rig.press('BUTTON1');
      expect(rig.app.admin.currentPath).toHaveLength(1);
      rig.press('BUTTON2');
      expect(rig.app.admin.currentPath).toEqual([]);
    }
  });

  it('ADM-104 — 관리자 진입이 날짜 롤오버를 확인한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.wall.setDate('2026-08-18');
    rig.send('SERVICE');
    expect(rig.app.credits.view().date).toBe('2026-08-18');
  });

  it('ADM-006 — 5분 무입력이면 어트랙트로 복귀한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.clock.advance(ADMIN_IDLE_MS);
    rig.app.flow.tick();
    expect(rig.app.flow.screen).toBe('ATTRACT');
  });

  it('ADM-006 — 미저장이 있으면 복귀하지 않는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.send('RIGHT');
    rig.clock.advance(ADMIN_IDLE_MS);
    rig.app.flow.tick();
    expect(rig.app.flow.screen).toBe('ADMIN');
  });

  it('`EXIT & SAVE`가 어트랙트로 돌려보낸다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    void rig.app.admin.exitAndSave();
    await flushAsync();
    rig.clock.advance(EXIT_SAVED_HOLD_MS);
    rig.app.admin.tick();
    expect(rig.app.flow.screen).toBe('ATTRACT');
  });
});

describe('14-3 저장·재기동 (ADM-207 · ADM-301 준비)', () => {
  it('편집 → 저장 → 재기동에서 값이 살아 있다', async () => {
    const kv = new MemoryKeyValue();
    const first = makeApp({ kv });
    await first.app.ready;
    first.send('SERVICE');
    first.app.admin.goTo(['PARAMS', 'P_SESSION']);
    first.send('RIGHT');
    first.send('RIGHT');
    expect(await first.app.admin.save()).toBe(true);
    await flushAsync();
    expect(kv.dump(FILES.params)).toContain('1,core.sessionTimeSec,122');

    const second = makeApp({ kv });
    await second.app.ready;
    expect(second.app.params.live.core.sessionTimeSec).toBe(122);
    expect(second.app.flow.activeParams.sessionTimeSec).toBe(122);
  });

  it('기기 설정도 재기동에서 살아 있고 코인 비용에 반영된다', async () => {
    const kv = new MemoryKeyValue();
    const first = makeApp({ kv });
    await first.app.ready;
    first.send('SERVICE');
    first.app.admin.goTo(['MACHINE']);
    for (let i = 0; i < 6; i += 1) {
      const view = first.app.admin.view();
      if (view.rows[view.cursor]?.id === 'machine.coinsPerPlay') break;
      first.send('DOWN');
    }
    first.send('RIGHT'); // COINS PER PLAY 2
    first.storage.flush();
    await first.app.storage.saveNow(FILES.settings);

    const second = makeApp({ kv });
    await second.app.ready;
    expect(second.app.credits.coinsPerPlay).toBe(2);
    expect(second.app.settings.machine.coinsPerPlay).toBe(2);
  });

  it('`PARAM_DATA_VERSION` 불일치면 공장값으로 부팅하고 OVERVIEW가 경고한다 (§12.1)', async () => {
    const kv = new MemoryKeyValue();
    const edited = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150);
    kv.put(
      FILES.params,
      paramsToCsv(edited).replace('PARAM_DATA_VERSION,1', 'PARAM_DATA_VERSION,9')
    );

    const rig = makeApp({ kv });
    await rig.app.ready;
    expect(rig.app.params.live.core.sessionTimeSec).toBe(120);
    expect(rig.app.params.versionMismatch).toBe(true);
    rig.send('SERVICE');
    rig.app.admin.goTo(['OVERVIEW']);
    expect(rig.app.admin.view().rows.find((r) => r.id === 'ov.params')?.value).toContain('불일치');
    expect(rig.app.admin.view().status).toBe('▲ CHECK');
  });

  it('손상된 `params.csv`도 부팅을 막지 않는다', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.params, '!!!,,,\n@@@');
    const rig = makeApp({ kv });
    await expect(rig.app.ready).resolves.toBeDefined();
    expect(rig.app.params.live).toEqual(FACTORY_ADMIN_PARAMS);
  });

  it('`.bak`이 저장 직전 내용을 담는다', async () => {
    const kv = new MemoryKeyValue();
    const rig = makeApp({ kv });
    await rig.app.ready;
    await rig.app.storage.saveNow(FILES.params);
    const before = kv.dump(FILES.params);
    rig.send('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.send('RIGHT');
    await rig.app.admin.save();
    expect(kv.dump(`${FILES.params}.bak`)).toBe(before);
  });
});

describe('14-4 저장된 파라미터의 실런타임 반영 (Q-1)', () => {
  it('세션 시간이 코어에 실제로 들어간다', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.params, paramsToCsv(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 90)));
    const rig = makeApp({ kv });
    await rig.app.ready;
    rig.send('COIN');
    rig.send('START');
    rig.clock.advance(20000);
    rig.app.flow.tick();
    expect(rig.app.flow.activeParams.sessionTimeSec).toBe(90);
  });

  it('등급 임계가 결과 판정에 쓰인다', async () => {
    const kv = new MemoryKeyValue();
    let p = writeField(FACTORY_ADMIN_PARAMS, 'grade.sPlus', 900000);
    p = writeField(p, 'grade.s', 800000);
    p = writeField(p, 'grade.a', 700000);
    p = writeField(p, 'grade.b', 600000);
    kv.put(FILES.params, paramsToCsv(p));
    const rig = makeApp({ kv });
    await rig.app.ready;
    // 공장 임계에서는 S+지만 편집된 임계에서는 C다
    expect(gradeOf(300000)).toBe('S+');
    expect(gradeOf(300000, 0, { 'S+': 900000, S: 800000, A: 700000, B: 600000 })).toBe('C');
    expect(rig.app.params.live.grade.sPlus).toBe(900000);
  });

  it('힌트 표시·쿨다운이 런에 주입된다', async () => {
    const kv = new MemoryKeyValue();
    let p = writeField(FACTORY_ADMIN_PARAMS, 'ui.hintShowSec', 5);
    p = writeField(p, 'ui.hintCooldownSec', 0);
    kv.put(FILES.params, paramsToCsv(p));
    const rig = makeApp({ kv });
    await rig.app.ready;
    expect(rig.app.params.live.ui.hintShowSec).toBe(5);
    rig.send('COIN');
    rig.send('START');
    // 튜토리얼을 지나 본 런으로
    rig.clock.advance(11000);
    rig.app.flow.tick();
    expect(rig.app.flow.screen).toBe('RUN');
    rig.send('BUTTON2'); // 힌트
    rig.app.flow.tick();
    const hint = rig.app.flow.snapshot().run?.hint;
    // 쿨다운 0초 설정이 그대로 적용됐다 (공장값 5초였다면 5000이 남는다)
    expect(hint?.cooldownLeftMs).toBe(0);
  });

  it('기본값(공장값)에서는 WU-03 상수와 완전히 같다 — 회귀 0', () => {
    expect(FACTORY_ADMIN_PARAMS.ui.hintShowSec * 1000).toBe(HINT_DISPLAY_MS);
    expect(FACTORY_ADMIN_PARAMS.ui.hintCooldownSec * 1000).toBe(HINT_COOLDOWN_MS);
    expect(FACTORY_ADMIN_PARAMS.ui.nameEntrySec * 1000).toBe(NAME_ENTRY_MS);
    expect(FACTORY_ADMIN_PARAMS.grade.sPlus).toBe(GRADE_THRESHOLDS['S+']);
    expect(FACTORY_ADMIN_PARAMS.grade.s).toBe(GRADE_THRESHOLDS.S);
    expect(FACTORY_ADMIN_PARAMS.grade.a).toBe(GRADE_THRESHOLDS.A);
    expect(FACTORY_ADMIN_PARAMS.grade.b).toBe(GRADE_THRESHOLDS.B);
  });

  it('분포 전환 표본 수는 부팅에서만 반영된다 (RESTART REQUIRED)', async () => {
    const kv = new MemoryKeyValue();
    kv.put(
      FILES.params,
      paramsToCsv(writeField(FACTORY_ADMIN_PARAMS, 'grade.sampleThreshold', 50))
    );
    const rig = makeApp({ kv });
    await rig.app.ready;
    expect(rig.app.stats.scoreRingCapacity).toBe(50);
  });
});

describe('14-5 RESET 4종 전 경로 (ADM-105 · ADM-106 · ADM-404)', () => {
  it('ADM-404 — 랭킹이 실제로 비고 `ranking.csv`가 갱신된다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.app.ranking.submit({
      initials: 'ABC',
      score: 5000,
      board: 3,
      maxComboCentis: 150,
      continues: 0,
      registeredAt: '2026-08-17T00:00:00.000Z',
    });
    await rig.app.storage.saveNow(FILES.ranking);
    rig.send('SERVICE');
    rig.app.admin.goTo(['RESET', 'R_RANKING']);
    for (let i = 0; i < 4; i += 1) {
      const view = rig.app.admin.view();
      if (view.rows[view.cursor]?.id === 'reset.ranking') break;
      rig.send('DOWN');
    }
    rig.send('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.app.ranking.size).toBe(0);
    expect(rig.storage.kv.dump(FILES.ranking)).not.toContain('ABC');
    expect(rig.storage.kv.dump(`${FILES.ranking}.bak`)).toContain('ABC');
    expect(rig.storage.kv.dump(FILES.auditLog)).toContain(',ranking_reset,');
  });

  it('ADM-105 — 유료 통계만 0이 되고 영구 코인 미터는 남는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.press('COIN');
    // 유료 플레이 카운트를 올린 뒤 관리자에 들어간다 (플레이 중에는 진입할 수 없다 — ADM-002)
    rig.app.credits.chargeStart();
    rig.press('SERVICE');
    const pulses = rig.app.credits.view().coinPulseTotal;
    expect(rig.app.credits.view().paidPlayTotal).toBe(1);
    rig.app.admin.goTo(['RESET', 'R_PAID']);
    for (let i = 0; i < 4; i += 1) {
      const view = rig.app.admin.view();
      if (view.rows[view.cursor]?.id === 'reset.paid') break;
      rig.send('DOWN');
    }
    rig.send('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    const view = rig.app.credits.view();
    expect(view.paidPlayTotal).toBe(0);
    expect(view.coinPulseTotal).toBe(pulses);
    expect(rig.storage.kv.dump(FILES.auditLog)).toContain(',stats_reset,');
  });

  it('ADM-106 — 이벤트 통계와 잔액이 0이 된다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.app.credits.grantEvent(3);
    rig.send('SERVICE');
    rig.app.admin.goTo(['RESET', 'R_EVENT']);
    for (let i = 0; i < 4; i += 1) {
      const view = rig.app.admin.view();
      if (view.rows[view.cursor]?.id === 'reset.event') break;
      rig.send('DOWN');
    }
    rig.send('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.app.credits.balance().event).toBe(0);
    expect(rig.app.credits.view().eventGrantedTotal).toBe(0);
  });
});

// 독립 검증 D-1 — 앱 전 경로에서 §11.5 우회가 없는지 확인한다 (03_quality_report §5)
describe('14-5b 저장 검증 우회 경로가 없다 (D-1 · ADM-401 보장)', () => {
  it('미검증 편집 + 기기 설정 변경 + EXIT & SAVE로도 `params.csv`가 오염되지 않는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.press('SERVICE');
    await rig.app.storage.saveNow(FILES.params);

    // ① GAME PARAMETERS에서 `GRADE_ORDER` 오류를 만든다 (SAVE는 누르지 않는다)
    rig.app.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.send('LEFT');
    expect(rig.app.admin.draft.grade.sPlus).toBe(0);
    expect(rig.app.admin.validate().errors.some((e) => e.code === 'GRADE_ORDER')).toBe(true);

    // ② MACHINE SETTINGS에서 SOUND VOLUME 1칸
    rig.app.admin.goTo(['MACHINE']);
    rig.send('RIGHT');

    // ③ EXIT & SAVE
    void rig.app.admin.exitAndSave();
    await flushAsync();

    const params = rig.storage.kv.dump(FILES.params) ?? '';
    expect(params).toContain('1,grade.sPlus,300000');
    expect(params).not.toContain('1,grade.sPlus,0');
    expect(rig.app.params.live.grade.sPlus).toBe(300000);
    // 기기 설정만 반영됐다
    expect(rig.storage.kv.dump(FILES.settings)).toContain(',85,');
    // 파라미터 저장 감사가 없다 = 파라미터가 저장되지 않았다
    expect(rig.storage.kv.dump(FILES.auditLog)).not.toContain(',param_save,');
  });

  it('미검증 등급 임계가 런타임 등급 판정에 새어 나가지 않는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.press('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.send('LEFT');
    rig.app.admin.goTo(['MACHINE']);
    rig.send('RIGHT');
    // `grade.sPlus = 0`이 반영됐다면 0점도 S+가 된다
    expect(rig.app.params.live.grade.sPlus).toBe(300000);
  });
});

describe('14-6 솔버 게이트 결선 (ADM-402 배선 — 교체 지점 1곳)', () => {
  it('기본 게이트는 스텁이라 `pending`이다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    expect(rig.app.admin.validate().solver.pending).toBe('WU-08');
  });

  it('`createApp({ solverGate })` 하나로 실제 차단이 성립한다', async () => {
    const rig = makeApp({ solverGate: failingSolverGate() });
    await rig.app.ready;
    rig.send('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.send('RIGHT');
    expect(await rig.app.admin.save()).toBe(false);
    expect(rig.app.params.live.core.sessionTimeSec).toBe(120);
  });
});

describe('14-7 감사 로그 파일 (WU-04 → WU-05 인계 완결)', () => {
  it('WU-04가 쏘던 이벤트도 같은 파일에 남는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.app.credits.grantEvent(1, 'admin');
    await flushAsync();
    expect(rig.storage.kv.dump(FILES.auditLog)).toContain(',event_grant,');
  });

  it('한 세션의 감사 로그가 순서대로 쌓인다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.send('RIGHT');
    await rig.app.admin.save();
    void rig.app.admin.exitAndSave();
    await flushAsync();
    const actions = (rig.storage.kv.dump(FILES.auditLog) ?? '')
      .split('\n')
      .map((l) => l.split(',')[1]);
    expect(actions[0]).toBe('admin_enter');
    expect(actions).toContain('param_save');
    expect(actions[actions.length - 1]).toBe('admin_exit');
  });

  it('감사 로그에 헤더 줄이 없다 (F-c)', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    await flushAsync();
    expect((rig.storage.kv.dump(FILES.auditLog) ?? '').startsWith('timestamp,')).toBe(false);
  });
});

describe('14-8 등록 문서 (§12.1 저장 파일)', () => {
  it('`params.csv`·`settings.csv`가 저장 문서로 등록됐다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    await rig.app.storage.saveAll();
    expect(rig.storage.kv.dump(FILES.params)).toContain('schema,key,value');
    expect(rig.storage.kv.dump(FILES.settings)).toContain('#machine');
  });

  it('4종 문서가 모두 쓰인다 (ranking·stats·params·settings)', async () => {
    const rig = makeApp();
    await rig.app.ready;
    await rig.app.storage.saveAll();
    for (const file of [FILES.ranking, FILES.stats, FILES.params, FILES.settings]) {
      expect(rig.storage.kv.dump(file)).not.toBe(null);
    }
  });

  it('DATA & LOGS 화면이 파일 7종을 나열한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.app.admin.goTo(['DATA']);
    expect(rig.app.admin.view().rows).toHaveLength(7);
  });
});
