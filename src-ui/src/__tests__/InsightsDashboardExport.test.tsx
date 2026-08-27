/**
 * @vitest-environment jsdom
 */
import { describe, expect, test, vi } from 'vitest';

const fetchMonitoringEvents = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  fetchMonitoringEvents: (...args: unknown[]) => fetchMonitoringEvents(...args),
  useInsightsQuery: () => ({ data: undefined }),
}));

const { downloadInsightEvents } = await import(
  '../components/monitoring/InsightsDashboard'
);

describe('the export refuses to misrepresent itself (station#3075)', () => {
  test('sends tools=true, so the file matches the name it is given', async () => {
    // Dropping the tools flag widens the export from tool events to EVERY
    // monitoring event in the window — reasoning text, agent turns, health
    // frames — while the file is still called station-tool-events. A
    // one-line, test-invisible widening of a path that writes model and
    // tool content to disk.
    fetchMonitoringEvents.mockResolvedValue([{ a: 1 }]);
    await downloadInsightEvents(14, { agent: 'dev' });

    const filters = fetchMonitoringEvents.mock.calls[0]?.[3] as {
      tools?: boolean;
      agent?: string;
    };
    expect(filters.tools).toBe(true);
    expect(filters.agent).toBe('dev');
  });

  test('writes nothing when no rows come back, and says why', async () => {
    // fetchMonitoringEvents flattens a 401, a 500 and a parse error into the
    // same empty array, so a silent empty download cannot be told apart from
    // "there are genuinely none".
    fetchMonitoringEvents.mockResolvedValue([]);
    const result = await downloadInsightEvents(14, {});

    expect(result.written).toBe(false);
    expect(result.reason).toContain('3130');
  });

  test('refuses when the rollup counted far more than the export can read', async () => {
    // The panel beside this button reads /api/insights, which applies no
    // user filter; the export reads the endpoint that does. On a corpus of
    // unattributed tool events the two disagree by orders of magnitude, and
    // a file claiming to hold "the rows behind" that number would be a lie.
    fetchMonitoringEvents.mockResolvedValue([{ a: 1 }]);
    const result = await downloadInsightEvents(14, {}, 6239);

    expect(result.written).toBe(false);
    expect(result.rows).toBe(1);
    expect(result.reason).toContain('6239');
  });

  test('writes when the counts agree', async () => {
    // The negative control: this guard must not block the working case.
    fetchMonitoringEvents.mockResolvedValue([{ a: 1 }, { a: 2 }]);
    const result = await downloadInsightEvents(14, {}, 2);

    expect(result.written).toBe(true);
    expect(result.rows).toBe(2);
  });
});
