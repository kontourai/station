/**
 * #2316: the inline approval card answers a Claude-adapter request through
 * orchestration `respondToRequest` — the SAME command the card's SDK call
 * (`resolveOrchestrationRequest`) posts to `/api/orchestration/commands`.
 *
 * Composes the REAL `ClaudeAdapter` (only the vendor SDK and host CLI probes
 * are stubbed) under the real `OrchestrationService` and event store, so the
 * request id travels the production path: `canUseTool` → published
 * `request.opened` → persisted event → `respondToRequest` dispatch → the SDK's
 * permission promise settles. The card used to post the id to
 * `/tool-approval/:id` instead, which only consults the ApprovalRegistry that
 * this adapter never registers with.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { toolRequestSessionGrantFromPayload } from '@kontourai/station-shared/tool-request-preview';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDiagnosticsRoutes } from '../../../routes/system/diagnostics.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  bindStationControlRequestAuthority,
  bindStationControlRequestCurrent,
} from '../../../security/station-control-request-authority.js';
import { stationControlCallerPrincipal } from '../../../tools/station-control-shared.js';
import { createLogger } from '../../../utils/logger.js';
import { DiagnosticsService } from '../../infra/diagnostics-service.js';
import { createServerLogReader } from '../../infra/server-log-reader.js';
import {
  gateMediatedMcpCall,
  resetPersonApprovedCalls,
} from '../../plugins/mediated-untrusted-content-gate.js';
import { sharedUntrustedContentLedger } from '../../plugins/untrusted-content-policy.js';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

// #2932: the adapter reads each permission ask off the engine's stdout. Its
// real spawn wrapper and tap run over a fake child, and `query` wraps
// `canUseTool` so each call here first gets a frame on that stdout.
vi.mock(
  '../../../providers/adapters/claude-code-spawn.js',
  async (importOriginal) => {
    const { fakeEngineProcessModule } = await import(
      '../../../providers/__tests__/claude-engine-process-test-utils.js'
    );
    return fakeEngineProcessModule(
      await importOriginal<
        typeof import('../../../providers/adapters/claude-code-spawn.js')
      >(),
    );
  },
);

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const { withRecordedClaudeAsks } = await import(
    '../../../providers/__tests__/claude-engine-process-test-utils.js'
  );
  return {
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    listSessions: vi.fn(),
    query: (args: { options?: unknown }) =>
      mockQuery(withRecordedClaudeAsks(args)),
  };
});

// Host CLI discovery and version probes: none of that is under test, and all
// of it would make the result depend on the developer's machine.
vi.mock('../../../providers/auth/cli-auth.js', () => ({
  augmentedSpawnEnv: vi.fn().mockResolvedValue(undefined),
  buildCliRuntimePrerequisites: vi.fn().mockResolvedValue([]),
  findCliBinaryAsync: vi.fn().mockResolvedValue(null),
  runCliCommand: vi.fn().mockResolvedValue(null),
}));

import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import { isConversationContinuationPending } from '../conversation-lineage.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

function createMockQuery() {
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * The session query's permission callback. The adapter also queries the SDK
 * for model discovery, so the session call is the one that carries it.
 */
function sessionCanUseTool() {
  return mockQuery.mock.calls
    .map((call) => call[0]?.options?.canUseTool)
    .find((candidate) => typeof candidate === 'function');
}

async function eventually<T>(
  read: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('#2316 inline approval card → Claude adapter', () => {
  let tmp: string;
  let eventStore: EventStore;
  let service: OrchestrationService;
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-inline-approval-'));
    mockQuery.mockReturnValue(createMockQuery());
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    adapter = new ClaudeAdapter();
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'claude' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(async () => {
    await adapter.stopSession('claude-inline').catch(() => undefined);
    mockQuery.mockReset();
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function openBashRequest(
    toolName = 'Bash',
    toolInput: Record<string, unknown> = { command: 'ls' },
    autoApprove: string[] = [],
    suggestions: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[] = [],
  ) {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: 'claude-inline',
          provider: 'claude',
          ...(autoApprove.length
            ? { agent: { slug: 'question-agent', autoApprove } }
            : {}),
        },
      },
      { userId: 'owner-user' },
    );
    const canUseTool = sessionCanUseTool();
    if (typeof canUseTool !== 'function') {
      throw new Error('the Claude adapter did not hand the SDK canUseTool');
    }
    const permission = canUseTool(toolName, toolInput, {
      signal: new AbortController().signal,
      toolUseID: 'toolu-inline-1',
      suggestions,
    });
    const opened = await eventually(() =>
      eventStore
        .listEvents('claude-inline')
        .map((persisted) => persisted.payload)
        .find((event) => event.method === 'request.opened'),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');
    return { permission, opened };
  }

  test('an all-scoped Claude edit answer preserves the recorded Ask mode', async () => {
    const threadId = 'claude-inline';
    service.recordApprovalModeDecision({
      threadId,
      provider: 'claude',
      approvalMode: 'ask',
      basedOnSequence: null,
    });
    const { permission, opened } = await openBashRequest(
      'Edit',
      { file_path: 'src/readme.md' },
      [],
      [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    );
    expect(toolRequestSessionGrantFromPayload(opened.payload)).toBe(
      'edit-mode',
    );
    expect(opened.payload).toHaveProperty('sessionGrantAll', true);
    await service.dispatchWithReceipt(
      {
        type: 'respondToRequest',
        threadId,
        requestId: opened.requestId,
        expectedRequestEventId: opened.eventId,
        decision: 'acceptForSession',
        sessionGrantScope: 'all',
      },
      { userId: 'owner-user', approvalModeAuthority: true },
    );
    await expect(permission).resolves.toMatchObject({
      behavior: 'allow',
      updatedPermissions: undefined,
    });
    const modeDecisions = eventStore
      .listEvents(threadId)
      .map(({ payload }) => payload)
      .filter((event) => event.method === 'session.approval-mode-set');
    expect(modeDecisions).toEqual([
      expect.objectContaining({ approvalMode: 'ask' }),
    ]);
  });

  test('wildcard approval never answers a question; validated answers reach the suspended SDK call', async () => {
    const input = {
      questions: [
        {
          question: 'Where should we deploy?',
          header: 'Deployment',
          multiSelect: true,
          options: [
            { label: 'Staging', description: 'Try first' },
            { label: 'Production', description: 'Release' },
          ],
        },
      ],
      answers: { 'Where should we deploy?': 'Engine-authored answer' },
    };
    const { permission, opened } = await openBashRequest(
      'AskUserQuestion',
      input,
      ['*'],
    );
    let settled = false;
    void permission.then(() => {
      settled = true;
    });
    expect(opened.payload?.inputRequest).toMatchObject({
      schema: 'station.input-request/v1',
      source: 'harness:claude',
      body: {
        kind: 'form',
        fields: [
          {
            name: '0',
            header: 'Deployment',
            kind: 'multi-choice',
            allowCustom: true,
            minItems: 1,
          },
        ],
      },
    });
    expect(settled).toBe(false);
    const command = {
      type: 'respondToRequest' as const,
      threadId: opened.threadId,
      requestId: opened.requestId,
      expectedRequestEventId: opened.eventId,
      decision: 'accept' as const,
    };
    await expect(service.dispatch(command)).rejects.toThrow(
      'Fill in the form before sending it.',
    );
    await expect(
      service.dispatch({ ...command, decision: 'acceptForSession' }),
    ).rejects.toThrow('Inspect the current request');
    await expect(
      service.dispatch({
        ...command,
        content: { '0': ['unknown'] },
      }),
    ).rejects.toThrow('must use only the offered choices');
    await expect(
      service.dispatch({
        ...command,
        expectedRequestEventId: 'stale-event',
        content: { '0': ['0'] },
      }),
    ).rejects.toThrow();
    expect(settled).toBe(false);
    expect(
      eventStore.readCurrentRequestEvent(opened.threadId, opened.requestId),
    ).toMatchObject({ state: 'found', event: { method: 'request.opened' } });
    await service.dispatch({
      ...command,
      content: { '0': ['0', { custom: 'A separate test environment' }] },
    });
    await expect(permission).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: {
          'Where should we deploy?': 'Staging, A separate test environment',
        },
      },
    });
    const canUseTool = sessionCanUseTool();
    await expect(
      canUseTool(
        'Bash',
        { command: 'pwd' },
        { signal: new AbortController().signal, suggestions: [] },
      ),
    ).resolves.toMatchObject({ behavior: 'allow' });
  });

  test('the respondToRequest command the card sends settles the SDK permission with the right decision', async () => {
    const { permission, opened } = await openBashRequest();
    // The persisted event carries everything the card needs to answer: the
    // request id, the session that minted it, and the exact call it gates.
    expect(opened).toMatchObject({
      threadId: 'claude-inline',
      payload: { toolName: 'Bash', toolCallId: 'toolu-inline-1' },
    });

    await service.dispatch({
      type: 'respondToRequest',
      threadId: opened.threadId,
      requestId: opened.requestId,
      decision: 'accept',
    });

    await expect(permission).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    await expect(
      eventually(() =>
        eventStore
          .listEvents('claude-inline')
          .map((persisted) => persisted.payload)
          .find(
            (event) =>
              event.method === 'request.resolved' &&
              event.requestId === opened.requestId,
          ),
      ),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  test("#3483: only a person's accept admits the approved MCP call at a Station seam, once", async () => {
    resetPersonApprovedCalls();
    sharedUntrustedContentLedger.markConversation(
      'claude-inline',
      Promise.resolve(true),
    );
    const gate = () =>
      gateMediatedMcpCall({
        conversationIds: ['claude-inline'],
        serverId: 'mail',
        toolNames: ['send_reply'],
        definition: async () => ({ id: 'mail', kind: 'mcp' }),
      });
    // A station-control call answering for the session owner (no person).
    const first = await openBashRequest('mcp__mail__send_reply', {});
    await service.dispatchWithReceipt({
      type: 'respondToRequest',
      threadId: first.opened.threadId,
      requestId: first.opened.requestId,
      decision: 'accept',
    });
    await first.permission;
    expect(await gate()).toMatchObject({ allowed: false });

    // The same tool asked again in this session; a person answers.
    const permission = (
      sessionCanUseTool() as (...args: unknown[]) => Promise<unknown>
    )(
      'mcp__mail__send_reply',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu-inline-2',
        suggestions: [],
      },
    );
    const opened = await eventually(() =>
      eventStore
        .listEvents('claude-inline')
        .map((persisted) => persisted.payload)
        .find(
          (event) =>
            event.method === 'request.opened' &&
            event.requestId !== first.opened.requestId,
        ),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');
    await service.dispatchWithReceipt(
      {
        type: 'respondToRequest',
        threadId: opened.threadId,
        requestId: opened.requestId,
        decision: 'accept',
      },
      { personAnswer: true },
    );
    await permission;
    expect(await gate()).toEqual({ allowed: true });
    expect(await gate()).toMatchObject({ allowed: false });
  });

  test('the card binds its answer to the exact prompt: the request event id is verified, a second answer finds it resolved', async () => {
    const { permission, opened } = await openBashRequest();

    // A decision naming a different prompt is refused before the adapter.
    await expect(
      service.dispatch({
        type: 'respondToRequest',
        threadId: opened.threadId,
        requestId: opened.requestId,
        expectedRequestEventId: 'not-the-prompt-the-user-saw',
        decision: 'accept',
      }),
    ).rejects.toThrow(/changed/);
    const settledEarly = await Promise.race([
      permission.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(settledEarly).toBe('pending');

    // The exact prompt is accepted: the live Claude request is open and
    // answerable, so every guard the event id turns on passes.
    await service.dispatch({
      type: 'respondToRequest',
      threadId: opened.threadId,
      requestId: opened.requestId,
      expectedRequestEventId: opened.eventId,
      decision: 'accept',
    });
    await expect(permission).resolves.toMatchObject({ behavior: 'allow' });

    // What the card reads when a second answer (toast + card) is refused:
    // the request itself says it is already resolved.
    await eventually(() =>
      eventStore
        .listEvents('claude-inline')
        .find((persisted) => persisted.payload.method === 'request.resolved'),
    );
    await expect(
      service.dispatch({
        type: 'respondToRequest',
        threadId: opened.threadId,
        requestId: opened.requestId,
        expectedRequestEventId: opened.eventId,
        decision: 'accept',
      }),
    ).rejects.toThrow();
    expect(
      service.inspectAttentionRequest(
        {
          threadId: opened.threadId,
          requestId: opened.requestId,
          requestEventId: opened.eventId,
        },
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).toMatchObject({ state: 'resolved' });
  });

  test('a decline through the same command denies the tool', async () => {
    const { permission, opened } = await openBashRequest();
    await service.dispatch({
      type: 'respondToRequest',
      threadId: opened.threadId,
      requestId: opened.requestId,
      decision: 'decline',
    });
    await expect(permission).resolves.toMatchObject({ behavior: 'deny' });
  });

  test('an answer for a request this session never opened is refused, not swallowed', async () => {
    await openBashRequest();
    await expect(
      service.dispatch({
        type: 'respondToRequest',
        threadId: 'claude-inline',
        requestId: 'not-a-real-request',
        decision: 'accept',
      }),
    ).rejects.toThrow(/not-a-real-request/);
  });

  test('a server log read resumes only after the owner answers its exact chat approval', async () => {
    const threadId = 'claude-inline';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'Check recent warnings' },
    });
    await eventually(() =>
      eventStore
        .listEvents(threadId)
        .find(({ payload }) => payload.method === 'turn.started'),
    );
    const controller = new AbortController();
    try {
      const read = service.requestServerLogRead(
        threadId,
        'Severity: warn',
        controller.signal,
      );
      const opened = eventStore.listEvents(threadId).at(-1)?.payload;
      if (opened?.method !== 'request.opened')
        throw new Error('Expected the log approval card');
      expect(opened).toMatchObject({
        title: 'Allow this server log query?',
        description: 'Severity: warn',
      });
      const answer = {
        type: 'respondToRequest',
        threadId,
        requestId: opened.requestId,
        expectedRequestEventId: opened.eventId,
        decision: 'accept',
      } as const;
      await expect(
        service.dispatchWithReceipt(answer, { personAnswer: true }),
      ).rejects.toThrow('The Station owner must answer');
      const owner = { serverLogReadDecisionAuthorized: () => true };
      await expect(
        service.dispatchWithReceipt(
          {
            ...answer,
            expectedRequestEventId: 'stale-event',
          },
          owner,
        ),
      ).rejects.toThrow();
      await service.dispatchWithReceipt(answer, owner);
      await expect(read).resolves.toBe(true);
      expect(eventStore.listEvents(threadId).at(-1)?.payload).toMatchObject({
        method: 'request.resolved',
        requestId: opened.requestId,
        status: 'approved',
      });
      await expect(
        service.dispatchWithReceipt(answer, owner),
      ).rejects.toThrow();
    } finally {
      controller.abort();
    }
  });

  test('session log approval returns redacted logs and expires when the session stops', async () => {
    const threadId = 'claude-inline';
    const otherThreadId = 'other-log-session';
    const controller = new AbortController();
    const logger = createLogger({
      name: 'session-log-approval-test',
      level: 'error',
    });
    const reader = createServerLogReader({ directory: tmp });
    writeFileSync(
      join(tmp, 'server-2026-08-01.ndjson'),
      `${JSON.stringify({
        timestamp: '2026-08-01T00:00:01.000Z',
        level: 'warn',
        msg: 'test log',
        config: { apiKey: 'private-log-canary' },
      })}\n`,
    );
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'internal',
        credential: 'test-internal',
        authority: undefined,
        source: 'bearer',
        locality: 'home-possession',
      });
      expect(bindRuntimeLocalOperator(c.req.raw)).toBe(true);
      bindStationControlRequestAuthority(c.req.raw, {
        kind: 'caller',
        boundOperator: true,
        caller: {
          sessionId: c.req.header('x-test-session') ?? threadId,
          assurance: 'bound',
          principal: stationControlCallerPrincipal(
            'owner-user',
            'session-owner',
          ),
        },
      });
      bindStationControlRequestCurrent(c.req.raw, () => true);
      await next();
    });
    app.route(
      '/',
      createDiagnosticsRoutes(new DiagnosticsService(tmp), logger, reader, {
        requestLogRead: service.requestServerLogRead.bind(service),
      }),
    );
    const read = (sessionId: string) =>
      app.request('/logs?level=warn', {
        headers: { 'x-test-session': sessionId },
        signal: controller.signal,
      });
    const approvals = (sessionId: string) =>
      eventStore
        .listEvents(sessionId)
        .map(({ payload }) => payload)
        .filter((event) => event.method === 'request.opened');
    const startTurn = async (sessionId: string) => {
      const previous = eventStore
        .listEvents(sessionId)
        .filter(({ payload }) => payload.method === 'turn.started').length;
      await service.dispatch({
        type: 'startSession',
        input: { threadId: sessionId, provider: 'claude' },
      });
      await service.dispatch({
        type: 'sendTurn',
        input: { threadId: sessionId, input: 'Check recent warnings' },
      });
      await eventually(() =>
        eventStore
          .listEvents(sessionId)
          .filter(({ payload }) => payload.method === 'turn.started').length >
        previous
          ? true
          : undefined,
      );
    };
    const owner = { serverLogReadDecisionAuthorized: () => true };
    try {
      await startTurn(threadId);
      const first = read(threadId);
      const opened = await eventually(() => approvals(threadId)[0]);
      expect(toolRequestSessionGrantFromPayload(opened.payload)).toBe('tool');
      const answer = {
        type: 'respondToRequest',
        threadId,
        requestId: opened.requestId,
        expectedRequestEventId: opened.eventId,
        decision: 'acceptForSession',
      } as const;
      await expect(
        service.dispatchWithReceipt(answer, {
          serverLogReadDecisionAuthorized: () => false,
        }),
      ).rejects.toThrow('The Station owner must answer');
      await expect(
        service.dispatchWithReceipt(
          {
            ...answer,
            expectedRequestEventId: 'stale-event',
          },
          owner,
        ),
      ).rejects.toThrow('The Station owner must answer');
      await service.dispatchWithReceipt(answer, owner);
      const firstResponse = await first;
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toMatchObject({
        entries: [{ config: { apiKey: '[REDACTED]' } }],
      });
      const second = await read(threadId);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        entries: [{ config: { apiKey: '[REDACTED]' } }],
      });
      expect(approvals(threadId)).toHaveLength(1);

      await startTurn(otherThreadId);
      const other = read(otherThreadId);
      const otherOpened = await eventually(() => approvals(otherThreadId)[0]);
      await service.dispatchWithReceipt(
        {
          ...answer,
          threadId: otherThreadId,
          requestId: otherOpened.requestId,
          expectedRequestEventId: otherOpened.eventId,
          decision: 'decline',
        },
        owner,
      );
      expect((await other).status).toBe(403);

      await service.dispatch({ type: 'stopSession', threadId });
      expect((await read(threadId)).status).toBe(403);
      await startTurn(threadId);
      const restarted = read(threadId);
      const restartedOpened = await eventually(() => approvals(threadId)[1]);
      if (!restartedOpened.turnId) throw new Error('Expected an active turn');
      eventStore.appendEvent({
        eventId: 'end-restarted-log-turn',
        threadId,
        turnId: restartedOpened.turnId,
        provider: 'claude',
        method: 'turn.aborted',
        reason: 'interrupted',
        createdAt: new Date().toISOString(),
      });
      await expect(
        service.dispatchWithReceipt(
          {
            ...answer,
            requestId: restartedOpened.requestId,
            expectedRequestEventId: restartedOpened.eventId,
          },
          owner,
        ),
      ).rejects.toThrow('This request ended with the turn that asked it');
      controller.abort();
      expect((await restarted).status).toBe(403);
    } finally {
      controller.abort();
      await adapter.stopSession(otherThreadId);
    }
  });

  test('a reload during the pending approval reads as a wait on the active turn, not read-only', async () => {
    // The public start command records the conversation the open read
    // resolves; the bare adapter dispatch above does not.
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'claude-inline',
          provider: 'claude',
          metadata: { userId: 'owner-user' },
        },
      },
      { userId: 'owner-user' },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    // A conversation is listed by its Agent; the runtime stamps this on
    // configure (same fixture as the service suite's continuation tests).
    eventStore.appendEvent({
      eventId: 'claude-inline-configured',
      provider: 'claude',
      threadId: 'claude-inline',
      sessionId: 'claude-inline',
      method: 'session.configured',
      metadata: { userId: 'owner-user', agentSlug: 'station' },
      createdAt: new Date().toISOString(),
    } as never);
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: 'claude-inline', input: 'list the files' },
    });
    const canUseTool = sessionCanUseTool();
    void canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu-inline-2',
        suggestions: [],
      },
    );
    await eventually(() =>
      eventStore
        .listEvents('claude-inline')
        .find((persisted) => persisted.payload.method === 'request.opened'),
    );

    const detail = await service.readSession(
      'claude-inline',
      INTERNAL_SESSION_READ_SCOPE,
    );
    if (!detail) throw new Error('expected the session detail');
    expect(detail.session).toMatchObject({
      pendingReview: true,
      hasActiveTurn: true,
    });

    const open = await service.resolveConversationOpen(
      'claude-inline',
      sessionReadAuthorityFromRequest('owner-user', undefined, undefined),
    );
    expect(open).toMatchObject({
      status: 'resolved',
      canContinue: false,
      continuationPending: true,
    });

    // The protection stays for everything that is NOT a live turn paused on
    // the user: no active turn, a read-only attachment, an unanswerable child.
    for (const session of [
      { ...detail.session, hasActiveTurn: false },
      { ...detail.session, controlMode: 'read-only-attached' as const },
      {
        ...detail.session,
        answerability: {
          answerable: false as const,
          qualification: 'provider_absent' as const,
          observedBy: 'claude-inline-approval-test',
          observedAt: '2026-09-22T00:00:00.000Z',
        },
      },
    ]) {
      expect(isConversationContinuationPending({ ...detail, session })).toBe(
        false,
      );
    }
  });
});
