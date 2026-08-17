// WU-06 T10 — 이월 흡수 V-2 · V-3 · F-3 · F-4 (WU-04 §H · 계획 P-14)
//
//   V-2 `refund()`는 마커가 가리키는 결제라면 **실제 차감액**을 되돌린다
//   V-3 `Storage`는 `init()`이 도는 동안의 저장을 보류하고 로드가 끝난 뒤 1회 저장한다
//   F-3 랭킹 등록 날짜·`BEST TODAY`는 **로컬 날짜** 기준이다
//   F-4 `occupancyMsTotal`은 정수다

import { describe, expect, it } from 'vitest';
import { CreditWallet } from '../../src/core/credits';
import { FACTORY_PARAMS } from '../../src/core/params';
import { RunSession } from '../../src/core/session';
import { StatsModel, type WallClock } from '../../src/core/stats';
import type { Clock } from '../../src/core/types';
import { Board } from '../../src/core/puzzle';
import { createChain } from '../../src/core/chain';
import type { BoardSource } from '../../src/game/boardSource';
import { CreditsService } from '../../src/game/creditsService';
import { FlowMachine } from '../../src/game/flow';
import { RankingStore } from '../../src/game/rankingStore';
import { createSilentSfx } from '../../src/game/sfx';
import { FILES } from '../../src/persist/csv';
import { CounterDoc, memoryStorage } from './harness';

const ISO = '2026-08-18T02:30:00.000Z';
/** UTC로는 8/18이지만 로컬(UTC-9 가정)로는 8/17인 시각 — F-3의 핵심 경계 */
const LOCAL_DATE = '2026-08-17';

const wall: WallClock = {
  nowMs: () => Date.parse(ISO),
  localDate: () => LOCAL_DATE,
  nowIso: () => ISO,
};

// ── V-2 ────────────────────────────────────────────────────────────────────

function makeCredits(coinsPerPlay: number) {
  let ms = 0;
  const clock: Clock = { now: () => ms };
  const stats = new StatsModel({ wall });
  const wallet = new CreditWallet();
  const lines: string[] = [];
  const credits = new CreditsService({
    stats,
    clock,
    nowIso: () => ISO,
    wallet,
    coinsPerPlay,
    appendCreditLog: (l) => {
      lines.push(l);
      return Promise.resolve();
    },
  });
  return {
    credits,
    wallet,
    stats,
    lines,
    advance: (by: number) => {
      ms += by;
    },
  };
}

describe('V-2 — 원복 금액은 실제 차감액이다', () => {
  it('결제 후 `COINS PER PLAY`가 바뀌어도 낸 만큼 돌아온다', () => {
    const rig = makeCredits(3);
    for (let i = 0; i < 3; i += 1) rig.credits.insertCoin();
    expect(rig.credits.chargeStart()).toBe('paid');
    expect(rig.credits.balance().paid).toBe(0);

    // §11.3 — 관리자가 값을 바꿨다. 반영 시점은 "다음 결제"라 이번 원복에 소급되면 안 된다
    rig.credits.setCoinsPerPlay(1);
    rig.credits.refund(rig.credits.coinsPerPlay, 'paid', '런 진입 실패');
    expect(rig.credits.balance().paid).toBe(3); // 1이 아니라 3
  });

  it('마커가 없는 원복은 인자 그대로 쓴다 (관리자 직접 조정)', () => {
    const rig = makeCredits(1);
    rig.credits.insertCoin();
    rig.credits.refund(1, 'paid', '직접 조정');
    expect(rig.credits.balance().paid).toBe(2);
  });

  it('다른 지갑의 원복에는 마커 금액을 쓰지 않는다', () => {
    const rig = makeCredits(2);
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart(); // pending = paid 2
    rig.credits.refund(1, 'event', '엉뚱한 지갑');
    expect(rig.credits.balance()).toEqual({ paid: 0, event: 1 });
  });

  it('원복은 한 번만 마커를 소비한다 (두 번째는 인자 그대로)', () => {
    const rig = makeCredits(3);
    for (let i = 0; i < 3; i += 1) rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.credits.refund(1, 'paid', 'a'); // 마커 → 3
    expect(rig.credits.balance().paid).toBe(3);
    rig.credits.refund(1, 'paid', 'b'); // 마커 없음 → 1
    expect(rig.credits.balance().paid).toBe(4);
  });
});

// ── V-3 ────────────────────────────────────────────────────────────────────

describe('V-3 — `init()` 중의 저장은 보류된다', () => {
  it('로드 전에 도착한 저장이 마지막 정상값을 덮어쓰지 않는다', async () => {
    const rig = memoryStorage();
    rig.kv.put(FILES.settings, CounterDoc.csv(77));
    const doc = new CounterDoc();
    doc.value = 0; // 아직 파일을 읽기 전의 공장값
    rig.storage.register(doc.asSaveDocument());

    // `init()`이 도는 동안(read await 사이) 저장 요청이 들어온다
    const init = rig.storage.init();
    const deferred = [rig.storage.saveNow(FILES.settings), rig.storage.saveAll()];
    // 보류 플래그는 **동기적으로** 선다 — 저장이 실제로 나가기 전에 막혔다는 뜻이다
    expect(rig.storage.hasDeferredSave).toBe(true);
    // 공장값 0이 파일을 덮어쓰지 않았다
    expect(rig.kv.dump(FILES.settings)).toBe(CounterDoc.csv(77));

    await Promise.all(deferred);
    await init;
    expect(doc.value).toBe(77);
    // 보류된 저장은 로드가 끝난 뒤 **1회** 나간다 — 되살린 값 그대로
    expect(rig.kv.dump(FILES.settings)).toBe(CounterDoc.csv(77));
    expect(rig.storage.hasDeferredSave).toBe(false);
  });

  it('`init()`이 끝난 뒤의 저장은 평소대로 나간다', async () => {
    const rig = memoryStorage();
    const doc = new CounterDoc();
    rig.storage.register(doc.asSaveDocument());
    await rig.storage.init();
    doc.value = 5;
    await rig.storage.saveNow(FILES.settings);
    expect(rig.kv.dump(FILES.settings)).toBe(CounterDoc.csv(5));
  });

  it('`init()`을 부르지 않은 호출자는 영향을 받지 않는다 (WU-05 단독 리그)', async () => {
    const rig = memoryStorage();
    const doc = new CounterDoc();
    doc.value = 9;
    rig.storage.register(doc.asSaveDocument());
    await rig.storage.saveNow(FILES.settings);
    expect(rig.kv.dump(FILES.settings)).toBe(CounterDoc.csv(9));
    expect(rig.storage.hasDeferredSave).toBe(false);
  });
});

// ── F-3 ────────────────────────────────────────────────────────────────────

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
    seed: `wu06-carry-${String(boardNumber)}`,
  });
}

describe('F-3 — 랭킹 날짜는 로컬 날짜다', () => {
  function makeFlow(localDate?: () => string) {
    let ms = 0;
    const clock: Clock = { now: () => ms };
    const wallet = new CreditWallet();
    const ranking = new RankingStore();
    const boardSource: BoardSource = { next: (req) => openBoard(req.boardNumber) };
    const flow = new FlowMachine({
      clock,
      credits: {
        coinsPerPlay: 1,
        continueCoins: 1,
        insertCoin: () => wallet.insertCoin().accepted,
        balance: () => wallet.balance,
        canStart: () => wallet.affordable(1),
        canContinue: () => wallet.affordable(1),
        chargeStart: () => wallet.charge(1).source,
        chargeContinue: () => wallet.charge(1).source,
        refund: () => undefined,
      },
      boardSource,
      ranking,
      params: FACTORY_PARAMS,
      sfx: createSilentSfx(),
      nowIso: () => ISO,
      makeSession: (p, c) => new RunSession(p, c),
      ...(localDate === undefined ? {} : { localDate }),
    });
    return { flow, ranking, advance: (by: number) => (ms += by) };
  }

  it('`BEST TODAY`가 로컬 날짜로 조회된다', () => {
    const rig = makeFlow(() => LOCAL_DATE);
    rig.ranking.submit({
      initials: 'ABC',
      score: 1000,
      board: 2,
      maxComboCentis: 100,
      continues: 0,
      registeredAt: `${LOCAL_DATE}T23:30:00.000Z`,
    });
    expect(rig.flow.snapshot().bestToday?.initials).toBe('ABC');
  });

  it('UTC 날짜(8/18)로는 오늘 기록을 찾지 못한다 — 그래서 로컬이 필요하다', () => {
    const rig = makeFlow(); // 기본값 = nowIso().slice(0,10) = 2026-08-18
    rig.ranking.submit({
      initials: 'ABC',
      score: 1000,
      board: 2,
      maxComboCentis: 100,
      continues: 0,
      registeredAt: `${LOCAL_DATE}T23:30:00.000Z`,
    });
    expect(rig.flow.snapshot().bestToday).toBe(null);
  });

  it('기본값은 `nowIso()`의 날짜부라 WU-03 동작과 같다', () => {
    const rig = makeFlow();
    rig.ranking.submit({
      initials: 'XYZ',
      score: 1000,
      board: 2,
      maxComboCentis: 100,
      continues: 0,
      registeredAt: ISO,
    });
    expect(rig.flow.snapshot().bestToday?.initials).toBe('XYZ');
  });
});

// ── F-4 ────────────────────────────────────────────────────────────────────

describe('F-4 — 점유 시간 누계는 정수다', () => {
  it('소수점 밀리초를 반올림해 더한다', () => {
    const stats = new StatsModel({ wall });
    stats.noteSessionOpened(100.4);
    stats.noteSessionClosed(5100.9, { boardReached: 3, score: 100, counted: true });
    expect(Number.isInteger(stats.toSnapshot().occupancyMsTotal)).toBe(true);
    expect(stats.toSnapshot().occupancyMsTotal).toBe(5001);
  });

  it('여러 세션을 더해도 정수로 남는다', () => {
    const stats = new StatsModel({ wall });
    for (let i = 0; i < 10; i += 1) {
      stats.noteSessionOpened(i * 1000 + 0.3);
      stats.noteSessionClosed(i * 1000 + 333.7, { boardReached: 1, score: 1, counted: true });
    }
    const snap = stats.toSnapshot();
    expect(Number.isInteger(snap.occupancyMsTotal)).toBe(true);
    expect(snap.occupancySessions).toBe(10);
    expect(snap.occupancyMsTotal).toBe(3330);
  });

  it('음수 구간은 0으로 잘린다 (시계 역행)', () => {
    const stats = new StatsModel({ wall });
    stats.noteSessionOpened(5000);
    stats.noteSessionClosed(1000, { boardReached: 1, score: 1, counted: true });
    expect(stats.toSnapshot().occupancyMsTotal).toBe(0);
  });
});
