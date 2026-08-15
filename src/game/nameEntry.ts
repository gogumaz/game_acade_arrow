// 이름 입력 모델 (§5.7 · SCR-311 — 작업 계획 P-4 · P-11)
//
// 조작은 §5.7 그대로다: 레버 상하 = 문자 순환, 좌우 = 자리 이동, 버튼1 = 확정, 버튼2 = 한 글자 지우기.
// 화면·타이머 표시는 씬이 하고, 이 모델은 **문자열과 커서만** 소유한다.

import type { InputAction } from '../core/types';
import { NAME_ENTRY_MS } from './timing';

/** §5.7 — `A`~`Z`(26) + `0`~`9`(10) + `.` + `-` + 공백 = **39자** */
export const NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.- ';

/** §5.7 N13b — 이니셜 3자 */
export const NAME_LENGTH = 3;

/** 자동 등록 시의 기본값 (§5.7 "빈 값은 `AAA`") */
export const DEFAULT_INITIALS = 'AAA';

const BLANK = ' ';
const BLANK_INDEX = NAME_CHARSET.indexOf(BLANK);

export class NameEntryModel {
  private readonly startedAtMs: number;
  private readonly limitMs: number;
  private readonly slots: number[];
  private cursorIndex = 0;
  private done = false;

  constructor(now: number, limitMs: number = NAME_ENTRY_MS) {
    this.startedAtMs = now;
    this.limitMs = limitMs;
    // 초기값은 `AAA`가 아니라 **빈 3칸**이다 — 15초 자동 등록에서 "입력이 없었다"를 구분해야
    // §5.7의 "빈 값은 AAA" 규칙이 성립한다 (SCR-311)
    this.slots = new Array<number>(NAME_LENGTH).fill(BLANK_INDEX);
  }

  handle(action: InputAction): void {
    if (this.done) return;
    switch (action) {
      // 빈 칸(마지막 문자)에서 `UP` 한 번이면 `A`가 나오도록 위쪽을 +1 방향으로 둔다
      case 'UP':
        this.rotate(1);
        break;
      case 'DOWN':
        this.rotate(-1);
        break;
      case 'LEFT':
        this.cursorIndex = (this.cursorIndex - 1 + NAME_LENGTH) % NAME_LENGTH;
        break;
      case 'RIGHT':
        this.cursorIndex = (this.cursorIndex + 1) % NAME_LENGTH;
        break;
      case 'BUTTON1':
        // 현재 자리 확정 → 다음 자리로. 마지막 자리에서 누르면 등록이다 (P-11)
        if (this.cursorIndex === NAME_LENGTH - 1) this.done = true;
        else this.cursorIndex += 1;
        break;
      case 'BUTTON2':
        // 커서를 왼쪽으로 옮기고 그 자리를 비운다. 첫 자리면 현재 자리만 비운다 (P-11)
        if (this.cursorIndex > 0) this.cursorIndex -= 1;
        this.slots[this.cursorIndex] = BLANK_INDEX;
        break;
      default:
        break;
    }
  }

  get value(): string {
    return this.slots.map((i) => NAME_CHARSET[i]).join('');
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  get committed(): boolean {
    return this.done;
  }

  /** §5.7 — 15초 초과 시 현재 입력값으로 자동 등록한다 */
  expired(now: number): boolean {
    return now - this.startedAtMs >= this.limitMs;
  }

  remainingMs(now: number): number {
    return Math.max(0, this.startedAtMs + this.limitMs - now);
  }

  /** 등록에 쓸 최종 값 — 공백뿐이면 `AAA` */
  finalValue(): string {
    const value = this.value;
    return value.trim() === '' ? DEFAULT_INITIALS : value;
  }

  private rotate(step: number): void {
    const size = NAME_CHARSET.length;
    this.slots[this.cursorIndex] = (this.slots[this.cursorIndex] + step + size) % size;
  }
}
