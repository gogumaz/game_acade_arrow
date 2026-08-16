// 선언형 필드 편집기 (§11.4 · admin §4.1·§4.3 — 계획 T6 · ADM-005 · ADM-201)
//
// 항목별 코드 없이 타입만 보고 증감·clamp·표시가 성립하는지, 2초 홀드 5배 가속이 실제로
// 붙는지, 작업 사본이 라이브를 오염시키지 않는지를 판정한다.

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, fieldOf, readField, writeField } from '../../src/core/adminParams';
import {
  ACCEL_AFTER_MS,
  ACCEL_BURST_GAP_MS,
  ACCEL_FACTOR,
  FieldEditor,
  HoldAccel,
  adjustCell,
  decimalsOf,
  formatChange,
  formatCellValue,
  formatFieldValue,
} from '../../src/game/admin/editor';

const SESSION = fieldOf('core.sessionTimeSec');
const HEARTS = fieldOf('core.initialHearts');
const CONTINUE = fieldOf('core.continueEnabled');
const PRESET = fieldOf('difficulty.preset');
const NIGHT = fieldOf('machine.nightMute');
const PRICE = fieldOf('machine.coinUnitPrice');
const TIER = fieldOf('tiers.WARMUP.chains');
const SLIDE = fieldOf('core.slideOutPerSegmentSec');

describe('8-1 증감과 clamp (ADM-005 "범위 밖 값 없음")', () => {
  it('step만큼 오른다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, 1, 0);
    expect(e.draft.core.sessionTimeSec).toBe(121);
  });

  it('step만큼 내린다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, -1, 0);
    expect(e.draft.core.sessionTimeSec).toBe(119);
  });

  it('상한에서 더 움직이지 않는다', () => {
    const e = new FieldEditor(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150));
    expect(e.adjust(SESSION, 0, 1, 0)).toBe(false);
    expect(e.draft.core.sessionTimeSec).toBe(150);
  });

  it('하한에서 더 움직이지 않는다', () => {
    const e = new FieldEditor(writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', 1));
    expect(e.adjust(HEARTS, 0, -1, 0)).toBe(false);
    expect(e.draft.core.initialHearts).toBe(1);
  });

  it('음수 범위 항목도 조인다 (FAIL TIME PENALTY)', () => {
    const spec = fieldOf('core.failTimePenaltySec');
    let p = FACTORY_ADMIN_PARAMS;
    const e = new FieldEditor(p);
    for (let i = 0; i < 20; i += 1) e.adjust(spec, 0, -1, i * 1000);
    expect(e.draft.core.failTimePenaltySec).toBe(-5);
    p = e.draft;
    const up = new FieldEditor(p);
    for (let i = 0; i < 20; i += 1) up.adjust(spec, 0, 1, i * 1000);
    expect(up.draft.core.failTimePenaltySec).toBe(0);
  });

  it('소수 step에서 부동소수 잔차가 남지 않는다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SLIDE, 0, 1, 0);
    expect(e.draft.core.slideOutPerSegmentSec).toBe(0.023);
    e.adjust(SLIDE, 0, 1, 10000);
    expect(e.draft.core.slideOutPerSegmentSec).toBe(0.024);
  });

  it('`decimalsOf`가 step의 자릿수를 센다', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.5)).toBe(1);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(0.001)).toBe(3);
  });

  it('방향 0이면 값이 그대로다', () => {
    expect(adjustCell(SESSION.cells[0], 120, 0)).toBe(120);
  });
});

describe('8-2 타입별 편집 (항목별 코드 없이)', () => {
  it('toggle은 방향으로 ON/OFF가 정해진다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(CONTINUE, 0, -1, 0);
    expect(e.draft.core.continueEnabled).toBe(false);
    e.adjust(CONTINUE, 0, 1, 10000);
    expect(e.draft.core.continueEnabled).toBe(true);
  });

  it('enum은 목록을 따라 움직이고 끝에서 멈춘다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(PRESET, 0, -1, 0);
    expect(e.draft.difficulty.preset).toBe('KIDS');
    expect(e.adjust(PRESET, 0, -1, 10000)).toBe(false);
    e.adjust(PRESET, 0, 1, 20000);
    e.adjust(PRESET, 0, 1, 30000);
    expect(e.draft.difficulty.preset).toBe('HARD');
    expect(e.adjust(PRESET, 0, 1, 40000)).toBe(false);
  });

  it('clock은 30분 단위로 움직인다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(NIGHT, 1, 1, 0);
    expect(e.draft.machine.nightMuteStart).toBe('22:30');
    e.adjust(NIGHT, 1, -1, 10000);
    e.adjust(NIGHT, 1, -1, 20000);
    expect(e.draft.machine.nightMuteStart).toBe('21:30');
  });

  it('clock도 범위 끝에서 멈춘다', () => {
    const e = new FieldEditor(writeField(FACTORY_ADMIN_PARAMS, 'machine.nightMuteEnd', '23:30'));
    expect(e.adjust(NIGHT, 2, 1, 0)).toBe(false);
    expect(e.draft.machine.nightMuteEnd).toBe('23:30');
  });

  it('미설정 단가는 오른쪽 1회로 하한이 된다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(PRICE, 0, 1, 0);
    expect(e.draft.machine.coinUnitPrice).toBe(100);
  });

  it('하한에서 왼쪽 1회면 다시 미설정이 된다', () => {
    const e = new FieldEditor(writeField(FACTORY_ADMIN_PARAMS, 'machine.coinUnitPrice', 100));
    e.adjust(PRICE, 0, -1, 0);
    expect(e.draft.machine.coinUnitPrice).toBe(null);
  });

  it('미설정에서 왼쪽은 미설정 그대로다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    expect(e.adjust(PRICE, 0, -1, 0)).toBe(false);
    expect(e.draft.machine.coinUnitPrice).toBe(null);
  });

  it('구간표 행은 셀 인덱스로 MIN·MAX를 따로 편집한다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(TIER, 0, 1, 0);
    expect(e.draft.tiers.WARMUP.chains.min).toBe(7);
    expect(e.draft.tiers.WARMUP.chains.max).toBe(12);
    e.adjust(TIER, 1, 1, 10000);
    expect(e.draft.tiers.WARMUP.chains.max).toBe(13);
  });

  it('셀 인덱스가 범위를 벗어나면 마지막 셀로 조인다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(TIER, 9, 1, 0);
    expect(e.draft.tiers.WARMUP.chains.max).toBe(13);
  });
});

describe('8-3 2초 홀드 5배 가속 (admin §4.1)', () => {
  it('버스트가 2초를 넘기면 배수가 5가 된다 (반복 간격 100ms — 입력 계층 §2.5)', () => {
    const accel = new HoldAccel();
    expect(accel.factor(0, 1)).toBe(1);
    for (let t = 100; t < ACCEL_AFTER_MS; t += 100) expect(accel.factor(t, 1)).toBe(1);
    expect(accel.factor(ACCEL_AFTER_MS, 1)).toBe(ACCEL_FACTOR);
  });

  it('간격이 벌어지면 버스트가 끊긴다', () => {
    const accel = new HoldAccel();
    accel.factor(0, 1);
    expect(accel.factor(ACCEL_BURST_GAP_MS + 1, 1)).toBe(1);
    expect(accel.factor(ACCEL_BURST_GAP_MS + 1 + ACCEL_AFTER_MS, 1)).toBe(1);
  });

  it('방향이 바뀌면 버스트가 끊긴다', () => {
    const accel = new HoldAccel();
    for (let t = 0; t <= ACCEL_AFTER_MS; t += 100) accel.factor(t, 1);
    expect(accel.factor(ACCEL_AFTER_MS + 100, -1)).toBe(1);
  });

  it('`reset()`이 버스트를 끊는다', () => {
    const accel = new HoldAccel();
    for (let t = 0; t <= ACCEL_AFTER_MS; t += 100) accel.factor(t, 1);
    accel.reset();
    expect(accel.factor(ACCEL_AFTER_MS + 100, 1)).toBe(1);
  });

  it('편집기에서 2초 홀드 뒤 값이 5배씩 움직인다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    let t = 0;
    for (; t <= ACCEL_AFTER_MS; t += 100) e.adjust(SESSION, 0, 1, t);
    const before = e.draft.core.sessionTimeSec;
    e.adjust(SESSION, 0, 1, t);
    expect(e.draft.core.sessionTimeSec - before).toBe(5);
  });

  it('가속 중에도 상한을 넘지 않는다', () => {
    const e = new FieldEditor(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 148));
    for (let t = 0; t <= ACCEL_AFTER_MS + 500; t += 100) e.adjust(SESSION, 0, 1, t);
    expect(e.draft.core.sessionTimeSec).toBe(150);
  });

  it('행 이동(`breakAccel`)이 가속을 끊는다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    let t = 0;
    for (; t <= ACCEL_AFTER_MS; t += 100) e.adjust(SESSION, 0, 1, t);
    e.breakAccel();
    const before = e.draft.core.sessionTimeSec;
    e.adjust(SESSION, 0, 1, t + 100);
    expect(e.draft.core.sessionTimeSec - before).toBe(1);
  });
});

describe('8-4 표시 포맷 (admin §4.3 단위·`1 → 2`)', () => {
  it('단위를 붙인다', () => {
    expect(formatFieldValue(SESSION, FACTORY_ADMIN_PARAMS)).toBe('120 초');
    expect(formatFieldValue(HEARTS, FACTORY_ADMIN_PARAMS)).toBe('3 개');
  });

  it('toggle은 ON/OFF다', () => {
    expect(formatFieldValue(CONTINUE, FACTORY_ADMIN_PARAMS)).toBe('ON');
  });

  it('구간표는 `MIN ~ MAX`다', () => {
    expect(formatFieldValue(TIER, FACTORY_ADMIN_PARAMS)).toBe('6 ~ 12 개');
  });

  it('NIGHT MUTE는 스위치 + 두 시각이다', () => {
    expect(formatFieldValue(NIGHT, FACTORY_ADMIN_PARAMS)).toBe('ON 22:00 ~ 10:00');
  });

  it('미설정 단가는 `— 미설정`이다', () => {
    expect(formatFieldValue(PRICE, FACTORY_ADMIN_PARAMS)).toBe('— 미설정 원');
  });

  it('소수는 step 자릿수로 잘라 보여 준다', () => {
    expect(formatFieldValue(SLIDE, FACTORY_ADMIN_PARAMS)).toBe('0.022 초');
  });

  it('변경 전/후를 `1 → 2` 형식으로 만든다', () => {
    const next = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 135);
    expect(formatChange(SESSION, FACTORY_ADMIN_PARAMS, next)).toBe('120 초 → 135 초');
  });

  it('값이 없으면 `—`다', () => {
    expect(formatCellValue(SESSION.cells[0], undefined)).toBe('—');
  });
});

describe('8-5 작업 사본 (ADM-201 · 돌연변이 ③)', () => {
  it('편집은 draft에만 반영된다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, 1, 0);
    expect(e.live.core.sessionTimeSec).toBe(120);
    expect(e.draft.core.sessionTimeSec).toBe(121);
  });

  it('`discard()`는 draft만 버린다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, 1, 0);
    e.discard();
    expect(e.draft).toBe(e.live);
    expect(e.dirty).toBe(false);
  });

  it('`commit()`이 draft를 live로 올린다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, 1, 0);
    e.commit();
    expect(e.live.core.sessionTimeSec).toBe(121);
    expect(e.dirty).toBe(false);
  });

  it('공장 문서 객체는 절대 바뀌지 않는다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, 1, 0);
    e.adjust(TIER, 0, 1, 100);
    expect(FACTORY_ADMIN_PARAMS.core.sessionTimeSec).toBe(120);
    expect(FACTORY_ADMIN_PARAMS.tiers.WARMUP.chains.min).toBe(6);
  });

  it('`dirtyKeys`가 바뀐 셀만 준다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, 1, 0);
    e.adjust(TIER, 1, 1, 100);
    expect([...e.dirtyKeys()]).toEqual(['core.sessionTimeSec', 'tiers.WARMUP.chains.max']);
  });

  it('되돌린 값은 dirty가 아니다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(SESSION, 0, 1, 0);
    e.adjust(SESSION, 0, -1, 10000);
    expect(e.dirtyKeys()).toEqual([]);
    expect(e.dirty).toBe(false);
  });

  it('`dirtySpecs`가 화면 행 단위로 중복 없이 준다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.adjust(TIER, 0, 1, 0);
    e.adjust(TIER, 1, 1, 100);
    expect(e.dirtySpecs().map((s) => s.id)).toEqual(['tiers.WARMUP.chains']);
    expect(e.isDirtySpec(TIER)).toBe(true);
    expect(e.isDirtySpec(SESSION)).toBe(false);
  });

  it('`reset()`은 live·draft를 함께 갈아 끼운다 (공장값 복원)', () => {
    const e = new FieldEditor(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150));
    e.reset(FACTORY_ADMIN_PARAMS);
    expect(e.live).toBe(FACTORY_ADMIN_PARAMS);
    expect(e.draft).toBe(FACTORY_ADMIN_PARAMS);
  });

  it('`setDraft`는 라이브를 건드리지 않는다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    e.setDraft(writeField(FACTORY_ADMIN_PARAMS, 'core.scoreBase', 200));
    expect(e.live.core.scoreBase).toBe(100);
    expect(e.draft.core.scoreBase).toBe(200);
  });

  it('79수치를 전부 편집해도 라이브가 그대로다', () => {
    const e = new FieldEditor(FACTORY_ADMIN_PARAMS);
    let t = 0;
    for (const spec of [SESSION, HEARTS, TIER, SLIDE]) {
      for (let i = 0; i < spec.cells.length; i += 1) {
        t += 1000;
        e.adjust(spec, i, 1, t);
      }
    }
    expect(e.live).toEqual(FACTORY_ADMIN_PARAMS);
    expect(readField(e.draft, 'core.initialHearts')).toBe(4);
  });
});
