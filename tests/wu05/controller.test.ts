// 관리자 컨트롤러 조립 (§11 전체 · admin §3·§8·§9·§13 — 계획 T9)
//
// 진입 5단계 · 저장 6단계 · SAVE/DISCARD/CANCEL · 5분 유휴 보호 · 작업 사본 폐기(ADM-201) ·
// RESET 4종 · 저장 실패 유지(ADM-302) · 종료(ADM-307)를 전 경로로 판정한다.
//
// 13-5b ~ 13-5f는 독립 검증이 찾아낸 결함 D-1~D-5의 회귀 테스트다 (03_quality_report §5).

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, writeField } from '../../src/core/adminParams';
import { EXIT_SAVED_HOLD_MS, MACHINE_SAVE_DEBOUNCE_MS } from '../../src/game/admin/controller';
import { MENU_MAX_DEPTH, maxTreeDepth } from '../../src/game/admin/menu';
import { ADMIN_TEXT, MARKER } from '../../src/game/admin/view';
import { FILES } from '../../src/persist/csv';
import { flushAsync, makeAdmin } from './harness';

describe('13-1 진입 5단계 (admin §3.1)', () => {
  it('진입하면 ADMIN HOME에 선다', () => {
    const rig = makeAdmin();
    expect(rig.admin.isEntered).toBe(true);
    expect(rig.admin.currentPath).toEqual([]);
    expect(rig.admin.view().breadcrumb).toBe('ADMIN > HOME');
  });

  it('8그룹이 첫 화면에 보인다', () => {
    const rig = makeAdmin();
    expect(rig.admin.view().rows).toHaveLength(8);
  });

  it('`admin_enter` 감사 로그에 잔액이 실린다 (4단계 확인)', () => {
    const rig = makeAdmin();
    const enter = rig.audits.find((e) => e.kind === 'ADMIN_ENTER');
    expect(enter?.target).toBe('ADMIN HOME');
    expect(enter?.after).toContain('credit');
  });

  it('저장소 프로브를 돌린다 (3단계 장치 검사)', async () => {
    const rig = makeAdmin();
    await flushAsync();
    rig.admin.goTo(['MAINTENANCE', 'M_STORAGE']);
    expect(rig.admin.view().rows.find((r) => r.id === 'storage.writable')?.value).toBe('OK');
  });

  it('다시 진입하면 작업 사본이 초기화된다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(rig.admin.draft.core.sessionTimeSec).toBe(121);
    rig.admin.enter();
    expect(rig.admin.draft.core.sessionTimeSec).toBe(120);
  });

  it('부팅에 저장된 값이 있으면 그 값에서 시작한다', () => {
    const live = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 135);
    const rig = makeAdmin({ live });
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(135);
  });
});

describe('13-2 작업 사본 (ADM-201 · 돌연변이 ③)', () => {
  it('편집은 라이브 값과 `params.csv`를 바꾸지 않는다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.storage.storage.saveNow(FILES.params);
    expect(rig.params.live.core.sessionTimeSec).toBe(120);
    expect(rig.storage.kv.dump(FILES.params)).toContain('1,core.sessionTimeSec,120');
  });

  it('`G`로 나가려 하면 미저장 3선택이 뜬다 (admin §3.2)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.press('BUTTON2');
    expect(rig.admin.view().rows.map((r) => r.id)).toEqual([
      'unsaved.head',
      'unsaved.save',
      'unsaved.discard',
      'unsaved.cancel',
    ]);
  });

  it('DISCARD를 고르면 작업 사본이 사라지고 라이브가 그대로다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.press('BUTTON2');
    rig.focus('unsaved.discard');
    rig.press('BUTTON1');
    expect(rig.admin.draft.core.sessionTimeSec).toBe(120);
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(120);
    expect(rig.admin.view().toast?.text).toBe(ADMIN_TEXT.discarded);
  });

  it('CANCEL을 고르면 편집이 유지된다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.press('BUTTON2');
    rig.focus('unsaved.cancel');
    rig.press('BUTTON1');
    expect(rig.admin.draft.core.sessionTimeSec).toBe(121);
  });

  it('SAVE를 고르면 저장된다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.press('BUTTON2');
    rig.focus('unsaved.save');
    rig.press('BUTTON1');
    await flushAsync();
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(121);
  });

  it('미저장 3선택에서 `G`는 취소와 같다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.press('BUTTON2');
    rig.press('BUTTON2');
    expect(rig.admin.draft.core.sessionTimeSec).toBe(121);
    expect(rig.admin.view().rows.length).toBeGreaterThan(4);
  });

  it('VALIDATION 화면의 DISCARD도 작업 사본만 버린다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.admin.goTo(['PARAMS', 'P_VALIDATE']);
    rig.focus('params.discard');
    rig.press('BUTTON1');
    expect(rig.admin.draft).toBe(rig.admin.liveParams);
  });

  it('변경이 없으면 `G`가 곧바로 뒤로 간다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('BUTTON2');
    expect(rig.admin.currentPath).toEqual(['PARAMS']);
  });
});

describe('13-3 저장 6단계 (계획 §5.4)', () => {
  it('검증 통과 → 백업 → 라이브 반영 → 저장 → 감사 → 토스트', async () => {
    const rig = makeAdmin();
    await rig.storage.storage.saveNow(FILES.params);
    const before = rig.storage.kv.dump(FILES.params);
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(true);

    expect(rig.storage.kv.dump(`${FILES.params}.bak`)).toBe(before); // ②
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(121); // ③
    expect(rig.storage.kv.dump(FILES.params)).toContain('1,core.sessionTimeSec,121'); // ④
    expect(rig.audits.some((e) => e.kind === 'PARAM_SAVE')).toBe(true); // ⑤
    expect(rig.admin.view().toast?.text).toContain('SAVED'); // ⑥
  });

  it('저장 통과 시 코어에 반영된다 (NEXT GAME · P-8)', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    expect(rig.applied).toHaveLength(1);
    expect(rig.applied[0].core.sessionTimeSec).toBe(121);
  });

  it('오류가 있으면 저장이 차단되고 라이브가 그대로다 (ADM-401 · 돌연변이 ①)', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.press('LEFT');
    expect(await rig.admin.save()).toBe(false);
    expect(rig.admin.liveParams.grade.sPlus).toBe(300000);
    expect(rig.applied).toEqual([]);
  });

  it('오류 **전체 목록**이 화면에 뜬다 (admin §9.4)', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.press('LEFT'); // S+ → 0
    rig.focus('grade.s');
    for (let i = 0; i < 300; i += 1) rig.press('LEFT'); // S → 0
    await rig.admin.save();
    expect(rig.admin.view().errors.length).toBeGreaterThanOrEqual(2);
    expect(rig.admin.view().toast?.text).toContain('저장·테스트 불가');
  });

  it('경고가 있으면 `H` 1회로는 저장되지 않는다 (ADM-204)', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.focus('core.initialHearts');
    for (let i = 0; i < 4; i += 1) rig.press('RIGHT'); // 하트 7 → 경고
    expect(await rig.admin.save()).toBe(false);
    expect(rig.admin.view().danger?.requiredHoldMs).toBe(2000);
    expect(rig.admin.liveParams.core.initialHearts).toBe(3);
  });

  it('경고는 2초 홀드로 저장된다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.focus('core.initialHearts');
    for (let i = 0; i < 4; i += 1) rig.press('RIGHT');
    await rig.admin.save();
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.admin.liveParams.core.initialHearts).toBe(7);
  });

  it('경고 홀드가 짧으면 저장되지 않는다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.focus('core.initialHearts');
    for (let i = 0; i < 4; i += 1) rig.press('RIGHT');
    await rig.admin.save();
    rig.holdConfirm(500);
    await flushAsync();
    expect(rig.admin.liveParams.core.initialHearts).toBe(3);
  });

  it('백업이 실패하면 라이브를 갱신하지 않는다 (②가 실패하면 ③으로 가지 않는다)', async () => {
    const fail = { on: false };
    const rig = makeAdmin({ failWrites: fail });
    await rig.storage.storage.saveNow(FILES.params);
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    fail.on = true;
    expect(await rig.admin.save()).toBe(false);
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(120);
    expect(rig.admin.saveState).toBe('SAVE FAILED');
  });

  it('감사 로그에 솔버 결과가 실린다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    expect(rig.audits.find((e) => e.kind === 'PARAM_SAVE')?.result).toContain('solver=ok');
  });

  it('VALIDATE 행이 검증만 돌린다 (저장하지 않는다)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.admin.goTo(['PARAMS', 'P_VALIDATE']);
    rig.focus('params.validate');
    rig.press('BUTTON1');
    expect(rig.admin.validationReport).not.toBe(null);
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(120);
  });

  it('저장 검증 화면이 변경 항목 수와 도달 보드를 보여 준다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.admin.goTo(['PARAMS', 'P_VALIDATE']);
    rig.focus('params.validate');
    rig.press('BUTTON1');
    const rows = rig.admin.view().rows;
    expect(rows.find((r) => r.id === 'save.dirty')?.value).toBe('1개');
    expect(rows.find((r) => r.id === 'save.budget')?.value).toBe('13');
  });
});

describe('13-4 MACHINE SETTINGS 즉시 반영 + 디바운스 (admin §8.5 · §13 낮음)', () => {
  it('변경이 곧바로 라이브가 된다 (홀드 없음)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    expect(rig.admin.liveParams.machine.soundVolume).toBe(85);
    expect(rig.settings.machine.soundVolume).toBe(85);
  });

  it('`UNSAVED → SAVING → SAVED` 상태를 거친다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    expect(rig.admin.saveState).toBe('UNSAVED');
    rig.clock.advance(MACHINE_SAVE_DEBOUNCE_MS);
    rig.admin.tick();
    await flushAsync();
    expect(rig.admin.saveState).toBe('SAVED');
  });

  it('디바운스 전에는 저장되지 않는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    rig.clock.advance(MACHINE_SAVE_DEBOUNCE_MS - 1);
    rig.admin.tick();
    expect(rig.admin.saveState).toBe('UNSAVED');
  });

  it('코인 설정이 크레딧 서비스에 즉시 넘어간다 (NEXT CHARGE)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.focus('machine.coinsPerPlay');
    rig.press('RIGHT');
    expect(rig.credits.coinsPerPlay).toBe(2);
  });

  it('단가를 넣으면 크레딧 서비스가 받는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.focus('machine.coinUnitPrice');
    rig.press('RIGHT');
    expect(rig.credits.coinUnitPrice).toBe(100);
  });

  it('고정값 4종이 읽기 전용으로 표시된다 (§11.3)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    const fixed = rig.admin.view().rows.filter((r) => r.id.startsWith('machine.fixed.'));
    expect(fixed).toHaveLength(4);
    expect(fixed.every((r) => !r.selectable && r.marker === MARKER.readOnly)).toBe(true);
  });

  it('기기 설정 변경은 `params.csv`를 건드리지 않는다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    rig.clock.advance(MACHINE_SAVE_DEBOUNCE_MS);
    rig.admin.tick();
    await flushAsync();
    expect(rig.storage.kv.dump(FILES.settings)).toContain(',85,');
  });
});

describe('13-5 RESET 4종 (§11.7 · ADM-105 · ADM-106 · ADM-404)', () => {
  it('RESET PAID STATISTICS — 홀드·백업·감사·저장', async () => {
    const rig = makeAdmin();
    await rig.storage.storage.saveNow(FILES.stats);
    rig.admin.goTo(['RESET', 'R_PAID']);
    rig.focus('reset.paid');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.credits.resets).toContain('paid');
    expect(rig.audits.some((e) => e.kind === 'STATS_RESET' && e.target === 'paid')).toBe(true);
  });

  it('RESET EVENT STATISTICS', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['RESET', 'R_EVENT']);
    rig.focus('reset.event');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.credits.resets).toContain('event');
  });

  it('RESET RANKING — 삭제 건수 표시 + 백업 + 감사 (ADM-404)', async () => {
    const rig = makeAdmin();
    rig.ranking.size = 4;
    rig.storage.kv.put(FILES.ranking, 'schema,initials\n1,AAA');
    rig.admin.goTo(['RESET', 'R_RANKING']);
    expect(rig.admin.view().rows[0].value).toContain('4건');
    rig.focus('reset.ranking');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.ranking.cleared).toBe(1);
    expect(rig.storage.kv.dump(`${FILES.ranking}.bak`)).toContain('AAA');
  });

  it('RESTORE GAME PARAMETERS — 공장값 + 백업 + 감사 + 즉시 저장 (ADM-206)', async () => {
    const rig = makeAdmin({ live: writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150) });
    await rig.storage.storage.saveNow(FILES.params);
    rig.admin.goTo(['RESET', 'R_PARAMS']);
    rig.focus('reset.params');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.admin.liveParams).toEqual(FACTORY_ADMIN_PARAMS);
    expect(rig.storage.kv.dump(`${FILES.params}.bak`)).toContain('1,core.sessionTimeSec,150');
    expect(rig.storage.kv.dump(FILES.params)).toContain('1,core.sessionTimeSec,120');
  });

  it('RESET 4종이 전부 2초 홀드를 요구한다', () => {
    for (const [node, row] of [
      ['R_PAID', 'reset.paid'],
      ['R_EVENT', 'reset.event'],
      ['R_RANKING', 'reset.ranking'],
      ['R_PARAMS', 'reset.params'],
    ] as const) {
      const rig = makeAdmin();
      rig.admin.goTo(['RESET', node]);
      rig.focus(row);
      rig.press('BUTTON1');
      expect(rig.admin.view().danger?.requiredHoldMs).toBe(2000);
      expect(rig.admin.view().danger?.level).toBe('HIGH');
    }
  });

  it('`RESTORE THIS PRESET`은 중간 등급(홀드 없음)이고 draft만 바꾼다 (ADM-205)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_DIFFICULTY']);
    rig.press('RIGHT'); // 프리셋 변경
    rig.focus('restore.group');
    rig.press('BUTTON1');
    expect(rig.admin.view().danger?.level).toBe('MEDIUM');
    rig.press('BUTTON1');
    expect(rig.admin.draft.difficulty.preset).toBe('STANDARD');
  });
});

// ── 독립 검증 FIX 대응 (03_quality_report §5) ─────────────────────────────

describe('13-5b D-1 — 기기 설정 변경이 GAME PARAMETERS 작업 사본을 승격하지 않는다 [치명]', () => {
  /** 검증 실패(등급 내림차순 위반) 상태의 작업 사본을 만든다 */
  function draftWithError(rig: ReturnType<typeof makeAdmin>): void {
    rig.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.press('LEFT'); // S+ 임계 300,000 → 0
    expect(rig.admin.draft.grade.sPlus).toBe(0);
    expect(rig.admin.validate().errors.some((e) => e.code === 'GRADE_ORDER')).toBe(true);
  }

  it('SOUND VOLUME 1칸 조작으로 미검증 값이 라이브가 되지 않는다', () => {
    const rig = makeAdmin();
    draftWithError(rig);
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT'); // SOUND VOLUME 80 → 85

    expect(rig.admin.liveParams.grade.sPlus).toBe(300000); // 라이브 불변
    expect(rig.admin.liveParams.machine.soundVolume).toBe(85); // 기기 값만 승격
    expect(rig.admin.draft.grade.sPlus).toBe(0); // 작업 사본은 그대로 살아 있다
  });

  it('코인 설정 조작으로도 승격되지 않는다 (모든 기기 행이 같은 경로)', () => {
    const rig = makeAdmin();
    draftWithError(rig);
    rig.admin.goTo(['MACHINE']);
    rig.focus('machine.coinsPerPlay');
    rig.press('RIGHT');
    expect(rig.admin.liveParams.grade.sPlus).toBe(300000);
    expect(rig.credits.coinsPerPlay).toBe(2);
  });

  it('그 뒤 EXIT & SAVE 해도 `params.csv`에 미검증 값이 기록되지 않는다', async () => {
    const rig = makeAdmin();
    await rig.storage.storage.saveNow(FILES.params);
    draftWithError(rig);
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    await rig.admin.exitAndSave();

    const params = rig.storage.kv.dump(FILES.params) ?? '';
    expect(params).toContain('1,grade.sPlus,300000');
    expect(params).not.toContain('1,grade.sPlus,0');
    expect(rig.storage.kv.dump(FILES.settings)).toContain(',85,');
  });

  it('미검증 값이 코어 런타임에도 반영되지 않는다', () => {
    const rig = makeAdmin();
    draftWithError(rig);
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    expect(rig.applied.length).toBeGreaterThan(0);
    expect(rig.applied.every((p) => p.grade.sPlus === 300000)).toBe(true);
  });

  it('기기 변경은 `setting_change`만 남기고 `param_save`를 만들지 않는다', () => {
    const rig = makeAdmin();
    draftWithError(rig);
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    expect(rig.audits.filter((e) => e.kind === 'PARAM_SAVE')).toEqual([]);
    expect(rig.audits.some((e) => e.kind === 'SETTING_CHANGE')).toBe(true);
  });

  it('검증을 통과하는 작업 사본도 SAVE 전에는 승격되지 않는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT'); // 유효한 편집 (120 → 121)
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(120);
    expect(rig.admin.draft.core.sessionTimeSec).toBe(121);
    expect(rig.admin.hasUnsavedWork()).toBe(true); // 여전히 미저장이다
  });

  it('SAVE 경로는 그대로 검증을 거쳐 승격한다 (대조군)', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(true);
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(121);
    expect(rig.admin.liveParams.machine.soundVolume).toBe(85);
  });
});

describe('13-5c D-2 — RESTORE GAME PARAMETERS의 범위 [높음]', () => {
  async function machineTuned(): Promise<ReturnType<typeof makeAdmin>> {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT'); // SOUND VOLUME 80 → 85
    rig.focus('machine.coinsPerPlay');
    rig.press('RIGHT'); // 1 → 2
    rig.focus('machine.coinUnitPrice');
    rig.press('RIGHT'); // 미설정 → 100
    await rig.storage.storage.saveNow(FILES.settings);
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    return rig;
  }

  it('게임 파라미터만 공장값으로 돌아간다', async () => {
    const rig = await machineTuned();
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(121);
    rig.admin.goTo(['RESET', 'R_PARAMS']);
    rig.focus('reset.params');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(120);
  });

  it('기기 설정은 유지된다 (§11.2 그룹 분리 · §11.7 항목명)', async () => {
    const rig = await machineTuned();
    rig.admin.goTo(['RESET', 'R_PARAMS']);
    rig.focus('reset.params');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    const machine = rig.admin.liveParams.machine;
    expect(machine.soundVolume).toBe(85);
    expect(machine.coinsPerPlay).toBe(2);
    expect(machine.coinUnitPrice).toBe(100);
  });

  it('`COIN UNIT PRICE`가 미설정으로 돌아가지 않아 ESTIMATED GROSS가 살아 있다', async () => {
    const rig = await machineTuned();
    rig.admin.goTo(['RESET', 'R_PARAMS']);
    rig.focus('reset.params');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.credits.coinUnitPrice).toBe(100);
    rig.admin.goTo(['SALES', 'SALES_METERS']);
    expect(rig.admin.view().rows.some((r) => r.id === 'meter.gross')).toBe(true);
  });

  it('`settings.csv`를 다시 쓰므로 그쪽 `.bak`도 남긴다', async () => {
    const rig = await machineTuned();
    rig.admin.goTo(['RESET', 'R_PARAMS']);
    rig.focus('reset.params');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.storage.kv.dump(`${FILES.params}.bak`)).not.toBe(null);
    expect(rig.storage.kv.dump(`${FILES.settings}.bak`)).not.toBe(null);
  });
});

describe('13-5d D-3 — 위험 작업이 실패해도 화면이 잠기지 않는다 [높음]', () => {
  async function failedReset(): Promise<ReturnType<typeof makeAdmin>> {
    const rig = makeAdmin({ throwOnRankingClear: true });
    rig.ranking.size = 5;
    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.focus('reset.ranking');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    return rig;
  }

  it('포트가 던져도 EXECUTING 잠금이 풀린다', async () => {
    const rig = await failedReset();
    expect(rig.admin.view().danger).toBe(null);
  });

  it('입력이 계속 살아 있다 (재부팅 없이 탈출 가능)', async () => {
    const rig = await failedReset();
    rig.press('BUTTON2');
    expect(rig.admin.currentPath).toEqual(['RESET']);
    rig.press('DOWN');
    rig.press('BUTTON2');
    expect(rig.admin.currentPath).toEqual([]);
  });

  it('실패를 감사 로그에 남긴다 (admin §13 "성공·실패 모두")', async () => {
    const rig = await failedReset();
    const failed = rig.audits.find(
      (e) => e.kind === 'RANKING_RESET' && e.result?.startsWith('failed') === true
    );
    expect(failed).toBeDefined();
    expect(failed?.target).toBe('RESET RANKING');
  });

  it('오류 토스트를 띄우고 거부음을 낸다', async () => {
    const rig = await failedReset();
    expect(rig.admin.view().toast?.level).toBe('error');
    expect(rig.admin.view().toast?.text).toContain('실행 실패');
    expect(rig.sfx.count('reject')).toBeGreaterThan(0);
  });

  it('성공 경로는 그대로 동작한다 (대조군)', async () => {
    const rig = makeAdmin();
    rig.ranking.size = 5;
    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.focus('reset.ranking');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.ranking.cleared).toBe(1);
    expect(rig.admin.view().danger).toBe(null);
    expect(rig.audits.some((e) => e.kind === 'RANKING_RESET' && e.result === 'ok')).toBe(true);
  });
});

describe('13-5e D-4 — 백업이 실패하면 파괴적 초기화를 실행하지 않는다 [중간]', () => {
  it('RESET RANKING — 랭킹이 그대로 남고 `backup_failed` 감사가 남는다', async () => {
    const fail = { on: false };
    const rig = makeAdmin({ failWrites: fail });
    rig.ranking.size = 4;
    rig.storage.kv.put(FILES.ranking, 'schema,initials\n1,AAA');
    fail.on = true;

    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.focus('reset.ranking');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();

    expect(rig.ranking.cleared).toBe(0);
    expect(rig.ranking.size).toBe(4);
    expect(rig.audits.some((e) => e.kind === 'RANKING_RESET' && e.result === 'backup_failed')).toBe(
      true
    );
    expect(rig.admin.view().toast?.text).toContain('백업 실패');
    expect(rig.admin.view().danger).toBe(null);
  });

  it('RESET PAID STATISTICS — 통계가 그대로 남는다', async () => {
    const fail = { on: false };
    const rig = makeAdmin({ failWrites: fail });
    rig.storage.kv.put(FILES.stats, 'schema,date\n1,2026-08-17');
    fail.on = true;

    rig.admin.goTo(['RESET', 'R_PAID']);
    rig.focus('reset.paid');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();

    expect(rig.credits.resets).toEqual([]);
    expect(rig.audits.some((e) => e.kind === 'STATS_RESET' && e.result === 'backup_failed')).toBe(
      true
    );
  });

  it('RESTORE GAME PARAMETERS — 라이브가 그대로 남는다', async () => {
    const fail = { on: false };
    const rig = makeAdmin({
      failWrites: fail,
      live: writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150),
    });
    rig.storage.kv.put(FILES.params, 'schema,key,value\n1,PARAM_DATA_VERSION,1');
    fail.on = true;

    rig.admin.goTo(['RESET', 'R_PARAMS']);
    rig.focus('reset.params');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();

    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(150);
    expect(rig.audits.some((e) => e.kind === 'PARAM_RESTORE' && e.result === 'backup_failed')).toBe(
      true
    );
  });

  it('파일이 아직 없으면 백업할 것이 없으므로 정상 진행한다', async () => {
    const rig = makeAdmin();
    rig.ranking.size = 3;
    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.focus('reset.ranking');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.ranking.cleared).toBe(1);
  });
});

describe('13-5f D-5 — 적응 난이도 고급 4항목이 편집 가능하다 [중간]', () => {
  it('`ADAPTIVE DETAIL` 화면에 4행이 나온다 (§11.4 고급 하위 화면)', () => {
    const rig = makeAdmin();
    expect(rig.admin.goTo(['PARAMS', 'P_ADAPTIVE'])).toBe(true);
    expect(rig.admin.view().rows.map((r) => r.id)).toEqual([
      'difficulty.window',
      'difficulty.upPercent',
      'difficulty.downPercent',
      'difficulty.downMistakes',
    ]);
  });

  it('레버로 실제 편집된다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_ADAPTIVE']);
    rig.press('RIGHT'); // ADAPTIVE WINDOW 2 → 3
    expect(rig.admin.draft.difficulty.window).toBe(3);
    rig.focus('difficulty.upPercent');
    rig.press('RIGHT'); // 70 → 75 (step 5)
    expect(rig.admin.draft.difficulty.upPercent).toBe(75);
  });

  it('DIFFICULTY 화면에는 고급이 아닌 2행만 남는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_DIFFICULTY']);
    const fields = rig.admin.view().rows.filter((r) => r.id.startsWith('difficulty.'));
    expect(fields.map((r) => r.id)).toEqual(['difficulty.preset', 'difficulty.adaptive']);
  });

  it('편집분이 SAVE로 `params.csv`까지 간다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_ADAPTIVE']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(true);
    expect(rig.storage.kv.dump(FILES.params)).toContain('1,difficulty.window,3');
  });

  it('메뉴 깊이는 여전히 3단 이하다', () => {
    expect(maxTreeDepth()).toBeLessThanOrEqual(MENU_MAX_DEPTH);
  });
});

describe('13-6 이벤트 크레딧 지급 (ADM-102)', () => {
  it('중간 등급 확인 뒤 +1 지급된다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['SALES', 'SALES_GRANT']);
    rig.focus('grant.event');
    rig.press('BUTTON1');
    expect(rig.admin.view().danger?.level).toBe('MEDIUM');
    rig.press('BUTTON1');
    expect(rig.credits.balanceRef.event).toBe(1);
  });

  it('상한 5에서는 `MAX 5`를 표시한다', () => {
    const rig = makeAdmin();
    rig.credits.balanceRef = { paid: 0, event: 5 };
    rig.admin.goTo(['SALES', 'SALES_GRANT']);
    rig.focus('grant.event');
    rig.press('BUTTON1');
    rig.press('BUTTON1');
    expect(rig.admin.view().toast?.text).toBe(ADMIN_TEXT.eventCreditMax);
  });
});

describe('13-7 5분 유휴 보호 (ADM-006)', () => {
  it('미저장이 없으면 복귀를 허용한다', () => {
    const rig = makeAdmin();
    expect(rig.admin.idleGuard()).toBe(true);
  });

  it('미저장이 있으면 복귀하지 않고 경고한다 (admin §2.2)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(rig.admin.idleGuard()).toBe(false);
    expect(rig.admin.view().toast?.text).toBe(ADMIN_TEXT.idleBlocked);
    expect(rig.sfx.count('reject')).toBeGreaterThan(0);
  });

  it('예약된 자동 저장은 복귀를 막지 않는다 (스스로 완료된다)', () => {
    const rig = makeAdmin();
    rig.storage.storage.scheduleSave();
    expect(rig.admin.hasPendingSave()).toBe(true);
    expect(rig.admin.hasUnsavedWork()).toBe(false);
    expect(rig.admin.idleGuard()).toBe(true);
  });

  it('저장 뒤에는 다시 복귀를 허용한다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    rig.storage.flush();
    expect(rig.admin.idleGuard()).toBe(true);
  });
});

describe('13-8 종료 (ADM-307 · admin §3.2)', () => {
  it('저장이 끝난 뒤 `SAVED` 스탬프를 1초 이상 보여 주고 복귀한다', async () => {
    const rig = makeAdmin();
    await rig.admin.exitAndSave();
    expect(rig.admin.view().toast?.text).toMatch(/^SAVED · \d{4}-\d{2}-\d{2}/);
    expect(rig.exits.count).toBe(0);
    rig.clock.advance(EXIT_SAVED_HOLD_MS);
    rig.admin.tick();
    expect(rig.exits.count).toBe(1);
    expect(rig.admin.isEntered).toBe(false);
  });

  it('저장이 실패하면 화면을 닫지 않는다 (ADM-302)', async () => {
    const fail = { on: true };
    const rig = makeAdmin({ failWrites: fail });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(false);
    expect(rig.admin.saveState).toBe('SAVE FAILED');
    expect(rig.admin.view().saveState).toBe(ADMIN_TEXT.saveFailed);
    expect(rig.admin.view().toast?.text).toBe(ADMIN_TEXT.savePathHint);
    expect(rig.exits.count).toBe(0);
  });

  it('`EXIT & SAVE`도 저장이 실패하면 나가지 않는다 (ADM-307)', async () => {
    const fail = { on: true };
    const rig = makeAdmin({ failWrites: fail });
    expect(await rig.admin.exitAndSave()).toBe(false);
    rig.clock.advance(EXIT_SAVED_HOLD_MS * 2);
    rig.admin.tick();
    expect(rig.exits.count).toBe(0);
    expect(rig.audits.some((e) => e.kind === 'ADMIN_EXIT' && e.result === 'failed')).toBe(true);
  });

  it('루트에서 변경이 없으면 `G`가 종료로 이어진다', async () => {
    const rig = makeAdmin();
    rig.press('BUTTON2');
    await flushAsync();
    rig.clock.advance(EXIT_SAVED_HOLD_MS);
    rig.admin.tick();
    expect(rig.exits.count).toBe(1);
  });

  it('루트에서 미저장이 있으면 3선택이 먼저 뜬다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    rig.admin.goTo([]);
    rig.press('BUTTON2');
    expect(rig.admin.view().rows.map((r) => r.id)).toContain('unsaved.save');
    expect(rig.exits.count).toBe(0);
  });

  it('`EXIT & SAVE` 메뉴로도 종료한다', async () => {
    const rig = makeAdmin();
    rig.focus('EXIT');
    rig.press('BUTTON1');
    rig.press('BUTTON1');
    await flushAsync();
    rig.clock.advance(EXIT_SAVED_HOLD_MS);
    rig.admin.tick();
    expect(rig.exits.count).toBe(1);
  });
});

describe('13-9 뷰 (admin §4.2·§4.3)', () => {
  it('헤더에 경로·시각·종합 상태가 있다', () => {
    const rig = makeAdmin();
    const view = rig.admin.view();
    expect(view.breadcrumb).toBe('ADMIN > HOME');
    expect(view.clock).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(view.status).toMatch(/^[●▲×] /);
  });

  it('저장 상태를 4종 중 하나로 항상 표시한다 (admin §4.3)', async () => {
    const rig = makeAdmin();
    expect(rig.admin.view().saveState).toBe('SAVED'); // 진입 직후 — 아직 저장한 적 없음
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    expect(rig.admin.view().saveState).toBe(ADMIN_TEXT.unsaved);
    rig.clock.advance(MACHINE_SAVE_DEBOUNCE_MS);
    rig.admin.tick();
    await flushAsync();
    expect(rig.admin.view().saveState).toMatch(/^SAVED · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('푸터가 화면에 따라 바뀐다', () => {
    const rig = makeAdmin();
    expect(rig.admin.view().footer).toContain('G 종료');
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    expect(rig.admin.view().footer).toContain('A/D 변경');
    rig.admin.goTo(['MAINTENANCE']);
    expect(rig.admin.view().footer).toContain('H 열기');
  });

  it('변경된 행에 `●`와 `1 → 2` 표기가 붙는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    const row = rig.admin.view().rows.find((r) => r.id === 'core.sessionTimeSec');
    expect(row?.marker).toBe(MARKER.normal);
    expect(row?.value).toBe('120 초 → 121 초');
  });

  it('오류 행에 `×`가 붙는다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.press('LEFT');
    await rig.admin.save();
    expect(rig.admin.view().rows.find((r) => r.id === 'grade.sPlus')?.marker).toBe(MARKER.error);
  });

  it('경고 행에 `▲`가 붙는다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.focus('core.initialHearts');
    for (let i = 0; i < 4; i += 1) rig.press('RIGHT');
    await rig.admin.save();
    expect(rig.admin.view().rows.find((r) => r.id === 'core.initialHearts')?.marker).toBe(
      MARKER.warn
    );
  });

  it('반영 시점이 행에 표기된다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    const row = rig.admin.view().rows.find((r) => r.id === 'machine.coinsPerPlay');
    expect(row?.applyTiming).toBe('NEXT CHARGE');
  });

  it('완료된 WU-07·WU-08 필드에는 대기 배지가 없다 (R6)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TIERS']);
    expect(rig.admin.view().rows[0].badge).toBeUndefined();
    rig.admin.goTo(['MACHINE']);
    expect(rig.admin.view().rows[0].badge).toBeUndefined();
  });

  it('상세 패널이 범위·공장값·반영 시점을 보여 준다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    const detail = rig.admin.view().detail;
    expect(detail[0]).toBe('SESSION TIME · NEXT GAME');
    expect(detail[1]).toContain('범위 90 ~ 150');
    expect(detail[2]).toContain('공장값 120 초');
  });

  it('구간표 행은 셀 커서를 표시하고 `H`로 MIN↔MAX를 돈다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TIERS']);
    expect(rig.admin.view().rows[0].cellCount).toBe(2);
    expect(rig.admin.activeCell).toBe(0);
    rig.press('BUTTON1');
    expect(rig.admin.activeCell).toBe(1);
    rig.press('RIGHT');
    expect(rig.admin.draft.tiers.WARMUP.chains.max).toBe(13);
    rig.press('BUTTON1');
    expect(rig.admin.activeCell).toBe(0);
  });

  it('행 이동이 셀 커서를 처음으로 되돌린다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TIERS']);
    rig.press('BUTTON1');
    rig.press('DOWN');
    expect(rig.admin.activeCell).toBe(0);
  });

  it('토스트가 시간이 지나면 사라진다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_VALIDATE']);
    rig.focus('params.validate');
    rig.press('BUTTON1');
    expect(rig.admin.view().toast).not.toBe(null);
    rig.clock.advance(3000);
    rig.admin.tick();
    expect(rig.admin.view().toast).toBe(null);
  });

  it('오류 토스트는 남아 있는다 (admin §4.2)', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.press('LEFT');
    await rig.admin.save();
    rig.clock.advance(60000);
    rig.admin.tick();
    expect(rig.admin.view().toast?.level).toBe('error');
  });
});

describe('13-10 SALES & CREDITS (ADM-102 · admin §7)', () => {
  it('§7.1 10지표가 전부 나온다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['SALES', 'SALES_STATS']);
    expect(rig.admin.view().rows).toHaveLength(10);
  });

  it('단가 미설정이면 `ESTIMATED GROSS`를 숨긴다 (admin §7.2)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['SALES', 'SALES_METERS']);
    expect(rig.admin.view().rows.some((r) => r.id === 'meter.gross')).toBe(false);
  });

  it('단가를 넣으면 `ESTIMATED GROSS`가 보인다', () => {
    const rig = makeAdmin();
    rig.credits.setCoinUnitPrice(1500);
    rig.admin.goTo(['SALES', 'SALES_METERS']);
    expect(rig.admin.view().rows.some((r) => r.id === 'meter.gross')).toBe(true);
  });

  it('통계는 천 단위 구분자로 표시된다 (admin §1.2)', () => {
    const rig = makeAdmin();
    for (let i = 0; i < 1500; i += 1) rig.stats.noteCoinPulse(1);
    rig.admin.goTo(['SALES', 'SALES_METERS']);
    expect(rig.admin.view().rows[0].value).toBe('1,500');
  });
});
