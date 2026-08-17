import { describe, expect, it } from 'vitest';
import { SFX_NAMES } from '../../src/game/sfx';
import { makeAdmin } from '../wu05/harness';

describe('WU-07 admin diagnostics', () => {
  it('exposes and plays all twelve procedural sound cues', () => {
    const rig = makeAdmin();
    expect(rig.admin.goTo(['MAINTENANCE', 'M_SOUND'])).toBe(true);

    const rows = rig.admin.view().rows;
    expect(rows.map((row) => row.id)).toEqual(SFX_NAMES.map((name) => `sound.${name}`));
    expect(rows.every((row) => row.badge === undefined)).toBe(true);

    expect(rig.focus('sound.perfect')).toBe(true);
    rig.sfx.clear();
    rig.press('BUTTON1');
    expect(rig.sfx.log).toEqual(['perfect']);
  });

  it('runs the static display pattern for 30 seconds and lets G close it early', () => {
    const rig = makeAdmin();
    expect(rig.admin.goTo(['MAINTENANCE', 'M_DISPLAY'])).toBe(true);
    expect(rig.focus('display.pattern')).toBe(true);

    rig.press('BUTTON1');
    expect(rig.admin.view().displayTestRemainingMs).toBe(30_000);

    rig.clock.advance(29_999);
    rig.admin.tick();
    expect(rig.admin.view().displayTestRemainingMs).toBe(1);

    rig.press('BUTTON2');
    expect(rig.admin.view().displayTestRemainingMs).toBe(0);
    expect(rig.admin.currentPath).toEqual(['MAINTENANCE', 'M_DISPLAY']);
  });

  it('removes the WU-07 pending badge from machine sound and motion settings', () => {
    const rig = makeAdmin();
    expect(rig.admin.goTo(['MACHINE'])).toBe(true);

    const released = new Set([
      'machine.soundVolume',
      'machine.attractVolume',
      'machine.nightMute',
      'machine.motionReduce',
    ]);
    const rows = rig.admin.view().rows.filter((row) => released.has(row.id));
    expect(rows).toHaveLength(released.size);
    expect(rows.every((row) => row.badge === undefined)).toBe(true);
  });
});
