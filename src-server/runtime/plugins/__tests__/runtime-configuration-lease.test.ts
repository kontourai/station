import { describe, expect, test } from 'vitest';
import {
  captureRuntimeConfigurationLease,
  requireStableRuntimeConfigurationAcross,
} from '../runtime-configuration-lease.js';

function createRevisionSource() {
  let agentRevision = 2;
  let providerRevision = 3;
  let appRevision = 4;
  return {
    source: {
      getAgentConfigurationRevision: () => agentRevision,
      commitAgentConfigurationRead: async <T>(
        expectedRevision: number,
        operation: () => Promise<T>,
      ) => {
        if (agentRevision !== expectedRevision) {
          throw new Error('configuration changed during the request');
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
    const { source, setAgentRevision } = createRevisionSource();
    const lease = captureRuntimeConfigurationLease(source);
    setAgentRevision(6);

    await expect(
      requireStableRuntimeConfigurationAcross(source, lease, async () => {}),
    ).rejects.toThrow('configuration changed during the request');
  });

  test('rejects a result when a launchability source changes during the operation', async () => {
    const { source, setProviderRevision } = createRevisionSource();
    const lease = captureRuntimeConfigurationLease(source);

    await expect(
      requireStableRuntimeConfigurationAcross(source, lease, async () => {
        setProviderRevision(9);
        return 'stale-success';
      }),
    ).rejects.toThrow('configuration changed during the request');
  });
});
