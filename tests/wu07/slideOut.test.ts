// WU-07 — EFX-810 슬라이드 아웃 운영 설정 정합

import { describe, expect, it } from 'vitest';
import { createChain } from '../../src/core/chain';
import { FACTORY_PARAMS, resolveParams } from '../../src/core/params';
import { slideOutMs } from '../../src/core/puzzle';

describe('EFX-810 — 길이 비례 슬라이드 아웃', () => {
  it('공장값은 0.18초 + 선분 수 × 0.022초다', () => {
    const chain = createChain(
      1,
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
      0
    );
    expect(slideOutMs(chain, resolveParams(FACTORY_PARAMS))).toBe(180 + 3 * 22);
  });

  it('긴 사슬은 0.75초 상한을 넘지 않는다', () => {
    const points = Array.from({ length: 40 }, (_, index) => {
      const y = Math.floor(index / 13);
      const column = index % 13;
      return { x: y % 2 === 0 ? column : 12 - column, y };
    });
    const chain = createChain(1, points, 0);
    expect(slideOutMs(chain, resolveParams(FACTORY_PARAMS))).toBe(750);
    expect(FACTORY_PARAMS.slideOutCapSec).toBeLessThanOrEqual(FACTORY_PARAMS.comboWindowSec * 0.5);
  });
});
