// WU-06 T10 — §12.3 SAFE PAUSE (계획 P-7)
//
// 상태 모델은 시계를 모른다 — `tick(nowMs)`만 받으므로 3초 카운트다운이 결정적으로 판정된다.
// flow 쪽 결선(런 타이머 정지 · 조작 차단 · 도어 폴링)도 여기서 함께 본다.

import { describe, expect, it } from 'vitest';
import { RunSession } from '../../src/core/session';
import type { Clock } from '../../src/core/types';
import { FlowMachine } from '../../src/game/flow';
import {
  closedDoorSensor,
  SafePauseModel,
  SAFE_PAUSE_COUNTDOWN_MS,
  SAFE_PAUSE_TEXT,
  type DoorSensorPort,
} from '../../src/game/safePause';
import { createSilentSfx } from '../../src/game/sfx';
import { RankingStore } from '../../src/game/rankingStore';
import { Board } from '../../src/core/puzzle';
import { createChain } from '../../src/core/chain';
import { CreditWallet } from '../../src/core/credits';
import type { BoardSource } from '../../src/game/boardSource';
import type { ChargeSource, CreditBalance, CreditsPort } from '../../src/game/creditsService';
import { FACTORY_PARAMS } from '../../src/core/params';

describe('§12.3 — SafePauseModel 상태 전이', () => {
  it('카운트다운은 3초다', () => {
    expect(SAFE_PAUSE_COUNTDOWN_MS).toBe(3000);
  });

  it('idle → paused → countdown → idle', () => {
    const events: string[] = [];
    const m = new SafePauseModel({
      onPause: (r) => events.push(`pause:${r}`),
      onResume: () => events.push('resume'),
    });
    expect(m.state).toBe('idle');
    expect(m.trigger('service')).toBe(true);
    expect(m.state).toBe('paused');
    expect(m.active).toBe(true);

    expect(m.release(1000)).toBe(true);
    expect(m.state).toBe('countdown');
    expect(m.remainingMs(1000)).toBe(3000);

    expect(m.tick(3999)).toBe(false); // 아직
    expect(m.remainingMs(3999)).toBe(1);
    expect(m.tick(4000)).toBe(true); // 정확히 3초
    expect(m.state).toBe('idle');
    expect(m.reason).toBe(null);
    expect(m.resumes).toBe(1);
    expect(events).toEqual(['pause:service', 'resume']);
  });

  it('이미 멈춰 있으면 `trigger`가 다시 정지 콜백을 부르지 않는다', () => {
    let pauses = 0;
    const m = new SafePauseModel({ onPause: () => (pauses += 1) });
    expect(m.trigger('service')).toBe(true);
    expect(m.trigger('door')).toBe(false);
    expect(pauses).toBe(1);
    expect(m.reason).toBe('door'); // 사유는 갱신된다
  });

  it('카운트다운 중 다시 트리거되면 재개가 취소된다', () => {
    let resumes = 0;
    const m = new SafePauseModel({ onResume: () => (resumes += 1) });
    m.trigger('door');
    m.release(0);
    expect(m.state).toBe('countdown');
    m.trigger('door'); // 도어가 다시 열렸다
    expect(m.state).toBe('paused');
    expect(m.tick(999999)).toBe(false);
    expect(resumes).toBe(0);
  });

  it('멈춰 있지 않으면 `release`가 아무 일도 하지 않는다', () => {
    const m = new SafePauseModel();
    expect(m.release(0)).toBe(false);
    expect(m.state).toBe('idle');
    expect(m.tick(999999)).toBe(false);
  });

  it('`reset()`은 재개 콜백 없이 상태를 버린다', () => {
    let resumes = 0;
    const m = new SafePauseModel({ onResume: () => (resumes += 1) });
    m.trigger('service');
    m.reset();
    expect(m.state).toBe('idle');
    expect(resumes).toBe(0);
  });

  it('문구는 사유별 · 카운트다운은 남은 초를 보여 준다', () => {
    const m = new SafePauseModel();
    expect(m.view(0).text).toBe('');
    m.trigger('door');
    expect(m.view(0).text).toBe(SAFE_PAUSE_TEXT.door);
    m.trigger('service');
    expect(m.view(0).text).toBe(SAFE_PAUSE_TEXT.service);
    m.release(0);
    expect(m.view(0).text).toBe('RESUMING 3');
    expect(m.view(2100).text).toBe('RESUMING 1');
    expect(m.view(3000).text).toBe('RESUMING 0');
  });

  it('도어 스텁은 항상 닫힘이다 (§17 `[보류]`)', () => {
    expect(closedDoorSensor().isOpen()).toBe(false);
  });
});

// ── flow 결선 ──────────────────────────────────────────────────────────────

function openBoard(boardNumber = 1): Board {
  return new Board({
    chains: Array.from({ length: 3 }, (_, i) =>
      createChain(
        i + 1,
        [
          { x: 11, y: i * 2 },
          { x: 12, y: i * 2 },
        ],
        0
      )
    ),
    boardNumber,
    seed: `wu06-safepause-${String(boardNumber)}`,
  });
}

function makeFlow(over: { door?: DoorSensorPort; serviceSafePause?: boolean } = {}) {
  let ms = 0;
  const clock: Clock = { now: () => ms };
  const wallet = new CreditWallet();
  const credits: CreditsPort = {
    get coinsPerPlay() {
      return 1;
    },
    get continueCoins() {
      return 1;
    },
    insertCoin: () => wallet.insertCoin().accepted,
    balance: (): CreditBalance => wallet.balance,
    canStart: () => wallet.affordable(1),
    canContinue: () => wallet.affordable(1),
    chargeStart: (): ChargeSource => wallet.charge(1).source,
    chargeContinue: (): ChargeSource => wallet.charge(1).source,
    refund: (amount, source) => {
      if (source === 'paid' || source === 'event') wallet.refund(amount, source);
    },
  };
  const boardSource: BoardSource = { next: (req) => openBoard(req.boardNumber) };
  const flow = new FlowMachine({
    clock,
    credits,
    boardSource,
    ranking: new RankingStore(),
    params: FACTORY_PARAMS,
    sfx: createSilentSfx(),
    nowIso: () => '2026-08-17T00:00:00.000Z',
    makeSession: (p, c) => new RunSession(p, c),
    ...(over.door === undefined ? {} : { door: over.door }),
    ...(over.serviceSafePause === undefined ? {} : { serviceSafePause: over.serviceSafePause }),
  });
  return {
    flow,
    advance(by: number): void {
      ms += by;
    },
    now: () => ms,
  };
}

/** 코인 → START → 튜토리얼 통과 → RUN */
function toRun(rig: ReturnType<typeof makeFlow>): void {
  rig.flow.handle('COIN');
  rig.flow.handle('START');
  rig.advance(11000);
  rig.flow.tick();
  expect(rig.flow.screen).toBe('RUN');
}

describe('§12.3 — flow 결선 (런 타이머 정지·재개)', () => {
  it('SAFE PAUSE 중에는 런 타이머가 멈춘다', () => {
    const rig = makeFlow();
    toRun(rig);
    const before = rig.flow.snapshot().run?.timeRemainingMs ?? 0;
    expect(rig.flow.safePauseNow('service')).toBe(true);
    rig.advance(10000);
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.timeRemainingMs).toBe(before);
  });

  it('해제하면 3초 뒤 재개하고 타이머가 다시 흐른다', () => {
    const rig = makeFlow();
    toRun(rig);
    rig.flow.safePauseNow('service');
    const paused = rig.flow.snapshot().run?.timeRemainingMs ?? 0;
    expect(rig.flow.releaseSafePause()).toBe(true);
    expect(rig.flow.safePauseView.state).toBe('countdown');

    rig.advance(2999);
    rig.flow.tick();
    expect(rig.flow.safePauseView.state).toBe('countdown');

    rig.advance(1);
    rig.flow.tick();
    expect(rig.flow.safePauseView.state).toBe('idle');

    rig.advance(5000);
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.timeRemainingMs).toBeLessThan(paused);
  });

  it('SAFE PAUSE 중 게임 조작은 보드에 닿지 않는다', () => {
    const rig = makeFlow();
    toRun(rig);
    const focusBefore = rig.flow.snapshot().run?.focusId;
    rig.flow.safePauseNow('service');
    rig.flow.handle('RIGHT');
    rig.flow.handle('BUTTON1');
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.focusId).toBe(focusBefore);
    expect(rig.flow.screen).toBe('RUN');
  });

  it('SAFE PAUSE 중에는 5분 방치 종료가 돌지 않는다', () => {
    const rig = makeFlow();
    toRun(rig);
    rig.flow.safePauseNow('service');
    rig.advance(10 * 60 * 1000);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RUN');
  });

  it('RUN·TUTORIAL이 아니면 정지 요청이 무시된다', () => {
    const rig = makeFlow();
    expect(rig.flow.screen).toBe('ATTRACT');
    expect(rig.flow.safePauseNow('service')).toBe(false);
    expect(rig.flow.safePauseView.state).toBe('idle');
  });

  it('런이 끝나면 정지 상태를 들고 가지 않는다', () => {
    const rig = makeFlow();
    toRun(rig);
    rig.flow.safePauseNow('service');
    expect(rig.flow.safePauseView.state).toBe('paused');
    rig.flow.abortToAdmin();
    expect(rig.flow.safePauseView.state).toBe('idle');
  });

  it('스냅샷이 SAFE PAUSE 상태를 그대로 노출한다 (씬 입력)', () => {
    const rig = makeFlow();
    toRun(rig);
    expect(rig.flow.snapshot().safePause.state).toBe('idle');
    rig.flow.safePauseNow('door');
    expect(rig.flow.snapshot().safePause).toMatchObject({ state: 'paused', reason: 'door' });
    expect(rig.flow.snapshot().safePause.text).toBe(SAFE_PAUSE_TEXT.door);
  });
});

describe('§12.3 — 도어 포트 (실물은 `[보류]`)', () => {
  it('도어가 열리면 자동으로 멈추고 닫으면 3초 뒤 재개한다', () => {
    const door = { open: false };
    const rig = makeFlow({ door: { isOpen: () => door.open } });
    toRun(rig);

    door.open = true;
    rig.flow.tick();
    expect(rig.flow.safePauseView).toMatchObject({ state: 'paused', reason: 'door' });

    door.open = false;
    rig.flow.tick();
    expect(rig.flow.safePauseView.state).toBe('countdown');

    rig.advance(SAFE_PAUSE_COUNTDOWN_MS);
    rig.flow.tick();
    expect(rig.flow.safePauseView.state).toBe('idle');
  });

  it('기본 도어(닫힘)에서는 아무 일도 일어나지 않는다 — WU-03 회귀 0', () => {
    const rig = makeFlow();
    toRun(rig);
    rig.advance(1000);
    rig.flow.tick();
    expect(rig.flow.safePauseView.state).toBe('idle');
  });
});

describe('§12.3 — SERVICE 키 배선 (가정 (나) · 기본 꺼짐)', () => {
  it('기본값에서 런 중 SERVICE는 **무시**된다 (WU-03 계약)', () => {
    const rig = makeFlow();
    toRun(rig);
    rig.flow.handle('SERVICE');
    expect(rig.flow.screen).toBe('RUN');
    expect(rig.flow.safePauseView.state).toBe('idle');
  });

  it('`serviceSafePause`를 켜면 SERVICE가 정지·해제 토글이 된다', () => {
    const rig = makeFlow({ serviceSafePause: true });
    toRun(rig);
    rig.flow.handle('SERVICE');
    expect(rig.flow.safePauseView.state).toBe('paused');
    expect(rig.flow.screen).toBe('RUN'); // 관리자로 가지 않는다

    rig.flow.handle('SERVICE');
    expect(rig.flow.safePauseView.state).toBe('countdown');
    rig.advance(SAFE_PAUSE_COUNTDOWN_MS);
    rig.flow.tick();
    expect(rig.flow.safePauseView.state).toBe('idle');
  });

  it('도어 정지는 SERVICE로 풀리지 않는다 (물리적으로 열려 있다)', () => {
    const door = { open: false };
    const rig = makeFlow({ door: { isOpen: () => door.open }, serviceSafePause: true });
    toRun(rig);
    door.open = true;
    rig.flow.tick();
    expect(rig.flow.safePauseView.reason).toBe('door');
    rig.flow.handle('SERVICE');
    expect(rig.flow.safePauseView.state).toBe('paused');
  });

  it('어트랙트에서는 SERVICE가 여전히 관리자로 간다', () => {
    const rig = makeFlow({ serviceSafePause: true });
    rig.flow.handle('SERVICE');
    expect(rig.flow.screen).toBe('ADMIN');
  });
});
