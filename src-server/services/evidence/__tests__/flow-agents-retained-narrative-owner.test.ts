import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeGroundedNarrative,
  parseSourceId,
  snapshotNarrative,
  writeEnvelope,
} from '@kontourai/flow-agents';
import { STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER } from '@kontourai/station-contracts/answer-narrative-binding';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FlowAgentsRetainedNarrativeOwner } from '../flow-agents-retained-narrative-owner.js';

const makeTempDir = trackTempDirs();
const NARRATIVE_ID = 'station-owner-fixture';
const READER = '@kontourai/flow-agents/narrative-retained-reader';

/** A narrative retained by Flow Agents' own snapshot, compose and write steps. */
function retainedNarrative() {
  const workspace = makeTempDir('station-retained-narrative-');
  const narrativeDir = join(workspace, '.kontourai', 'narrative', NARRATIVE_ID);
  const flowRoot = join(workspace, 'flow');
  const report = Buffer.from(
    JSON.stringify({ run_id: 'owner-run', gate_summaries: [] }),
  );
  mkdirSync(join(flowRoot, 'runs', 'owner-run'), { recursive: true });
  writeFileSync(join(flowRoot, 'runs', 'owner-run', 'report.json'), report);
  const sha8 = createHash('sha256').update(report).digest('hex').slice(0, 8);
  snapshotNarrative(
    {
      narrativeDir,
      narrativeId: NARRATIVE_ID,
      requests: [
        {
          source: parseSourceId(`fa1:flow-report:owner-run:report/${sha8}`),
          roots: { flowRoot },
        },
      ],
      redactionFields: [],
      compiler: { name: 'fixture', version: '1', policy_hash: 'fixture' },
      captureCompleteness: { channels: { full: 'active' }, known_gaps: [] },
    },
    { now: () => '2026-11-16T00:00:00.000Z' },
  );
  const envelope = composeGroundedNarrative(narrativeDir, {
    compiledAt: '2026-11-16T00:01:00.000Z',
  });
  const written = writeEnvelope(narrativeDir, envelope);
  const narrativeRef = {
    schemaVersion: 'grounded-narrative-ref/v1' as const,
    narrativeId: NARRATIVE_ID,
    envelopeSha256: written.envelopeSha256,
  };
  const adapter = new FlowAgentsRetainedNarrativeOwner((projectId) =>
    projectId === 'project-a' ? workspace : undefined,
  );
  const owner = adapter.capture({
    ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
    projectId: 'project-a',
    workspacePath: '',
    narrativeRef,
  });
  if (!owner) throw new Error('fixture owner was not captured');
  return { adapter, owner, narrativeRef, envelopePath: written.envelopePath };
}

describe('FlowAgentsRetainedNarrativeOwner', () => {
  test('reads and projects a narrative Flow Agents retained', async () => {
    const { adapter, owner, narrativeRef } = retainedNarrative();
    const read = await adapter.read({
      owner,
      narrativeRef,
      authorize: () => true,
    });
    expect(read.state).toBe('available');
    expect(read).toMatchObject({
      process: { narrativeId: NARRATIVE_ID, ref: narrativeRef },
    });
  });

  test('reports a narrative whose envelope is gone as not captured', async () => {
    const { adapter, owner, narrativeRef, envelopePath } = retainedNarrative();
    rmSync(envelopePath);
    await expect(
      adapter.read({ owner, narrativeRef, authorize: () => true }),
    ).resolves.toMatchObject({ state: 'not-captured' });
  });

  test('rejects while the reader cannot load and reads once it can', async () => {
    // The reader is loaded on first read (load-flow-agents.ts); a failed load
    // is not remembered, so the next read loads it again (vitest reports the
    // factory's error as a mocking error).
    const { adapter, owner, narrativeRef } = retainedNarrative();
    vi.resetModules();
    vi.doMock(READER, () => {
      throw new Error('narrative reader unavailable');
    });
    try {
      const { FlowAgentsRetainedNarrativeOwner: FreshOwner } = await import(
        '../flow-agents-retained-narrative-owner.js'
      );
      const fresh = new FreshOwner(() => owner.workspacePath);
      await expect(
        fresh.read({ owner, narrativeRef, authorize: () => true }),
      ).rejects.toThrow(/error when mocking a module/);
      vi.doUnmock(READER);
      await expect(
        fresh.read({ owner, narrativeRef, authorize: () => true }),
      ).resolves.toMatchObject({ state: 'available' });
      // The module-level adapter loaded before the failure still reads.
      await expect(
        adapter.read({ owner, narrativeRef, authorize: () => true }),
      ).resolves.toMatchObject({ state: 'available' });
    } finally {
      vi.doUnmock(READER);
      vi.resetModules();
    }
  });
});
