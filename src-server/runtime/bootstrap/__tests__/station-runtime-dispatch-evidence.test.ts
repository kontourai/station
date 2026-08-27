/**
 * station#1426 fix round (SF-7): a production-binding test for
 * `StationRuntime.dispatchEvidenceSource()` — the closure that backs
 * `AgentCreationConfig.dispatchEvidenceSource`/
 * `RuntimeContext.dispatchEvidenceSource` with the real `ConnectionService`.
 * Everything else in this arc (dispatch-model-policy.test.ts,
 * runtime-agent-builder.test.ts) exercises the grading logic against a fake
 * evidence source; this is the one test that proves the real
 * `ConnectionService`-backed implementation resolves and batches correctly
 * (SF-5: one `listConnections()` call regardless of how many/which
 * connection ids are requested).
 */

import type { ConnectionReadinessEvidence } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';

function readiness(
  level: ConnectionReadinessEvidence['level'],
): ConnectionReadinessEvidence {
  return {
    evidenceVersion: 1,
    level,
    observedAt: '2026-08-01T00:00:00.000Z',
    freshness: 'fresh',
    summary: `test evidence at ${level}`,
    smoke: {
      status: level === 'smoke-passed' ? 'passed' : 'not-tested',
      freshness: level === 'smoke-passed' ? 'fresh' : 'unknown',
      turnLimit: 1,
    },
  };
}

function createRuntime(listConnections: ReturnType<typeof vi.fn>): any {
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.connectionService = { listConnections };
  return runtime;
}

describe('StationRuntime.dispatchEvidenceSource (production binding)', () => {
  test('resolves readiness evidence for the requested connection ids from exactly one listConnections() call', async () => {
    const listConnections = vi.fn(async () => [
      { id: 'conn-a', readinessEvidence: readiness('smoke-passed') },
      { id: 'conn-b', readinessEvidence: undefined },
      { id: 'conn-c', readinessEvidence: readiness('discovered') },
    ]);
    const runtime = createRuntime(listConnections);
    const source = runtime.dispatchEvidenceSource();

    const evidence = await source.getConnectionReadinessEvidence([
      'conn-a',
      'conn-c',
      'conn-missing',
    ]);

    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(evidence.get('conn-a')?.level).toBe('smoke-passed');
    expect(evidence.get('conn-c')?.level).toBe('discovered');
    // Not requested, and unknown to the connection service, respectively:
    // neither should appear in the returned map.
    expect(evidence.has('conn-b')).toBe(false);
    expect(evidence.has('conn-missing')).toBe(false);
  });

  test('a connection with no readinessEvidence is simply absent from the map, not present as undefined', async () => {
    const listConnections = vi.fn(async () => [
      { id: 'conn-a', readinessEvidence: undefined },
    ]);
    const runtime = createRuntime(listConnections);
    const source = runtime.dispatchEvidenceSource();

    const evidence = await source.getConnectionReadinessEvidence(['conn-a']);

    expect(evidence.has('conn-a')).toBe(false);
  });

  test('an empty id request never calls listConnections at all', async () => {
    const listConnections = vi.fn();
    const runtime = createRuntime(listConnections);
    const source = runtime.dispatchEvidenceSource();

    const evidence = await source.getConnectionReadinessEvidence([]);

    expect(evidence.size).toBe(0);
    expect(listConnections).not.toHaveBeenCalled();
  });

  test('a duplicated connection id in the request still resolves from one listConnections() call', async () => {
    const listConnections = vi.fn(async () => [
      { id: 'conn-a', readinessEvidence: readiness('catalog-ready') },
    ]);
    const runtime = createRuntime(listConnections);
    const source = runtime.dispatchEvidenceSource();

    const evidence = await source.getConnectionReadinessEvidence([
      'conn-a',
      'conn-a',
    ]);

    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(evidence.get('conn-a')?.level).toBe('catalog-ready');
  });
});
