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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  query: mockQuery,
}));

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

  async function openBashRequest() {
    await service.dispatch(
      {
        type: 'startSession',
        input: { threadId: 'claude-inline', provider: 'claude' },
      },
      { userId: 'owner-user' },
    );
    const canUseTool = sessionCanUseTool();
    if (typeof canUseTool !== 'function') {
      throw new Error('the Claude adapter did not hand the SDK canUseTool');
    }
    const permission = canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu-inline-1',
        suggestions: [],
      },
    );
    const opened = await eventually(() =>
      eventStore
        .listEvents('claude-inline')
        .map((persisted) => persisted.payload)
        .find((event) => event.method === 'request.opened'),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');
    return { permission, opened };
  }

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
