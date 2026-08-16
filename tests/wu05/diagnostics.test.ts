// 현장 진단 (§11.7 · admin §6.3·§10 — 계획 T8 · ADM-304 · ADM-305)
//
// `INPUT TEST`의 5초 STUCK과 Serial 10회 실패 전이는 인수 항목이므로 **실동작**이다.
// 둘 다 순수 모델이라 시각을 인자로 넣어 그대로 판정한다.

import { describe, expect, it } from 'vitest';
import {
  INPUT_TEST_ACTIONS,
  InputTestModel,
  OPPOSING_PAIRS,
  OVERALL_GLYPH,
  SERIAL_FAIL_LIMIT,
  SERIAL_RETRY_MS,
  STORAGE_PROBE_FILE,
  SerialState,
  overallStatus,
  probeStorage,
  statusReasons,
  type StatusInput,
} from '../../src/game/admin/diagnostics';
import {
  InputStateMachine,
  STUCK_HOLD_MS,
  asPhaseSource,
  type PhaseEvent,
} from '../../src/game/input';
import { makeAdmin, memoryStorage } from './harness';

function down(action: PhaseEvent['action'], player: PhaseEvent['player'] = 1): PhaseEvent {
  return { action, player, phase: 'down', sourceId: `k:${action}` };
}

function up(action: PhaseEvent['action'], player: PhaseEvent['player'] = 1): PhaseEvent {
  return { action, player, phase: 'up', sourceId: `k:${action}` };
}

const READY: StatusInput = {
  ioConnected: true,
  storageWritable: true,
  memoryBackend: false,
  fatalErrorsIn60s: 0,
  backupRestored: false,
  clockChanged: false,
  paramsVersionMismatch: false,
  coinPriceUnset: false,
  stuckInput: false,
};

describe('11-1 INPUT TEST 개별 표시 (admin §10.1)', () => {
  it('표시 대상 입력이 9종이다', () => {
    expect([...INPUT_TEST_ACTIONS]).toEqual([
      'UP',
      'DOWN',
      'LEFT',
      'RIGHT',
      'BUTTON1',
      'BUTTON2',
      'START',
      'COIN',
      'SERVICE',
    ]);
  });

  it('누르면 PRESS, 떼면 RELEASE다', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT'), 100);
    expect(m.signalOf(1, 'LEFT', 100).pressed).toBe(true);
    m.handle(up('LEFT'), 400);
    expect(m.signalOf(1, 'LEFT', 400).pressed).toBe(false);
  });

  it('누른 횟수를 센다', () => {
    const m = new InputTestModel();
    for (let i = 0; i < 3; i += 1) {
      m.handle(down('BUTTON1'), i * 100);
      m.handle(up('BUTTON1'), i * 100 + 50);
    }
    expect(m.signalOf(1, 'BUTTON1', 500).presses).toBe(3);
  });

  it('마지막 입력 시각을 남긴다', () => {
    const m = new InputTestModel();
    expect(m.signalOf(1, 'START', 0).lastAtMs).toBe(null);
    m.handle(down('START'), 1234);
    expect(m.signalOf(1, 'START', 2000).lastAtMs).toBe(1234);
  });

  it('누른 채로 시간이 흐르면 홀드 시간이 자란다', () => {
    const m = new InputTestModel();
    m.handle(down('BUTTON1'), 0);
    expect(m.signalOf(1, 'BUTTON1', 800).holdMs).toBe(800);
  });

  it('떼면 마지막 홀드 시간이 고정된다', () => {
    const m = new InputTestModel();
    m.handle(down('BUTTON1'), 0);
    m.handle(up('BUTTON1'), 700);
    expect(m.signalOf(1, 'BUTTON1', 5000).holdMs).toBe(700);
  });

  it('P1·P2를 따로 표시한다 (admin §4.1)', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT', 2), 0);
    expect(m.signalOf(2, 'LEFT', 0).pressed).toBe(true);
    expect(m.signalOf(1, 'LEFT', 0).pressed).toBe(false);
  });

  it('플레이어별 9행을 준다', () => {
    const m = new InputTestModel();
    expect(m.signals(1, 0)).toHaveLength(9);
    expect(m.signals(2, 0)).toHaveLength(9);
  });

  it('`reset()`이 전부 지운다', () => {
    const m = new InputTestModel();
    m.handle(down('COIN'), 0);
    m.reset();
    expect(m.signalOf(1, 'COIN', 0).presses).toBe(0);
  });
});

describe('11-2 5초 STUCK (ADM-305)', () => {
  it('상수가 입력 계층과 같다', () => {
    expect(STUCK_HOLD_MS).toBe(5000);
  });

  it('5초 미만은 STUCK이 아니다', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT'), 0);
    expect(m.signalOf(1, 'LEFT', 4999).stuck).toBe(false);
  });

  it('5초 이상 유지되면 STUCK이다', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT'), 0);
    expect(m.signalOf(1, 'LEFT', 5000).stuck).toBe(true);
  });

  it('떼면 STUCK이 풀린다', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT'), 0);
    m.handle(up('LEFT'), 6000);
    expect(m.signalOf(1, 'LEFT', 7000).stuck).toBe(false);
  });

  it('고착된 입력 전량을 P1·P2에서 모은다', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT'), 0);
    m.handle(down('BUTTON2', 2), 0);
    const stuck = m.stuckSignals(6000);
    expect(stuck).toHaveLength(2);
    expect(stuck.map((s) => `${String(s.player)}${s.action}`)).toEqual(['1LEFT', '2BUTTON2']);
  });
});

describe('11-3 동시 반대 방향 (admin §10.1)', () => {
  it('감시 쌍이 상하·좌우다', () => {
    expect(OPPOSING_PAIRS.map((p) => [...p])).toEqual([
      ['UP', 'DOWN'],
      ['LEFT', 'RIGHT'],
    ]);
  });

  it('둘 다 눌리면 경고가 잡힌다', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT'), 0);
    m.handle(down('RIGHT'), 0);
    expect(m.opposing(1, 0)).toHaveLength(1);
  });

  it('하나만 눌리면 경고가 없다', () => {
    const m = new InputTestModel();
    m.handle(down('LEFT'), 0);
    expect(m.opposing(1, 0)).toEqual([]);
  });

  it('플레이어별로 따로 본다', () => {
    const m = new InputTestModel();
    m.handle(down('UP'), 0);
    m.handle(down('DOWN', 2), 0);
    expect(m.opposing(1, 0)).toEqual([]);
    expect(m.opposing(2, 0)).toEqual([]);
  });
});

describe('11-4 SERIAL I/O (ADM-304 · §12.3)', () => {
  it('상수가 §12.3과 같다 (1초 간격 · 10회)', () => {
    expect(SERIAL_RETRY_MS).toBe(1000);
    expect(SERIAL_FAIL_LIMIT).toBe(10);
  });

  it('초기에는 연결 상태다', () => {
    const s = new SerialState();
    expect(s.status).toBe('connected');
    expect(s.serviceRequired).toBe(false);
  });

  it('9회 실패까지는 SERVICE REQUIRED가 아니다', () => {
    const s = new SerialState();
    for (let i = 0; i < 9; i += 1) s.noteReconnectFailure();
    expect(s.reconnectAttempts).toBe(9);
    expect(s.serviceRequired).toBe(false);
    expect(s.status).toBe('disconnected');
  });

  it('10회 실패면 SERVICE REQUIRED로 전이한다', () => {
    const s = new SerialState();
    for (let i = 0; i < 10; i += 1) s.noteReconnectFailure();
    expect(s.serviceRequired).toBe(true);
  });

  it('다시 연결되면 카운터가 0으로 돌아간다', () => {
    const s = new SerialState();
    for (let i = 0; i < 10; i += 1) s.noteReconnectFailure();
    s.setStatus('connected');
    expect(s.reconnectAttempts).toBe(0);
    expect(s.serviceRequired).toBe(false);
  });

  it('마지막 패킷 시각을 기록한다', () => {
    const s = new SerialState();
    expect(s.lastPacketMs).toBe(null);
    s.notePacket(4321);
    expect(s.lastPacketMs).toBe(4321);
  });

  it('stuck 상태도 그대로 반영한다', () => {
    const s = new SerialState();
    s.setStatus('stuck');
    expect(s.status).toBe('stuck');
  });
});

describe('11-5 STORAGE TEST (admin §10.5)', () => {
  it('쓰기 → 읽기 → 비우기가 성공하면 writable이다', async () => {
    const rig = memoryStorage();
    const result = await probeStorage(rig.storage.backend);
    expect(result.writable).toBe(true);
    expect(result.readBackOk).toBe(true);
    expect(result.error).toBe(null);
  });

  it('임시 파일 이름이 고정돼 있고 검사 뒤 비워진다', async () => {
    const rig = memoryStorage();
    await probeStorage(rig.storage.backend);
    expect(rig.kv.dump(STORAGE_PROBE_FILE)).toBe('');
  });

  it('백엔드 종류를 함께 알려 준다', async () => {
    const rig = memoryStorage();
    expect((await probeStorage(rig.storage.backend)).backend).toBe('localStorage');
  });

  it('쓰기가 실패하면 오류를 담아 온다', async () => {
    const result = await probeStorage({
      kind: 'memory',
      write: () => Promise.reject(new Error('read-only')),
      read: () => Promise.resolve(null),
    });
    expect(result.writable).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('읽기 값이 다르면 readBackOk가 false다', async () => {
    const result = await probeStorage({
      kind: 'memory',
      write: () => Promise.resolve(),
      read: () => Promise.resolve('다른 값'),
    });
    expect(result.writable).toBe(true);
    expect(result.readBackOk).toBe(false);
  });
});

describe('11-6 OVERVIEW 종합 상태 3단계 (admin §6.3)', () => {
  it('기호가 색맹 대응 3종이다', () => {
    expect(OVERALL_GLYPH.READY).toBe('●');
    expect(OVERALL_GLYPH.CHECK).toBe('▲');
    expect(OVERALL_GLYPH.SERVICE_REQUIRED).toBe('×');
  });

  it('정상이면 READY다', () => {
    expect(overallStatus(READY)).toBe('READY');
    expect(statusReasons(READY)).toEqual([]);
  });

  it('I/O 미연결이면 SERVICE REQUIRED다', () => {
    expect(overallStatus({ ...READY, ioConnected: false })).toBe('SERVICE_REQUIRED');
  });

  it('저장 불가면 SERVICE REQUIRED다', () => {
    expect(overallStatus({ ...READY, storageWritable: false })).toBe('SERVICE_REQUIRED');
  });

  it('메모리 백엔드 강등이면 SERVICE REQUIRED다 (§12.4)', () => {
    expect(overallStatus({ ...READY, memoryBackend: true })).toBe('SERVICE_REQUIRED');
  });

  it('60초 내 치명 오류 3회면 SERVICE REQUIRED다', () => {
    expect(overallStatus({ ...READY, fatalErrorsIn60s: 3 })).toBe('SERVICE_REQUIRED');
    expect(overallStatus({ ...READY, fatalErrorsIn60s: 2 })).toBe('READY');
  });

  it('백업 복구·시간 변경은 CHECK다', () => {
    expect(overallStatus({ ...READY, backupRestored: true })).toBe('CHECK');
    expect(overallStatus({ ...READY, clockChanged: true })).toBe('CHECK');
  });

  it('파라미터 버전 불일치는 CHECK다 (§12.1)', () => {
    expect(overallStatus({ ...READY, paramsVersionMismatch: true })).toBe('CHECK');
  });

  it('단가 미설정은 CHECK다 (§11.3 OVERVIEW 경고)', () => {
    expect(overallStatus({ ...READY, coinPriceUnset: true })).toBe('CHECK');
  });

  it('고착 입력은 CHECK다', () => {
    expect(overallStatus({ ...READY, stuckInput: true })).toBe('CHECK');
  });

  it('빨강 조건이 노랑보다 우선한다', () => {
    expect(overallStatus({ ...READY, clockChanged: true, ioConnected: false })).toBe(
      'SERVICE_REQUIRED'
    );
  });

  it('사유 문구가 조건마다 붙는다', () => {
    const reasons = statusReasons({
      ...READY,
      ioConnected: false,
      clockChanged: true,
      coinPriceUnset: true,
    });
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain('I/O DISCONNECTED');
    expect(reasons.some((r) => r.includes('CLOCK CHANGED'))).toBe(true);
    expect(reasons.some((r) => r.includes('COIN UNIT PRICE'))).toBe(true);
  });
});

describe('11-7 입력 계층 phase 스트림 (P-6 · F-e 해소)', () => {
  it('`InputStateMachine`이 누름·뗌을 모두 발화한다', () => {
    const core = new InputStateMachine();
    const seen: PhaseEvent[] = [];
    core.onPhase((e) => seen.push(e));
    core.setConnected(true);
    core.press('KeyH', { player: 1, action: 'BUTTON1' });
    core.release('KeyH');
    expect(seen.map((e) => e.phase)).toEqual(['down', 'up']);
    expect(seen[0].action).toBe('BUTTON1');
  });

  it('blur에서 눌려 있던 입력 전부에 뗌이 나간다 (§2.3)', () => {
    const core = new InputStateMachine();
    const seen: PhaseEvent[] = [];
    core.setConnected(true);
    core.press('KeyH', { player: 1, action: 'BUTTON1' });
    core.press('KeyA', { player: 1, action: 'LEFT' });
    core.onPhase((e) => seen.push(e));
    core.releaseAll();
    expect(seen.map((e) => e.action).sort()).toEqual(['BUTTON1', 'LEFT']);
    expect(seen.every((e) => e.phase === 'up')).toBe(true);
  });

  it('어댑터 분리에서도 뗌이 나간다', () => {
    const core = new InputStateMachine();
    const seen: PhaseEvent[] = [];
    core.setConnected(true);
    core.press('KeyH', { player: 1, action: 'BUTTON1' });
    core.onPhase((e) => seen.push(e));
    core.setConnected(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].phase).toBe('up');
  });

  it('표에 없는 키는 phase를 만들지 않는다', () => {
    const core = new InputStateMachine();
    const seen: PhaseEvent[] = [];
    core.onPhase((e) => seen.push(e));
    core.setConnected(true);
    core.press('KeyZ', undefined);
    core.release('KeyZ');
    expect(seen).toEqual([]);
  });

  it('구독 해제가 동작한다', () => {
    const core = new InputStateMachine();
    const seen: PhaseEvent[] = [];
    core.setConnected(true);
    const off = core.onPhase((e) => seen.push(e));
    off();
    core.press('KeyH', { player: 1, action: 'BUTTON1' });
    expect(seen).toEqual([]);
  });

  it('`asPhaseSource`가 구조적으로 판정한다 (인터페이스 무변경 — P-6)', () => {
    expect(asPhaseSource(new InputStateMachine())).not.toBe(null);
    expect(asPhaseSource({ id: 'old' })).toBe(null);
  });

  it('ADM-003 — SERVICE 키를 끄면 액션도 phase도 나오지 않는다', () => {
    const core = new InputStateMachine();
    const actions: string[] = [];
    const phases: PhaseEvent[] = [];
    core.onAction((pa) => actions.push(pa.action));
    core.onPhase((e) => phases.push(e));
    core.setConnected(true);
    core.setServiceKeyEnabled(false);
    core.press('F9', { player: 1, action: 'SERVICE' });
    expect(actions).toEqual([]);
    expect(phases).toEqual([]);
    core.setServiceKeyEnabled(true);
    core.press('F9', { player: 1, action: 'SERVICE' });
    expect(actions).toEqual(['SERVICE']);
  });

  it('기본값은 활성이다 (WU-01 동작 보존)', () => {
    expect(new InputStateMachine().isServiceKeyEnabled).toBe(true);
  });
});

describe('11-8 컨트롤러 진단 화면', () => {
  it('INPUT TEST 화면이 P1·P2 18행 + 경고 행을 만든다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MAINTENANCE', 'M_INPUT']);
    rig.admin.phase(down('LEFT'));
    rig.admin.phase(down('RIGHT'));
    const rows = rig.admin.view().rows;
    expect(rows.filter((r) => r.id.startsWith('input.1.')).length).toBeGreaterThanOrEqual(9);
    expect(rows.some((r) => r.label.includes('동시 반대 방향'))).toBe(true);
  });

  it('5초 유지하면 행에 STUCK 배지가 붙는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MAINTENANCE', 'M_INPUT']);
    rig.admin.phase(down('LEFT'));
    rig.clock.advance(5000);
    const row = rig.admin.view().rows.find((r) => r.id === 'input.1.LEFT');
    expect(row?.badge).toContain('STUCK INPUT');
    expect(row?.marker).toBe('×');
  });

  it('STORAGE TEST 화면이 백엔드·쓰기 권한을 보여 준다', async () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MAINTENANCE', 'M_STORAGE']);
    rig.press('DOWN');
    rig.press('DOWN');
    rig.press('DOWN');
    rig.press('DOWN');
    rig.press('BUTTON1'); // RUN STORAGE TEST
    await new Promise((r) => setTimeout(r, 0));
    const rows = rig.admin.view().rows;
    expect(rows.find((r) => r.id === 'storage.backend')?.value).toBe('localStorage');
    expect(rows.find((r) => r.id === 'storage.writable')?.value).toBe('OK');
  });

  it('SERIAL 화면이 재연결 시도와 SERVICE REQUIRED를 보여 준다', () => {
    const rig = makeAdmin();
    for (let i = 0; i < 10; i += 1) rig.admin.serialState.noteReconnectFailure();
    rig.admin.goTo(['MAINTENANCE', 'M_SERIAL']);
    const rows = rig.admin.view().rows;
    expect(rows.find((r) => r.id === 'serial.attempts')?.value).toBe('10 / 10');
    expect(rows.find((r) => r.id === 'serial.service')?.value).toBe('YES');
  });

  it('Serial 포트·펌웨어는 `[보류]` 배지다 (§17 #1)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['MAINTENANCE', 'M_SERIAL']);
    expect(rig.admin.view().rows.find((r) => r.id === 'serial.port')?.badge).toBe('[보류]');
  });

  it('OVERVIEW가 종합 상태 3단계 중 하나를 보여 준다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['OVERVIEW']);
    const status = rig.admin.view().status;
    expect(['● READY', '▲ CHECK', '× SERVICE REQUIRED']).toContain(status);
  });

  it('단가 미설정이면 OVERVIEW가 CHECK다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['OVERVIEW']);
    expect(rig.admin.view().status).toBe('▲ CHECK');
    expect(rig.admin.view().detail.some((l) => l.includes('COIN UNIT PRICE'))).toBe(true);
  });
});
