import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  continueDelegatedTask,
  delegateTask,
  discoverDelegationOptions,
  interruptDelegatedTask,
  listDelegatedTasks,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  respondToDelegatedTaskRequest,
} from '../client/delegations';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('client/delegations fetchers (#977 Wave 2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('delegateTask posts to /delegations and unwraps the handle', async () => {
    const handle = {
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'dispatched',
      environment: { id: 'current', name: 'This Station', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: handle }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      delegateTask('http://station.test', {
        prompt: 'Ship it',
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
      }),
    ).resolves.toMatchObject(handle);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'Ship it',
          target: { environment: { kind: 'current' }, agent: 'station' },
        }),
      }),
    );
  });

  test('projects poisoned caller handle identities out of the exact create body and preserves distinct server identities', async () => {
    const handle = {
      taskId: 'task:server',
      conversationId: 'conversation:server',
      sessionId: 'session:server',
      currentSessionId: 'session:current-server',
      status: 'dispatched',
      environment: { id: 'current', name: 'This Station', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: handle }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      delegateTask('http://station.test', {
        prompt: 'Ship it',
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
        parentTaskId: 'task:parent',
        conversationId: 'conversation:poisoned',
        sessionId: 'session:poisoned',
        currentSessionId: 'session:current-poisoned',
        taskId: 'task:poisoned',
      } as Parameters<typeof delegateTask>[1]),
    ).resolves.toEqual(handle);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'Ship it',
          target: { environment: { kind: 'current' }, agent: 'station' },
          parentTaskId: 'task:parent',
        }),
      }),
    );
  });

  test('delegateTask throws the server error text on a non-success envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(400, {
        success: false,
        error: 'Select exactly one Station agent or Agent app',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      delegateTask('http://station.test', {
        prompt: 'Ship it',
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
      }),
    ).rejects.toThrow('Select exactly one Station agent or Agent app');
  });

  test('normalizes legacy create and inventory identities without inventing write resumability', async () => {
    const legacyCreate = {
      taskId: 'task:legacy-create',
      sessionId: 'task:legacy-create',
      status: 'dispatched',
      environment: { id: 'current', name: 'This Station', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
    };
    const legacyListItem = {
      taskId: 'task:legacy-list',
      status: 'completed',
      environment: { id: 'current', name: 'This Station', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
      eventCount: 1,
      canInterrupt: false,
      resumable: true,
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(200, { success: true, data: legacyCreate }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            success: true,
            data: {
              environment: legacyListItem.environment,
              tasks: [legacyListItem],
              truncated: false,
            },
          }),
        ),
    );

    const created = await delegateTask('http://station.test', {
      prompt: 'Ship it',
      target: {
        environment: { kind: 'current' },
        agent: agentId('station'),
      },
    });
    expect(created).toMatchObject({
      taskId: legacyCreate.taskId,
      conversationId: legacyCreate.taskId,
      sessionId: legacyCreate.sessionId,
      currentSessionId: legacyCreate.sessionId,
    });
    expect(created).not.toHaveProperty('resumable');

    const inventory = await listDelegatedTasks('http://station.test');
    expect(inventory.tasks[0]).toMatchObject({
      taskId: legacyListItem.taskId,
      conversationId: legacyListItem.taskId,
      sessionId: legacyListItem.taskId,
      currentSessionId: legacyListItem.taskId,
      resumable: true,
    });
  });

  test('delegateTask forwards model options and workspace only inside the canonical target', async () => {
    const handle = {
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'dispatched',
      environment: { id: 'current', name: 'This Station', kind: 'current' },
      target: { kind: 'agent', id: 'codex' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: handle }));
    vi.stubGlobal('fetch', fetchMock);

    await delegateTask('http://station.test', {
      prompt: 'Ship it',
      target: {
        environment: { kind: 'current' },
        agent: agentId('codex'),
        workspace: { kind: 'directory', cwd: '/explicit/work/dir' },
        model: { options: { approvalMode: 'auto', effort: 'high' } },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'Ship it',
          target: {
            environment: { kind: 'current' },
            agent: 'codex',
            workspace: { kind: 'directory', cwd: '/explicit/work/dir' },
            model: { options: { approvalMode: 'auto', effort: 'high' } },
          },
        }),
      }),
    );
  });

  test('continueDelegatedTask forwards modelOptions in the request body (#978)', async () => {
    const handle = {
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'dispatched',
      environment: { id: 'current', name: 'This Station', kind: 'current' },
      target: { kind: 'agent', id: 'codex' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: handle }));
    vi.stubGlobal('fetch', fetchMock);

    await continueDelegatedTask('http://station.test', 'task:1', {
      message: 'Keep going',
      modelOptions: { thinking: true },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/task%3A1/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          message: 'Keep going',
          modelOptions: { thinking: true },
        }),
      }),
    );
  });

  test('discoverDelegationOptions posts to /delegations/options', async () => {
    const options = {
      environment: { id: 'env-remote', name: 'Remote', kind: 'ssh' },
      targets: [],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: options }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      discoverDelegationOptions('http://station.test', {
        environmentId: 'env-remote',
      }),
    ).resolves.toEqual(options);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/options',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ environmentId: 'env-remote' }),
      }),
    );
  });

  test('observeDelegatedTask reads /delegations/:taskId with the environment query', async () => {
    const snapshot = {
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'running',
      environment: { id: 'env-1', name: 'Env 1', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
      eventCount: 2,
      canInterrupt: true,
      resumable: true,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: snapshot }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      observeDelegatedTask('http://station.test', 'task:1', {
        environmentId: 'env-1',
      }),
    ).resolves.toMatchObject(snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/task%3A1?environmentId=env-1',
      { method: 'GET' },
    );
  });

  test('observeDelegatedTask omits the query string with no input', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { taskId: 'task:1' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await observeDelegatedTask('http://station.test', 'task:1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/task%3A1',
      { method: 'GET' },
    );
  });

  test('observeDelegatedTaskEvents reads a page via the opaque cursor, never a raw integer', async () => {
    const page = {
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'running',
      environment: { id: 'env-1', name: 'Env 1', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
      eventCount: 5,
      events: [],
      nextCursor: 'station-task-events:v1:5',
      hasMore: false,
      canInterrupt: true,
      resumable: true,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: page }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      observeDelegatedTaskEvents('http://station.test', 'task:1', {
        cursor: 'station-task-events:v1:2',
        limit: 25,
      }),
    ).resolves.toMatchObject(page);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/task%3A1/events?cursor=station-task-events%3Av1%3A2&limit=25',
      { method: 'GET' },
    );
  });

  test('continueDelegatedTask posts the follow-up message', async () => {
    const handle = {
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'dispatched',
      environment: { id: 'env-1', name: 'Env 1', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: handle }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      continueDelegatedTask('http://station.test', 'task:1', {
        message: 'Keep going',
      }),
    ).resolves.toMatchObject(handle);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/task%3A1/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'Keep going' }),
      }),
    );
  });

  test('normalizes legacy Station identity shapes for every supervision response', async () => {
    const legacy = {
      taskId: 'cli:legacy-1',
      sessionId: 'cli:legacy-1',
      status: 'dispatched',
      environment: { id: 'env-1', name: 'Env 1', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            ...legacy,
            status: 'completed',
            eventCount: 1,
            canInterrupt: false,
            resumable: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            ...legacy,
            eventCount: 1,
            events: [],
            nextCursor: 'station-task-events:v1:1',
            hasMore: false,
            canInterrupt: false,
            resumable: true,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: legacy }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            ...legacy,
            requestId: 'request-1',
            status: 'resolved',
            decision: 'accept',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            ...legacy,
            eventCount: 1,
            canInterrupt: false,
            resumable: false,
            interruptRequested: true,
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const outputs = await Promise.all([
      observeDelegatedTask('http://station.test', legacy.taskId),
      observeDelegatedTaskEvents('http://station.test', legacy.taskId),
      continueDelegatedTask('http://station.test', legacy.taskId, {
        message: 'Continue',
      }),
      respondToDelegatedTaskRequest('http://station.test', legacy.taskId, {
        requestId: 'request-1',
        decision: 'accept',
      }),
      interruptDelegatedTask('http://station.test', legacy.taskId),
    ]);

    for (const output of outputs) {
      expect(output).toMatchObject({
        taskId: legacy.taskId,
        conversationId: legacy.taskId,
        sessionId: legacy.sessionId,
        currentSessionId: legacy.sessionId,
      });
    }
  });

  test('respondToDelegatedTaskRequest posts the decision', async () => {
    const handle = {
      taskId: 'task:1',
      requestId: 'req-1',
      status: 'resolved',
      decision: 'accept',
      environment: { id: 'env-1', name: 'Env 1', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: handle }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      respondToDelegatedTaskRequest('http://station.test', 'task:1', {
        requestId: 'req-1',
        decision: 'accept',
      }),
    ).resolves.toMatchObject(handle);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/task%3A1/respond',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestId: 'req-1', decision: 'accept' }),
      }),
    );
  });

  test('interruptDelegatedTask always sends a JSON body, even with no input', async () => {
    const result = {
      taskId: 'task:1',
      status: 'running',
      environment: { id: 'env-1', name: 'Env 1', kind: 'current' },
      target: { kind: 'agent', id: 'station' },
      eventCount: 1,
      canInterrupt: true,
      resumable: true,
      interruptRequested: true,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: result }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      interruptDelegatedTask('http://station.test', 'task:1'),
    ).resolves.toMatchObject(result);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations/task%3A1/interrupt',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
  });

  test('listDelegatedTasks reads /delegations with environment and limit', async () => {
    const inventory = {
      environment: { id: 'env-1', name: 'Env 1', kind: 'current' },
      tasks: [],
      truncated: false,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { success: true, data: inventory }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listDelegatedTasks('http://station.test', {
        environmentId: 'env-1',
        limit: 10,
      }),
    ).resolves.toEqual(inventory);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/delegations?environmentId=env-1&limit=10',
      { method: 'GET' },
    );
  });

  test('listDelegatedTasks rejects a non-2xx envelope with the server error text', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(503, {
        success: false,
        error: 'Delegated task inventory is unavailable',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listDelegatedTasks('http://station.test')).rejects.toThrow(
      'Delegated task inventory is unavailable',
    );
  });
});
