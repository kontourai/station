import { describe, expect, it } from 'vitest';
import { snoozePresetTargets } from '../views/home/snooze-presets';

describe('snoozePresetTargets', () => {
  it('offers the four agent-rhythm presets, each strictly in the future', () => {
    const now = Date.parse('2026-07-28T15:30:00-06:00'); // a Tuesday afternoon
    const presets = snoozePresetTargets(now);
    expect(presets.map((preset) => preset.id)).toEqual([
      'in-1-hour',
      'this-evening',
      'tomorrow-9am',
      'next-week-mon-9am',
    ]);
    for (const preset of presets) {
      expect(preset.wakeAt).toBeGreaterThan(now);
    }
  });

  it('rolls "this evening" to tomorrow evening once evening has already passed', () => {
    const evening = Date.parse('2026-07-28T21:00:00-06:00');
    const [, thisEvening] = snoozePresetTargets(evening);
    const wakeDate = new Date(thisEvening.wakeAt);
    expect(wakeDate.getDate()).toBe(29);
    expect(wakeDate.getHours()).toBe(18);
  });

  it('"next week Mon 9am" always lands in a later week than today, including on a Monday', () => {
    const monday = Date.parse('2026-07-27T09:00:00-06:00'); // a Monday
    const [, , , nextWeek] = snoozePresetTargets(monday);
    const wakeDate = new Date(nextWeek.wakeAt);
    expect(wakeDate.getDay()).toBe(1);
    expect(wakeDate.getHours()).toBe(9);
    expect(wakeDate.getTime() - monday).toBeGreaterThanOrEqual(
      6 * 24 * 60 * 60 * 1000,
    );
  });
});
