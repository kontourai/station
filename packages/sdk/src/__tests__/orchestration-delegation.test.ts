import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  delegateOrchestrationTask,
  fetchDelegationOptions,
} from '../query-domains/chatRuntimeOrchestration';

describe('orchestration delegation client', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('posts only authored task input and preserves distinct server handle identities', async () => {
    const handle = {
      taskId: 'task:server',
      conversationId: 'conversation:server',
      sessionId: 'session:server',
      currentSessionId: 'session:current-server',
      status: 'dispatched',
      environment: { id: 'current', name: 'This Station', kind: 'current' },
      target: { kind: 'agent', id: 'codex' },
      resumable: true,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: handle }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      delegateOrchestrationTask({
        apiBase: 'http://station.test',
        prompt: 'Continue the queue',
        target: {
          environment: { kind: 'current' },
          agent: agentId('codex'),
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        conversationId: 'conversation:poisoned',
        sessionId: 'session:poisoned',
        currentSessionId: 'session:current-poisoned',
        taskId: 'task:poisoned',
      } as Parameters<typeof delegateOrchestrationTask>[0]),
    ).resolves.toEqual(handle);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'Continue the queue',
          target: {
            environment: { kind: 'current' },
            agent: 'codex',
            workspace: { kind: 'project', projectSlug: 'station' },
          },
        }),
      }),
    );
  });

  test('discovers capabilities for an explicit environment', async () => {
    const options = {
      environment: { id: 'env-media', name: 'Brian Media', kind: 'ssh' },
      targets: [],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: options }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchDelegationOptions({
        apiBase: 'http://station.test',
        environmentId: 'env-media',
      }),
    ).resolves.toEqual(options);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/options',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ environmentId: 'env-media' }),
      }),
    );
  });
});
