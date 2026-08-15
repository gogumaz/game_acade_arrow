// 이름 입력 (§5.7 · SCR-311) — 3자 · 15초 · 초과 시 현재 값(빈 값은 `AAA`) 자동 등록.

import type { FlowSnapshot } from '../game/flow';
import { TextPanel, nameEntryPanel } from '../game/render/panels';
import { FONT_SIZE, LAYOUT } from '../game/render/boardView';
import { ArrowScene } from './ArrowScene';

export class NameEntryScene extends ArrowScene {
  private panel!: TextPanel;

  constructor() {
    super('NameEntry');
  }

  protected build(): void {
    this.panel = new TextPanel(this, LAYOUT.centerY - 200, FONT_SIZE.label);
  }

  protected paint(snap: FlowSnapshot): void {
    this.panel.set(nameEntryPanel(snap));
  }
}
