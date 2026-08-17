// 관리자 씬 (§11 · admin §4.2 — 작업 계획 P-1)
//
// **8그룹 전 화면을 이 씬 1개가 그린다.** 화면마다 씬을 두면 화면 수만큼 Phaser 결선·등록이
// 늘고 규칙이 씬으로 새어 나간다. 여기에는 규칙 분기가 **0개**다 — `AdminController.view()`가
// 준 헤더·행·상세·푸터·토스트·위험 패널을 좌표에 올려 놓는 일만 한다.

import type { AdminRow, AdminView } from '../game/admin/view';
import type { FlowSnapshot } from '../game/flow';
import {
  ADMIN_CSS,
  ADMIN_FONT,
  ADMIN_HEX,
  ADMIN_LAYOUT,
  colorOfMarker,
  colorOfToast,
} from '../game/render/adminTheme';
import { ArrowScene } from './ArrowScene';

interface RowText {
  readonly marker: Phaser.GameObjects.Text;
  readonly label: Phaser.GameObjects.Text;
  readonly value: Phaser.GameObjects.Text;
}

const DETAIL_LINES = 14;

export class AdminScene extends ArrowScene {
  private header!: Phaser.GameObjects.Text;
  private clock!: Phaser.GameObjects.Text;
  private status!: Phaser.GameObjects.Text;
  private rows: RowText[] = [];
  private detail: Phaser.GameObjects.Text[] = [];
  private footer!: Phaser.GameObjects.Text;
  private saveState!: Phaser.GameObjects.Text;
  private toast!: Phaser.GameObjects.Text;
  private dangerBox!: Phaser.GameObjects.Rectangle;
  private dangerTitle!: Phaser.GameObjects.Text;
  private dangerBody!: Phaser.GameObjects.Text;
  private dangerBar!: Phaser.GameObjects.Rectangle;
  private cursorBar!: Phaser.GameObjects.Rectangle;
  private displayPattern!: Phaser.GameObjects.Container;
  private displayCountdown!: Phaser.GameObjects.Text;

  constructor() {
    super('Admin');
  }

  protected build(): void {
    const L = ADMIN_LAYOUT;
    // Phaser는 같은 씬 인스턴스를 재사용한다 — 두 번째 진입에서 이전 회차의 **파괴된** 텍스트가
    // 배열에 남아 있으면 그리는 순간 죽는다. 목록을 먼저 비운다
    this.rows = [];
    this.detail = [];
    this.cameras.main.setBackgroundColor(ADMIN_CSS.background);
    this.add.rectangle(L.screenWidth / 2, 42, L.screenWidth, 84, ADMIN_HEX.headerBar);
    this.add.rectangle(L.screenWidth / 2, L.ruleTopY, L.screenWidth, 2, ADMIN_HEX.rule);

    this.header = this.text(L.rowX, L.headerY, ADMIN_FONT.header, ADMIN_CSS.text);
    this.clock = this.text(1280, L.headerY, ADMIN_FONT.header, ADMIN_CSS.dim);
    this.status = this.text(1620, L.headerY, ADMIN_FONT.header, ADMIN_CSS.ok);

    this.cursorBar = this.add
      .rectangle(L.rowX - 20, L.rowFirstY + 14, 1120, 36, ADMIN_HEX.cursor, 0.18)
      .setOrigin(0, 0.5);

    for (let i = 0; i < L.rowsPerPage; i += 1) {
      const y = L.rowFirstY + i * L.rowGap;
      this.rows.push({
        marker: this.text(L.rowX - 4, y, ADMIN_FONT.row, ADMIN_CSS.text),
        label: this.text(L.rowX + 36, y, ADMIN_FONT.row, ADMIN_CSS.text),
        value: this.text(L.rowValueX, y, ADMIN_FONT.row, ADMIN_CSS.text).setFixedSize(
          L.detailX - L.rowValueX - 20,
          ADMIN_FONT.row + 6
        ),
      });
    }
    for (let i = 0; i < DETAIL_LINES; i += 1) {
      // §8.3 — 상세 패널은 우측 40%를 넘지 않는다. 긴 오류 문구는 화면 밖으로 나가지 않고 접힌다
      this.detail.push(
        this.text(
          L.detailX,
          L.detailY + i * L.detailGap,
          ADMIN_FONT.detail,
          ADMIN_CSS.dim
        ).setWordWrapWidth(L.screenWidth - L.detailX - 40)
      );
    }
    this.footer = this.text(L.rowX, L.footerY, ADMIN_FONT.footer, ADMIN_CSS.dim);
    this.saveState = this.text(1400, L.footerY, ADMIN_FONT.footer, ADMIN_CSS.dim);
    this.toast = this.text(L.rowX, L.toastY, ADMIN_FONT.toast, ADMIN_CSS.ok);

    this.dangerBox = this.add
      .rectangle(L.screenWidth / 2, L.dangerY + 60, 1300, 260, ADMIN_HEX.headerBar)
      .setStrokeStyle(3, 0xf2545b)
      .setVisible(false);
    this.dangerTitle = this.text(320, L.dangerY - 20, ADMIN_FONT.danger, ADMIN_CSS.error);
    this.dangerBody = this.text(320, L.dangerY + 50, ADMIN_FONT.row, ADMIN_CSS.text);
    this.dangerBar = this.add
      .rectangle(320, L.dangerY + 120, 0, 18, ADMIN_HEX.cursor)
      .setOrigin(0, 0.5)
      .setVisible(false);
    this.buildDisplayPattern();
  }

  update(): void {
    // `admin.tick()`은 `ArrowScene.update()`가 이미 부른다 (화면과 무관하게 흐른다)
    super.update();
    this.draw(this.app.admin.view());
  }

  protected paint(snap: FlowSnapshot): void {
    // 관리자 화면은 `flow` 스냅샷이 아니라 컨트롤러 뷰를 그린다 — 화면이 맞을 때만 반응한다
    if (snap.screen !== 'ADMIN') return;
    this.draw(this.app.admin.view());
  }

  private draw(view: AdminView): void {
    const L = ADMIN_LAYOUT;
    this.header.setText(view.breadcrumb);
    this.clock.setText(view.clock);
    this.status.setText(view.status).setColor(colorOfMarker(view.status.charAt(0)));

    // 커서가 화면 밖으로 나가면 목록을 밀어 준다 (긴 화면: 구간표 20행 · INPUT TEST 18행)
    const offset = Math.max(0, view.cursor - (L.rowsPerPage - 1));
    for (let i = 0; i < this.rows.length; i += 1) {
      const slot = this.rows[i];
      const index = offset + i;
      if (index >= view.rows.length) {
        slot.marker.setText('');
        slot.label.setText('');
        slot.value.setText('');
        continue;
      }
      const row: AdminRow = view.rows[index];
      const badge = row.badge === undefined ? '' : `  ${row.badge}`;
      const timing = row.applyTiming === undefined ? '' : `  ${row.applyTiming}`;
      // 편집 셀 표시는 **커서가 선 행에만** 붙인다 (다른 행에서는 값 칸을 밀어내는 잡음이다)
      const cells =
        index !== view.cursor || row.cellCount === undefined || row.cellCount <= 1
          ? ''
          : `  [${String((row.cellIndex ?? 0) + 1)}/${String(row.cellCount)}]`;
      slot.marker.setText(row.marker).setColor(colorOfMarker(row.marker));
      slot.label.setText(`${index === view.cursor ? '> ' : '  '}${row.label}`);
      slot.label.setColor(row.selectable ? ADMIN_CSS.text : ADMIN_CSS.readOnly);
      slot.value.setText(`${row.value}${cells}${badge}${timing}`);
      slot.value.setColor(colorOfMarker(row.marker));
    }
    this.cursorBar
      .setVisible(view.rows.length > 0)
      .setY(L.rowFirstY + (view.cursor - offset) * L.rowGap + 14);

    const detailLines = [...view.detail, ...view.errors, ...view.warnings];
    for (let i = 0; i < this.detail.length; i += 1) {
      this.detail[i].setText(i < detailLines.length ? detailLines[i] : '');
      this.detail[i].setColor(i < view.detail.length ? ADMIN_CSS.dim : ADMIN_CSS.error);
    }

    this.footer.setText(view.footer);
    this.saveState.setText(view.saveState);
    const toast = view.toast;
    this.toast.setText(toast === null ? '' : toast.text);
    if (toast !== null) this.toast.setColor(colorOfToast(toast.level));

    this.drawDanger(view);
    const displayVisible = view.displayTestRemainingMs > 0;
    this.displayPattern.setVisible(displayVisible);
    if (displayVisible) {
      this.displayCountdown.setText(
        `DISPLAY TEST · ${String(Math.ceil(view.displayTestRemainingMs / 1000))}초 · G 복귀`
      );
    }
  }

  private drawDanger(view: AdminView): void {
    const danger = view.danger;
    const visible = danger !== null;
    this.dangerBox.setVisible(visible);
    this.dangerBar.setVisible(visible);
    if (danger === null) {
      this.dangerTitle.setText('');
      this.dangerBody.setText('');
      return;
    }
    const hold =
      danger.requiredHoldMs === 0 ? 'H 확정' : `H ${String(danger.requiredHoldMs / 1000)}초 유지`;
    this.dangerTitle.setText(`${danger.level} · ${danger.label}`);
    this.dangerBody.setText(
      [
        danger.summary,
        danger.balanceWarning ?? '',
        danger.executing ? '실행 중 · 입력 잠금' : `${hold}  ·  G 취소`,
        danger.rejected ? 'H를 더 오래 유지하세요' : '',
        `자동 취소 ${String(Math.ceil(danger.autoCancelLeftMs / 1000))}초`,
      ]
        .filter((s) => s !== '')
        .join('\n')
    );
    this.dangerBar.setSize(Math.round(1160 * danger.progress01), 18);
  }

  private text(x: number, y: number, size: number, color: string): Phaser.GameObjects.Text {
    return this.add.text(x, y, '', {
      fontFamily: ADMIN_FONT.family,
      fontSize: `${String(size)}px`,
      color,
    });
  }

  /** admin §10.3 — 정적 안전 영역·RGB·백/흑·폰트 패턴. 점멸은 사용하지 않는다. */
  private buildDisplayPattern(): void {
    const objects: Phaser.GameObjects.GameObject[] = [];
    const bg = this.add.rectangle(960, 540, 1920, 1080, 0x050505);
    objects.push(bg);
    const grid = this.add.graphics();
    grid.lineStyle(2, 0x3a3a3a, 1);
    for (let x = 0; x <= 1920; x += 120) {
      grid.beginPath();
      grid.moveTo(x, 0);
      grid.lineTo(x, 1080);
      grid.strokePath();
    }
    for (let y = 0; y <= 1080; y += 120) {
      grid.beginPath();
      grid.moveTo(0, y);
      grid.lineTo(1920, y);
      grid.strokePath();
    }
    grid.lineStyle(4, 0xffffff, 1).strokeRect(48, 48, 1824, 984);
    objects.push(grid);
    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x000000];
    for (let i = 0; i < colors.length; i += 1) {
      objects.push(
        this.add
          .rectangle(360 + i * 300, 360, 250, 220, colors[i])
          .setStrokeStyle(3, i === colors.length - 1 ? 0xffffff : 0x333333)
      );
    }
    this.displayCountdown = this.add
      .text(960, 90, '', {
        fontFamily: ADMIN_FONT.family,
        fontSize: '40px',
        color: '#FFFFFF',
      })
      .setOrigin(0.5);
    objects.push(this.displayCountdown);
    for (const [i, size] of [72, 48, 28, 22].entries()) {
      objects.push(
        this.add
          .text(960, 560 + i * 90, `${String(size)}px  ARROW OUT · 한글 0123456789`, {
            fontFamily: ADMIN_FONT.family,
            fontSize: `${String(size)}px`,
            color: '#FFFFFF',
          })
          .setOrigin(0.5)
      );
    }
    this.displayPattern = this.add.container(0, 0, objects).setDepth(1000).setVisible(false);
  }
}
