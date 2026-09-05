/** @vitest-environment jsdom */

import { nextOccurrences } from '@kontourai/ephemeris';
import type { SchedulerSchedule } from '@kontourai/station-contracts/scheduler';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #1536 D1 — L1 fixed WHEN a job fires and left the preview describing the old
 * behaviour, which is worse than either alone: the form told the reader a
 * different time from the one it was about to save.
 *
 * Two independent errors, both measured on America/Denver before the fix:
 *
 *  - the occurrences came back from a request carrying no zone, so the server
 *    projected `0 8 * * 1-5` as 08:00 UTC;
 *  - `cronToHuman` applied `setUTCHours` to the cron's hour and then labelled
 *    the result with the READER's zone abbreviation, so the same expression
 *    rendered "2:00 AM MDT" for a job that fires at 8:00 AM MDT.
 *
 * `cronToHuman` had no unit coverage at all, which is how both survived.
 */

const previewCalls = vi.hoisted(
  () => [] as Array<{ cron: string | null; timezone?: string }>,
);
const previewState = vi.hoisted(() => ({
  data: [] as string[],
  isLoading: false,
}));

vi.mock('../hooks/useScheduler', () => ({
  usePreviewSchedule: (cron: string | null, timezone?: string) => {
    previewCalls.push({ cron, timezone });
    return { data: previewState.data, isLoading: previewState.isLoading };
  },
}));

import { CronPreview, cronToHuman } from '../components/scheduler/CronEditor';
import { getScheduleStarterTemplates } from '../views/schedule/utils';

const BRISBANE = 'Australia/Brisbane'; // UTC+10, no DST
const DENVER = 'America/Denver'; // UTC−6/−7, the machine the audit measured on

describe('cronToHuman names the zone its hour is written in', () => {
  test.each([BRISBANE, DENVER])(
    "reads the expression's own hour in %s",
    (timezone) => {
      const human = cronToHuman('0 8 * * 1-5', { timezone });
      // The hour in the expression IS the hour a reader is promised. Before the
      // fix this said "2:00 AM MDT" for Denver — shifted AND mislabelled.
      expect(human).toContain('8:00 AM');
      expect(human).toContain(timezone);
      // The composed line's own weekday phrasing ("Weekdays"), unchanged.
      expect(human).toContain('Weekdays');
    },
  );

  test("says UTC — not the reader's zone — for an expression with no zone", () => {
    // An unzoned schedule really is evaluated as UTC by the scheduler, so this
    // is the one case where naming UTC is a fact rather than a default.
    const human = cronToHuman('0 8 * * 1-5');
    expect(human).toContain('8:00 AM');
    expect(human).toContain('UTC');
  });

  test('never labels an hour with a zone abbreviation it did not convert into', () => {
    // The exact shape of the old defect: a local abbreviation appended to a
    // UTC-shifted hour. Whatever the runner's own zone is, it must not appear
    // unless it IS the schedule's zone.
    const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const other = runnerZone === BRISBANE ? DENVER : BRISBANE;
    const human = cronToHuman('0 8 * * 1-5', { timezone: other });
    expect(human).toContain(other);
    expect(human).not.toContain(runnerZone);
  });
});

describe("CronPreview asks the server in the schedule's zone", () => {
  beforeEach(() => {
    previewCalls.length = 0;
    previewState.data = [];
    previewState.isLoading = false;
  });

  test('sends the zone with the expression', () => {
    render(
      <CronPreview
        schedule={{ kind: 'cron', expr: '0 8 * * 1-5', timezone: BRISBANE }}
      />,
    );

    expect(previewCalls).toEqual([{ cron: '0 8 * * 1-5', timezone: BRISBANE }]);
  });

  test('sends no zone for an unzoned schedule, and says UTC', () => {
    render(<CronPreview schedule={{ kind: 'cron', expr: '0 8 * * 1-5' }} />);

    expect(previewCalls).toEqual([
      { cron: '0 8 * * 1-5', timezone: undefined },
    ]);
    expect(screen.getByText(/UTC/)).toBeTruthy();
  });

  test("renders each occurrence in the schedule's zone, not the reader's", () => {
    // 22:00 UTC on a Sunday is Monday 08:00 in Brisbane. Rendered in the
    // reader's zone this would read as Sunday evening somewhere in the
    // Americas — a weekday rule that looks like it fires at the weekend.
    previewState.data = ['2026-09-06T22:00:00.000Z'];
    render(
      <CronPreview
        schedule={{ kind: 'cron', expr: '0 8 * * 1-5', timezone: BRISBANE }}
      />,
    );

    const times = screen
      .getAllByText(/2026|Mon|Sun|AM|PM/)
      .map((node) => node.textContent ?? '')
      .join(' | ');
    expect(times).toContain('Mon');
    expect(times).toContain('8:00 AM');
  });
});

/**
 * #1536 D6 — the verification the L1 commit claimed but did not run: the
 * starter's schedule, through the SAME projector the scheduler uses, landing on
 * the hour its own `meta` line advertises, on the weekdays it names.
 */
describe('a starter schedule fires when its meta line says', () => {
  test('Morning Briefing lands on 8:00 on weekdays in Australia/Brisbane', () => {
    const morning = getScheduleStarterTemplates()[0];
    expect(morning.meta).toBe('Weekdays · 8:00 AM');
    expect(morning.schedule.kind).toBe('cron');
    if (morning.schedule.kind !== 'cron') return;

    // The reader's own zone is whatever this machine is; pin the zone under
    // test explicitly so the assertion means the same thing everywhere.
    const schedule: SchedulerSchedule = {
      ...morning.schedule,
      timezone: BRISBANE,
    };
    const occurrences = nextOccurrences(
      schedule as never,
      6,
      Date.UTC(2026, 8, 1),
    );
    expect(occurrences).toHaveLength(6);

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: BRISBANE,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    });
    for (const ms of occurrences) {
      const rendered = parts.format(new Date(ms));
      // Every occurrence at 08:00 local…
      expect(rendered, `occurrence rendered ${rendered}`).toContain('08:00');
      // …and never on a weekend. Shifting only the HOUR into UTC put these on
      // Tue–Sat at this offset, which is the defect L1 fixed and this pins.
      expect(rendered).not.toContain('Sat');
      expect(rendered).not.toContain('Sun');
    }
  });
});
