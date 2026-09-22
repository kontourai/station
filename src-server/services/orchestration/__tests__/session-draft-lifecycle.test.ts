import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import type { ProviderSession } from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { receiptBus } from '../../infra/receipt-bus.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * #2310 — a session nothing has been sent to is a DRAFT, derived on the
 * server so every device agrees, and derived over the conversation's LINEAGE
 * rather than one thread's events.
 *
 * The fixture events copy the byte shapes the nightly home recorded for
 * `grok-build:1790099828990` on 2026-09-22 (ids, paths and the environment id
 * replaced): `session.started`, 31 `_x.ai` `extension.notification`s,
 * `session.configured`, `policy.hooks-attached` — and no turn, ever. The same
 * home also held the shape that makes lineage load-bearing: two continuation
 * children with zero `turn.started` of their own inside conversations with 3
 * and 4 turns. A per-thread fold labels both of those Draft.
 */

const ROOT = 'grok-build:1790099828990';
const CREATED = '2026-09-22T17:58:14.194Z';
const OWNER = 'human:local:operator';

const logger = { debug: () => {}, warn: () => {} };

function metadata(conversationId: string, extra: Record<string, unknown> = {}) {
  return {
    agentId: 'grok-build',
    agentSlug: 'grok-build',
    targetKind: 'agent',
    targetId: 'grok-build',
    connectionId: 'grok-build',
    projectSlug: 'example-project',
    workspaceIsolation: { mode: 'shared' },
    userId: OWNER,
    conversationId,
    environmentId: 'env-test',
    modelLaunchPlan: { kind: 'engine-selected', evidence: 'adapter-declared' },
    ...extra,
  };
}

function registry(): IProviderAdapterRegistry {
  return {
    register() {},
    get() {
      return undefined;
    },
    list() {
      return [];
    },
  };
}

describe('Draft lifecycle derivation (#2310)', () => {
  let dir: string;
  let store: EventStore;
  let sequence = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-draft-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
    sequence = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    receiptBus.resetForTest();
  });

  function at(offsetMs: number): string {
    return new Date(Date.parse(CREATED) + offsetMs).toISOString();
  }

  function append(event: Record<string, unknown>): void {
    sequence += 1;
    store.appendEvent({
      eventId: `evt-${sequence}`,
      provider: 'acp',
      createdAt: at(sequence * 10),
      ...event,
    } as unknown as CanonicalRuntimeEvent);
  }

  function upsert(
    threadId: string,
    extra: Partial<ProviderSession> = {},
  ): ProviderSession {
    const session = {
      provider: 'acp',
      threadId,
      status: 'ready',
      createdAt: CREATED,
      updatedAt: at(1_000),
      ...extra,
    } as ProviderSession;
    store.upsertSession(session);
    return session;
  }

  /** The recorded never-prompted ACP session, event for event. */
  function seedNeverPrompted(
    threadId: string,
    conversationId = threadId,
    extraMetadata: Record<string, unknown> = {},
  ): void {
    append({
      threadId,
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
      metadata: metadata(conversationId, extraMetadata),
    });
    for (let index = 0; index < 31; index += 1) {
      append({
        threadId,
        method: 'extension.notification',
        namespace: '_x.ai',
        type: index % 2 === 0 ? 'mcp/server_status' : 'session/setup',
        payload:
          index % 2 === 0
            ? {
                sessionId: 'engine-session',
                name: 'knowledge',
                source: 'local',
                status: 'unavailable',
                reason: 'handshake_failed',
                tools: null,
              }
            : { method: 'session/new', phase: 'auth', sessionId: null },
      });
    }
    append({
      threadId,
      method: 'session.configured',
      sessionId: threadId,
      model: 'grok-4.7',
      cwd: '/workspace/example',
      metadata: metadata(conversationId, {
        ...extraMetadata,
        effectiveModel: 'grok-4.7',
        reportedModel: 'grok-4.7',
      }),
    });
    append({
      threadId,
      method: 'policy.hooks-attached',
      cwd: '/workspace/example',
      profile: 'standard',
      engine: 'native',
    });
  }

  function turn(threadId: string, turnId: string): void {
    append({
      threadId,
      method: 'turn.started',
      turnId,
      prompt: `prompt for ${turnId}`,
    });
    append({ threadId, method: 'turn.completed', turnId });
  }

  /** What the list route builds for one thread, lineage consulted. */
  function summaryFor(threadId: string, session: ProviderSession) {
    return buildOrchestrationSessionSummary({
      persisted: session,
      events: store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload),
      conversationTurnObserved: store.conversationTurnObserved(threadId),
      answerability: { answerable: true } as never,
    });
  }

  async function service(): Promise<OrchestrationService> {
    const instance = new OrchestrationService({
      adapterRegistry: registry(),
      eventBus: new EventBus(),
      eventStore: store,
      logger,
    });
    instance.initialize();
    await awaitSessionAttachmentSettled(instance);
    return instance;
  }

  test('the recorded never-prompted session is a Draft', () => {
    const session = upsert(ROOT);
    seedNeverPrompted(ROOT);

    const summary = summaryFor(ROOT, session);
    expect(summary.hasActiveTurn).toBe(false);
    expect(summary.draft).toBe(true);
  });

  test('its first turn.started ends the Draft', () => {
    const session = upsert(ROOT);
    seedNeverPrompted(ROOT);
    append({
      threadId: ROOT,
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'first prompt',
    });

    const summary = summaryFor(ROOT, session);
    expect(summary.hasActiveTurn).toBe(true);
    expect(summary.draft).toBe(false);
  });

  test('a continuation child with no turn of its own is not a Draft when the conversation has turns', () => {
    const root = upsert(ROOT);
    seedNeverPrompted(ROOT);
    turn(ROOT, 'turn-1');
    turn(ROOT, 'turn-2');
    const child = `${ROOT}:session:3329a9d6-acde-4143-8421-b0b99bf6f0da`;
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: child,
      createdAt: at(5_000),
    });
    const childSession = upsert(child, { createdAt: at(5_000) });
    seedNeverPrompted(child, ROOT);

    // The discriminating fact: the child's own log has no turn at all.
    expect(
      store
        .listSessionProjectionEvents(child)
        .some((event) => event.method === 'turn.started'),
    ).toBe(false);
    expect(summaryFor(child, childSession).draft).toBe(false);
    expect(summaryFor(ROOT, root).draft).toBe(false);
  });

  test('a root whose turns all ran in children is not a Draft', () => {
    const root = upsert(ROOT);
    seedNeverPrompted(ROOT);
    const child = `${ROOT}:session:6acdd623-1420-4a50-8f54-e804f66a07b2`;
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: child,
      createdAt: at(5_000),
    });
    const childSession = upsert(child, { createdAt: at(5_000) });
    seedNeverPrompted(child, ROOT);
    turn(child, 'turn-1');

    expect(
      store
        .listSessionProjectionEvents(ROOT)
        .some((event) => event.method === 'turn.started'),
    ).toBe(false);
    expect(summaryFor(ROOT, root).draft).toBe(false);
    expect(summaryFor(child, childSession).draft).toBe(false);
  });

  test('a conversation that never ran a turn in ANY session is still a Draft', () => {
    // Guards the other direction: lineage must not blanket-exclude children.
    const root = upsert(ROOT);
    seedNeverPrompted(ROOT);
    const child = `${ROOT}:session:0f0f0f0f-0000-4000-8000-000000000000`;
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: child,
      createdAt: at(5_000),
    });
    const childSession = upsert(child, { createdAt: at(5_000) });
    seedNeverPrompted(child, ROOT);

    expect(summaryFor(ROOT, root).draft).toBe(true);
    expect(summaryFor(child, childSession).draft).toBe(true);
  });

  describe('sessions that carry history without a local turn are never Drafts', () => {
    test('read-only attached (followed from another app)', () => {
      const session = upsert(ROOT, {
        controlMode: 'read-only-attached',
        attachedSource: {
          kind: 'claude-code',
          externalSessionId: 'external-1',
        } as never,
      });
      seedNeverPrompted(ROOT);
      expect(summaryFor(ROOT, session).draft).toBe(false);
    });

    test('adopted continuation of an attached session', () => {
      const session = upsert(ROOT, {
        continuationSourceThreadId: 'claude-code:attached-source',
      });
      seedNeverPrompted(ROOT);
      expect(summaryFor(ROOT, session).draft).toBe(false);
    });

    test('Station-dispatched delegation, whose prompt exists by construction', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT, ROOT, { taskId: 'task-42' });
      expect(summaryFor(ROOT, session).draft).toBe(false);
    });
  });

  test('without the lineage read, no Draft claim is made', () => {
    const session = upsert(ROOT);
    seedNeverPrompted(ROOT);
    const summary = buildOrchestrationSessionSummary({
      persisted: session,
      events: store
        .listSessionProjectionEvents(ROOT)
        .map((event) => event.payload),
      answerability: { answerable: true } as never,
    });
    expect('draft' in summary).toBe(false);
  });

  test('the batched lineage read answers every thread, in one call', () => {
    upsert(ROOT);
    seedNeverPrompted(ROOT);
    const other = 'grok-build:1789746816232';
    upsert(other);
    seedNeverPrompted(other);
    turn(other, 'turn-1');

    const batched = store.conversationTurnObservedForThreads([
      ROOT,
      other,
      'never-persisted',
    ]);
    expect(Object.fromEntries(batched)).toEqual({
      [ROOT]: false,
      [other]: true,
      'never-persisted': false,
    });
  });

  test('the list route carries the lineage-aware answer', async () => {
    upsert(ROOT);
    seedNeverPrompted(ROOT);
    turn(ROOT, 'turn-1');
    const child = `${ROOT}:session:3329a9d6-acde-4143-8421-b0b99bf6f0da`;
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: child,
      createdAt: at(5_000),
    });
    upsert(child, { createdAt: at(5_000) });
    seedNeverPrompted(child, ROOT);
    const fresh = 'grok-build:1790099999999';
    upsert(fresh);
    seedNeverPrompted(fresh);

    const instance = await service();
    const sessions = await instance.listSessionReadModel(
      INTERNAL_SESSION_READ_SCOPE,
    );
    const draftOf = (threadId: string) =>
      sessions.find((session) => session.threadId === threadId)?.draft;
    expect(draftOf(ROOT)).toBe(false);
    expect(draftOf(child)).toBe(false);
    expect(draftOf(fresh)).toBe(true);

    // The detail route agrees with the list for the discriminating child.
    const detail = await instance.readSession(
      child,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.draft).toBe(false);
    const freshDetail = await instance.readSession(
      fresh,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(freshDetail?.session.draft).toBe(true);
  });
});
