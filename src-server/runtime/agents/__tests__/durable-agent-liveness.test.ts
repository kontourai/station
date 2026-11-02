import { agentWire } from '@kontourai/agent-runtime/internal';
import { probeExactProcessIdentity } from '@kontourai/station-shared/process-identity';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { resetFixtureSqliteSynchronousForTest } from '../../../utils/sqlite-fixture-durability.js';
import { stationAgentRuntimeOwner } from '../durable-agent-owner.js';

vi.mock(
  '@kontourai/station-shared/process-identity',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/process-identity')
      >();
    return {
      ...actual,
      probeExactProcessIdentity: vi.fn(actual.probeExactProcessIdentity),
    };
  },
);
const temp = trackTempDirs();
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => resetFixtureSqliteSynchronousForTest());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('the real Station owner executes journal steps without probing its own process per command', async () => {
  const owner = stationAgentRuntimeOwner(temp('durable-local-live-'));
  cleanup.push(() => owner.pause());
  owner.configure({
    preview: { select: (branches) => branches.enabled() },
    failed: (error) => {
      throw error;
    },
  });
  owner.registerAgent('assistant', 'definition/1', async () => {
    throw Error('No model invocation in the ownership test');
  });
  vi.mocked(probeExactProcessIdentity).mockClear();
  const lease = await owner.runtime.start({
    key: {
      scopeId: 'station',
      conversationId: 'conversation',
      invocationId: 'turn',
    },
    implementation: 'station-agent/1',
    input: agentWire({
      version: 1,
      slug: 'assistant',
      definition: 'definition/1',
      input: 'go',
      options: { conversationId: 'conversation', userId: 'owner' },
    }),
  });
  let calls = 0;
  await lease.run(async () => {
    expect(
      await lease.tool(
        { id: 'tool:probe', input: {}, replay: 'unsafe' },
        async () => ++calls,
      ),
    ).toBe(1);
  });
  expect(calls).toBe(1);
  expect(owner.read('conversation', 'turn')?.turn.state).toBe('completed');
  expect(probeExactProcessIdentity).not.toHaveBeenCalled();
});
