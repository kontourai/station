import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionAttentionDisposition } from '@kontourai/station-contracts/session-attention';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import type { ProviderSession } from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { receiptBus } from '../../infra/receipt-bus.js';
import { buildSessionFailedItem } from '../../projects/attention-projection.js';
import { EventBus } from '../event-bus.js';
import { type CommandRefusalPhase, EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * #2310 — a session nothing has been sent to is a DRAFT, derived on the
 * server so every device computes the same answer from the same read, and
 * derived over the conversation's LINEAGE rather than one thread's events.
 *
 * The fixture events copy the byte shapes the nightly home recorded for
 * `grok-build:1790099828990` on 2026-09-22 (ids, paths and the environment id
 * replaced): `session.started`, 31 `_x.ai` `extension.notification`s,
 * `session.configured`, `policy.hooks-attached` — and no turn, ever. The
 * recorded thread ALSO held three failed `sendTurn` receipts, which makes it
 * Failed, not a Draft (review M1); the event sequence alone is the Draft
 * case, and both are tested below. The same
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
      conversationDraftFacts: store.conversationDraftFacts(threadId),
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

    const batched = store.conversationDraftFactsForThreads([
      ROOT,
      other,
      'never-persisted',
    ]);
    const none = {
      activityObserved: false,
      sendAccepted: false,
      sendRejected: false,
      sendFailed: false,
      hasCopiedHistory: false,
    };
    expect(Object.fromEntries(batched)).toEqual({
      [ROOT]: none,
      [other]: { ...none, activityObserved: true },
      'never-persisted': none,
    });
  });

  function receipt(
    threadId: string,
    status: 'accepted' | 'rejected' | 'failed',
    n: number,
    refusalPhase?: CommandRefusalPhase,
  ): void {
    store.appendCommandReceipt(
      {
        commandId: `cmd-${threadId}-${n}`,
        threadId,
        commandType: 'sendTurn',
        status,
        createdAt: at(2_000 + n),
      },
      refusalPhase ? { refusalPhase } : {},
    );
  }

  const REFUSED = 'Station refused the send before it started.';
  const FAILED = 'The send failed and no activity has been recorded since.';

  describe('a send was attempted (review M1, F1, F2, F3, F5)', () => {
    // The nightly home recorded exactly this for grok-build:1790099828990:
    // one accepted startSession, then three FAILED sendTurn receipts and no
    // activity, ever. `failed` is written for a genuinely indeterminate send
    // too (the provider may have accepted it), so the wording never says
    // "nothing ran".
    test('failed sends with no activity since read Failed, with the reason on every surface', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      receipt(ROOT, 'failed', 1);
      receipt(ROOT, 'failed', 2);
      receipt(ROOT, 'failed', 3);

      const summary = summaryFor(ROOT, session);
      expect(summary.draft).toBe(false);
      // The event fold is left alone: control paths read it as runtime truth.
      expect(summary.lifecycleState).toBe('queued');
      expect(summary.terminalAttribution).toEqual({
        kind: 'send_failed',
        detail: FAILED,
      });
      // F1: the dock banner / session detail read `blockedReason`...
      expect(summary.blockedReason).toBe(FAILED);
      // ...and the shared fold every label and the bell use reads Failed.
      expect(sessionAttentionDisposition(summary)).toEqual({ state: 'failed' });
      // F1: the bell item carries the reason as its body.
      expect(buildSessionFailedItem(summary).body).toBe(FAILED);
    });

    test('an execution-phase rejection reads "refused", and outranks a failure for the wording', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      receipt(ROOT, 'failed', 1);
      receipt(ROOT, 'rejected', 2, 'execution');
      const summary = summaryFor(ROOT, session);
      expect(summary.terminalAttribution).toEqual({
        kind: 'send_refused',
        detail: REFUSED,
      });
      expect(summary.blockedReason).toBe(REFUSED);
    });

    test('an authorization refusal, or a rejection with no recorded phase, changes nothing (F3)', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      receipt(ROOT, 'rejected', 1, 'authorization');
      receipt(ROOT, 'rejected', 2);
      const summary = summaryFor(ROOT, session);
      expect(summary.draft).toBe(true);
      expect(summary.terminalAttribution).toBeUndefined();
      expect(summary.blockedReason).toBeUndefined();
    });

    test('a caller who cannot read the session cannot flip its Draft to Failed (F3, real dispatch)', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      const instance = await service();

      await expect(
        instance.dispatch(
          { type: 'sendTurn', input: { threadId: ROOT, input: 'hello' } },
          { userId: 'human:local:someone-else' },
        ),
      ).rejects.toThrow(`Session not found: ${ROOT}`);
      // The refusal WAS recorded — the guard is in what counts, not in
      // whether the receipt exists.
      expect(
        store
          .listCommandReceipts(ROOT)
          .filter((entry) => entry.commandType === 'sendTurn')
          .map((entry) => entry.status),
      ).toEqual(['rejected']);

      const sessions = await instance.listSessionReadModel(
        INTERNAL_SESSION_READ_SCOPE,
      );
      const owner = sessions.find((entry) => entry.threadId === ROOT);
      expect(owner?.draft).toBe(true);
      expect(owner?.terminalAttribution).toBeUndefined();
    });

    test('an accepted send ends the Draft without claiming a failure', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      receipt(ROOT, 'failed', 1);
      receipt(ROOT, 'accepted', 2);
      const summary = summaryFor(ROOT, session);
      expect(summary.draft).toBe(false);
      expect(summary.terminalAttribution).toBeUndefined();
      expect(summary.blockedReason).toBeUndefined();
    });

    test('activity landing after a failed send clears the failure (F2)', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      receipt(ROOT, 'failed', 1);
      expect(summaryFor(ROOT, session).terminalAttribution?.kind).toBe(
        'send_failed',
      );
      // The indeterminate send had in fact reached the provider.
      append({
        threadId: ROOT,
        method: 'turn.started',
        turnId: 'late-turn',
        prompt: 'the send that looked failed',
      });
      const summary = summaryFor(ROOT, session);
      expect(summary.draft).toBe(false);
      expect(summary.terminalAttribution).toBeUndefined();
      expect(summary.blockedReason).toBeUndefined();
      expect(sessionAttentionDisposition(summary).state).toBe('active');
    });

    test('a refused send in a conversation that already ran turns changes nothing', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      turn(ROOT, 'turn-1');
      receipt(ROOT, 'rejected', 1, 'execution');
      const summary = summaryFor(ROOT, session);
      expect(summary.draft).toBe(false);
      expect(summary.lifecycleState).toBe('idle');
      expect(summary.terminalAttribution?.kind).not.toBe('send_refused');
    });

    // F5: the fold's own outcome is never overwritten.
    test('a session the event fold already failed keeps its own cause', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      append({
        threadId: ROOT,
        method: 'runtime.error',
        message: 'engine boom',
      });
      receipt(ROOT, 'rejected', 1, 'execution');
      const summary = summaryFor(ROOT, session);
      expect(summary.lifecycleState).toBe('failed');
      expect(summary.terminalAttribution?.kind).not.toBe('send_refused');
      expect(summary.blockedReason).not.toBe(REFUSED);
    });

    test('a session the event fold already stopped stays finished, not Failed', () => {
      const session = upsert(ROOT);
      seedNeverPrompted(ROOT);
      append({
        threadId: ROOT,
        method: 'session.exited',
        exitKind: 'graceful',
        reason: 'user stop',
      });
      receipt(ROOT, 'failed', 1);
      const summary = summaryFor(ROOT, session);
      expect(summary.lifecycleState).toBe('canceled');
      expect(summary.terminalAttribution?.kind).not.toBe('send_failed');
      expect(sessionAttentionDisposition(summary).state).toBe('finished');
    });
  });

  // Verifier LOW: pin the turn.completed half of the turn facts. A log with a
  // turn.completed and no turn.started does not occur in real data today, so
  // this is a unit pin on both halves of the derivation: the thread's own
  // events, and the lineage read.
  test('a turn.completed alone is activity, on the thread and across the lineage', () => {
    const root = upsert(ROOT);
    seedNeverPrompted(ROOT);
    append({ threadId: ROOT, method: 'turn.completed', turnId: 'orphan' });
    const child = `${ROOT}:session:11111111-2222-4333-8444-555555555555`;
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: child,
      createdAt: at(5_000),
    });
    const childSession = upsert(child, { createdAt: at(5_000) });
    seedNeverPrompted(child, ROOT);

    expect(summaryFor(ROOT, root).draft).toBe(false);
    expect(summaryFor(child, childSession).draft).toBe(false);
  });

  test('a fork target carries copied messages and is never a Draft (review M2)', () => {
    const target = 'human:local:operator:fork:0123456789abcdef01234567';
    const session = upsert(target);
    seedNeverPrompted(target);
    store.appendEvent({
      eventId: 'conversation-fork:test',
      provider: 'station',
      threadId: 'grok-build:1789000000000',
      method: 'conversation.forked',
      sourceConversationId: 'grok-build:1789000000000',
      targetConversationId: target,
      targetAgent: 'grok-build',
      forkedAt: at(3_000),
      continuation: 'replay-seed',
      createdAt: at(3_000),
    } as never);
    // The fixture is the fact the fork route writes: the store's own fork
    // fold reads it as this conversation's origin.
    expect(
      store.readConversationForkProvenance(target).forkedFrom
        ?.targetConversationId,
    ).toBe(target);
    expect(summaryFor(target, session).draft).toBe(false);
  });

  // Review L4. The discriminating session is always the one with NO output
  // of its own, so only the lineage read can see the activity: the nightly
  // home's second lineage child streamed text and started a tool with no
  // turn.started anywhere nearby.
  describe.each([
    {
      family: 'content',
      output: {
        method: 'content.text-delta',
        turnId: 'unseen-turn',
        delta: 'partial output',
      },
    },
    {
      family: 'tool',
      output: {
        method: 'tool.started',
        turnId: 'unseen-turn',
        toolCallId: 'call-1',
        toolName: 'shell',
      },
    },
  ])(
    '$family output elsewhere in the lineage is activity (review L4)',
    ({ output }) => {
      test('a quiet child of a conversation whose only activity is that output is not a Draft', () => {
        upsert(ROOT);
        seedNeverPrompted(ROOT);
        append({ threadId: ROOT, ...output });
        const child = `${ROOT}:session:6acdd623-1420-4a50-8f54-e804f66a07b2`;
        store.reserveNextConversationSession({
          conversationId: ROOT,
          predecessorSessionId: ROOT,
          proposedSessionId: child,
          createdAt: at(5_000),
        });
        const childSession = upsert(child, { createdAt: at(5_000) });
        seedNeverPrompted(child, ROOT);

        // No turn fact anywhere, and none of the output is the child's own.
        expect(
          store
            .listSessionProjectionEvents(child)
            .some((event) => /^(turn|content|tool)\./.test(event.method)),
        ).toBe(false);
        expect(summaryFor(child, childSession).draft).toBe(false);
      });
    },
  );

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

    // The event-window and event-page reads (session-event-reads.ts) carry
    // the same lineage-aware answer — the child has no activity of its own.
    const childWindow = await instance.readSessionEventWindow(child, {
      turnLimit: 5,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });
    expect(childWindow?.session.draft).toBe(false);
    const freshWindow = await instance.readSessionEventWindow(fresh, {
      turnLimit: 5,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });
    expect(freshWindow?.session.draft).toBe(true);
    const childPage = await instance.readSessionEventPage(child, {
      afterSequence: 0,
      limit: 5,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });
    expect(childPage?.session.draft).toBe(false);
  });
  /**
   * #2312: discarding a Draft is a SERVER action, so every device agrees —
   * the next session-list read anywhere no longer returns it. The server
   * re-derives the Draft fact itself and refuses anything else.
   */
  describe('discardDraft (#2312)', () => {
    const SOMEONE_ELSE = 'human:local:someone-else';
    const ownerRead = () =>
      sessionReadAuthorityFromRequest(OWNER, undefined, undefined);

    async function listedIds(
      instance: OrchestrationService,
    ): Promise<string[]> {
      return (await instance.listSessionReadModel(ownerRead())).map(
        (session) => session.threadId,
      );
    }

    async function refusal(promise: Promise<unknown>) {
      return promise.then(
        () => {
          throw new Error('expected the discard to be refused');
        },
        (error: unknown) => error as { message: string; code?: string },
      );
    }

    test('deletes the Draft for every reader: the owner, and a fresh process over the same store', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      const instance = await service();
      expect(await listedIds(instance)).toEqual([ROOT]);

      const { receipt: accepted } = await instance.dispatchWithReceipt(
        { type: 'discardDraft', threadId: ROOT },
        { userId: OWNER },
      );

      expect(accepted).toMatchObject({
        threadId: ROOT,
        commandType: 'discardDraft',
        status: 'accepted',
      });
      expect(await listedIds(instance)).toEqual([]);
      expect(await instance.readSession(ROOT, ownerRead())).toBeNull();
      // Another device is another read of the same store — a second service
      // instance proves nothing is left in memory that the list relied on.
      const otherDevice = await service();
      expect(await listedIds(otherDevice)).toEqual([]);
      expect(store.listSessionProjectionEvents(ROOT)).toEqual([]);
      // No conversation lineage is left naming the deleted Session.
      expect(store.conversationSessions(ROOT)).toEqual([]);
      // The discard itself stays on record.
      expect(
        store.listCommandReceipts(ROOT).map((entry) => entry.commandType),
      ).toEqual(['discardDraft']);
    });

    test('a caller who cannot read the session cannot discard it', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      const instance = await service();

      const error = await refusal(
        instance.dispatchWithReceipt(
          { type: 'discardDraft', threadId: ROOT },
          { userId: SOMEONE_ELSE },
        ),
      );

      expect(error.message).toBe(`Session not found: ${ROOT}`);
      expect(await listedIds(instance)).toEqual([ROOT]);
      const kept = (await instance.listSessionReadModel(ownerRead()))[0];
      expect(kept?.draft).toBe(true);
    });

    test('a session that took a turn is not a Draft and is not discarded', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      turn(ROOT, 'turn-1');
      const instance = await service();
      const eventsBefore = store.listSessionProjectionEvents(ROOT).length;

      const error = await refusal(
        instance.dispatchWithReceipt(
          { type: 'discardDraft', threadId: ROOT },
          { userId: OWNER },
        ),
      );

      expect(error.code).toBe('not_a_draft');
      expect(error.message).toContain('Only a Draft can be discarded');
      expect(await listedIds(instance)).toEqual([ROOT]);
      expect(store.listSessionProjectionEvents(ROOT)).toHaveLength(
        eventsBefore,
      );
      expect(
        store
          .listCommandReceipts(ROOT)
          .filter((entry) => entry.commandType === 'discardDraft')
          .map((entry) => entry.status),
      ).toEqual(['rejected']);
    });

    test('a first send that failed reads Failed, not Draft, and is not discarded', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      receipt(ROOT, 'failed', 1);
      const instance = await service();

      const error = await refusal(
        instance.dispatchWithReceipt(
          { type: 'discardDraft', threadId: ROOT },
          { userId: OWNER },
        ),
      );

      expect(error.code).toBe('not_a_draft');
      expect(await listedIds(instance)).toEqual([ROOT]);
    });

    test('a quiet child whose conversation ran turns elsewhere is not discarded', async () => {
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
      const instance = await service();

      const error = await refusal(
        instance.dispatchWithReceipt(
          { type: 'discardDraft', threadId: child },
          { userId: OWNER },
        ),
      );

      expect(error.code).toBe('not_a_draft');
      expect((await listedIds(instance)).sort()).toEqual([ROOT, child].sort());
    });

    test('a fork source is never discarded: the fork fact lives on its thread', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      append({
        threadId: ROOT,
        method: 'conversation.forked',
        sourceConversationId: ROOT,
        targetConversationId: 'fork-target',
        targetAgent: 'grok-build',
        forkedAt: at(9_000),
        continuation: 'replay-seed',
      });
      const instance = await service();
      // Fixture guard: the fork fact does not end the source's Draft.
      expect((await instance.listSessionReadModel(ownerRead()))[0]?.draft).toBe(
        true,
      );

      const error = await refusal(
        instance.dispatchWithReceipt(
          { type: 'discardDraft', threadId: ROOT },
          { userId: OWNER },
        ),
      );

      expect(error.code).toBe('not_a_draft');
      expect(await listedIds(instance)).toEqual([ROOT]);
    });

    // Verifier M3: every Session the discard deletes must pass the gate the
    // named one passed — and the refusal must not reveal the other Session.
    test('a successor owned by someone else stops the discard, answered as not found', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      const child = `${ROOT}:session:0f0f0f0f-0000-4000-8000-00000000beef`;
      store.reserveNextConversationSession({
        conversationId: ROOT,
        predecessorSessionId: ROOT,
        proposedSessionId: child,
        createdAt: at(5_000),
      });
      upsert(child, { createdAt: at(5_000) });
      seedNeverPrompted(child, ROOT, { userId: SOMEONE_ELSE });
      const instance = await service();

      const error = await refusal(
        instance.dispatchWithReceipt(
          { type: 'discardDraft', threadId: ROOT },
          { userId: OWNER },
        ),
      );

      expect(error.message).toBe(`Session not found: ${ROOT}`);
      expect(error.message).not.toContain(child);
      expect(error.code).toBeUndefined();
      expect(store.readSessionByThread(child)).toBeDefined();
      expect(store.readSessionByThread(ROOT)).toBeDefined();
    });

    // Verifier L4: a successor that was reserved but never started has no
    // history and no owner; it must not make the Draft undiscardable.
    test('a reserved successor that never started goes with the Draft', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      const reserved = `${ROOT}:session:0f0f0f0f-0000-4000-8000-00000000cafe`;
      store.reserveNextConversationSession({
        conversationId: ROOT,
        predecessorSessionId: ROOT,
        proposedSessionId: reserved,
        createdAt: at(5_000),
      });
      const instance = await service();
      // Fixture guard: the row still reads Draft and the lineage has both.
      expect((await instance.listSessionReadModel(ownerRead()))[0]?.draft).toBe(
        true,
      );
      expect(store.conversationSessions(ROOT)).toHaveLength(2);

      await instance.dispatchWithReceipt(
        { type: 'discardDraft', threadId: ROOT },
        { userId: OWNER },
      );

      expect(await listedIds(instance)).toEqual([]);
      expect(store.conversationSessions(ROOT)).toEqual([]);
    });

    // Verifier L5: the handoff and context-boundary records between deleted
    // Sessions go too.
    test('handoff and context-boundary records of the discarded conversation are removed', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      const successor = `${ROOT}:session:0f0f0f0f-0000-4000-8000-0000000b0001`;
      store.reserveConversationContextBoundary({
        boundaryId: 'boundary-draft',
        conversationId: ROOT,
        predecessorSessionId: ROOT,
        successorSessionId: successor,
        idempotencyKey: 'boundary-draft',
        policy: 'empty-next-cold-start',
        status: 'reserved',
        actorId: OWNER,
        createdAt: at(5_000),
      });
      store.reserveConversationHandoff({
        conversationId: ROOT,
        predecessorSessionId: successor,
        sessionId: `${successor}:handoff`,
        idempotencyKey: 'handoff-draft',
        targetAgentId: 'codex',
        targetEnvironmentId: 'env-test',
        messageDigest: 'digest-empty',
        createdAt: at(6_000),
      });
      // Fixture guard: both records exist before the discard.
      expect(store.listConversationContextBoundaries(ROOT)).toHaveLength(1);
      expect(store.listConversationHandoffs(ROOT)).toHaveLength(1);
      const instance = await service();

      await instance.dispatchWithReceipt(
        { type: 'discardDraft', threadId: ROOT },
        { userId: OWNER },
      );

      expect(store.listConversationContextBoundaries(ROOT)).toEqual([]);
      expect(store.listConversationHandoffs(ROOT)).toEqual([]);
      expect(await listedIds(instance)).toEqual([]);
    });

    test('a Draft conversation is discarded whole: no member is left naming a deleted Session', async () => {
      upsert(ROOT);
      seedNeverPrompted(ROOT);
      const child = `${ROOT}:session:0f0f0f0f-0000-4000-8000-000000000000`;
      store.reserveNextConversationSession({
        conversationId: ROOT,
        predecessorSessionId: ROOT,
        proposedSessionId: child,
        createdAt: at(5_000),
      });
      upsert(child, { createdAt: at(5_000) });
      seedNeverPrompted(child, ROOT);
      const instance = await service();

      await instance.dispatchWithReceipt(
        { type: 'discardDraft', threadId: child },
        { userId: OWNER },
      );

      expect(await listedIds(instance)).toEqual([]);
      expect(store.conversationSessions(ROOT)).toEqual([]);
    });
  });
});
