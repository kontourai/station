import { describe, expect, test } from 'vitest';
import { formatNotificationTime } from '../notifications';

const now = new Date(2026, 9, 28, 12, 0);
const ago = (mins: number) =>
  new Date(now.getTime() - mins * 60_000).toISOString();

describe('formatNotificationTime', () => {
  test('is relative within a week, in the one compact format', () => {
    expect(formatNotificationTime(ago(0), now)).toBe('now');
    expect(formatNotificationTime(ago(14), now)).toBe('14m');
    expect(formatNotificationTime(ago(6 * 60), now)).toBe('6h');
    expect(formatNotificationTime(ago(2 * 1440), now)).toBe('2d');
  });

  test('older rows show a short date with no clock time or seconds', () => {
    const label = formatNotificationTime(ago(8 * 1440), now);
    expect(label).not.toMatch(/\d:\d\d/);
    expect(label).not.toMatch(/2026/);
    expect(
      formatNotificationTime(new Date(2025, 0, 3).toISOString(), now),
    ).toMatch(/2025/);
  });
});
