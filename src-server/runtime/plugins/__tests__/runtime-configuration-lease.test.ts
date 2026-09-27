import { describe, expect, test, vi } from 'vitest';
import {
  captureRuntimeConfigurationLease,
  RuntimeConfigurationConflictError,
  requireStableRuntimeConfigurationAcross,
} from '../runtime-configuration-lease.js';

function createRevisionSource() {
  let agentRevision = 2;
  let providerRevision = 3;
  let appRevision = 4;
  const commits: number[] = [];
  return {
    commits,
    source: {
      getAgentConfigurationRevision: () => agentRevision,
      commitAgentConfigurationRead: async <T>(
        expectedRevision: number,
        operation: () => Promise<T>,
      ) => {
        commits.push(expectedRevision);
        // Distinct from the lease's own conflict error, so a rejection that
        // reaches the commit cannot pass for one the lease raised itself.
        if (agentRevision !== expectedRevision) {
          throw new Error('fixture commit refused a stale revision');
        }
        return operation();
      },
      providerService: { getLaunchabilityRevision: () => providerRevision },
      configLoader: { getLaunchabilityRevision: () => appRevision },
    },
    setAgentRevision: (revision: number) => {
      agentRevision = revision;
    },
    setProviderRevision: (revision: number) => {
      providerRevision = revision;
    },
    setAppRevision: (revision: number) => {
      appRevision = revision;
    },
  };
}

describe('runtime configuration lease', () => {
  test('returns an awaited result when its configuration remains current', async () => {
    const { source } = createRevisionSource();
    const lease = captureRuntimeConfigurationLease(source);

    await expect(
      requireStableRuntimeConfigurationAcross(source, lease, async () => 'ok'),
    ).resolves.toBe('ok');
  });

  test('rejects completion before the terminal operation when configuration changed', async () => {
    const { source, commits, setAgentRevision } = createRevisionSource();
    const lease = captureRuntimeConfigurationLease(source);
    setAgentRevision(6);
    const operation = vi.fn(async () => {});

    await expect(
      requireStableRuntimeConfigurationAcross(source, lease, operation),
    ).rejects.toBeInstanceOf(RuntimeConfigurationConflictError);
    expect(commits).toEqual([]);
    expect(operation).not.toHaveBeenCalled();
  });

  test('rejects a result when a launchability source changes during the operation', async () => {
    const { source, setProviderRevision } = createRevisionSource();
    const lease = captureRuntimeConfigurationLease(source);

    await expect(
      requireStableRuntimeConfigurationAcross(source, lease, async () => {
        setProviderRevision(9);
        return 'stale-success';
      }),
    ).rejects.toBeInstanceOf(RuntimeConfigurationConflictError);
  });
});
