import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerLogReader } from '../../../services/infra/server-log-reader.js';
import { installServerLogSink } from '../../../services/infra/server-log-store.js';
import { readBootHistory, writeBootRecord } from '../boot-history.js';

/**
 * station#2642, sol review finding 1: the route test mocked the reader, so a
 * written boot record that the durable reader REJECTS (time vs timestamp)
 * escaped every suite. This test pushes real bytes through the real sink and
 * the real reader — fixture-vs-reality (#1715 class).
 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('boot history round-trip (station#2642)', () => {
  it('a written boot record is readable back through the durable reader', async () => {
    dir = mkdtempSync(join(tmpdir(), 'boot-history-'));
    const sink = installServerLogSink({ directory: dir });
    writeBootRecord(sink.writeLine.bind(sink), {
      shortSha: 'abc1234',
      fullSha: 'abc1234def',
      instanceId: 'test-instance',
    } as never);

    const history = await readBootHistory(
      createServerLogReader({ directory: dir }),
      Date.now() - 60_000,
    );
    expect(history.records.length).toBe(1);
    expect(history.records[0].source).toBe('recorded');
    expect(history.records[0].shortSha).toBe('abc1234');
    expect(history.records[0].cause).toBeUndefined();
    expect(history.currentUptimeSeconds).toBeGreaterThanOrEqual(59);
  });

  it('both legacy readiness markers from one startup collapse to one derived row', async () => {
    dir = mkdtempSync(join(tmpdir(), 'boot-history-'));
    const sink = installServerLogSink({ directory: dir });
    const boot = Date.now() - 10 * 60_000;
    const line = (offsetMs: number, msg: string) =>
      sink.writeLine(
        JSON.stringify({
          level: 'info',
          timestamp: new Date(boot + offsetMs).toISOString(),
          msg,
        }),
      );
    // First boot: two markers three seconds apart = ONE restart.
    line(0, 'Voice WebSocket listening');
    line(3_000, 'MCP Apps sandbox proxy listening');
    // Second boot five minutes later: one marker.
    line(5 * 60_000, 'Voice WebSocket listening');

    const history = await readBootHistory(
      createServerLogReader({ directory: dir }),
      Date.now(),
    );
    const derived = history.records.filter((r) => r.source === 'derived');
    expect(derived.length).toBe(2);
  });
});
