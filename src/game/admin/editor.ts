// 선언형 필드 편집기 (§11.4 · admin §4.1·§4.3 — 작업 계획 P-3)
//
// **항목별 코드가 하나도 없다.** `FIELD_SCHEMA`의 셀 타입(`int|float|percent|seconds|toggle|
// enum|clock`)만 보고 증감·clamp·표시를 처리한다. 항목이 늘어도 이 파일은 그대로다.
//
// 작업 사본(§11.4 · ADM-201): `AdminParams`가 불변 값이므로 `live`와 `draft` **두 참조**가
// 곧 작업 사본이다. `G` 폐기는 `draft = live` 대입 한 줄이고, 얕은 복사 누락으로 라이브가
// 오염되는 경로가 구조적으로 존재하지 않는다.

import {
  FIELD_SCHEMA,
  applyPreset,
  minutesToClock,
  clockToMinutes,
  readField,
  restoreGroup,
  writeField,
  type AdminParams,
  type DifficultyPreset,
  type FieldCell,
  type FieldGroup,
  type FieldKey,
  type FieldSpec,
  type FieldValue,
} from '../../core/adminParams';

/** 같은 방향 반복이 이 간격 안에 이어지면 한 버스트로 본다 */
export const ACCEL_BURST_GAP_MS = 200;
/** admin §4.1 — "숫자 범위가 큰 필드는 2초 이상 홀드하면 5배 단위로 가속" */
export const ACCEL_AFTER_MS = 2000;
export const ACCEL_FACTOR = 5;

/**
 * 홀드 가속. 입력 계층의 반복(250ms → 100ms)이 만들어 주는 연속 이벤트를 버스트로 묶고,
 * 버스트가 2초를 넘긴 순간부터 `step × 5`를 돌려준다.
 */
export class HoldAccel {
  private burstFromMs = 0;
  private lastAtMs = Number.NEGATIVE_INFINITY;
  private lastDirection = 0;

  /** 이번 조작에 적용할 배수 */
  factor(nowMs: number, direction: number): number {
    const continues =
      direction === this.lastDirection && nowMs - this.lastAtMs <= ACCEL_BURST_GAP_MS;
    if (!continues) this.burstFromMs = nowMs;
    this.lastAtMs = nowMs;
    this.lastDirection = direction;
    return nowMs - this.burstFromMs >= ACCEL_AFTER_MS ? ACCEL_FACTOR : 1;
  }

  /** 행 이동·화면 전환 — 버스트를 끊는다 */
  reset(): void {
    this.burstFromMs = 0;
    this.lastAtMs = Number.NEGATIVE_INFINITY;
    this.lastDirection = 0;
  }
}

/** `0.022` 같은 값이 `0.022000000000000002`가 되지 않게 step의 소수 자릿수로 자른다 */
export function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function quantize(value: number, step: number): number {
  const d = decimalsOf(step);
  return d === 0 ? Math.round(value) : Number(value.toFixed(d));
}

/** 값 1칸의 표시 문구 — 단위는 행이 갖고 있으므로 여기서는 숫자·상태만 만든다 */
export function formatCellValue(cell: FieldCell, value: FieldValue | undefined): string {
  if (value === undefined) return '—';
  if (value === null) return '— 미설정';
  if (cell.type === 'toggle') return value === true ? 'ON' : 'OFF';
  if (cell.type === 'enum' || cell.type === 'clock') return String(value);
  if (typeof value !== 'number') return String(value);
  const d = decimalsOf(cell.step);
  return d === 0 ? String(Math.round(value)) : value.toFixed(d);
}

/** 행 전체의 표시 문구 — 구간표는 `6 ~ 12`, NIGHT MUTE는 `ON 22:00 ~ 10:00` */
export function formatFieldValue(spec: FieldSpec, p: AdminParams): string {
  const sep = spec.separator ?? ' ';
  const parts = spec.cells.map((c) => formatCellValue(c, readField(p, c.key)));
  const joined = spec.cells.length === 1 ? parts[0] : joinCells(parts, sep);
  return spec.unit === '' ? joined : `${joined} ${spec.unit}`;
}

/** 첫 칸이 ON/OFF 스위치면 구분자 앞에 붙이지 않는다 (`ON 22:00 ~ 10:00`) */
function joinCells(parts: readonly string[], sep: string): string {
  if (parts.length <= 2) return parts.join(` ${sep} `);
  return `${parts[0]} ${parts.slice(1).join(` ${sep} `)}`;
}

/** admin §4.3 — 변경 전/후가 중요한 값은 `1 → 2` 형식 */
export function formatChange(spec: FieldSpec, from: AdminParams, to: AdminParams): string {
  return `${formatFieldValue(spec, from)} → ${formatFieldValue(spec, to)}`;
}

/** 셀 1칸 증감. 범위 끝에서는 **더 움직이지 않는다** (admin §4.1 · ADM-005) */
export function adjustCell(
  cell: FieldCell,
  value: FieldValue | undefined,
  direction: number,
  multiplier = 1
): FieldValue | undefined {
  if (direction === 0) return value;
  if (cell.type === 'toggle') return direction > 0;
  if (cell.type === 'enum') {
    const options = cell.options ?? [];
    if (options.length === 0) return value;
    const index = options.indexOf(String(value));
    const next = Math.max(0, Math.min(options.length - 1, (index < 0 ? 0 : index) + direction));
    return options[next];
  }
  if (cell.type === 'clock') {
    const minutes = clockToMinutes(String(value)) ?? cell.min;
    const next = clampNumber(minutes + direction * cell.step * multiplier, cell);
    return minutesToClock(next);
  }
  // `COIN UNIT PRICE`처럼 "미설정"이 유효한 필드는 하한 아래로 한 칸 더 내려가면 미설정이 된다
  if (value === null) return direction > 0 ? cell.min : null;
  if (typeof value !== 'number') return value;
  const raw = value + direction * cell.step * multiplier;
  if (cell.nullable === true && raw < cell.min) return null;
  return quantize(clampNumber(raw, cell), cell.step);
}

function clampNumber(n: number, cell: FieldCell): number {
  return Math.max(cell.min, Math.min(cell.max, n));
}

/**
 * 작업 사본 편집기. `live`는 SAVE가 통과할 때만 바뀐다 (§11.4 · ADM-201).
 */
export class FieldEditor {
  private liveRef: AdminParams;
  private draftRef: AdminParams;
  private readonly accel = new HoldAccel();

  constructor(live: AdminParams) {
    this.liveRef = live;
    this.draftRef = live;
  }

  get live(): AdminParams {
    return this.liveRef;
  }

  get draft(): AdminParams {
    return this.draftRef;
  }

  /** SAVE 통과 — 작업 사본을 실제 값으로 승격한다 */
  commit(): AdminParams {
    this.liveRef = this.draftRef;
    return this.liveRef;
  }

  /**
   * **지정한 셀만** 승격한다. 나머지 작업 사본은 그대로 남는다.
   *
   * `FIELD_SCHEMA`가 `params.csv`(59행)와 `settings.csv`(7행)를 한 배열에 담고 있으므로,
   * 위험도 "낮음"인 기기 설정 1칸이 `commit()`을 부르면 **검증을 통과하지 않은 GAME PARAMETERS
   * 작업 사본까지 함께 라이브가 된다.** 그 우회 경로를 막기 위해 두 문서의 승격 경로를 나눈다
   * (§11.5 저장 검증은 `params.csv` 쪽에만 있다).
   */
  commitCells(keys: readonly FieldKey[]): AdminParams {
    let next = this.liveRef;
    for (const key of keys) {
      const value = readField(this.draftRef, key);
      if (value === undefined) continue;
      next = writeField(next, key, value);
    }
    this.liveRef = next;
    return this.liveRef;
  }

  /** 외부에서 라이브가 바뀌었다 (공장값 복원 등). 작업 사본도 따라간다 */
  reset(live: AdminParams): void {
    this.liveRef = live;
    this.draftRef = live;
    this.accel.reset();
  }

  /** `G` 폐기 — 작업 사본만 버린다. 라이브는 손대지 않는다 (ADM-201) */
  discard(): void {
    this.draftRef = this.liveRef;
    this.accel.reset();
  }

  get dirty(): boolean {
    return this.draftRef !== this.liveRef && this.dirtyKeys().length > 0;
  }

  /** 라이브와 다른 셀 키 (선언 순서). 감사 로그 `before/after`가 이 목록을 쓴다 */
  dirtyKeys(): readonly FieldKey[] {
    const out: FieldKey[] = [];
    for (const spec of FIELD_SCHEMA) {
      for (const cell of spec.cells) {
        if (readField(this.draftRef, cell.key) !== readField(this.liveRef, cell.key)) {
          out.push(cell.key);
        }
      }
    }
    return out;
  }

  /** 변경된 화면 행 (중복 없이) */
  dirtySpecs(): readonly FieldSpec[] {
    const keys = new Set(this.dirtyKeys());
    return FIELD_SCHEMA.filter((spec) => spec.cells.some((c) => keys.has(c.key)));
  }

  isDirtySpec(spec: FieldSpec): boolean {
    return spec.cells.some(
      (c) => readField(this.draftRef, c.key) !== readField(this.liveRef, c.key)
    );
  }

  /** 레버 좌우 1회. 홀드 2초를 넘기면 5배 가속이 붙는다 */
  adjust(spec: FieldSpec, cellIndex: number, direction: number, nowMs: number): boolean {
    const cell = spec.cells[Math.max(0, Math.min(spec.cells.length - 1, cellIndex))];
    const before = readField(this.draftRef, cell.key);
    const multiplier = this.accel.factor(nowMs, direction);
    const after = adjustCell(cell, before, direction, multiplier);
    if (after === undefined || after === before) return false;
    this.draftRef = writeField(this.draftRef, cell.key, after);
    return true;
  }

  /** 행 이동·화면 전환 시 호출 — 가속 버스트를 끊는다 */
  breakAccel(): void {
    this.accel.reset();
  }

  /** §11.4 프리셋 — 구간표 20행만 통째로. **작업 사본에만** 적용된다 */
  usePreset(preset: DifficultyPreset): void {
    this.draftRef = applyPreset(this.draftRef, preset);
  }

  /** `RESTORE THIS PRESET` — 그룹 1개 공장값 복원. 저장 전까지 작업 사본만 바뀐다 (ADM-205) */
  restore(group: FieldGroup): void {
    this.draftRef = restoreGroup(this.draftRef, group);
  }

  /** 임의 값 주입 (테스트 플레이 복귀·외부 반영) */
  setDraft(next: AdminParams): void {
    this.draftRef = next;
  }
}
