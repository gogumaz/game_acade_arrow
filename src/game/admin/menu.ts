// 관리자 메뉴 트리 (§11.2 8그룹 · admin §5.1 · §1.1 "깊이 최대 3단계")
//
// 트리는 **데이터**다. 씬도 컨트롤러도 그룹 이름으로 분기하지 않고 이 배열을 순회한다.
// 화면 1장의 행 목록은 컨트롤러가 만들고(메뉴 자식 · 파라미터 필드 · 정보 줄 중 하나),
// 커서는 `RowCursor` 하나가 공통으로 관리한다 — 읽기 전용 행 건너뜀·끝에서 순환이
// 8그룹 어디서나 같은 코드로 성립한다 (admin §4.1).

import type { FieldGroup } from '../../core/adminParams';

/** admin §1.1 — `ADMIN > SECTION > PAGE` 3단이 상한이다 */
export const MENU_MAX_DEPTH = 3;

export interface MenuNode {
  readonly id: string;
  readonly label: string;
  /** 컨트롤러가 행을 만들 때 보는 태그. 없으면 자식 목록을 그대로 그린다 */
  readonly page?: string;
  /** `page === 'fields'`인 화면이 다루는 그룹 */
  readonly group?: FieldGroup;
  /** 고급 필드(`advanced`)만 모으는 하위 화면인가 */
  readonly advancedOnly?: boolean;
  readonly children?: readonly MenuNode[];
}

function page(id: string, label: string, tag: string, extra: Partial<MenuNode> = {}): MenuNode {
  return { id, label, page: tag, ...extra };
}

function fields(id: string, label: string, group: FieldGroup, advancedOnly = false): MenuNode {
  return { id, label, page: 'fields', group, advancedOnly };
}

/** §11.2 8그룹 — 치환은 `STAGE SETTINGS → GAME PARAMETERS` 1개뿐이다 */
export const ADMIN_GROUPS: readonly MenuNode[] = [
  page('OVERVIEW', 'OVERVIEW', 'overview'),
  {
    id: 'SALES',
    label: 'SALES & CREDITS',
    children: [
      page('SALES_STATS', 'STATISTICS', 'sales.stats'),
      page('SALES_METERS', 'CREDIT METERS', 'sales.meters'),
      page('SALES_GRANT', 'EVENT CREDIT GRANT', 'sales.grant'),
    ],
  },
  fields('MACHINE', 'MACHINE SETTINGS', '기기'),
  {
    id: 'PARAMS',
    label: 'GAME PARAMETERS',
    children: [
      fields('P_SESSION', 'SESSION', '세션'),
      fields('P_TIME', 'TIME', '시간'),
      fields('P_DIFFICULTY', 'DIFFICULTY', '난이도'),
      // §11.4 "고급 개별 필드는 프리셋 아래 하위 화면" — 적응 난이도 4항목(N9a~c)이 여기 산다.
      // 이 화면이 없으면 `advanced: true`인 4행이 어느 경로로도 편집되지 않는다
      fields('P_ADAPTIVE', 'ADAPTIVE DETAIL', '난이도', true),
      fields('P_TIERS', 'TIER TABLE', '구간표', true),
      fields('P_EFFECT', 'EFFECT', '연출'),
      fields('P_HINT', 'HINT', '힌트'),
      fields('P_SCORE', 'SCORE', '점수'),
      fields('P_GRADE', 'GRADE', '등급'),
      fields('P_RANKING', 'RANKING', '랭킹'),
      page('P_VALIDATE', 'VALIDATION & SAVE', 'params.save'),
      page('P_TESTPLAY', 'TEST PLAY', 'params.testplay'),
    ],
  },
  {
    id: 'MAINTENANCE',
    label: 'MAINTENANCE',
    children: [
      page('M_INPUT', 'INPUT TEST', 'diag.input'),
      page('M_SOUND', 'SOUND TEST', 'diag.sound'),
      page('M_DISPLAY', 'DISPLAY TEST', 'diag.display'),
      page('M_SERIAL', 'SERIAL I/O TEST', 'diag.serial'),
      page('M_STORAGE', 'STORAGE TEST', 'diag.storage'),
      page('M_BALANCE', 'BALANCE METRICS', 'diag.balance'),
      page('M_SYSTEM', 'SYSTEM ACTIONS', 'diag.system'),
    ],
  },
  page('DATA', 'DATA & LOGS', 'data'),
  {
    id: 'RESET',
    label: 'RESET',
    children: [
      page('R_PAID', 'RESET PAID STATISTICS', 'reset.paid'),
      page('R_EVENT', 'RESET EVENT STATISTICS', 'reset.event'),
      page('R_RANKING', 'RESET RANKING', 'reset.ranking'),
      page('R_PARAMS', 'RESTORE GAME PARAMETERS', 'reset.params'),
    ],
  },
  page('EXIT', 'EXIT & SAVE', 'exit'),
];

export const MENU_TREE: MenuNode = {
  id: 'ADMIN',
  label: 'ADMIN',
  children: ADMIN_GROUPS,
};

/** 경로(노드 id 열)를 따라간다. 어긋나면 null */
export function findNode(path: readonly string[]): MenuNode | null {
  let node: MenuNode = MENU_TREE;
  for (const id of path) {
    const next = node.children?.find((c) => c.id === id);
    if (next === undefined) return null;
    node = next;
  }
  return node;
}

/** admin §4.2 — 현재 위치 상시 표시. 루트는 `ADMIN > HOME` */
export function breadcrumbOf(path: readonly string[]): string {
  if (path.length === 0) return 'ADMIN > HOME';
  const parts = ['ADMIN'];
  let node: MenuNode = MENU_TREE;
  for (const id of path) {
    const next = node.children?.find((c) => c.id === id);
    if (next === undefined) break;
    node = next;
    parts.push(next.label);
  }
  return parts.join(' > ');
}

/** `ADMIN`을 1단으로 세는 깊이. 상한 3을 넘는 노드가 있으면 설계 위반이다 */
export function depthOf(path: readonly string[]): number {
  return path.length + 1;
}

/** 트리의 최대 깊이 — 테스트가 `MENU_MAX_DEPTH` 이하임을 고정한다 */
export function maxTreeDepth(node: MenuNode = MENU_TREE, depth = 1): number {
  const children = node.children;
  if (children === undefined || children.length === 0) return depth;
  return Math.max(...children.map((c) => maxTreeDepth(c, depth + 1)));
}

/** 모든 잎 노드의 경로 — "8그룹 전 메뉴 도달"을 전수로 판정한다 (C2) */
export function allPaths(node: MenuNode = MENU_TREE, prefix: readonly string[] = []): string[][] {
  const children = node.children;
  if (children === undefined || children.length === 0) return [[...prefix]];
  const out: string[][] = [[...prefix]];
  for (const child of children) out.push(...allPaths(child, [...prefix, child.id]));
  return out;
}

/** 커서가 설 수 있는 행인가를 알려 주는 최소 형태 */
export interface CursorRow {
  readonly selectable: boolean;
}

/**
 * 행 커서 — 읽기 전용 행을 건너뛰고 끝에서 순환한다 (admin §4.1 W/S).
 * 화면 종류(메뉴·필드·정보)와 무관하게 이 클래스 하나만 쓴다.
 */
export class RowCursor {
  private i = 0;

  get index(): number {
    return this.i;
  }

  /** 선택 가능한 첫 행으로 (화면 진입 시) */
  reset(rows: readonly CursorRow[]): void {
    this.i = rows.findIndex((r) => r.selectable);
    if (this.i < 0) this.i = 0;
  }

  set(index: number, rows: readonly CursorRow[]): void {
    this.i = rows.length === 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index));
  }

  /** `delta`만큼 이동. 선택 가능한 행이 없으면 제자리 */
  move(delta: number, rows: readonly CursorRow[]): boolean {
    if (rows.length === 0) return false;
    const step = delta > 0 ? 1 : -1;
    for (let n = 1; n <= rows.length; n += 1) {
      const next = (((this.i + step * n) % rows.length) + rows.length) % rows.length;
      if (rows[next].selectable) {
        const moved = next !== this.i;
        this.i = next;
        return moved;
      }
    }
    return false;
  }

  /** 행 목록이 바뀌었을 때 범위를 다시 맞춘다 */
  clampTo(rows: readonly CursorRow[]): void {
    if (rows.length === 0) {
      this.i = 0;
      return;
    }
    if (this.i >= rows.length) this.i = rows.length - 1;
    if (!rows[this.i].selectable) this.reset(rows);
  }
}
