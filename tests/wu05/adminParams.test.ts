// 파라미터 문서·필드 스키마 (§11.3 · §11.4 — 계획 T1)
//
// 여기서 고정하는 것은 셋이다.
//   ① §11.4 전 항목이 스키마에 **행 단위로** 있다 (59행 / 수치 79)
//   ② 코어 25항목의 범위·라벨·단위가 `PARAM_RANGES`와 **전수 일치**한다 (숫자를 두 번 적지 않았다)
//   ③ 실측 제약 F-a~F-e를 깨지 않았다 (가드 테스트)

import { describe, expect, it } from 'vitest';
import {
  FACTORY_ADMIN_PARAMS,
  FACTORY_TIERS,
  FIELD_CELLS,
  FIELD_SCHEMA,
  MONOTONIC_AXES,
  PARAM_DATA_VERSION,
  PARAM_TIERS,
  TIER_AXES,
  TIER_AXIS_RANGE,
  TIER_LABEL,
  TIER_AXIS_LABEL,
  cellOf,
  clockToMinutes,
  fieldOf,
  fieldsOfFile,
  fieldsOfGroup,
  minutesToClock,
  readField,
  restoreGroup,
  specOfCell,
  toCoreParams,
  writeField,
  type FieldGroup,
} from '../../src/core/adminParams';
import { FACTORY_PARAMS, PARAM_RANGES } from '../../src/core/params';
import { TIER_RANGES } from '../../src/game/boardSource';
import { APPEND_ONLY_FILES, CODEC_FILES, FILES } from '../../src/persist/csv';

const GAME_ROWS = FIELD_SCHEMA.filter((f) => f.file === 'params');
const MACHINE_ROWS = FIELD_SCHEMA.filter((f) => f.file === 'settings');

describe('1-1 스키마 규모 (§11.4 전 항목)', () => {
  it('GAME PARAMETERS는 59행이다', () => {
    expect(GAME_ROWS).toHaveLength(59);
  });

  it('GAME PARAMETERS의 편집 수치는 79개다 (구간표가 MIN~MAX 쌍 — Q-2)', () => {
    expect(GAME_ROWS.flatMap((f) => f.cells)).toHaveLength(79);
  });

  it('MACHINE SETTINGS는 7행 · 수치 9개다 (§11.3)', () => {
    expect(MACHINE_ROWS).toHaveLength(7);
    expect(MACHINE_ROWS.flatMap((f) => f.cells)).toHaveLength(9);
  });

  it('그룹별 행 수가 §11.4 표와 같다', () => {
    const counts: Readonly<Record<FieldGroup, number>> = {
      세션: 6,
      시간: 4,
      난이도: 6,
      구간표: 20,
      연출: 3,
      힌트: 4,
      점수: 10,
      등급: 5,
      랭킹: 1,
      기기: 7,
    };
    for (const [group, n] of Object.entries(counts)) {
      expect(fieldsOfGroup(group as FieldGroup)).toHaveLength(n);
    }
  });

  it('행 id가 중복되지 않는다', () => {
    expect(new Set(FIELD_SCHEMA.map((f) => f.id)).size).toBe(FIELD_SCHEMA.length);
  });

  it('셀 키가 중복되지 않는다', () => {
    expect(new Set(FIELD_CELLS.map((c) => c.key)).size).toBe(FIELD_CELLS.length);
  });

  it('`FIELD_CELLS`는 행 순서를 그대로 편 것이다', () => {
    expect(FIELD_CELLS).toEqual(FIELD_SCHEMA.flatMap((f) => f.cells));
  });

  it('모든 셀 키가 공장 문서에서 실제로 읽힌다', () => {
    for (const cell of FIELD_CELLS) {
      expect(readField(FACTORY_ADMIN_PARAMS, cell.key)).not.toBe(undefined);
    }
  });

  it('`fieldsOfFile`이 두 파일로 정확히 갈린다', () => {
    expect(fieldsOfFile('params')).toHaveLength(59);
    expect(fieldsOfFile('settings')).toHaveLength(7);
  });
});

describe('1-2 `PARAM_RANGES` 전수 일치 (P-2 — 숫자를 두 번 적지 않았다)', () => {
  const coreRows = FIELD_SCHEMA.filter((f) => f.binding === 'core');

  it('코어 바인딩 행은 25개다 (`CoreParams` 전량)', () => {
    expect(coreRows).toHaveLength(25);
  });

  it('수치 24종의 min·max·label·unit·group이 `PARAM_RANGES`와 같다', () => {
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
      const spec = fieldOf(`core.${key}`);
      expect(spec.label).toBe(range.label);
      expect(spec.unit).toBe(range.unit);
      expect(spec.group).toBe(range.group);
      expect(spec.cells[0].min).toBe(range.min);
      expect(spec.cells[0].max).toBe(range.max);
    }
  });

  it('`CONTINUE`(ON/OFF)만 `PARAM_RANGES`에 없는 코어 항목이다', () => {
    const missing = coreRows.filter((f) => !(f.id.slice('core.'.length) in PARAM_RANGES));
    expect(missing.map((f) => f.id)).toEqual(['core.continueEnabled']);
  });

  it('코어 행의 공장값이 `FACTORY_PARAMS`와 문자 단위로 같다', () => {
    for (const key of Object.keys(FACTORY_PARAMS) as (keyof typeof FACTORY_PARAMS)[]) {
      expect(readField(FACTORY_ADMIN_PARAMS, `core.${key}`)).toBe(FACTORY_PARAMS[key]);
    }
  });
});

describe('1-3 구간표 (§6.2 · Q-2 · Q-4)', () => {
  it('구간 5종이 `boardSource.TIER_RANGES`와 같은 집합이다', () => {
    expect([...PARAM_TIERS]).toEqual(Object.keys(TIER_RANGES));
  });

  it('공장 구간표의 사슬 수·안전수·깊이가 §6.2 표(TIER_RANGES)와 같다', () => {
    for (const tier of PARAM_TIERS) {
      const spec = FACTORY_TIERS[tier];
      expect([spec.chains.min, spec.chains.max]).toEqual([...TIER_RANGES[tier].chains]);
      expect([spec.safeMoves.min, spec.safeMoves.max]).toEqual([...TIER_RANGES[tier].safeMoves]);
      expect([spec.depth.min, spec.depth.max]).toEqual([...TIER_RANGES[tier].depth]);
    }
  });

  it('ENDLESS 목표 시간 공장값은 38초다 (Q-4 · §4.3 검산표)', () => {
    expect(FACTORY_TIERS.ENDLESS.targetSec).toEqual({ min: 38, max: 38 });
  });

  it('구간표 20행이 전부 MIN~MAX 2셀이다', () => {
    const rows = fieldsOfGroup('구간표');
    for (const row of rows) {
      expect(row.cells).toHaveLength(2);
      expect(row.separator).toBe('~');
    }
  });

  it('구간표 셀 범위가 §6.2 조정 범위와 같다', () => {
    for (const tier of PARAM_TIERS) {
      for (const axis of TIER_AXES) {
        const spec = fieldOf(`tiers.${tier}.${axis}`);
        expect(spec.cells[0].min).toBe(TIER_AXIS_RANGE[axis].min);
        expect(spec.cells[1].max).toBe(TIER_AXIS_RANGE[axis].max);
      }
    }
  });

  it('공장 구간표가 조정 범위 안에 있다', () => {
    for (const tier of PARAM_TIERS) {
      for (const axis of TIER_AXES) {
        const range = TIER_AXIS_RANGE[axis];
        const value = FACTORY_TIERS[tier][axis];
        expect(value.min).toBeGreaterThanOrEqual(range.min);
        expect(value.max).toBeLessThanOrEqual(range.max);
        expect(value.min).toBeLessThanOrEqual(value.max);
      }
    }
  });

  it('단조성 검사 축은 사슬 수·의존 깊이 둘뿐이다 (§11.5 문언)', () => {
    expect([...MONOTONIC_AXES]).toEqual(['chains', 'depth']);
  });

  it('구간표 행 라벨이 구간명 + 축명이다', () => {
    expect(fieldOf('tiers.MASTER.depth').label).toBe(
      `${TIER_LABEL.MASTER} ${TIER_AXIS_LABEL.depth}`
    );
  });

  it('구간표 20행은 전부 고급 필드다 (§11.4 하위 화면)', () => {
    expect(fieldsOfGroup('구간표').every((f) => f.advanced === true)).toBe(true);
  });
});

describe('1-4 반영 시점·바인딩·배지 (admin §4.3 · R6)', () => {
  it('`binding === "store"` 행에는 반드시 대기 배지가 있다', () => {
    for (const spec of FIELD_SCHEMA) {
      if (spec.binding === 'store') expect(spec.pendingUnit).toBeDefined();
    }
  });

  it('실제로 소비되는 행에는 대기 배지가 없다', () => {
    for (const spec of FIELD_SCHEMA) {
      if (spec.binding !== 'store') expect(spec.pendingUnit).toBeUndefined();
    }
  });

  it('코어 25항목은 전부 NEXT GAME이다 (P-8)', () => {
    for (const spec of FIELD_SCHEMA) {
      if (spec.binding === 'core') expect(spec.applyTiming).toBe('NEXT GAME');
    }
  });

  it('코인·컨티뉴 코인은 NEXT CHARGE다 (§11.3)', () => {
    expect(fieldOf('machine.coinsPerPlay').applyTiming).toBe('NEXT CHARGE');
    expect(fieldOf('machine.continueCoins').applyTiming).toBe('NEXT CHARGE');
  });

  it('사운드·야간 음소거·단가는 LIVE다', () => {
    expect(fieldOf('machine.soundVolume').applyTiming).toBe('LIVE');
    expect(fieldOf('machine.nightMute').applyTiming).toBe('LIVE');
    expect(fieldOf('machine.coinUnitPrice').applyTiming).toBe('LIVE');
  });

  it('분포 전환 표본 수는 RESTART REQUIRED다 (admin §4.3)', () => {
    expect(fieldOf('grade.sampleThreshold').applyTiming).toBe('RESTART REQUIRED');
  });

  it('Q-1 7항목이 실제 소비처(flow)에 묶여 있다', () => {
    for (const id of [
      'grade.sPlus',
      'grade.s',
      'grade.a',
      'grade.b',
      'ui.hintShowSec',
      'ui.hintCooldownSec',
      'ui.nameEntrySec',
    ]) {
      expect(fieldOf(id).binding).toBe('flow');
    }
  });

  it('`COIN UNIT PRICE`만 미설정(null)을 허용한다', () => {
    const nullable = FIELD_CELLS.filter((c) => c.nullable === true);
    expect(nullable.map((c) => c.key)).toEqual(['machine.coinUnitPrice']);
  });
});

describe('1-5 읽기·쓰기 불변성', () => {
  it('`writeField`는 원본을 바꾸지 않는다', () => {
    const before = FACTORY_ADMIN_PARAMS.core.sessionTimeSec;
    const next = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 135);
    expect(FACTORY_ADMIN_PARAMS.core.sessionTimeSec).toBe(before);
    expect(next.core.sessionTimeSec).toBe(135);
  });

  it('중첩 경로도 원본을 공유하지 않는다', () => {
    const next = writeField(FACTORY_ADMIN_PARAMS, 'tiers.MASTER.depth.max', 20);
    expect(FACTORY_ADMIN_PARAMS.tiers.MASTER.depth.max).toBe(16);
    expect(next.tiers.MASTER.depth.max).toBe(20);
    expect(next.tiers.WARMUP).toBe(FACTORY_ADMIN_PARAMS.tiers.WARMUP);
  });

  it('없는 경로는 undefined를 돌려준다', () => {
    expect(readField(FACTORY_ADMIN_PARAMS, 'core.nope')).toBe(undefined);
    expect(readField(FACTORY_ADMIN_PARAMS, 'nope.nope.nope')).toBe(undefined);
  });

  it('null 값(미설정 단가)을 그대로 읽는다', () => {
    expect(readField(FACTORY_ADMIN_PARAMS, 'machine.coinUnitPrice')).toBe(null);
  });

  it('불리언·문자열도 읽는다', () => {
    expect(readField(FACTORY_ADMIN_PARAMS, 'core.continueEnabled')).toBe(true);
    expect(readField(FACTORY_ADMIN_PARAMS, 'difficulty.preset')).toBe('STANDARD');
    expect(readField(FACTORY_ADMIN_PARAMS, 'machine.nightMuteStart')).toBe('22:00');
  });

  it('`toCoreParams`가 코어 25항목을 그대로 넘긴다', () => {
    expect(toCoreParams(FACTORY_ADMIN_PARAMS)).toEqual(FACTORY_PARAMS);
  });

  it('편집된 코어 값이 투영에 그대로 나온다', () => {
    const next = writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', 7);
    expect(toCoreParams(next).initialHearts).toBe(7);
    expect(Object.keys(toCoreParams(next))).toHaveLength(25);
  });

  it('`specOfCell`·`cellOf`가 셀 키에서 행·셀을 찾는다', () => {
    expect(specOfCell('tiers.WARMUP.chains.max')?.id).toBe('tiers.WARMUP.chains');
    expect(cellOf('tiers.WARMUP.chains.max')?.step).toBe(1);
    expect(specOfCell('없는키')).toBe(undefined);
    expect(cellOf('없는키')).toBe(undefined);
  });

  it('`fieldOf`는 없는 id에서 던진다', () => {
    expect(() => fieldOf('없는행')).toThrow();
  });
});

describe('1-6 그룹 복원 (`RESTORE THIS PRESET` — ADM-205)', () => {
  it('그룹 1개만 공장값으로 되돌린다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150);
    p = writeField(p, 'core.scoreBase', 200);
    const restored = restoreGroup(p, '세션');
    expect(restored.core.sessionTimeSec).toBe(120);
    expect(restored.core.scoreBase).toBe(200);
  });

  it('구간표 복원은 20행 전량을 되돌린다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'tiers.WARMUP.chains.min', 40);
    p = writeField(p, 'tiers.ENDLESS.depth.max', 30);
    const restored = restoreGroup(p, '구간표');
    expect(restored.tiers).toEqual(FACTORY_TIERS);
  });

  it('원본은 바뀌지 않는다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150);
    restoreGroup(p, '세션');
    expect(p.core.sessionTimeSec).toBe(150);
  });
});

describe('1-7 시각 변환 (`NIGHT MUTE` clock 타입)', () => {
  it('HH:MM ↔ 분을 왕복한다', () => {
    expect(clockToMinutes('22:00')).toBe(1320);
    expect(clockToMinutes('00:30')).toBe(30);
    expect(minutesToClock(1320)).toBe('22:00');
    expect(minutesToClock(30)).toBe('00:30');
  });

  it('형식이 어긋나면 null이다', () => {
    for (const bad of ['22시', '2200', '', '99:99', '12:5']) {
      expect(clockToMinutes(bad)).toBe(null);
    }
  });

  it('하루를 넘는 분은 감아 돈다', () => {
    expect(minutesToClock(1440)).toBe('00:00');
    expect(minutesToClock(-30)).toBe('23:30');
  });
});

describe('1-8 실측 제약 가드 (F-a ~ F-d)', () => {
  it('F-a — `CoreParams` 공장값은 여전히 25키다 (확장하지 않았다)', () => {
    expect(Object.keys(FACTORY_PARAMS)).toHaveLength(25);
  });

  it('F-b — `params.csv`는 `CODEC_FILES`에 들어가지 않았다', () => {
    expect(CODEC_FILES).not.toContain(FILES.params);
    expect([...CODEC_FILES]).toEqual([FILES.settings, FILES.stats, FILES.creditLog]);
  });

  it('F-c — `audit_log.csv`는 추가 전용 목록에 그대로 있다', () => {
    expect(APPEND_ONLY_FILES).toContain(FILES.auditLog);
  });

  it('F-d — `settings.csv`는 코덱 목록의 첫 항목 그대로다', () => {
    expect(CODEC_FILES[0]).toBe(FILES.settings);
  });

  it('공장 데이터 버전은 1이다 (§12.1)', () => {
    expect(PARAM_DATA_VERSION).toBe(1);
  });
});
