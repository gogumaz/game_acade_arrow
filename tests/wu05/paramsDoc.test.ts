// `params.csv` 코덱 (§12.1 · 계획 T4 · ADM-207)
//
// 왕복 동일 · 손상 관용 · 범위 클램프 · 데이터 버전 불일치 폐기를 전수로 판정한다.
// 파서는 **어떤 입력에도 throw 하지 않는다** — 저장 파일이 깨져도 기기가 서면 안 된다.

import { describe, expect, it } from 'vitest';
import {
  FACTORY_ADMIN_PARAMS,
  PARAM_DATA_VERSION,
  applyPreset,
  readField,
  writeField,
} from '../../src/core/adminParams';
import {
  PARAMS_HEADER,
  PARAM_VERSION_KEY,
  ParamsStore,
  cellsOfFile,
  decodeValue,
  encodeValue,
  paramsToCsv,
  parseParamsCsv,
} from '../../src/game/admin/paramsDoc';
import { APPEND_ONLY_FILES, CODEC_FILES, FILES } from '../../src/persist/csv';
import { Storage } from '../../src/persist/storage';
import { MemoryKeyValue, memoryStorage } from './harness';

describe('5-1 형식 (P-4 — schema,key,value 3열 균일 행렬)', () => {
  const csv = paramsToCsv(FACTORY_ADMIN_PARAMS);
  const lines = csv.split('\n');

  it('첫 줄이 헤더다', () => {
    expect(lines[0]).toBe(PARAMS_HEADER);
  });

  it('둘째 줄이 데이터 버전이다', () => {
    expect(lines[1]).toBe(`1,${PARAM_VERSION_KEY},${String(PARAM_DATA_VERSION)}`);
  });

  it('행 수 = 헤더 1 + 버전 1 + 셀 79', () => {
    expect(lines).toHaveLength(2 + 79);
    expect(cellsOfFile('params')).toHaveLength(79);
  });

  it('모든 행이 정확히 3열이다', () => {
    for (const line of lines.slice(1)) expect(line.split(',')).toHaveLength(3);
  });

  it('행 순서가 스키마 선언 순서와 같다 (결정적 직렬화)', () => {
    const keys = lines.slice(2).map((l) => l.split(',')[1]);
    expect(keys).toEqual(cellsOfFile('params').map((c) => c.key));
  });

  it('두 번 만들어도 문자열이 같다', () => {
    expect(paramsToCsv(FACTORY_ADMIN_PARAMS)).toBe(csv);
  });

  it('기기 설정(settings.csv 소유)은 들어가지 않는다', () => {
    expect(csv).not.toContain('machine.');
  });

  it('구간표 40수치가 모두 들어간다', () => {
    expect(csv.split('\n').filter((l) => l.startsWith('1,tiers.'))).toHaveLength(40);
  });

  it('toggle은 1/0으로 적힌다', () => {
    expect(csv).toContain('1,core.continueEnabled,1');
    const off = paramsToCsv(writeField(FACTORY_ADMIN_PARAMS, 'core.continueEnabled', false));
    expect(off).toContain('1,core.continueEnabled,0');
  });

  it('enum은 이름 문자열로 적힌다', () => {
    expect(csv).toContain('1,difficulty.preset,STANDARD');
  });
});

describe('5-2 왕복 동일 (ADM-207)', () => {
  it('공장값이 왕복에서 그대로다', () => {
    expect(parseParamsCsv(paramsToCsv(FACTORY_ADMIN_PARAMS)).params).toEqual(FACTORY_ADMIN_PARAMS);
  });

  it('79수치를 전부 바꿔도 왕복에서 전 필드가 같다', () => {
    let p = FACTORY_ADMIN_PARAMS;
    for (const cell of cellsOfFile('params')) {
      const before = readField(p, cell.key);
      if (typeof before === 'number') p = writeField(p, cell.key, cell.min);
      else if (typeof before === 'boolean') p = writeField(p, cell.key, !before);
    }
    const back = parseParamsCsv(paramsToCsv(p)).params;
    for (const cell of cellsOfFile('params')) {
      expect(readField(back, cell.key)).toBe(readField(p, cell.key));
    }
  });

  it('프리셋 적용분도 왕복에서 살아남는다', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    expect(parseParamsCsv(paramsToCsv(p)).params.tiers).toEqual(p.tiers);
  });

  it('소수 파라미터도 잔차 없이 왕복한다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.slideOutPerSegmentSec', 0.022);
    expect(parseParamsCsv(paramsToCsv(p)).params.core.slideOutPerSegmentSec).toBe(0.022);
  });

  it('왕복 문자열이 동일하다 (문자 비교로 판정 가능)', () => {
    const csv = paramsToCsv(FACTORY_ADMIN_PARAMS);
    expect(paramsToCsv(parseParamsCsv(csv).params)).toBe(csv);
  });
});

describe('5-3 손상 관용 (절대 throw 하지 않는다)', () => {
  it('빈 문자열도 공장값을 돌려준다', () => {
    expect(parseParamsCsv('').params).toEqual(FACTORY_ADMIN_PARAMS);
  });

  it('완전한 쓰레기도 공장값을 돌려준다', () => {
    expect(() => parseParamsCsv('!!!\n@@@\n,,,,')).not.toThrow();
    expect(parseParamsCsv('###').params).toEqual(FACTORY_ADMIN_PARAMS);
  });

  it('알 수 없는 키는 조용히 무시한다', () => {
    const csv = [PARAMS_HEADER, '1,PARAM_DATA_VERSION,1', '1,core.없는키,5'].join('\n');
    const r = parseParamsCsv(csv);
    expect(r.params).toEqual(FACTORY_ADMIN_PARAMS);
    expect(r.droppedRows).toBe(0);
  });

  it('손상된 행만 버리고 나머지는 살린다', () => {
    const csv = [
      PARAMS_HEADER,
      '1,PARAM_DATA_VERSION,1',
      '1,core.sessionTimeSec,135',
      '1,core.initialHearts,없음',
      '깨진행',
    ].join('\n');
    const r = parseParamsCsv(csv);
    expect(r.params.core.sessionTimeSec).toBe(135);
    expect(r.params.core.initialHearts).toBe(3);
    expect(r.droppedRows).toBe(2);
  });

  it('CRLF도 읽는다', () => {
    const csv = `${PARAMS_HEADER}\r\n1,PARAM_DATA_VERSION,1\r\n1,core.sessionTimeSec,150\r\n`;
    expect(parseParamsCsv(csv).params.core.sessionTimeSec).toBe(150);
  });

  it('헤더가 없어도 읽는다', () => {
    const csv = '1,PARAM_DATA_VERSION,1\n1,core.initialHearts,5';
    expect(parseParamsCsv(csv).params.core.initialHearts).toBe(5);
  });
});

describe('5-4 범위 클램프 (손상돼도 기기가 서지 않는다)', () => {
  it('상한을 넘는 값은 상한으로 조인다', () => {
    const csv = `${PARAMS_HEADER}\n1,PARAM_DATA_VERSION,1\n1,core.sessionTimeSec,9999`;
    expect(parseParamsCsv(csv).params.core.sessionTimeSec).toBe(150);
  });

  it('하한 아래 값은 하한으로 조인다', () => {
    const csv = `${PARAMS_HEADER}\n1,PARAM_DATA_VERSION,1\n1,core.initialHearts,-5`;
    expect(parseParamsCsv(csv).params.core.initialHearts).toBe(1);
  });

  it('구간표 값도 조인다', () => {
    const csv = `${PARAMS_HEADER}\n1,PARAM_DATA_VERSION,1\n1,tiers.MASTER.depth.max,999`;
    expect(parseParamsCsv(csv).params.tiers.MASTER.depth.max).toBe(30);
  });

  it('`decodeValue`가 타입별로 동작한다', () => {
    const cells = new Map(cellsOfFile('params').map((c) => [c.key, c]));
    const toggle = cells.get('core.continueEnabled');
    const enumCell = cells.get('difficulty.preset');
    expect(toggle).toBeDefined();
    expect(enumCell).toBeDefined();
    if (toggle !== undefined) {
      expect(decodeValue(toggle, '1')).toBe(true);
      expect(decodeValue(toggle, '0')).toBe(false);
      expect(decodeValue(toggle, 'yes')).toBe(undefined);
    }
    if (enumCell !== undefined) {
      expect(decodeValue(enumCell, 'HARD')).toBe('HARD');
      expect(decodeValue(enumCell, 'INSANE')).toBe(undefined);
    }
  });

  it('`encodeValue`가 null·boolean·number를 규칙대로 적는다', () => {
    expect(encodeValue(null)).toBe('');
    expect(encodeValue(undefined)).toBe('');
    expect(encodeValue(true)).toBe('1');
    expect(encodeValue(false)).toBe('0');
    expect(encodeValue(0.022)).toBe('0.022');
    expect(encodeValue('A,B')).toBe('A B');
  });
});

describe('5-5 데이터 버전 (§12.1)', () => {
  it('버전이 같으면 편집분을 적용한다', () => {
    const csv = `${PARAMS_HEADER}\n1,PARAM_DATA_VERSION,1\n1,core.sessionTimeSec,135`;
    const r = parseParamsCsv(csv);
    expect(r.versionMismatch).toBe(false);
    expect(r.params.core.sessionTimeSec).toBe(135);
  });

  it('버전이 다르면 **편집분을 버리고** 공장값을 쓴다', () => {
    const csv = `${PARAMS_HEADER}\n1,PARAM_DATA_VERSION,7\n1,core.sessionTimeSec,135`;
    const r = parseParamsCsv(csv);
    expect(r.versionMismatch).toBe(true);
    expect(r.params).toEqual(FACTORY_ADMIN_PARAMS);
  });

  it('버전 칸이 손상돼도 폐기 경로를 탄다', () => {
    const csv = `${PARAMS_HEADER}\n1,PARAM_DATA_VERSION,없음\n1,core.sessionTimeSec,135`;
    expect(parseParamsCsv(csv).versionMismatch).toBe(true);
  });

  it('버전 줄이 아예 없으면 현재 버전으로 본다 (신규 파일)', () => {
    const csv = `${PARAMS_HEADER}\n1,core.sessionTimeSec,135`;
    const r = parseParamsCsv(csv);
    expect(r.versionMismatch).toBe(false);
    expect(r.params.core.sessionTimeSec).toBe(135);
  });

  it('스토어가 불일치 플래그를 들고 있다가 지울 수 있다', () => {
    const store = new ParamsStore();
    store.apply(`${PARAMS_HEADER}\n1,PARAM_DATA_VERSION,9`);
    expect(store.versionMismatch).toBe(true);
    store.clearVersionWarning();
    expect(store.versionMismatch).toBe(false);
  });
});

describe('5-6 SaveDocument 결선 (F-b 준수)', () => {
  it('`params.csv`는 코덱·추가 전용 목록 어디에도 없다', () => {
    expect(CODEC_FILES).not.toContain(FILES.params);
    expect(APPEND_ONLY_FILES).not.toContain(FILES.params);
  });

  it('`Storage.register()`에 그대로 붙는다', async () => {
    const rig = memoryStorage();
    const store = new ParamsStore();
    rig.storage.register(store.asSaveDocument());
    store.set(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 135));
    await rig.storage.saveNow(FILES.params);
    expect(rig.kv.dump(FILES.params)).toContain('1,core.sessionTimeSec,135');
  });

  it('재기동해도 값이 유지된다', async () => {
    const kv = new MemoryKeyValue();
    const first = memoryStorage(kv);
    const a = new ParamsStore();
    first.storage.register(a.asSaveDocument());
    a.set(writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', 5));
    await first.storage.saveNow(FILES.params);

    const second = memoryStorage(kv);
    const b = new ParamsStore();
    second.storage.register(b.asSaveDocument());
    await second.storage.init();
    expect(b.live.core.initialHearts).toBe(5);
  });

  it('`.bak`이 저장 직전 내용을 담는다', async () => {
    const kv = new MemoryKeyValue();
    const rig = memoryStorage(kv);
    const store = new ParamsStore();
    rig.storage.register(store.asSaveDocument());
    await rig.storage.saveNow(FILES.params);
    const before = kv.dump(FILES.params);

    store.set(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150));
    expect(await rig.storage.backup(FILES.params)).toBe(true);
    await rig.storage.saveNow(FILES.params);

    expect(kv.dump(`${FILES.params}.bak`)).toBe(before);
    expect(kv.dump(FILES.params)).toContain('1,core.sessionTimeSec,150');
  });

  it('파일이 아직 없으면 백업은 남길 것이 없어도 진행 가능이다', async () => {
    const rig = memoryStorage();
    expect(await rig.storage.backup(FILES.params)).toBe(true);
    expect(rig.kv.dump(`${FILES.params}.bak`)).toBe(null);
  });

  it('백업 읽기·쓰기가 실패하면 false다', async () => {
    const storage = new Storage({
      backend: {
        kind: 'memory',
        read: () => Promise.resolve('x'),
        write: () => Promise.reject(new Error('nope')),
        append: () => Promise.resolve(),
      },
      onError: () => undefined,
    });
    expect(await storage.backup(FILES.params)).toBe(false);
  });
});
