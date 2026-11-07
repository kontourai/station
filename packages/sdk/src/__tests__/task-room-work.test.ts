import {
  TASK_ROOM_CONTEXT_VERSION,
  TASK_ROOM_WORK_VERSION,
} from '@kontourai/station-contracts/task-room-work';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  fetchTaskRoomAgentRequests,
  submitTaskRoomAgentRequest,
  TaskRoomWorkNotSentError,
} from '../client/task-room-work';

const input = {
  operationId: 'operation-1',
  agentId: 'researcher',
  prompt: 'Explore this idea',
};
const incarnation = '2026-09-30T12:00:00.000Z';
const record = {
  version: TASK_ROOM_WORK_VERSION,
  taskId: 'task-1',
  projectId: 'project-1',
  taskCreatedAt: incarnation,
  ...input,
  requesterId: 'task-room-requester:alice',
  sessionId: 'task:123',
  createdAt: incarnation,
  state: 'dispatched',
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
function sharedAuthority() {
  setClientCredentialResolver(() => ({
    origin: 'http://station.test',
    credential: 'test',
    requestAuthority: {
      apiBase: 'http://station.test',
      authorityKey: 'a',
      isCurrent: () => true,
    },
  }));
}

test('attachment acknowledgements accept reordered descriptor keys and reject changed fields', async () => {
  const attachment = {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    kind: 'image' as const,
    name: 'screen.png',
    mimeType: 'image/png' as const,
    size: 8,
  };
  let name = attachment.name;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/agent-requests')
        ? response({
            version: TASK_ROOM_WORK_VERSION,
            kind: 'available',
            records: [],
          })
        : response({
            kind: 'recorded',
            replayed: false,
            record: {
              ...record,
              attachments: [
                {
                  size: 8,
                  mimeType: 'image/png',
                  name,
                  kind: 'image',
                  id: attachment.id,
                },
              ],
            },
          }),
    ),
  );
  const submit = () =>
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      { ...input, attachments: [attachment] },
    );
  await expect(submit()).resolves.toMatchObject({ kind: 'recorded' });
  name = 'changed.png';
  await expect(submit()).rejects.toThrow('acknowledgement');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/agent-requests')
        ? response({
            version: TASK_ROOM_WORK_VERSION,
            kind: 'available',
            records: [],
          })
        : new Response(
            JSON.stringify({
              success: false,
              code: 'task_room_attachments_unavailable',
            }),
            { status: 409 },
          ),
    ),
  );
  await expect(submit()).rejects.toBeInstanceOf(TaskRoomWorkNotSentError);
});

test('an older Station never receives a delegation before version negotiation succeeds', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ kind: 'available', records: [] }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      input,
    ),
  ).rejects.toBeInstanceOf(TaskRoomWorkNotSentError);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe(
    'http://station.test/api/tasks/task-1/room/agent-requests',
  );
});

test.each([undefined, 'codex'])(
  'a room request sends exact execution binding %s and adopts a matching replay acknowledgement',
  async (executionAgentId) => {
    const model = executionAgentId
      ? {
          override: 'model-a',
          options: { reasoningEffort: 'high', nested: { b: 2, a: 1 } },
        }
      : undefined;
    const request = {
      ...input,
      ...(model ? { model } : {}),
      ...(executionAgentId
        ? {
            executionAgentId,
            expectedDefinitionFingerprint: `sha256:${'a'.repeat(64)}`,
          }
        : {}),
    };
    const recorded = {
      ...record,
      ...(model
        ? {
            modelId: 'model-a',
            modelOptionsDigest:
              'd1bea53ae92863831c08cbba45c23aceeb56fcc1151746376a30fd316a9a17ac',
          }
        : {}),
      ...(executionAgentId
        ? {
            executionAgentId,
            expectedDefinitionFingerprint: `sha256:${'a'.repeat(64)}`,
          }
        : {}),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/agent-requests')
        ? response({
            version: TASK_ROOM_WORK_VERSION,
            kind: 'available',
            records: [],
          })
        : response({ kind: 'recorded', record: recorded, replayed: true }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      submitTaskRoomAgentRequest(
        'http://station.test',
        'task-1',
        'demo',
        incarnation,
        request,
      ),
    ).resolves.toMatchObject({
      kind: 'recorded',
      replayed: true,
      record: recorded,
    });
    const write = fetcher.mock.calls[1];
    expect(write[0]).toBe('http://station.test/api/orchestration/delegations');
    expect(JSON.parse(String(write[1]?.body))).toEqual({
      prompt: input.prompt,
      target: {
        environment: { kind: 'current' },
        agent: executionAgentId
          ? {
              kind: 'agent-execution-override',
              agent: input.agentId,
              executionAgent: executionAgentId,
              expectedDefinitionFingerprint: `sha256:${'a'.repeat(64)}`,
            }
          : input.agentId,
        ...(model ? { model } : {}),
        workspace: { kind: 'project', projectSlug: 'demo' },
      },
      clientTurnId: input.operationId,
      taskRoomRequest: {
        taskId: 'task-1',
        taskCreatedAt: incarnation,
        operationId: input.operationId,
      },
    });
  },
);

test('cross-Task history and mismatched acknowledgements are rejected rather than adopted', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response({
      version: TASK_ROOM_WORK_VERSION,
      kind: 'available',
      records: [{ ...record, taskId: 'other-task' }],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    fetchTaskRoomAgentRequests('http://station.test', 'task-1'),
  ).rejects.toThrow('does not support');
  fetcher.mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
        })
      : response({
          kind: 'recorded',
          record: { ...record, operationId: 'other-operation' },
          replayed: false,
        }),
  );
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      input,
    ),
  ).rejects.toThrow('acknowledgement is unavailable');
});

test('context support is negotiated, the selected reference survives newer briefs, and mismatched receipts are rejected', async () => {
  const snapshot = {
    version: TASK_ROOM_CONTEXT_VERSION,
    digest: 'a'.repeat(64),
    title: 'Objective',
    description: '',
    documentRevision: 'revision-1',
    text: 'Selected brief.',
  };
  const intent = {
    ...input,
    context: { version: snapshot.version, digest: snapshot.digest },
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response({
      version: TASK_ROOM_WORK_VERSION,
      kind: 'available',
      records: [],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      intent,
    ),
  ).rejects.toBeInstanceOf(TaskRoomWorkNotSentError);
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockReset().mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: {
            ...snapshot,
            digest: 'b'.repeat(64),
            text: 'Newer brief.',
          },
        })
      : response({
          kind: 'recorded',
          replayed: true,
          record: { ...record, context: snapshot },
        }),
  );
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      intent,
    ),
  ).resolves.toMatchObject({ kind: 'recorded', replayed: true });
  expect(
    JSON.parse(String(fetcher.mock.calls[1][1]?.body)).taskRoomRequest.context,
  ).toEqual(intent.context);
  fetcher.mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: snapshot,
        })
      : response({
          kind: 'recorded',
          replayed: true,
          record: {
            ...record,
            context: { ...snapshot, digest: 'b'.repeat(64) },
          },
        }),
  );
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      intent,
    ),
  ).rejects.toThrow('acknowledgement');
});

test('an explicit context refusal is not sent while a lost acknowledgement stays uncertain', async () => {
  const context = {
    version: TASK_ROOM_CONTEXT_VERSION,
    digest: 'a'.repeat(64),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: null,
        })
      : new Response(
          JSON.stringify({
            success: false,
            data: { kind: 'refused', reason: 'context' },
          }),
          { status: 409 },
        ),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      { ...input, context },
    ),
  ).rejects.toThrow('Nothing was sent');
  fetcher.mockImplementation(async (url) => {
    if (String(url).endsWith('/agent-requests'))
      return response({
        version: TASK_ROOM_WORK_VERSION,
        kind: 'available',
        records: [],
        contextVersion: TASK_ROOM_CONTEXT_VERSION,
        context: null,
      });
    throw new Error('lost acknowledgement');
  });
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      { ...input, context },
    ),
  ).rejects.not.toBeInstanceOf(TaskRoomWorkNotSentError);
});

test('shared discovery refuses unsupported hosts before POST', async () => {
  sharedAuthority();
  const { submitSharedTaskRoomAgentRequest } = await import(
    '../client/task-room-work'
  );
  const { TASK_ROOM_SHARED_WORK_VERSION, TASK_ROOM_SHARED_CONTEXT_VERSION } =
    await import('@kontourai/station-contracts/task-room-work');
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const outcome = await submitSharedTaskRoomAgentRequest(
    'http://station.test',
    { projectId: 'project', taskId: 'task', taskCreatedAt: incarnation },
    {
      version: TASK_ROOM_SHARED_WORK_VERSION,
      expectedActorId: 'actor',
      taskCreatedAt: incarnation,
      operationId: 'op',
      agentId: 'agent',
      modelId: 'model',
      context: {
        version: TASK_ROOM_SHARED_CONTEXT_VERSION,
        brief: { documentRevision: 'rev', digest: 'a'.repeat(64) },
        results: [],
      },
      prompt: 'Hello',
      target: { kind: 'new-thread' },
    },
    {
      requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
      isCurrent: () => true,
    },
  );
  expect(outcome.kind).toBe('not-sent');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
});

test('shared acknowledgement binds intent and loss remains unconfirmed', async () => {
  sharedAuthority();
  const { submitSharedTaskRoomAgentRequest } = await import(
    '../client/task-room-work'
  );
  const {
    TASK_ROOM_SHARED_WORK_VERSION,
    TASK_ROOM_SHARED_CONTEXT_VERSION,
    TASK_ROOM_SHARED_RESULT_VERSION,
  } = await import('@kontourai/station-contracts/task-room-work');
  const scope = {
    projectId: 'project',
    taskId: 'task',
    taskCreatedAt: incarnation,
  };
  const input = {
    version: TASK_ROOM_SHARED_WORK_VERSION,
    expectedActorId: 'actor',
    taskCreatedAt: incarnation,
    operationId: 'op',
    agentId: 'agent',
    modelId: 'model',
    context: {
      version: TASK_ROOM_SHARED_CONTEXT_VERSION,
      brief: {
        documentRevision: 'rev',
        digest:
          'c8b4a62b09c7062ccdeedbddf83faf3e3ca772feaa15182d4671c07b65491384',
      },
      results: [],
    },
    prompt: 'Hello',
    target: { kind: 'new-thread' as const },
  };
  const brief = {
    version: TASK_ROOM_CONTEXT_VERSION,
    digest: 'c8b4a62b09c7062ccdeedbddf83faf3e3ca772feaa15182d4671c07b65491384',
    title: 'Title',
    description: '',
    documentRevision: 'rev',
    text: 'Brief',
  };
  const accepted = {
    kind: 'accepted',
    replayed: false,
    record: {
      version: TASK_ROOM_SHARED_WORK_VERSION,
      ...scope,
      operationId: 'op',
      requesterId: 'room-person',
      expectedActorId: 'actor',
      agentId: 'agent',
      modelId: 'model',
      inputDigest:
        'd9afb2994f4923e063ee3512ac137ff71bb225e7525f7ec50b3f16e304395c8d',
      context: {
        version: TASK_ROOM_SHARED_CONTEXT_VERSION,
        digest: 'b'.repeat(64),
        brief,
        results: [],
      },
      target: input.target,
      thread: {
        ...scope,
        conversationId: 'conversation',
        originSessionId: 'session',
      },
      state: 'waiting',
    },
  };
  const capability = {
    version: TASK_ROOM_SHARED_WORK_VERSION,
    kind: 'available',
    contextVersion: TASK_ROOM_SHARED_CONTEXT_VERSION,
    resultVersion: TASK_ROOM_SHARED_RESULT_VERSION,
    mode: 'model-only',
    nextTurn: 'durable',
    agents: [
      {
        agentId: 'agent',
        definitionFingerprint: `sha256:${'a'.repeat(64)}`,
        modelIds: ['model'],
      },
    ],
    context: brief,
  };
  let reply: unknown = accepted;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith('shared-capabilities'))
      return response(capability);
    if (reply === null) throw new Error('connection lost');
    return response(reply);
  });
  vi.stubGlobal('fetch', fetcher);
  expect(
    (
      await submitSharedTaskRoomAgentRequest(
        'http://station.test',
        scope,
        input,
        {
          requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
          isCurrent: () => true,
        },
      )
    ).kind,
  ).toBe('accepted');
  reply = {
    ...accepted,
    record: { ...accepted.record, inputDigest: 'c'.repeat(64) },
  };
  expect(
    (
      await submitSharedTaskRoomAgentRequest(
        'http://station.test',
        scope,
        input,
        {
          requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
          isCurrent: () => true,
        },
      )
    ).kind,
  ).toBe('unconfirmed');
  reply = {
    ...accepted,
    record: {
      ...accepted.record,
      context: {
        ...accepted.record.context,
        brief: { ...brief, text: 'Different brief' },
      },
    },
  };
  expect(
    (
      await submitSharedTaskRoomAgentRequest(
        'http://station.test',
        scope,
        input,
        {
          requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
          isCurrent: () => true,
        },
      )
    ).kind,
  ).toBe('unconfirmed');
  reply = { ...accepted, record: { ...accepted.record, taskId: 'other' } };
  expect(
    (
      await submitSharedTaskRoomAgentRequest(
        'http://station.test',
        scope,
        input,
        {
          requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
          isCurrent: () => true,
        },
      )
    ).kind,
  ).toBe('unconfirmed');
  reply = null;
  expect(
    await submitSharedTaskRoomAgentRequest(
      'http://station.test',
      scope,
      input,
      {
        requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
        isCurrent: () => true,
      },
    ),
  ).toEqual({ kind: 'unconfirmed', operationId: 'op', intent: input });
});

test('shared discovery propagates cancellation after dispatch and accepts an active signal', async () => {
  sharedAuthority();
  const { fetchSharedTaskRoomCapabilities } = await import(
    '../client/task-room-work'
  );
  const { TASK_ROOM_SHARED_WORK_VERSION } = await import(
    '@kontourai/station-contracts/task-room-work'
  );
  const controller = new AbortController();
  const cancellation = new DOMException('caller cancelled', 'AbortError');
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        dispatched();
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const options = {
    signal: controller.signal,
    requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
    isCurrent: () => true,
  };
  const pending = fetchSharedTaskRoomCapabilities(
    'http://station.test',
    'task',
    options,
  );
  await started;
  controller.abort(cancellation);
  await expect(pending).rejects.toBe(cancellation);
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockResolvedValueOnce(
    response({
      version: TASK_ROOM_SHARED_WORK_VERSION,
      kind: 'unavailable',
      reason: 'host',
    }),
  );
  const active = new AbortController();
  await expect(
    fetchSharedTaskRoomCapabilities('http://station.test', 'task', {
      ...options,
      signal: active.signal,
    }),
  ).resolves.toMatchObject({ kind: 'unavailable', reason: 'host' });
});

test('cancellation after shared POST remains unconfirmed', async () => {
  sharedAuthority();
  const { submitSharedTaskRoomAgentRequest } = await import(
    '../client/task-room-work'
  );
  const {
    TASK_ROOM_SHARED_WORK_VERSION,
    TASK_ROOM_SHARED_CONTEXT_VERSION,
    TASK_ROOM_SHARED_RESULT_VERSION,
  } = await import('@kontourai/station-contracts/task-room-work');
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith('shared-capabilities'))
      return response({
        version: TASK_ROOM_SHARED_WORK_VERSION,
        kind: 'available',
        contextVersion: TASK_ROOM_SHARED_CONTEXT_VERSION,
        resultVersion: TASK_ROOM_SHARED_RESULT_VERSION,
        mode: 'model-only',
        nextTurn: 'durable',
        agents: [
          {
            agentId: 'agent',
            definitionFingerprint: `sha256:${'a'.repeat(64)}`,
            modelIds: ['model'],
          },
        ],
        context: null,
      });
    controller.abort(new Error('cancelled after dispatch'));
    throw new Error('lost response');
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await submitSharedTaskRoomAgentRequest(
    'http://station.test',
    { projectId: 'project', taskId: 'task', taskCreatedAt: incarnation },
    {
      version: TASK_ROOM_SHARED_WORK_VERSION,
      expectedActorId: 'actor',
      taskCreatedAt: incarnation,
      operationId: 'op',
      agentId: 'agent',
      modelId: 'model',
      context: {
        version: TASK_ROOM_SHARED_CONTEXT_VERSION,
        brief: { documentRevision: 'rev', digest: 'a'.repeat(64) },
        results: [],
      },
      prompt: 'Hello',
      target: { kind: 'new-thread' },
    },
    {
      requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
      isCurrent: () => true,
      signal: controller.signal,
    },
  );
  expect(result).toMatchObject({
    kind: 'unconfirmed',
    operationId: 'op',
    intent: { operationId: 'op' },
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('shared lookup refuses a malformed record rather than reporting an empty result', async () => {
  sharedAuthority();
  const { fetchSharedTaskRoomRequests } = await import(
    '../client/task-room-work'
  );
  const { TASK_ROOM_SHARED_WORK_VERSION, TASK_ROOM_SHARED_CONTEXT_VERSION } =
    await import('@kontourai/station-contracts/task-room-work');
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ version: TASK_ROOM_SHARED_WORK_VERSION, records: [{}] }),
      ),
  );
  const scope = {
    projectId: 'project',
    taskId: 'task',
    taskCreatedAt: incarnation,
  };
  const request = {
    version: TASK_ROOM_SHARED_WORK_VERSION,
    expectedActorId: 'actor',
    taskCreatedAt: incarnation,
    operationId: 'op',
    agentId: 'agent',
    modelId: 'model',
    context: {
      version: TASK_ROOM_SHARED_CONTEXT_VERSION,
      brief: { documentRevision: 'rev', digest: 'a'.repeat(64) },
      results: [],
    },
    prompt: 'Hello',
    target: { kind: 'new-thread' as const },
  };
  await expect(
    fetchSharedTaskRoomRequests('http://station.test', scope, request, {
      requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
      isCurrent: () => true,
    }),
  ).rejects.toThrow('Invalid shared request record');
});

test('personal v1 context keeps accepting additive snapshot fields', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      response({
        version: TASK_ROOM_WORK_VERSION,
        kind: 'available',
        records: [],
        contextVersion: TASK_ROOM_CONTEXT_VERSION,
        context: {
          version: TASK_ROOM_CONTEXT_VERSION,
          digest: 'a'.repeat(64),
          title: 'Title',
          description: '',
          documentRevision: 'rev',
          text: 'Brief',
          futureField: 'ignored',
        },
      }),
    ),
  );
  const result = await fetchTaskRoomAgentRequests(
    'http://station.test',
    'task',
  );
  expect(result.context?.documentRevision).toBe('rev');
});

test('shared withdrawal sends the frozen Task and intent preconditions', async () => {
  sharedAuthority();
  const { withdrawSharedTaskRoomRequest } = await import(
    '../client/task-room-work'
  );
  const { TASK_ROOM_SHARED_WORK_VERSION, TASK_ROOM_SHARED_CONTEXT_VERSION } =
    await import('@kontourai/station-contracts/task-room-work');
  const scope = {
    projectId: 'project',
    taskId: 'task',
    taskCreatedAt: incarnation,
  };
  const request = {
    version: TASK_ROOM_SHARED_WORK_VERSION,
    expectedActorId: 'actor',
    taskCreatedAt: incarnation,
    operationId: 'op',
    agentId: 'agent',
    modelId: 'model',
    context: {
      version: TASK_ROOM_SHARED_CONTEXT_VERSION,
      brief: { documentRevision: 'rev', digest: 'a'.repeat(64) },
      results: [],
    },
    prompt: 'Hello',
    target: { kind: 'new-thread' as const },
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}));
  vi.stubGlobal('fetch', fetcher);
  const options = {
    requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
    isCurrent: () => true,
  };
  expect(
    (
      await withdrawSharedTaskRoomRequest(
        'http://station.test',
        scope,
        request,
        options,
      )
    ).kind,
  ).toBe('unconfirmed');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe(
    'http://station.test/api/tasks/task/room/agent-requests/shared/op',
  );
  expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE');
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    version: TASK_ROOM_SHARED_WORK_VERSION,
    expectedActorId: 'actor',
    ...scope,
    operationId: 'op',
    inputDigest:
      '9abed33a631e3318fa62e61c14fa6eb35a859f0eb980a1e3623e2c6ca459e4f2',
  });
  expect(
    (
      await withdrawSharedTaskRoomRequest(
        'http://station.test',
        { ...scope, taskCreatedAt: '2020-01-01T00:00:00.000Z' },
        request,
        options,
      )
    ).kind,
  ).toBe('not-sent');
  expect(fetcher).toHaveBeenCalledOnce();
});

test('shared result uses the captured publication reference throughout a delayed read', async () => {
  sharedAuthority();
  const { fetchSharedTaskRoomResult } = await import(
    '../client/task-room-work'
  );
  const { TASK_ROOM_SHARED_RESULT_VERSION } = await import(
    '@kontourai/station-contracts/task-room-work'
  );
  const scope = {
    projectId: 'project',
    taskId: 'task',
    taskCreatedAt: incarnation,
  };
  const reference = {
    ...scope,
    conversationId: 'conversation',
    originSessionId: 'origin',
    version: TASK_ROOM_SHARED_RESULT_VERSION,
    sessionId: 'session',
    turnId: 'turn',
    sequence: 2,
    proposalDigest: 'a'.repeat(64),
    contentDigest:
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  };
  const original = structuredClone(reference);
  let deliver!: (value: Response) => void;
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
    dispatched();
    return new Promise<Response>((resolve) => {
      deliver = resolve;
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const options = {
    requestScope: { apiBase: 'http://station.test', authorityKey: 'a' },
    isCurrent: () => true,
  };
  const pending = fetchSharedTaskRoomResult(
    'http://station.test',
    scope,
    reference,
    options,
  );
  await started;
  scope.taskId = 'other';
  reference.taskId = 'other';
  reference.contentDigest = 'b'.repeat(64);
  deliver(response({ reference: original, markdown: 'hello' }));
  await expect(pending).resolves.toBe('hello');
  expect(String(fetcher.mock.calls[0][0])).toContain(
    '/api/tasks/task/room/agent-results/session/turn?',
  );
  await expect(
    fetchSharedTaskRoomResult('http://station.test', scope, original, options),
  ).rejects.toThrow('Invalid shared result reference');
  let deliverChanged!: (value: Response) => void;
  let startChanged!: () => void;
  const changedStarted = new Promise<void>((resolve) => {
    startChanged = resolve;
  });
  fetcher.mockImplementationOnce(() => {
    startChanged();
    return new Promise<Response>((resolve) => {
      deliverChanged = resolve;
    });
  });
  const mutable = structuredClone(original);
  const task = { ...scope, taskId: 'task' };
  const retargeted = fetchSharedTaskRoomResult(
    'http://station.test',
    task,
    mutable,
    options,
  );
  await changedStarted;
  task.taskId = 'other';
  mutable.taskId = 'other';
  mutable.contentDigest =
    'd67e2e944994496c8d8ec76eed0cf9f09679448d584b532bebf941852a37f5ed';
  deliverChanged(response({ reference: mutable, markdown: 'changed' }));
  await expect(retargeted).rejects.toThrow('Invalid shared result');
  fetcher.mockResolvedValueOnce(
    response({ reference: original, markdown: 'changed' }),
  );
  await expect(
    fetchSharedTaskRoomResult(
      'http://station.test',
      { ...scope, taskId: 'task' },
      original,
      options,
    ),
  ).rejects.toThrow('digest mismatch');
});
