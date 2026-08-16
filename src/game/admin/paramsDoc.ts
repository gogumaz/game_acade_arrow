// `params.csv` 코덱 + `SaveDocument` (§12.1 · 작업 계획 P-4 · 실측 제약 F-b)
//
// **`src/persist/csv.ts`를 건드리지 않는다.** `tests/wu01/csv.test.ts`가 `CODEC_FILES`를
// 3종 완전 일치로 고정했고 `params.csv`가 거기 없다고 단언한다. WU-04 `statsDoc.ts`와 같은
// 선례로 별도 모듈에 코덱을 두고 `Storage.register()`에만 붙인다.
//
// 형식 — **`schema,key,value` 3열 균일 행렬** (P-4)
//   1,PARAM_DATA_VERSION,1
//   1,core.sessionTimeSec,120
//   1,tiers.WARMUP.chains.min,6
//
// 구간표도 `tiers.WARMUP.chains.min` 같은 점 표기 키로 같은 행렬에 들어간다. 파라미터는 전부
// 스칼라 1종이라 섹션이 필요 없고, ADM-207(왕복 동일)이 스키마 순회 1줄로 판정된다.
// 키는 **TS 경로**다 — 라벨은 표시 문구라 문구 정비에서 바뀌면 저장 데이터가 고아가 된다 (Q-3).
//
// 손상 관용: 알 수 없는 키는 무시하고 손상 행은 **그 행만** 버린다. 값은 스키마 범위로 조인다.
// **이 파서는 절대 throw 하지 않는다** (`parseRankingCsv` 선례).

import {
  FACTORY_ADMIN_PARAMS,
  FIELD_SCHEMA,
  PARAM_DATA_VERSION,
  clockToMinutes,
  minutesToClock,
  readField,
  writeField,
  type AdminParams,
  type FieldCell,
  type FieldValue,
  type ParamFile,
} from '../../core/adminParams';
import { FILES, SCHEMA_VERSION, sanitizeField } from '../../persist/csv';
import type { SaveDocument } from '../../persist/storage';

export const PARAMS_HEADER = 'schema,key,value';

/** §12.1 — 저장 데이터 버전이 실리는 특별 키 */
export const PARAM_VERSION_KEY = 'PARAM_DATA_VERSION';

/** 그 파일이 소유하는 셀만 (`params.csv` 79개 / `settings.csv` 9개) */
export function cellsOfFile(file: ParamFile): readonly FieldCell[] {
  return FIELD_SCHEMA.filter((f) => f.file === file).flatMap((f) => f.cells);
}

/** 값 → CSV 칸. `toggle`은 1/0, `null`(미설정)은 빈 칸 */
export function encodeValue(value: FieldValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  return sanitizeField(value);
}

/**
 * CSV 칸 → 값. **범위 밖은 조인다** — 저장 파일이 손상돼도 게임이 불능이 되지 않는다.
 * 해석할 수 없으면 `undefined`를 돌려주고 호출자가 공장값을 유지한다.
 */
export function decodeValue(cell: FieldCell, raw: string): FieldValue | undefined {
  const text = raw.trim();
  if (cell.type === 'toggle') {
    if (text === '1' || text === 'true') return true;
    if (text === '0' || text === 'false') return false;
    return undefined;
  }
  if (cell.type === 'enum') {
    const options = cell.options ?? [];
    return options.includes(text) ? text : undefined;
  }
  if (cell.type === 'clock') {
    const minutes = clockToMinutes(text);
    if (minutes === null) return undefined;
    return minutesToClock(Math.max(cell.min, Math.min(cell.max, minutes)));
  }
  if (text === '') return cell.nullable === true ? null : undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(cell.min, Math.min(cell.max, n));
}

/** 선언 순서 = 파일 행 순서. 결정적 직렬화라 왕복 비교가 문자열 비교로 끝난다 */
export function paramsToCsv(p: AdminParams): string {
  const lines = [PARAMS_HEADER, `${SCHEMA_VERSION},${PARAM_VERSION_KEY},${PARAM_DATA_VERSION}`];
  for (const cell of cellsOfFile('params')) {
    lines.push(`${SCHEMA_VERSION},${cell.key},${encodeValue(readField(p, cell.key))}`);
  }
  return lines.join('\n');
}

interface ParamsParseResult {
  readonly params: AdminParams;
  /** §12.1 — 버전이 다르면 편집분을 적용하지 않고 공장값을 쓴다. OVERVIEW에 1회 경고 */
  readonly versionMismatch: boolean;
  /** 손상돼 버린 행 수 (진단 표시용) */
  readonly droppedRows: number;
}

export function parseParamsCsv(csv: string): ParamsParseResult {
  const byKey = new Map<string, FieldCell>();
  for (const cell of cellsOfFile('params')) byKey.set(cell.key, cell);

  let params = FACTORY_ADMIN_PARAMS;
  let droppedRows = 0;
  let version = PARAM_DATA_VERSION;
  const pending: { key: string; value: FieldValue }[] = [];

  for (const line of csv.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '' || text === PARAMS_HEADER) continue;
    const cols = text.split(',');
    if (cols.length < 3) {
      droppedRows += 1;
      continue;
    }
    const key = cols[1].trim();
    const raw = cols[2];
    if (key === PARAM_VERSION_KEY) {
      const n = Number(raw.trim());
      version = Number.isFinite(n) ? n : -1;
      continue;
    }
    const cell = byKey.get(key);
    if (cell === undefined) continue; // 알 수 없는 키는 조용히 무시한다
    const value = decodeValue(cell, raw);
    if (value === undefined) {
      droppedRows += 1;
      continue;
    }
    pending.push({ key, value });
  }

  if (version !== PARAM_DATA_VERSION) {
    return { params: FACTORY_ADMIN_PARAMS, versionMismatch: true, droppedRows };
  }
  for (const { key, value } of pending) params = writeField(params, key, value);
  return { params, versionMismatch: false, droppedRows };
}

/**
 * `params.csv`의 메모리 소유자. 라이브 값 1개만 갖고, 작업 사본은 컨트롤러가 든다
 * (`AdminParams`가 불변이라 참조 2개가 곧 작업 사본이다 — ADM-201).
 */
export class ParamsStore {
  private current: AdminParams = FACTORY_ADMIN_PARAMS;
  private mismatch = false;

  get live(): AdminParams {
    return this.current;
  }

  /** 버전 불일치로 편집분을 폐기했는가 — OVERVIEW 1회 경고 (§12.1) */
  get versionMismatch(): boolean {
    return this.mismatch;
  }

  clearVersionWarning(): void {
    this.mismatch = false;
  }

  set(next: AdminParams): void {
    this.current = next;
  }

  serialize(): string {
    return paramsToCsv(this.current);
  }

  apply(csv: string): void {
    const result = parseParamsCsv(csv);
    this.current = result.params;
    this.mismatch = result.versionMismatch;
  }

  asSaveDocument(): SaveDocument {
    return {
      file: FILES.params,
      serialize: () => this.serialize(),
      apply: (csv) => {
        this.apply(csv);
      },
    };
  }
}
