// 감사 로그 `audit_log.csv` (§11.7 · admin §11.2 — 계획 T7 · Q-6 · 돌연변이 ④)
//
// 6열 형식·행 sanitize·기록 시점·**이니셜 미기록**을 판정하고, 실측 제약 F-c(헤더 줄 없음)를
// 깨지 않았음을 재확인한다.

import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditKind } from '../../src/core/stats';
import {
  AUDIT_ACTION,
  AUDIT_COLUMNS,
  AuditLogger,
  auditLine,
  auditRecordOf,
  parseAuditLine,
} from '../../src/game/admin/audit';
import { APPEND_ONLY_FILES, FILES } from '../../src/persist/csv';
import { flushAsync, makeAdmin, memoryStorage } from './harness';

function event(kind: AuditKind, extra: Partial<AuditEvent> = {}): AuditEvent {
  return { kind, at: '2026-08-17T09:12:03.114Z', detail: '', ...extra };
}

describe('10-1 6열 형식 (Q-6 — 9열에서 3열을 뺐다)', () => {
  it('컬럼이 정확히 6개다', () => {
    expect([...AUDIT_COLUMNS]).toEqual([
      'timestamp',
      'action',
      'target',
      'before',
      'after',
      'result',
    ]);
  });

  it('machineId·operatorRole·appVersion은 없다 (§18 이월 6)', () => {
    for (const dropped of ['machineId', 'operatorRole', 'appVersion']) {
      expect(AUDIT_COLUMNS as readonly string[]).not.toContain(dropped);
    }
  });

  it('한 줄이 6칸이다', () => {
    const line = auditLine(auditRecordOf(event('ADMIN_ENTER', { target: 'ATTRACT' })));
    expect(line.split(',')).toHaveLength(6);
  });

  it('진입 로그가 기획서 예시와 같은 모양이다', () => {
    const line = auditLine(auditRecordOf(event('ADMIN_ENTER', { target: 'ATTRACT' })));
    expect(line).toBe('2026-08-17T09:12:03.114Z,admin_enter,ATTRACT,,,ok');
  });

  it('파라미터 저장 로그가 변경 전/후를 담는다', () => {
    const line = auditLine(
      auditRecordOf(
        event('PARAM_SAVE', {
          target: 'GAME PARAMETERS',
          before: 'SESSION TIME=120 초',
          after: 'SESSION TIME=135 초',
        })
      )
    );
    expect(line).toBe(
      '2026-08-17T09:12:03.114Z,param_save,GAME PARAMETERS,SESSION TIME=120 초,SESSION TIME=135 초,ok'
    );
  });

  it('쉼표·개행은 공백으로 바뀐다 (§9.1)', () => {
    const line = auditLine(
      auditRecordOf(event('SETTING_CHANGE', { target: 'A,B', after: 'x\ny' }))
    );
    expect(line.split(',')).toHaveLength(6);
    expect(line).toContain('A B');
    expect(line).not.toContain('\n');
  });

  it('결과 칸 기본값은 ok다', () => {
    expect(auditRecordOf(event('STATS_RESET')).result).toBe('ok');
  });

  it('결과 칸에 실패를 적을 수 있다 (성공·실패 모두 기록 — admin §13)', () => {
    expect(auditRecordOf(event('SYSTEM_ACTION', { result: '[보류]' })).result).toBe('[보류]');
  });

  it('`target`이 없으면 `detail`이 그 자리에 온다 (WU-04 경로 호환)', () => {
    expect(
      auditRecordOf(event('CLOCK_CHANGED', { detail: 'boot 2026-08-16 -> 2026-08-17' })).target
    ).toBe('boot 2026-08-16 -> 2026-08-17');
  });
});

describe('10-2 action 매핑 13종', () => {
  it('WU-04가 쏘던 5종이 그대로 있다', () => {
    expect(AUDIT_ACTION.CLOCK_CHANGED).toBe('clock_changed');
    expect(AUDIT_ACTION.CREDIT_RECOVERED).toBe('credit_recovered');
    expect(AUDIT_ACTION.STATS_RESET).toBe('stats_reset');
    expect(AUDIT_ACTION.EVENT_GRANT).toBe('event_grant');
    expect(AUDIT_ACTION.CREDIT_LOG_FAILURE).toBe('credit_log_failure');
  });

  it('WU-05 관리자 8종이 추가됐다', () => {
    expect(AUDIT_ACTION.ADMIN_ENTER).toBe('admin_enter');
    expect(AUDIT_ACTION.ADMIN_EXIT).toBe('admin_exit');
    expect(AUDIT_ACTION.SETTING_CHANGE).toBe('setting_change');
    expect(AUDIT_ACTION.PARAM_SAVE).toBe('param_save');
    expect(AUDIT_ACTION.PARAM_RESTORE).toBe('param_restore');
    expect(AUDIT_ACTION.RANKING_RESET).toBe('ranking_reset');
    expect(AUDIT_ACTION.SYSTEM_ACTION).toBe('system_action');
    expect(AUDIT_ACTION.TEST_PLAY).toBe('test_play');
  });

  it('action 문자열이 전부 유일하다', () => {
    const values = Object.values(AUDIT_ACTION);
    expect(new Set(values).size).toBe(values.length);
  });

  it('13종 전부 매핑돼 있다', () => {
    expect(Object.keys(AUDIT_ACTION)).toHaveLength(13);
  });
});

describe('10-3 파싱', () => {
  it('왕복한다', () => {
    const rec = auditRecordOf(event('PARAM_RESTORE', { target: '세션', after: 'FACTORY' }));
    expect(parseAuditLine(auditLine(rec))).toEqual(rec);
  });

  it('칸이 모자라면 null이다', () => {
    expect(parseAuditLine('a,b,c')).toBe(null);
  });

  it('타임스탬프·action이 비면 null이다', () => {
    expect(parseAuditLine(',,,,,')).toBe(null);
    expect(parseAuditLine('2026-08-17T00:00:00Z,,,,,')).toBe(null);
  });
});

describe('10-4 파일 기록 (F-c — 헤더 줄 없음)', () => {
  it('`audit_log.csv`는 추가 전용이다', () => {
    expect(APPEND_ONLY_FILES).toContain(FILES.auditLog);
  });

  it('첫 줄이 곧바로 데이터 행이다 (헤더를 붙이지 않는다)', async () => {
    const rig = memoryStorage();
    const logger = new AuditLogger({
      append: (file, line) => {
        void rig.storage.appendLine(file, line);
      },
    });
    logger.write(event('ADMIN_ENTER', { target: 'ATTRACT' }));
    await flushAsync();
    expect(rig.kv.dump(FILES.auditLog)).toBe('2026-08-17T09:12:03.114Z,admin_enter,ATTRACT,,,ok');
  });

  it('여러 줄이 순서대로 쌓인다', async () => {
    const rig = memoryStorage();
    const logger = new AuditLogger({
      append: (file, line) => {
        void rig.storage.appendLine(file, line);
      },
    });
    logger.write(event('ADMIN_ENTER', { target: 'ATTRACT' }));
    logger.write(event('PARAM_SAVE', { target: 'GAME PARAMETERS' }));
    logger.write(event('ADMIN_EXIT', { target: 'ADMIN HOME' }));
    await flushAsync();
    const lines = (rig.kv.dump(FILES.auditLog) ?? '').split('\n');
    expect(lines.map((l) => l.split(',')[1])).toEqual(['admin_enter', 'param_save', 'admin_exit']);
  });

  it('기록한 줄을 메모리에서도 볼 수 있다 (진단 표시)', () => {
    const written: string[] = [];
    const logger = new AuditLogger({
      append: (_file, line) => {
        written.push(line);
      },
    });
    logger.write(event('STATS_RESET', { target: 'paid' }));
    expect(logger.written).toEqual(written);
    expect(logger.written).toHaveLength(1);
  });
});

describe('10-5 기록 시점 (§11.7 · 돌연변이 ④)', () => {
  it('관리자 진입에서 `admin_enter`가 나온다', () => {
    const rig = makeAdmin();
    expect(rig.audits.map((e) => e.kind)).toContain('ADMIN_ENTER');
  });

  it('파라미터 저장 성공에서 `param_save`가 나온다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    const save = rig.audits.find((e) => e.kind === 'PARAM_SAVE');
    expect(save?.target).toBe('GAME PARAMETERS');
    expect(save?.after).toContain('SESSION TIME=121');
    expect(save?.result).toContain('ok');
  });

  it('저장 차단도 감사 로그를 남긴다 (성공·실패 모두)', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.press('LEFT'); // S+ 임계를 바닥으로
    await rig.admin.save();
    const save = rig.audits.find((e) => e.kind === 'PARAM_SAVE');
    expect(save?.result).toContain('blocked');
  });

  it('랭킹 초기화가 **건수만** 남긴다 (§5.7 · admin §11.6 — 이니셜 미기록)', async () => {
    const rig = makeAdmin();
    rig.ranking.size = 10;
    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.press('DOWN');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    const reset = rig.audits.find((e) => e.kind === 'RANKING_RESET');
    expect(reset?.before).toBe('10');
    expect(reset?.after).toBe('0');
    expect(reset?.target).toBe(FILES.ranking);
    // 건수 외에는 아무것도 없다 — 이니셜이 들어갈 칸 자체가 없다
    expect(reset?.before).toMatch(/^[0-9]+$/);
    expect(reset?.after).toMatch(/^[0-9]+$/);
    expect(reset?.detail).toBe(FILES.ranking);
  });

  it('기기 설정 변경에서 `setting_change`가 전/후를 담는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MACHINE']);
    rig.press('RIGHT');
    const change = rig.audits.find((e) => e.kind === 'SETTING_CHANGE');
    expect(change?.target).toBe('SOUND VOLUME');
    expect(change?.before).toBe('80');
    expect(change?.after).toBe('85');
  });

  it('공장값 복원에서 `param_restore`가 나온다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['RESET', 'R_PARAMS']);
    rig.press('DOWN');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.audits.some((e) => e.kind === 'PARAM_RESTORE')).toBe(true);
  });

  it('시스템 작업이 결과와 함께 기록된다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MAINTENANCE', 'M_SYSTEM']);
    rig.press('BUTTON1'); // RESTART GAME
    rig.holdConfirm(2000);
    await flushAsync();
    const action = rig.audits.find((e) => e.kind === 'SYSTEM_ACTION');
    expect(action?.target).toBe('RESTART GAME');
    expect(action?.result).toBe('ok');
  });

  it('종료에서 `admin_exit`가 나온다', async () => {
    const rig = makeAdmin();
    await rig.admin.exitAndSave();
    expect(rig.audits.some((e) => e.kind === 'ADMIN_EXIT')).toBe(true);
  });
});
