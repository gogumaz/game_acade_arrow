// 이름 입력 (§5.7) — SCR-311 · 39자 문자셋 (작업 계획 §8.4)

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INITIALS,
  NAME_CHARSET,
  NAME_LENGTH,
  NameEntryModel,
} from '../../src/game/nameEntry';
import { NAME_ENTRY_MS } from '../../src/game/timing';

function typed(actions: readonly Parameters<NameEntryModel['handle']>[0][]): NameEntryModel {
  const model = new NameEntryModel(0);
  for (const a of actions) model.handle(a);
  return model;
}

describe('SCR-311 — 39자 문자셋 (§5.7)', () => {
  it('A~Z · 0~9 · . · - · 공백 = 39자다', () => {
    expect(NAME_CHARSET.length).toBe(39);
    expect(NAME_CHARSET.slice(0, 26)).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(NAME_CHARSET.slice(26, 36)).toBe('0123456789');
    expect(NAME_CHARSET.slice(36)).toBe('.- ');
  });

  it('문자셋에 중복이 없다', () => {
    expect(new Set(NAME_CHARSET).size).toBe(39);
  });

  it('이니셜은 3자다 (§5.7 N13b)', () => {
    expect(NAME_LENGTH).toBe(3);
    expect(new NameEntryModel(0).value.length).toBe(3);
  });
});

describe('초기 상태', () => {
  it('빈 3칸으로 시작한다 — AAA로 시작하지 않는다', () => {
    expect(new NameEntryModel(0).value).toBe('   ');
  });

  it('커서는 첫 자리에 있다', () => {
    expect(new NameEntryModel(0).cursor).toBe(0);
  });

  it('시작 직후에는 확정되지 않았다', () => {
    expect(new NameEntryModel(0).committed).toBe(false);
  });
});

describe('레버 상하 — 문자 순환', () => {
  it('빈 칸에서 UP 한 번이면 A다', () => {
    expect(typed(['UP']).value).toBe('A  ');
  });

  it('UP을 계속 누르면 A → B → C로 간다', () => {
    expect(typed(['UP', 'UP', 'UP']).value).toBe('C  ');
  });

  it('빈 칸에서 DOWN 한 번이면 마지막 기호(-)다', () => {
    expect(typed(['DOWN']).value).toBe('-  ');
  });

  it('문자셋 끝에서 순환한다', () => {
    const model = new NameEntryModel(0);
    for (let i = 0; i < NAME_CHARSET.length; i += 1) model.handle('UP');
    expect(model.value).toBe('   '); // 한 바퀴 돌아 다시 공백
  });

  it('커서가 가리키는 자리만 바뀐다', () => {
    expect(typed(['UP', 'RIGHT', 'UP', 'UP']).value).toBe('AB ');
  });
});

describe('레버 좌우 — 자리 이동 (순환)', () => {
  it('RIGHT로 다음 자리로 간다', () => {
    expect(typed(['RIGHT']).cursor).toBe(1);
  });

  it('마지막 자리에서 RIGHT는 첫 자리로 순환한다', () => {
    expect(typed(['RIGHT', 'RIGHT', 'RIGHT']).cursor).toBe(0);
  });

  it('첫 자리에서 LEFT는 마지막 자리로 순환한다', () => {
    expect(typed(['LEFT']).cursor).toBe(2);
  });
});

describe('버튼 — 확정과 지우기 (작업 계획 P-11)', () => {
  it('BUTTON1은 다음 자리로 넘어간다', () => {
    expect(typed(['UP', 'BUTTON1']).cursor).toBe(1);
  });

  it('마지막 자리에서 BUTTON1을 누르면 등록이 확정된다', () => {
    const model = typed(['UP', 'BUTTON1', 'UP', 'BUTTON1', 'UP', 'BUTTON1']);
    expect(model.committed).toBe(true);
    expect(model.value).toBe('AAA');
  });

  it('확정 후에는 입력이 더 먹히지 않는다', () => {
    const model = typed(['UP', 'BUTTON1', 'UP', 'BUTTON1', 'UP', 'BUTTON1']);
    model.handle('UP');
    expect(model.value).toBe('AAA');
  });

  it('BUTTON2는 커서를 왼쪽으로 옮기고 그 자리를 비운다', () => {
    const model = typed(['UP', 'BUTTON1', 'UP', 'UP']); // "AB ", 커서는 둘째 자리
    expect(model.value).toBe('AB ');
    model.handle('BUTTON2');
    // 왼쪽(첫 자리)으로 옮겨 그 자리를 비운다 — 편집 중이던 둘째 자리는 건드리지 않는다
    expect(model.value).toBe(' B ');
    expect(model.cursor).toBe(0);
  });

  it('첫 자리에서 BUTTON2는 현재 자리만 비운다', () => {
    const model = typed(['UP', 'UP']); // "B  "
    model.handle('BUTTON2');
    expect(model.value).toBe('   ');
    expect(model.cursor).toBe(0);
  });

  it('알 수 없는 입력은 무시된다', () => {
    const model = typed(['UP']);
    model.handle('COIN');
    model.handle('START');
    expect(model.value).toBe('A  ');
  });
});

describe('SCR-311 — 15초 제한과 자동 등록 (§5.7)', () => {
  it('15초 직전에는 만료되지 않는다 (경계값)', () => {
    expect(new NameEntryModel(1000).expired(1000 + NAME_ENTRY_MS - 1)).toBe(false);
  });

  it('15초에 정확히 만료된다 (경계값)', () => {
    expect(new NameEntryModel(1000).expired(1000 + NAME_ENTRY_MS)).toBe(true);
  });

  it('남은 시간이 0 아래로 내려가지 않는다', () => {
    const model = new NameEntryModel(0);
    expect(model.remainingMs(0)).toBe(NAME_ENTRY_MS);
    expect(model.remainingMs(NAME_ENTRY_MS + 5000)).toBe(0);
  });

  it('입력이 전혀 없으면 AAA로 등록된다', () => {
    expect(new NameEntryModel(0).finalValue()).toBe(DEFAULT_INITIALS);
  });

  it('공백만 입력해도 AAA로 등록된다', () => {
    const model = typed(['UP', 'BUTTON2']);
    expect(model.finalValue()).toBe(DEFAULT_INITIALS);
  });

  it('일부만 입력했으면 그 값을 그대로 쓴다', () => {
    expect(typed(['UP', 'RIGHT', 'UP', 'UP']).finalValue()).toBe('AB ');
  });

  it('제한 시간을 바꿀 수 있다 (§11.4 운영 설정 대비)', () => {
    const model = new NameEntryModel(0, 5000);
    expect(model.expired(4999)).toBe(false);
    expect(model.expired(5000)).toBe(true);
  });
});
