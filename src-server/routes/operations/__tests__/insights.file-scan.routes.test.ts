import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { K, OP, SPAN } from '../../../../src-shared/monitoring-keys.js';
import { readJson as json } from '../../../__test-utils__/read-json.js';

/**
 * Every `events-*.ndjson` in the monitoring directory used to be opened,
 * streamed and `JSON.parse`d line by line before the per-row `ts < cutoff`
 * check discarded it. With the default 30-day retention and the dashboard's
 * 14-day window that is more than half the corpus read for nothing.
 *
 * These tests observe the OPEN, not just the rollup: a `createReadStream`
 * spy records every file the route actually touches, so "the older day is
 * skipped" is proven by absence of the read rather than by a count that a
 * per-row filter would produce either way.
 */
const openedFiles: string[] = [];

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const createReadStream = ((path: unknown, ...rest: unknown[]) => {
    openedFiles.push(basename(String(path)));
    return (
      actual.createReadStream as unknown as (
        ...args: unknown[]
      ) => ReturnType<typeof actual.createReadStream>
    )(path, ...rest);
  }) as typeof actual.createReadStream;
  return { ...actual, default: actual, createReadStream };
});

vi.mock('../../../telemetry/metrics.js', () => ({
  insightOps: { add: vi.fn() },
}));
vi.mock('../../system/auth.js', () => ({
  getCachedUser: () => ({ alias: 'user-1' }),
}));

const { mkdtempSync, rmSync, writeFileSync } =
  await vi.importActual<typeof import('node:fs')>('node:fs');
const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os');
const { createInsightsRoutes } = await import('../insights.js');

/**
 * A fixed UTC instant so the fixture days and the `days=2` cutoff are exact
 * rather than a function of when the suite runs. Only `Date` is faked —
 * `readdir`/`createReadStream`/`readline` still use real timers and real I/O.
 */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const TODAY_FILE = 'events-2026-06-15.ndjson';
/** `days=2` puts the cutoff at 2026-06-13T12:00:00Z — inside this day. */
const CUTOFF_DAY_FILE = 'events-2026-06-13.ndjson';
/** Ends at 2026-06-13T00:00:00Z, before the cutoff: nothing here can match. */
const OLDER_FILE = 'events-2026-06-12.ndjson';
/** Not a calendar date, so its contents are unknown and it must be read. */
const UNDATED_FILE = 'events-legacy-export.ndjson';

function chatEvent(isoTimestamp: string, traceId: string): string {
  return JSON.stringify({
    [K.TIMESTAMP]: isoTimestamp,
    [K.TIMESTAMP_MS]: Date.parse(isoTimestamp),
    [K.USER_ID]: 'user-1',
    [K.OP_NAME]: OP.INVOKE_AGENT,
    [K.SPAN_KIND]: SPAN.END,
    [K.TRACE_ID]: traceId,
    [K.AGENT_SLUG]: 'default',
  });
}

describe('Insights monitoring-file scan', () => {
  let dir: string;

  beforeEach(() => {
    openedFiles.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    dir = mkdtempSync(join(tmpdir(), 'insights-file-scan-'));
    writeFileSync(
      join(dir, OLDER_FILE),
      chatEvent('2026-06-12T12:00:00.000Z', 'trace-older'),
    );
    writeFileSync(
      join(dir, CUTOFF_DAY_FILE),
      [
        // Same file, opposite sides of the cutoff instant. This is why the
        // cutoff DAY can never be skipped from its name alone.
        chatEvent('2026-06-13T11:00:00.000Z', 'trace-before-cutoff'),
        chatEvent('2026-06-13T13:00:00.000Z', 'trace-after-cutoff'),
      ].join('\n'),
    );
    writeFileSync(
      join(dir, TODAY_FILE),
      chatEvent('2026-06-15T09:00:00.000Z', 'trace-today'),
    );
    writeFileSync(
      join(dir, UNDATED_FILE),
      chatEvent('2026-06-15T10:00:00.000Z', 'trace-undated'),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a day that ended before the cutoff is never opened; the cutoff day and an undated file still are', async () => {
    const body = await json(await createInsightsRoutes(dir).request('/?days=2'));

    expect(openedFiles).toContain(CUTOFF_DAY_FILE);
    expect(openedFiles).toContain(TODAY_FILE);
    expect(openedFiles).toContain(UNDATED_FILE);
    // The discriminating assertion: not "its rows were filtered out", but
    // "the file was never read at all".
    expect(openedFiles).not.toContain(OLDER_FILE);

    // The rollup is unchanged by the skip: the cutoff day's pre-cutoff row is
    // still excluded by the per-row check, and its post-cutoff sibling still
    // counts. Three distinct traces, not four.
    expect(body.data.totalChats).toBe(3);
  });

  test('a wider window opens the older day again — the skip follows the cutoff, not the file', async () => {
    const body = await json(await createInsightsRoutes(dir).request('/?days=7'));

    expect(openedFiles).toContain(OLDER_FILE);
    // All five rows are inside a 7-day window, including the cutoff day's
    // earlier row that the 2-day case excluded.
    expect(body.data.totalChats).toBe(5);
  });
});
