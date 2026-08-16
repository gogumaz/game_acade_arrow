// 메뉴 트리와 행 커서 (§11.2 · admin §1.1·§4.1 — 계획 T6 · C2)
//
// 8그룹이 전부 있고, 깊이가 3단을 넘지 않으며, 모든 잎에 도달·복귀할 수 있고,
// 커서가 읽기 전용 행을 건너뛰며 끝에서 순환한다.

import { describe, expect, it } from 'vitest';
import { FIELD_SCHEMA } from '../../src/core/adminParams';
import {
  ADMIN_GROUPS,
  MENU_MAX_DEPTH,
  MENU_TREE,
  RowCursor,
  allPaths,
  breadcrumbOf,
  depthOf,
  findNode,
  maxTreeDepth,
  type CursorRow,
} from '../../src/game/admin/menu';
import { makeAdmin } from './harness';

function rows(...selectable: boolean[]): CursorRow[] {
  return selectable.map((s) => ({ selectable: s }));
}

describe('7-1 8그룹 (§11.2)', () => {
  it('1단계 메뉴는 정확히 8개다', () => {
    expect(ADMIN_GROUPS).toHaveLength(8);
  });

  it('§11.2 표의 8그룹 이름이 그대로 있다', () => {
    expect(ADMIN_GROUPS.map((g) => g.label)).toEqual([
      'OVERVIEW',
      'SALES & CREDITS',
      'MACHINE SETTINGS',
      'GAME PARAMETERS',
      'MAINTENANCE',
      'DATA & LOGS',
      'RESET',
      'EXIT & SAVE',
    ]);
  });

  it('`STAGE SETTINGS`는 어디에도 없다 (장르 치환)', () => {
    const labels = allPaths().map((p) => breadcrumbOf(p));
    expect(labels.some((l) => l.includes('STAGE'))).toBe(false);
  });

  it('RESET 그룹은 4종이다 (랭킹 초기화 신설 포함)', () => {
    const reset = findNode(['RESET']);
    expect(reset?.children?.map((c) => c.label)).toEqual([
      'RESET PAID STATISTICS',
      'RESET EVENT STATISTICS',
      'RESET RANKING',
      'RESTORE GAME PARAMETERS',
    ]);
  });

  it('GAME PARAMETERS 하위에 §11.4 그룹 화면이 전부 있다', () => {
    const labels = findNode(['PARAMS'])?.children?.map((c) => c.label) ?? [];
    for (const need of [
      'SESSION',
      'TIME',
      'DIFFICULTY',
      'TIER TABLE',
      'EFFECT',
      'HINT',
      'SCORE',
      'GRADE',
      'RANKING',
      'VALIDATION & SAVE',
      'TEST PLAY',
    ]) {
      expect(labels).toContain(need);
    }
  });

  it('MAINTENANCE 하위에 진단 5종 + 시스템 작업이 있다', () => {
    const labels = findNode(['MAINTENANCE'])?.children?.map((c) => c.label) ?? [];
    for (const need of [
      'INPUT TEST',
      'SOUND TEST',
      'DISPLAY TEST',
      'SERIAL I/O TEST',
      'STORAGE TEST',
      'SYSTEM ACTIONS',
    ]) {
      expect(labels).toContain(need);
    }
  });

  it('노드 id가 전부 유일하다', () => {
    const ids: string[] = [];
    const walk = (node: typeof MENU_TREE): void => {
      ids.push(node.id);
      for (const c of node.children ?? []) walk(c);
    };
    walk(MENU_TREE);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('7-2 깊이 (admin §1.1 최대 3단)', () => {
  it('트리 최대 깊이가 3이다', () => {
    expect(maxTreeDepth()).toBe(MENU_MAX_DEPTH);
  });

  it('모든 경로의 깊이가 3 이하다', () => {
    for (const path of allPaths()) expect(depthOf(path)).toBeLessThanOrEqual(MENU_MAX_DEPTH);
  });

  it('루트 깊이는 1이다', () => {
    expect(depthOf([])).toBe(1);
  });
});

describe('7-3 breadcrumb (admin §4.2 현재 위치 상시 표시)', () => {
  it('루트는 `ADMIN > HOME`이다', () => {
    expect(breadcrumbOf([])).toBe('ADMIN > HOME');
  });

  it('1단계는 `ADMIN > 그룹`이다', () => {
    expect(breadcrumbOf(['PARAMS'])).toBe('ADMIN > GAME PARAMETERS');
  });

  it('2단계는 `ADMIN > 그룹 > 화면`이다', () => {
    expect(breadcrumbOf(['PARAMS', 'P_TIERS'])).toBe('ADMIN > GAME PARAMETERS > TIER TABLE');
  });

  it('어긋난 경로는 아는 데까지만 만든다', () => {
    expect(breadcrumbOf(['PARAMS', '없음'])).toBe('ADMIN > GAME PARAMETERS');
  });
});

describe('7-4 경로 탐색', () => {
  it('빈 경로는 루트다', () => {
    expect(findNode([])).toBe(MENU_TREE);
  });

  it('없는 경로는 null이다', () => {
    expect(findNode(['없음'])).toBe(null);
    expect(findNode(['PARAMS', '없음'])).toBe(null);
  });

  it('모든 잎 경로를 실제로 찾을 수 있다', () => {
    for (const path of allPaths()) expect(findNode(path)).not.toBe(null);
  });

  it('경로 목록에 루트가 1개 들어 있다', () => {
    expect(allPaths().filter((p) => p.length === 0)).toHaveLength(1);
  });
});

describe('7-5 행 커서 (admin §4.1 W/S)', () => {
  it('선택 가능한 첫 행으로 초기화한다', () => {
    const c = new RowCursor();
    c.reset(rows(false, false, true, true));
    expect(c.index).toBe(2);
  });

  it('선택 가능한 행이 없으면 0에 선다', () => {
    const c = new RowCursor();
    c.reset(rows(false, false));
    expect(c.index).toBe(0);
  });

  it('읽기 전용 행을 건너뛴다', () => {
    const c = new RowCursor();
    const r = rows(true, false, false, true);
    c.reset(r);
    c.move(1, r);
    expect(c.index).toBe(3);
  });

  it('끝에서 처음으로 순환한다', () => {
    const c = new RowCursor();
    const r = rows(true, true, true);
    c.reset(r);
    c.move(1, r);
    c.move(1, r);
    c.move(1, r);
    expect(c.index).toBe(0);
  });

  it('위로도 순환한다', () => {
    const c = new RowCursor();
    const r = rows(true, true, true);
    c.reset(r);
    c.move(-1, r);
    expect(c.index).toBe(2);
  });

  it('선택 가능한 행이 하나뿐이면 움직이지 않는다', () => {
    const c = new RowCursor();
    const r = rows(false, true, false);
    c.reset(r);
    expect(c.move(1, r)).toBe(false);
    expect(c.index).toBe(1);
  });

  it('행이 없으면 아무 일도 없다', () => {
    const c = new RowCursor();
    expect(c.move(1, [])).toBe(false);
    expect(c.index).toBe(0);
  });

  it('행 목록이 짧아지면 범위를 다시 맞춘다', () => {
    const c = new RowCursor();
    const long = rows(true, true, true, true);
    c.reset(long);
    c.move(1, long);
    c.move(1, long);
    c.clampTo(rows(true, true));
    expect(c.index).toBeLessThan(2);
  });

  it('현재 행이 읽기 전용이 되면 선택 가능한 행으로 옮긴다', () => {
    const c = new RowCursor();
    c.set(1, rows(true, true, true));
    c.clampTo(rows(true, false, true));
    expect(c.index).toBe(0);
  });

  it('`set`은 범위를 벗어나지 않는다', () => {
    const c = new RowCursor();
    c.set(99, rows(true, true));
    expect(c.index).toBe(1);
    c.set(-5, rows(true, true));
    expect(c.index).toBe(0);
  });
});

describe('7-6 전 메뉴 도달·복귀 (C2 — 레버 + 2버튼만)', () => {
  it('모든 잎 경로에 `goTo`로 도달하고 행이 만들어진다', () => {
    const rig = makeAdmin();
    for (const path of allPaths()) {
      expect(rig.admin.goTo(path)).toBe(true);
      expect(rig.admin.view().breadcrumb).toBe(breadcrumbOf(path));
    }
  });

  it('레버·버튼만으로 8그룹을 전부 열고 닫는다', () => {
    const rig = makeAdmin();
    for (let i = 0; i < ADMIN_GROUPS.length; i += 1) {
      rig.admin.goTo([]);
      for (let n = 0; n < i; n += 1) rig.press('DOWN');
      rig.press('BUTTON1');
      expect(rig.admin.currentPath).toEqual([ADMIN_GROUPS[i].id]);
      rig.press('BUTTON2');
      expect(rig.admin.currentPath).toEqual([]);
    }
  });

  it('2단계 화면에서도 `G` 한 번으로 한 단계만 올라간다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MAINTENANCE', 'M_INPUT']);
    rig.press('BUTTON2');
    expect(rig.admin.currentPath).toEqual(['MAINTENANCE']);
    rig.press('BUTTON2');
    expect(rig.admin.currentPath).toEqual([]);
  });

  it('없는 경로로는 이동하지 않는다', () => {
    const rig = makeAdmin();
    expect(rig.admin.goTo(['없음'])).toBe(false);
    expect(rig.admin.currentPath).toEqual([]);
  });
});

// 독립 검증 D-5 — 메뉴 **경로** 도달만으로는 "전 항목 편집"(완료 기준 2)이 성립하지 않는다.
// 스키마 66행이 실제로 어느 화면엔가 **행으로 나타나는지**를 전수로 판정한다.
describe('7-7 필드 전수 도달 (완료 기준 2 · §11.4 "전 항목 편집")', () => {
  /** 모든 잎 화면을 돌며 나타난 행 id를 모은다 */
  function reachableRowIds(): Set<string> {
    const rig = makeAdmin();
    const seen = new Set<string>();
    for (const path of allPaths()) {
      rig.admin.goTo(path);
      for (const row of rig.admin.view().rows) seen.add(row.id);
    }
    return seen;
  }

  it('`FIELD_SCHEMA` 66행이 전부 어느 화면엔가 나타난다', () => {
    const seen = reachableRowIds();
    const missing = FIELD_SCHEMA.filter((f) => !seen.has(f.id)).map((f) => f.id);
    expect(missing).toEqual([]);
  });

  it('행 수가 GAME PARAMETERS 59 + MACHINE 7이다', () => {
    expect(FIELD_SCHEMA).toHaveLength(66);
  });

  it('`advanced` 행도 전부 도달된다 (구간표 20 + 적응 4)', () => {
    const seen = reachableRowIds();
    const advanced = FIELD_SCHEMA.filter((f) => f.advanced === true);
    expect(advanced).toHaveLength(24);
    expect(advanced.every((f) => seen.has(f.id))).toBe(true);
  });

  it('모든 필드 행은 선택 가능하다 (읽기 전용으로 갇힌 편집 항목이 없다)', () => {
    const rig = makeAdmin();
    const ids = new Set(FIELD_SCHEMA.map((f) => f.id));
    for (const path of allPaths()) {
      rig.admin.goTo(path);
      for (const row of rig.admin.view().rows) {
        if (ids.has(row.id)) expect(row.selectable).toBe(true);
      }
    }
  });
});
