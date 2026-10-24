import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { runServerScenario } from '../bench/server-scenario.mjs';

const makeTempDir = trackTempDirs();

// Owns the real build, EventStore writer, authenticated HTTP reads, probe IPC,
// and process cleanup. Tiny corpus; the manual benchmark owns the 10k run.
test('real-server scenario records observed phases and reads seeded images and sessions', async () => {
  const out = makeTempDir('server-scenario-test-');
  const receipt = await runServerScenario({
    out,
    sessions: 5,
    turns: 30,
    images: 20,
    idleMs: 100,
    allowDirty: true,
  });
  expect(receipt.outcome).toBe('completed');
  expect(receipt.spawnToBootMs).toBeGreaterThan(receipt.spawnToReadyMs);
  expect(receipt.fixture).toMatchObject({
    sessions: 5,
    events: 121,
    images: 20,
  });
  expect(receipt.phases.sessionDetail.eventCount).toBe(121);
  expect(receipt.phases.eventWindow).toMatchObject({
    imageCount: 20,
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
}, 180_000);
