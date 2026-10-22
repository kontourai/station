import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runServerScenario } from '../bench/server-scenario.mjs';

// Owns the real build, EventStore writer, authenticated HTTP reads, probe IPC,
// and process cleanup. Tiny corpus; the manual benchmark owns the 10k run.
test('real-server scenario records observed phases and reads seeded images and sessions', async () => {
  const out = mkdtempSync(join(tmpdir(), 'server-scenario-test-'));
  try {
    const receipt = await runServerScenario({
      out,
      sessions: 5,
      turns: 25,
      images: 2,
      idleMs: 100,
      allowDirty: true,
    });
    expect(receipt.outcome).toBe('completed');
    expect(receipt.spawnToBootMs).toBeGreaterThan(receipt.spawnToReadyMs);
    expect(receipt.fixture).toMatchObject({
      sessions: 5,
      events: 101,
      images: 2,
    });
    expect(receipt.phases.sessionDetail.eventCount).toBe(101);
    expect(receipt.phases.eventWindow).toMatchObject({
      imageCount: 2,
      hasMore: true,
    });
    expect(receipt.phases.sessionList.sessionCount).toBe(5);
    expect(receipt.phases.idle.requests).toBe(0);
    expect(receipt.phases.sessionList.requests).toBe(1);
    for (const phase of Object.values(receipt.phases)) {
      expect(phase.elapsedMs).toBeGreaterThan(0);
      expect(phase.rssBytes).toBeGreaterThan(0);
      expect(phase.eventLoopDelayMs.samples).toBeGreaterThan(0);
      if (phase.eventLoopDelayMs.p99 === null)
        throw Error('missing delay samples');
      expect(phase.eventLoopDelayMs.max).toBeGreaterThanOrEqual(
        phase.eventLoopDelayMs.p99,
      );
    }
    expect(receipt.cleanup.settled).toBe(true);
    expect(
      JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8')).outcome,
    ).toBe('completed');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 180_000);
