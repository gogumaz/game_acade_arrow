// 난이도 프리셋과 그룹 복원 (§11.4 — 계획 T3 · ADM-205 · 돌연변이 ⑤)
//
// 프리셋은 **구간표 20행만** 갈아 끼우고, 결과는 항상 §6.2 조정 범위 안이며 단조성을 만족한다.
// 이 세 가지가 깨지면 저장 검증이 자기 프리셋을 거부하는 모순이 생긴다.

import { describe, expect, it } from 'vitest';
import {
  DIFFICULTY_PRESETS,
  FACTORY_ADMIN_PARAMS,
  FACTORY_TIERS,
  PARAM_TIERS,
  TIER_AXES,
  TIER_AXIS_RANGE,
  applyPreset,
  validateAdminParams,
  writeField,
  type DifficultyPreset,
} from '../../src/core/adminParams';
import { FieldEditor } from '../../src/game/admin/editor';
import { okSolverGate } from './harness';

const gate = okSolverGate();

describe('3-1 프리셋 3종이 조정 범위와 단조성을 만족한다 (돌연변이 ⑤)', () => {
  for (const preset of DIFFICULTY_PRESETS) {
    it(`${preset} — 모든 셀이 §6.2 조정 범위 안이다`, () => {
      const p = applyPreset(FACTORY_ADMIN_PARAMS, preset);
      for (const tier of PARAM_TIERS) {
        for (const axis of TIER_AXES) {
          const range = TIER_AXIS_RANGE[axis];
          const value = p.tiers[tier][axis];
          expect(value.min).toBeGreaterThanOrEqual(range.min);
          expect(value.max).toBeLessThanOrEqual(range.max);
          expect(value.min).toBeLessThanOrEqual(value.max);
        }
      }
    });

    it(`${preset} — 사슬 수·의존 깊이가 단조 증가한다`, () => {
      const p = applyPreset(FACTORY_ADMIN_PARAMS, preset);
      const monotonic = validateAdminParams(p, gate).errors.filter(
        (e) => e.code === 'TIER_MONOTONIC'
      );
      expect(monotonic).toEqual([]);
    });

    it(`${preset} — 범위 오류가 없다`, () => {
      const p = applyPreset(FACTORY_ADMIN_PARAMS, preset);
      expect(validateAdminParams(p, gate).errors.filter((e) => e.code === 'RANGE')).toEqual([]);
    });
  }
});

describe('3-2 프리셋별 규칙 (§11.4)', () => {
  it('STANDARD는 §6.2 표 그대로다', () => {
    expect(applyPreset(FACTORY_ADMIN_PARAMS, 'STANDARD').tiers).toEqual(FACTORY_TIERS);
  });

  it('KIDS는 사슬 수·의존 깊이를 하한으로 눕힌다', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'KIDS');
    for (const tier of PARAM_TIERS) {
      expect(p.tiers[tier].chains).toEqual({
        min: FACTORY_TIERS[tier].chains.min,
        max: FACTORY_TIERS[tier].chains.min,
      });
      expect(p.tiers[tier].depth).toEqual({
        min: FACTORY_TIERS[tier].depth.min,
        max: FACTORY_TIERS[tier].depth.min,
      });
    }
  });

  it('KIDS는 초기 안전수·목표 시간을 상한으로 올린다 (쉬워지는 방향)', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'KIDS');
    expect(p.tiers.WARMUP.safeMoves.min).toBe(FACTORY_TIERS.WARMUP.safeMoves.max);
    expect(p.tiers.WARMUP.targetSec.min).toBe(FACTORY_TIERS.WARMUP.targetSec.max);
  });

  it('HARD는 사슬 수·의존 깊이를 상한으로 올린다', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    for (const tier of PARAM_TIERS) {
      expect(p.tiers[tier].chains.min).toBe(FACTORY_TIERS[tier].chains.max);
      expect(p.tiers[tier].depth.max).toBe(FACTORY_TIERS[tier].depth.max);
    }
  });

  it('HARD는 초기 안전수·목표 시간을 하한으로 내린다', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    expect(p.tiers.MASTER.safeMoves.max).toBe(FACTORY_TIERS.MASTER.safeMoves.min);
    expect(p.tiers.MASTER.targetSec.max).toBe(FACTORY_TIERS.MASTER.targetSec.min);
  });

  it('KIDS는 HARD보다 쉬운 구간표다', () => {
    const kids = applyPreset(FACTORY_ADMIN_PARAMS, 'KIDS');
    const hard = applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    for (const tier of PARAM_TIERS) {
      expect(kids.tiers[tier].depth.max).toBeLessThanOrEqual(hard.tiers[tier].depth.max);
      expect(kids.tiers[tier].chains.max).toBeLessThanOrEqual(hard.tiers[tier].chains.max);
    }
  });

  it('프리셋 이름도 함께 바뀐다', () => {
    expect(applyPreset(FACTORY_ADMIN_PARAMS, 'HARD').difficulty.preset).toBe('HARD');
  });

  it('구간표 밖은 건드리지 않는다', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'KIDS');
    expect(p.core).toEqual(FACTORY_ADMIN_PARAMS.core);
    expect(p.grade).toEqual(FACTORY_ADMIN_PARAMS.grade);
    expect(p.ui).toEqual(FACTORY_ADMIN_PARAMS.ui);
    expect(p.machine).toEqual(FACTORY_ADMIN_PARAMS.machine);
  });

  it('적응 난이도 3종도 그대로 둔다 (프리셋은 구간표 전용)', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    expect(p.difficulty.window).toBe(FACTORY_ADMIN_PARAMS.difficulty.window);
    expect(p.difficulty.upPercent).toBe(FACTORY_ADMIN_PARAMS.difficulty.upPercent);
  });

  it('원본을 바꾸지 않는다', () => {
    applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    expect(FACTORY_ADMIN_PARAMS.tiers).toEqual(FACTORY_TIERS);
  });
});

describe('3-3 프리셋은 작업 사본에만 적용된다 (ADM-201 · ADM-205)', () => {
  it('`usePreset` 뒤에도 live는 그대로다', () => {
    const editor = new FieldEditor(FACTORY_ADMIN_PARAMS);
    editor.usePreset('HARD');
    expect(editor.live.tiers).toEqual(FACTORY_TIERS);
    expect(editor.draft.tiers).not.toEqual(FACTORY_TIERS);
  });

  it('`G` 폐기하면 프리셋 적용분이 사라진다', () => {
    const editor = new FieldEditor(FACTORY_ADMIN_PARAMS);
    editor.usePreset('KIDS');
    editor.discard();
    expect(editor.draft).toBe(editor.live);
  });

  it('`RESTORE THIS PRESET`은 draft만 공장값으로 되돌린다', () => {
    const edited = writeField(FACTORY_ADMIN_PARAMS, 'difficulty.window', 5);
    const editor = new FieldEditor(edited);
    editor.usePreset('HARD');
    editor.restore('난이도');
    expect(editor.draft.difficulty.window).toBe(2);
    expect(editor.live.difficulty.window).toBe(5);
  });

  it('SAVE(commit) 뒤에야 live가 프리셋을 받는다', () => {
    const editor = new FieldEditor(FACTORY_ADMIN_PARAMS);
    editor.usePreset('HARD');
    editor.commit();
    expect(editor.live.difficulty.preset).toBe('HARD');
    expect(editor.dirty).toBe(false);
  });

  it('프리셋 적용은 dirty로 잡힌다', () => {
    const editor = new FieldEditor(FACTORY_ADMIN_PARAMS);
    editor.usePreset('KIDS');
    // 구간표 20행 × 2셀 = 40 중 값이 실제로 바뀐 셀 + 프리셋 이름 1
    expect(editor.dirtyKeys().length).toBe(20);
    expect(editor.dirtyKeys()).toContain('difficulty.preset');
    expect(editor.dirtySpecs().some((s) => s.group === '구간표')).toBe(true);
  });
});

describe('3-4 프리셋 왕복', () => {
  it('KIDS → STANDARD면 공장 구간표로 정확히 돌아온다', () => {
    const kids = applyPreset(FACTORY_ADMIN_PARAMS, 'KIDS');
    expect(applyPreset(kids, 'STANDARD').tiers).toEqual(FACTORY_TIERS);
  });

  it('같은 프리셋을 두 번 적용해도 결과가 같다 (멱등)', () => {
    const once = applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    expect(applyPreset(once, 'HARD')).toEqual(once);
  });

  it('프리셋 3종 전부 저장 검증의 오류를 만들지 않는다', () => {
    for (const preset of DIFFICULTY_PRESETS as readonly DifficultyPreset[]) {
      expect(validateAdminParams(applyPreset(FACTORY_ADMIN_PARAMS, preset), gate).errors).toEqual(
        []
      );
    }
  });
});
