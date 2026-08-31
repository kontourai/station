import { mkdtempSync, rmSync } from 'node:fs';
import { vi as vitestConfigVi } from 'vitest';

// This file exercises REAL SQLite EventStores per test (one writes 401
// 3KB rows synchronously). Under full-corpus worker contention the default
// 5s budgets red these tests with hook-chain timeout shapes while every
// focused run is green — 4 of 5 corpus runs on a quiet host (archive#2654).
// The budget below prices the fs work honestly; no assertion changes.
vitestConfigVi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES } from '@kontourai/station-contracts/chat-attachment';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { readStreamUntil } from '../../../__test-utils__/sse-helpers.js';
import { ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD } from '../../../constants.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { createHostedTenantMiddleware } from '../../../runtime/bootstrap/runtime-tenant-context.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { AnswerAssessmentUnavailableError } from '../../../services/evidence/answer-assessment-module.js';
import {
  ContinuationWorkspaceError,
  executeForegroundMessage as executeResolvedForegroundMessage,
  ForegroundMessageIndeterminateError,
  ForegroundMessageTurnIdentityUnavailableError,
} from '../../../services/execution-target/execution-target-execution.js';
import { createServerLogReader } from '../../../services/infra/server-log-reader.js';
import {
  installServerLogSink,
  resetServerLogSinkForTests,
} from '../../../services/infra/server-log-store.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  EventStore,
  SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES,
} from '../../../services/orchestration/event-store.js';
import {
  AdoptionContinuationInProgressError,
  OrchestrationCommandDispatchError,
  OrchestrationService,
} from '../../../services/orchestration/orchestration-service.js';
import { ProjectWorktreeDirectoryError } from '../../../services/projects/project-service.js';
import {
  AnswerShareService,
  NO_CHANNEL_LOG_OBSERVER,
} from '../../../services/share/answer-share-service.js';
import type { AnswerShareStore } from '../../../services/share/answer-share-store.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';
import { createLogger } from '../../../utils/logger.js';
import { LOG_BINDING_KEYS } from '../../../utils/logger-correlation.js';
import {
  createOrchestrationRoutes,
  orchestrationEventMatchesThread,
  parseResumeCursor,
  resolveStreamResumePlan,
} from '../orchestration.js';

describe('direct Basis response revocation fence', () => {
  test('withholds every pre-await Basis field when authority is revoked during assessment I/O', async () => {
    let current = true;
    const outcome = {
      status: 'found' as const,
      sessionId: 'session-private',
      turnId: 'turn-private',
      observedAt: '2026-08-26T00:00:00.000Z',
      binding: {
        version: 'station-answer-binding/v1' as const,
        sessionId: 'session-private',
        turnId: 'turn-private',
        answer: {
          authority: '@kontourai/thread' as const,
          schemaVersion: '1.2.0' as const,
          kind: 'assistant-message' as const,
          standing: 'observed' as const,
          threadId: 'session-private',
          messageId: 'message-private',
        },
      },
      projectSlug: 'project-private',
      inputs: [
        {
          eventId: 'input-private',
          kind: 'initial' as const,
          prompt: 'PRIVATE_PROMPT_CANARY',
          attachments: [],
        },
      ],
      results: [],
    };
    const service = {
      sessionQueries: { readAnswerBasis: async () => outcome },
      canUserReadSession: () => true,
    };
    const app = createOrchestrationRoutes(service as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      isRequestPrincipalCurrent: () => current,
      answerAssessmentModule: {
        readExactAnswerAssessmentWithReviewedSource: async () => {
          current = false;
          return {
            assessment: {
              owner: { authority: '@kontourai/surface' },
              state: 'unavailable',
              observedAt: outcome.observedAt,
            },
          };
        },
      } as any,
    });
    const response = await app.request(
      '/sessions/session-private/turns/turn-private/basis',
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('PRIVATE_PROMPT_CANARY');
  });

  test('does not combine an R1 assessment with an association-only R2 source', async () => {
    let associationHead = 'R1';
    const read = vi.fn(async () => ({
      assessment: {
        owner: { authority: '@kontourai/surface' as const },
        state: 'not-captured' as const,
        observedAt: '2026-08-26T00:00:00.000Z',
      },
      reviewedSource: {
        revision: 1,
        artifactSha: 'a'.repeat(64),
        association: { exactRef: 'R1' },
        assessment: {} as never,
        evidence: {} as never,
        current: () => associationHead === 'R1',
      },
    }));
    const resolve = vi.fn(async (input: any) => {
      // Deterministic owner-await hook: the only changed R2 fact is the
      // reviewed-source association, after the R1 assessment was captured.
      associationHead = 'R2';
      return input.assessment.reviewedSource.current() ? {} : undefined;
    });
    const app = createOrchestrationRoutes(
      {
        sessionQueries: {
          readAnswerBasis: async () => ({
            status: 'found' as const,
            sessionId: 'session-a',
            turnId: 'turn-a',
            observedAt: '2026-08-26T00:00:00.000Z',
            projectSlug: 'project-a',
            binding: {
              version: 'station-answer-binding/v1' as const,
              sessionId: 'session-a',
              turnId: 'turn-a',
              answer: {
                authority: '@kontourai/thread' as const,
                schemaVersion: '1.2.0',
                kind: 'assistant-message' as const,
                standing: 'observed' as const,
                threadId: 'session-a',
                messageId: 'message-a',
              },
            },
            inputs: [],
            results: [],
          }),
        },
        canUserReadSession: () => true,
      } as any,
      {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        isRequestPrincipalCurrent: () => true,
        answerAssessmentModule: {
          readExactAnswerAssessmentWithReviewedSource: read,
        } as any,
        reviewedSourceBasisResolver: { read: resolve } as any,
      },
    );
    const response = await app.request(
      '/sessions/session-a/turns/turn-a/basis',
    );
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain('fieldwork');
  });

  test.each(['unavailable', 'corrupt'] as const)(
    'maps a %s durable answer projection to 503 without exposing its fields',
    async (status) => {
      const app = createOrchestrationRoutes(
        {
          sessionQueries: {
            readAnswerBasis: async () =>
              ({
                status,
                inputs: [{ prompt: 'DURABLE_ANSWER_CANARY' }],
              }) as any,
          },
        } as any,
        {
          getUserId: () => ROUTE_TEST_USER_ID,
          eventBus: new EventBus(),
          logger: { debug: vi.fn() },
          isRequestPrincipalCurrent: () => true,
        },
      );

      const response = await app.request(
        '/sessions/session-private/turns/turn-private/basis',
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe(
        JSON.stringify({ success: false, error: 'Basis unavailable' }),
      );
    },
  );
});

describe('answer narrative target durable-query boundary', () => {
  test.each(['unavailable', 'corrupt'] as const)(
    'maps a %s answer projection to 503 without calling the target owner',
    async (status) => {
      const readTarget = vi.fn();
      const app = createOrchestrationRoutes(
        {
          sessionQueries: {
            readAnswerBasis: async () =>
              ({ status, projectSlug: 'DURABLE_ANSWER_CANARY' }) as any,
          },
        } as any,
        {
          getUserId: () => ROUTE_TEST_USER_ID,
          eventBus: new EventBus(),
          logger: { debug: vi.fn() },
          isRequestPrincipalCurrent: () => true,
          answerNarrativeBindingModule: { readTarget } as any,
        },
      );

      const response = await app.request(
        '/sessions/session-private/turns/turn-private/narrative/target',
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe(
        JSON.stringify({ success: false, error: 'Narrative unavailable' }),
      );
      expect(readTarget).not.toHaveBeenCalled();
    },
  );
});

describe('answer assessment target route', () => {
  test('maps a corrupt protected assessment index to 503 instead of inventing revision zero', async () => {
    const outcome = {
      status: 'found' as const,
      sessionId: 'session-private',
      turnId: 'turn-private',
    };
    const app = createOrchestrationRoutes(
      { sessionQueries: { readAnswerBasis: async () => outcome } } as any,
      {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        isRequestPrincipalCurrent: () => true,
        answerAssessmentModule: {
          readTarget: () => {
            throw new AnswerAssessmentUnavailableError('corrupt index');
          },
        } as any,
      },
    );

    const response = await app.request(
      '/sessions/session-private/turns/turn-private/assessment/target',
    );
    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      success: false,
      error: 'Assessment unavailable',
    });
  });
});

describe('answer assessment producer route', () => {
  const reviewedSource = {
    version: 'station.reviewed-source-association/v1',
    pluginName: 'fieldwork-review',
    sourceClaimId: 'source-claim',
    sourceEvidenceId: 'source-evidence',
    answerClaimId: 'answer-claim',
    answerCitationEvidenceId: 'answer-citation',
    owner: '@kontourai/fieldwork',
    runId: 'run-a',
    exactRef: `fieldwork-reviewed-source:v1:${'a'.repeat(64)}`,
    assessmentRevision: 1,
    projectId: 'project-a',
    workspaceId: 'workspace-a',
    principalId: 'local:route-user',
  };

  test('passes a strict public reviewed-source association to its producer', async () => {
    const publish = vi.fn().mockResolvedValue({ revision: 1, active: true });
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => 'route-user',
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      isRequestPrincipalCurrent: () => true,
      answerAssessmentModule: { publish } as any,
    });
    const response = await app.request(
      '/sessions/session-a/turns/turn-a/assessment',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedAnswer: {},
          publicationId: 'publication-a',
          bundle: {},
          claimId: 'answer-claim',
          expectedRevision: 0,
          reviewedSource,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(
      'session-a',
      'turn-a',
      expect.objectContaining({ reviewedSource }),
      expect.anything(),
      expect.any(Function),
    );
  });

  test('rejects unknown reviewed-source association fields before calling its producer', async () => {
    const publish = vi.fn();
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => 'route-user',
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      isRequestPrincipalCurrent: () => true,
      answerAssessmentModule: { publish } as any,
    });
    const response = await app.request(
      '/sessions/session-a/turns/turn-a/assessment',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedAnswer: {},
          publicationId: 'publication-a',
          bundle: {},
          claimId: 'answer-claim',
          expectedRevision: 0,
          reviewedSource: {
            ...reviewedSource,
            owner: '@kontourai/not-fieldwork',
            unknown: true,
          },
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });
});

/** Minimal `OrchestrationService`-shaped fake backed by a real EventStore
 * (archive#1092): the resume feature's correctness lives entirely in
 * EventStore's global_sequence bookkeeping + the route's replay/snapshot
 * decision, so this avoids standing up the rest of OrchestrationService's
 * provider/session machinery, which is unrelated to what these tests cover.
 *
 * archive#1205 (LOW): `readEventStreamReplay` used to be a 2-arg stub that
 * ignored `userId` and returned every candidate unfiltered — a
 * permanently-open fake shape for the exact ownership gate archive#1197 added to
 * the real (3-arg) `OrchestrationService.readEventStreamReplay`. Call sites
 * pass this fake via `service as any`, so the widened production signature
 * gave no compile-time signal the stub was stale. It now takes `userId` and
 * filters candidates through this fake's own `canUserReadSession`, mirroring
 * production (`orchestration-service.ts`'s `readEventStreamReplay`) — an
 * override of `canUserReadSession` in a future test now actually changes
 * what this stub replays, instead of silently returning everything. */
function makeResumeTestService(
  eventStore: EventStore,
  overrides: Record<string, unknown> = {},
) {
  const service = {
    listSessionReadModel: vi.fn().mockResolvedValue([]),
    canUserReadSession: vi.fn().mockReturnValue(true),
    dispatch: vi.fn(),
    readEventStreamHead: () => eventStore.headGlobalSequence(),
    readEventGlobalSequence: (eventId: string) =>
      eventStore.readGlobalSequence(eventId),
    readEventStreamReplay: (
      afterGlobalSequence: number,
      options: { threadId?: string; limit: number },
      userId: string,
    ) =>
      eventStore
        .listEventsAfterGlobalSequence(afterGlobalSequence, options)
        .filter((persisted) =>
          service.canUserReadSession(persisted.threadId, userId),
        ),
    readEventStreamReplayPlan: (
      afterGlobalSequence: number,
      options: { threadId?: string; limit: number; maxSerializedBytes: number },
      userId: string,
    ) => {
      let bytes = 0;
      let count = 0;
      for (const event of eventStore.listEventReplayDescriptors(
        afterGlobalSequence,
        options,
      )) {
        if (!service.canUserReadSession(event.threadId, userId)) continue;
        count += 1;
        bytes += event.serializedFrameBytes;
        if (bytes > options.maxSerializedBytes)
          return { count, fitsBudget: false };
      }
      return { count, fitsBudget: true };
    },
    // archive#1410 (D2): mirrors production's `replayTurnProvenanceSidecar`
    // — same shared fold, same strict per-turn filter — so a route test
    // proves the route ATTACHES the sidecar rather than proving a stub does.
    replayTurnProvenanceSidecar: (event: CanonicalRuntimeEvent) => {
      if (event.method !== 'turn.completed' || !event.turnId) return {};
      const events = eventStore
        .listEvents(event.threadId)
        .map((persisted) => persisted.payload)
        .filter(
          (candidate) =>
            candidate.turnId === event.turnId &&
            candidate.threadId === event.threadId,
        );
      const envelope = assembleTurnProvenanceEnvelopes(events).find(
        (candidate) => candidate.turnId === event.turnId,
      );
      return envelope ? { provenance: envelope } : {};
    },
    ...overrides,
  };
  return service;
}

const ROUTE_TEST_USER_ID = 'orchestration-route-test-user';
const personalReadAuthority = (userId: string) =>
  expect.objectContaining({
    userId,
    mode: 'personal',
    tenantExecutionContext: undefined,
  });

describe('Orchestration Routes', () => {
  // archive#4075 stage 2 acceptance: "Missing principal fails closed at
  // dispatch — typed refusal, no 'unknown-user', no alias." Every OTHER
  // test in this file configures `getUserId` (the legacy test-only escape
  // hatch) or `resolvePrincipal`; these deliberately configure NEITHER, to
  // prove the route never falls through to a silent default when no
  // resolver is wired at all — the exact shape production had before this
  // stage (`createOrchestrationRoutes`' deps literal never wired
  // `getUserId`) and the exact shape a future regression would look like if
  // someone reintroduced `?? getCachedUser().alias`.
  describe('missing principal fails closed (station#4075 stage 2)', () => {
    test('POST /chat refuses with a typed error and never reaches executeForegroundMessage', async () => {
      const executeForegroundMessage = vi.fn();
      const app = createOrchestrationRoutes({} as any, {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        executeForegroundMessage,
      });

      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'hello',
          target: { environment: { kind: 'current' }, agent: 'codex' },
        }),
      });

      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body).toMatchObject({ success: false });
      expect((body as { error: string }).error).toMatch(
        /Unable to resolve a principal/,
      );
      expect((body as { error: string }).error).not.toMatch(/unknown.user/i);
      expect(executeForegroundMessage).not.toHaveBeenCalled();
    });

    test('POST /commands refuses with a typed error and never reaches dispatchWithReceipt', async () => {
      const dispatchWithReceipt = vi.fn();
      const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
      });

      const res = await app.request('/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'steerTurn',
          threadId: 'thread-unresolved',
          input: 'redirect',
        }),
      });

      // No local try/catch runs before principal resolution on this route
      // (it happens before the outer `try`), so an uncaught
      // `PrincipalUnresolvedError` reaches Hono's own default error
      // handler — still a typed refusal (never a silently-dispatched
      // command), just without this route's own JSON envelope.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(dispatchWithReceipt).not.toHaveBeenCalled();
    });

    test('GET /sessions refuses rather than defaulting to any implicit identity', async () => {
      const listSessions = vi.fn().mockResolvedValue([]);
      const app = createOrchestrationRoutes({ listSessions } as any, {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
      });

      const res = await app.request('/sessions');

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(listSessions).not.toHaveBeenCalled();
    });
  });

  test('POST /commands admits the typed steer command on the orchestration seam', async () => {
    const dispatchWithReceipt = vi.fn().mockResolvedValue({
      receipt: {
        commandId: 'steer-command',
        threadId: 'thread-live',
        commandType: 'steerTurn',
        status: 'accepted',
        createdAt: '2026-08-14T00:00:00.000Z',
      },
      result: {
        outcome: 'steered',
        threadId: 'thread-live',
        turnId: 'turn-live',
      },
    });
    const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const response = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'steerTurn',
        threadId: 'thread-live',
        input: 'change direction',
        turnId: 'turn-live',
      }),
    });

    expect(response.status).toBe(200);
    expect(dispatchWithReceipt).toHaveBeenCalledWith(
      {
        type: 'steerTurn',
        threadId: 'thread-live',
        input: 'change direction',
        turnId: 'turn-live',
      },
      expect.objectContaining({ userId: ROUTE_TEST_USER_ID }),
    );
  });

  test('POST /commands preserves unavailable receipt durability with accepted data', async () => {
    const dispatchWithReceipt = vi.fn().mockResolvedValue({
      receipt: {
        commandId: 'send-command',
        threadId: 'thread-live',
        commandType: 'steerTurn',
        status: 'accepted',
        createdAt: '2026-08-14T00:00:00.000Z',
      },
      receiptStatus: 'unavailable',
      result: { threadId: 'thread-live', turnId: 'turn-live' },
    });
    const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const response = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'steerTurn',
        threadId: 'thread-live',
        input: 'change direction',
        turnId: 'turn-live',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { threadId: 'thread-live', turnId: 'turn-live' },
      receiptStatus: 'unavailable',
    });
  });

  test('POST /commands projects an indeterminate command session with its receipt', async () => {
    const receipt = {
      commandId: 'command-1',
      threadId: 'thread-1',
      commandType: 'adoptSession' as const,
      status: 'accepted' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    const session = {
      threadId: 'thread-1',
      provider: 'claude' as const,
      status: 'ready' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    const app = createOrchestrationRoutes(
      {
        dispatchWithReceipt: vi
          .fn()
          .mockRejectedValue(
            new OrchestrationCommandDispatchError(
              'Session started, but receipt persistence is unavailable.',
              receipt,
              session,
              'unavailable',
            ),
          ),
      } as any,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => ROUTE_TEST_USER_ID,
      },
    );

    const response = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'adoptSession',
        sourceThreadId: 'thread-1',
      }),
    });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toEqual({
      success: false,
      error: 'Session started, but receipt persistence is unavailable.',
      receipt,
      outcome: 'indeterminate',
      receiptStatus: 'unavailable',
      session,
    });
  });

  test('GET /sessions/:threadId/messages maps the combined query outcome without a second replay', async () => {
    const read = vi.fn().mockResolvedValue({
      status: 'found' as const,
      conversation: {
        id: 'thread-1',
        agentSlug: 'codex',
        title: 'Query once',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
        messageCount: 1,
        mutable: false as const,
      },
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Query once' }] },
      ],
    });
    const app = createOrchestrationRoutes({ sessionQueries: { read } } as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const response = await app.request('/sessions/thread-1/messages');

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toEqual({
      success: true,
      data: [{ role: 'user', parts: [{ type: 'text', text: 'Query once' }] }],
    });
    expect(read).toHaveBeenCalledWith(
      { type: 'conversation', threadId: 'thread-1' },
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
  });

  test('GET /sessions/:threadId/messages makes an unavailable query explicit', async () => {
    const app = createOrchestrationRoutes(
      {
        sessionQueries: {
          read: vi.fn().mockResolvedValue({ status: 'unavailable' }),
        },
      } as any,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => ROUTE_TEST_USER_ID,
      },
    );

    const response = await app.request('/sessions/thread-1/messages');

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({
      success: false,
      error: 'Session messages unavailable',
    });
  });

  test('GET /sessions/:threadId/turns/:turnId resolves one authorized completed assistant answer', async () => {
    const readAssistantTurn = vi.fn().mockResolvedValue({
      status: 'found' as const,
      sessionId: 'thread-1',
      turnId: 'turn-1',
      message: {
        id: 'answer-1',
        role: 'assistant' as const,
        parts: [{ type: 'text', text: 'Exact answer' }],
        metadata: { turnId: 'turn-1' },
      },
    });
    const app = createOrchestrationRoutes(
      { sessionQueries: { read: vi.fn(), readAssistantTurn } } as any,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => ROUTE_TEST_USER_ID,
      },
    );

    const response = await app.request('/sessions/thread-1/turns/turn-1');

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toMatchObject({
      success: true,
      data: {
        sessionId: 'thread-1',
        turnId: 'turn-1',
        message: { role: 'assistant', metadata: { turnId: 'turn-1' } },
      },
    });
    expect(readAssistantTurn).toHaveBeenCalledWith(
      { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
  });

  test('GET /sessions/:threadId/turns/:turnId makes missing and denied answers the same response', async () => {
    const readAssistantTurn = vi.fn().mockResolvedValue({
      status: 'not-found' as const,
    });
    const app = createOrchestrationRoutes(
      { sessionQueries: { read: vi.fn(), readAssistantTurn } } as any,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => ROUTE_TEST_USER_ID,
      },
    );

    const response = await app.request('/sessions/private/turns/turn-1');

    expect(response.status).toBe(404);
    await expect(readJson(response)).resolves.toEqual({
      success: false,
      error: 'Assistant answer not found',
    });
  });

  test('POST /chat returns the exact continuation workspace refusal code', async () => {
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      executeForegroundMessage: vi
        .fn()
        .mockRejectedValue(
          new ContinuationWorkspaceError(
            'continuation_workspace_worktree_gone',
            "This conversation's worktree is gone and cannot be resumed.",
          ),
        ),
    });

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Resume safely',
        target: {
          environment: { kind: 'current' },
          agent: 'station',
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "This conversation's worktree is gone and cannot be resumed.",
      code: 'continuation_workspace_worktree_gone',
    });
  });

  test('POST /chat surfaces an unavailable-Agent refusal as a clean 400 carrying the reason (#3027)', async () => {
    // archive#3027 clean break: a turn sent into a conversation bound to a
    // spec-less engine-default alias refuses at target resolution. The
    // client must receive the exact enable-remedy reason as a structured
    // error envelope — never an opaque 500.
    const reason =
      "Agent 'codex' has no authored Agent definition, so Station cannot start new sessions or continue existing conversations with it. Enable this engine by creating an Agent for it — new chats will run as that Agent; existing conversations stay readable.";
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      executeForegroundMessage: vi.fn().mockRejectedValue(new Error(reason)),
    });

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Continue this legacy alias thread',
        conversationId: 'conversation:legacy-codex',
        target: { environment: { kind: 'current' }, agent: 'codex' },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: reason,
    });
  });

  test('POST /chat projects an indeterminate foreground start without inviting retry', async () => {
    const receipt = {
      commandId: 'command-uncertain',
      threadId: 'conversation-uncertain',
      commandType: 'startSession' as const,
      status: 'accepted' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    const session = {
      threadId: 'conversation-uncertain',
      provider: 'claude' as const,
      status: 'ready' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      executeForegroundMessage: vi.fn().mockRejectedValue(
        new ForegroundMessageIndeterminateError(
          {
            code: 'foreground_message_indeterminate',
            outcome: 'indeterminate',
            receipt,
            receiptStatus: 'unavailable',
            session,
          },
          'Session started, but its accepted receipt is unavailable. Session conversation-uncertain may already be running; do not retry automatically.',
        ),
      ),
    });

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Start safely',
        target: { environment: { kind: 'current' }, agent: 'claude' },
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error:
        'Foreground Agent message may have started. Do not retry automatically.',
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
      receipt,
      receiptStatus: 'unavailable',
      session,
    });
  });

  test('fixed delegated/background chat routes derive only their restrictive server intent', async () => {
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation-fixed-intent',
      sessionId: 'session-fixed-intent',
      providerTurnId: 'turn-fixed-intent',
      target: { kind: 'agent', id: 'claude' },
      resolution: {},
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      executeForegroundMessage,
    });
    const common = {
      message: 'Run later',
      target: { environment: { kind: 'current' }, agent: 'claude' },
    };

    expect(
      (
        await app.request('/chat/background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(common),
        })
      ).status,
    ).toBe(200);
    expect(executeForegroundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ automaticBackground: true }),
    );

    const delegation = {
      mode: 'isolated-child',
      depth: 1,
      maxDepth: 2,
      parentAgentSlug: 'parent',
      rootAgentSlug: 'root',
    };
    expect(
      (
        await app.request('/chat/delegated', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...common, delegation }),
        })
      ).status,
    ).toBe(200);
    expect(executeForegroundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ delegation }),
    );
  });

  test('POST /chat maps an unreachable workspace mount to 503, not 400 (#2552)', async () => {
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      executeForegroundMessage: vi
        .fn()
        .mockRejectedValue(
          new ProjectWorktreeDirectoryError(
            'stalled-project',
            '/mnt/dead',
            'unreachable',
          ),
        ),
    });

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Send into a stalled mount',
        target: {
          environment: { kind: 'current' },
          agent: 'station',
        },
      }),
    });

    // Temporary server-side infrastructure unavailability, not client input.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      code: 'project_worktree_directory_invalid',
    });
  });
  test('POST /chat binds the user and forwards one canonical execution target', async () => {
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:1',
      sessionId: 'session:1',
      providerTurnId: 'provider-turn-1',
      target: { kind: 'agent', id: 'codex' },
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      executeForegroundMessage,
    });

    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Inspect the target',
        target: {
          environment: { kind: 'saved', id: 'env-remote' },
          agent: 'codex',
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        ambientContext: '[Timezone: America/Denver]',
        clientTurnId: 'client-turn-1',
        userId: 'spoofed-user',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ providerTurnId: 'provider-turn-1' }),
      }),
    );
    expect(executeForegroundMessage).toHaveBeenCalledWith({
      message: 'Inspect the target',
      target: {
        environment: { kind: 'saved', id: 'env-remote' },
        agent: 'codex',
        workspace: { kind: 'project', projectSlug: 'station' },
      },
      ambientContext: '[Timezone: America/Denver]',
      clientTurnId: 'client-turn-1',
      userId: 'bound-user',
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
    });
  });

  test('POST /api/orchestration/chat persists a direct answer that the share path can resolve after reopening the store (#3830, #887)', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'orchestration-route-origin-'),
    );
    const eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
    const eventBus = new EventBus();
    const events = new AsyncEventQueue<CanonicalRuntimeEvent>();
    const providerInputs: Array<Record<string, unknown>> = [];
    const adapter = {
      provider: 'station-agent' as const,
      metadata: {
        displayName: 'Station',
        description: 'Early turn-start test adapter',
        capabilities: ['agent-runtime'],
        modelLaunch: {
          defaultAtStart: 'engine-selected',
          omissionAtResume: 'engine-selected',
          omissionPerTurn: 'engine-selected',
          overrideAtStart: true,
          overrideAtResume: true,
          overridePerTurn: true,
        },
      },
      events,
      startSession: vi.fn(async (input: { threadId: string }) => ({
        provider: 'station-agent' as const,
        threadId: input.threadId,
        status: 'ready' as const,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      })),
      sendTurn: vi.fn(async (input: Record<string, unknown>) => {
        providerInputs.push(input);
        events.push({
          eventId: 'early-origin-turn-started',
          method: 'turn.started',
          provider: 'station-agent',
          threadId: String(input.threadId),
          turnId: 'provider-turn-origin',
          createdAt: '2026-08-23T00:00:00.000Z',
        });
        return {
          threadId: String(input.threadId),
          turnId: 'provider-turn-origin',
        };
      }),
      interruptTurn: vi.fn(async () => ({
        outcome: 'no-active-turn' as const,
      })),
      respondToRequest: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => false),
      stopAll: vi.fn(async () => undefined),
      streamEvents: (options?: { signal?: AbortSignal }) =>
        events.iterable(options),
    };
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter as any),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const inner = createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'route-user',
      executeForegroundMessage: (input) =>
        executeResolvedForegroundMessage(input, {
          resolveEnvironmentAccess: async () => ({
            apiBase: 'http://station.test',
            environmentId: 'environment-current',
            environmentName: 'Current Station',
            kind: 'current',
          }),
          getAgent: async () => ({ slug: 'station', available: true }),
          getConnection: vi.fn(),
          getProject: vi.fn(),
          getProviderAdapter: (provider) =>
            service.getProviderAdapter(provider),
          readSessionBinding: async () => null,
          startSession: async (_access, startInput) => {
            const started = await service.sessionCommands.execute(
              { type: 'start-session', input: startInput },
              { userId: 'route-user' },
            );
            if (started.status !== 'accepted') throw new Error(started.message);
            // The provider contract returns a started-session handle; this mock
            // drives the real service and reports no handle of its own.
            return undefined;
          },
          sendTurn: async (_access, turnInput, context) => {
            const dispatched = await service.dispatchWithReceipt(
              { type: 'sendTurn', input: turnInput as any },
              context?.clientOrigin
                ? { clientOrigin: context.clientOrigin }
                : undefined,
            );
            return { turnId: (dispatched.result as { turnId: string }).turnId };
          },
          createConversationId: () => 'conversation:route-origin',
        }),
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'device-credential',
        authority: 'device-credential',
        deviceId: 'authenticated-device-7',
        source: 'bearer',
      });
      await next();
    });
    app.route('/api/orchestration', inner);
    let serviceOpen = true;
    let eventStoreOpen = true;

    try {
      const response = await app.request('/api/orchestration/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Station-Client-Origin': '1;web;2026.8.23',
        },
        body: JSON.stringify({
          message: 'Persist the early turn event',
          target: { environment: { kind: 'current' }, agent: 'station' },
        }),
      });

      expect(response.status).toBe(200);
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]).not.toHaveProperty('clientOrigin');
      events.push({
        eventId: 'early-origin-answer-delta',
        method: 'content.text-delta',
        provider: 'station-agent',
        threadId: 'conversation:route-origin',
        turnId: 'provider-turn-origin',
        itemId: 'answer-item',
        delta: 'Durable direct answer',
        createdAt: '2026-08-23T00:00:01.000Z',
      });
      events.push({
        eventId: 'early-origin-turn-completed',
        method: 'turn.completed',
        provider: 'station-agent',
        threadId: 'conversation:route-origin',
        turnId: 'provider-turn-origin',
        finishReason: 'stop',
        createdAt: '2026-08-23T00:00:02.000Z',
      });
      await vi.waitFor(() =>
        expect(
          eventStore
            .listEvents('conversation:route-origin')
            .map((event) => event.payload.method),
        ).toContain('turn.completed'),
      );
      expect(
        eventStore
          .listEvents('conversation:route-origin')
          .map((event) => event.payload),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'turn.started',
            turnId: 'provider-turn-origin',
            clientOrigin: {
              version: 1,
              actor: { kind: 'device', deviceId: 'authenticated-device-7' },
              reported: { version: 1, surface: 'web', build: '2026.8.23' },
            },
          }),
        ]),
      );

      // Close every live owner before reopening. This proves the answer came
      // through the real foreground route into the on-disk SQLite store, not
      // from the adapter queue or the process-local read model.
      await service.shutdown();
      serviceOpen = false;
      eventStore.close();
      eventStoreOpen = false;
      const reopened = new EventStore(join(directory, 'orchestration.sqlite'));
      try {
        const persistedEvents = reopened
          .listEvents('conversation:route-origin')
          .map((event) => event.payload);
        expect(JSON.stringify(persistedEvents)).toContain(
          'Durable direct answer',
        );

        const shareService = new AnswerShareService({
          store: {
            mint: async (input: Parameters<AnswerShareStore['mint']>[0]) => ({
              record: {
                id: 'share-direct-answer',
                tokenHash: '0'.repeat(64),
                sessionId: input.sessionId,
                turnId: input.turnId,
                ownerUserId: input.ownerUserId ?? null,
                label: input.label ?? null,
                createdAt: '2026-08-23T00:00:03.000Z',
                expiresAt: '2026-08-30T00:00:03.000Z',
                revokedAt: null,
                channel: input.channel,
                contentDigest: input.contentDigest,
              },
              token: 'test-share-token',
            }),
          } as never,
          sessions: {
            readSessionMessages: () =>
              projectRuntimeEventsToMessages(persistedEvents),
          },
          channelObserver: NO_CHANNEL_LOG_OBSERVER,
        });
        const minted = await shareService.mint({
          sessionId: 'conversation:route-origin',
          turnId: 'provider-turn-origin',
          ownerUserId: 'route-user',
        });
        expect(minted).not.toEqual({ error: 'answer-not-found' });
      } finally {
        reopened.close();
      }
    } finally {
      if (serviceOpen) await service.shutdown();
      if (eventStoreOpen) eventStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(['/chat', '/chat/conversation%3Aempty/continue'])(
    'POST %s projects a missing provider turn id as detail-less indeterminate',
    async (path) => {
      const app = createOrchestrationRoutes({} as any, {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => 'bound-user',
        executeForegroundMessage: vi.fn().mockResolvedValue({
          conversationId: 'conversation:empty',
          providerTurnId: '',
          target: { kind: 'agent', id: 'codex' },
        }),
        continueForegroundMessage: vi.fn().mockResolvedValue({
          conversationId: 'conversation:empty',
          providerTurnId: '',
          target: { kind: 'agent', id: 'codex' },
        }),
      });
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Do not accept without correlation',
          ...(path === '/chat'
            ? { target: { environment: { kind: 'current' }, agent: 'codex' } }
            : {}),
        }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        success: false,
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });
    },
  );

  test('POST /chat/:conversationId/continue preserves typed indeterminacy', async () => {
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      continueForegroundMessage: vi
        .fn()
        .mockRejectedValue(
          new ForegroundMessageTurnIdentityUnavailableError(
            'Continuation may have started without a provider receipt.',
          ),
        ),
    });
    const res = await app.request('/chat/conversation%3Atyped/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Do not retry typed continuation' }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error:
        'Foreground Agent continuation may have started. Do not retry automatically.',
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
  });

  test.each(['/chat', '/chat/conversation%3Aambiguous/continue'])(
    'POST %s preserves structural provider-invocation ambiguity as no-retry',
    async (path) => {
      const ambiguous = Object.assign(
        new Error('private provider transport detail'),
        {
          code: 'foreground_message_indeterminate',
          outcome: 'indeterminate',
        },
      );
      const app = createOrchestrationRoutes({} as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        executeForegroundMessage: vi.fn().mockRejectedValue(ambiguous),
        continueForegroundMessage: vi.fn().mockRejectedValue(ambiguous),
      });
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Observe this possible effect',
          ...(path === '/chat'
            ? { target: { environment: { kind: 'current' }, agent: 'codex' } }
            : {}),
        }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        success: false,
        error: expect.stringContaining('may have started'),
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });
    },
  );

  test('POST /chat/:conversationId/continue keeps detailed indeterminacy stable', async () => {
    const receipt = {
      commandId: 'command-uncertain',
      threadId: 'conversation-uncertain',
      commandType: 'startSession' as const,
      status: 'accepted' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    const session = {
      threadId: 'conversation-uncertain',
      provider: 'claude' as const,
      status: 'ready' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      continueForegroundMessage: vi.fn().mockRejectedValue(
        new ForegroundMessageIndeterminateError(
          {
            code: 'foreground_message_indeterminate',
            outcome: 'indeterminate',
            receipt,
            receiptStatus: 'unavailable',
            session,
          },
          'Provider diagnostics must not cross the route seam.',
        ),
      ),
    });
    const res = await app.request('/chat/conversation%3Atyped/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Observe rather than retry' }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error:
        'Foreground Agent continuation may have started. Do not retry automatically.',
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
      receipt,
      receiptStatus: 'unavailable',
      session,
    });
  });

  test('POST /chat derives a project default only when no explicit environment is supplied', async () => {
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:default-environment',
      sessionId: 'session:default-environment',
      providerTurnId: 'provider-turn-default-environment',
      target: { kind: 'agent', id: 'codex' },
    });
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      executeForegroundMessage,
      projectDefaultEnvironment: () => ({
        kind: 'saved',
        id: 'env-project-default' as any,
      }),
    });
    const request = (environment?: { kind: 'current' }) =>
      app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Resolve the environment',
          target: {
            ...(environment ? { environment } : {}),
            agent: 'codex',
            workspace: { kind: 'project', projectSlug: 'station' },
          },
        }),
      });

    expect((await request()).status).toBe(200);
    expect(executeForegroundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          environment: { kind: 'saved', id: 'env-project-default' },
        }),
      }),
    );

    expect((await request({ kind: 'current' })).status).toBe(200);
    expect(executeForegroundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ environment: { kind: 'current' } }),
      }),
    );
  });

  test('POST /chat does not resolve a project default for an explicit environment', async () => {
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:explicit-environment',
      sessionId: 'session:explicit-environment',
      providerTurnId: 'provider-turn-explicit-environment',
      target: { kind: 'agent', id: 'codex' },
    });
    const projectDefaultEnvironment = vi.fn(() => {
      throw new Error('default environment store unavailable');
    });
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      executeForegroundMessage,
      projectDefaultEnvironment,
    });

    const response = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Use this Station explicitly',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: { kind: 'project', projectSlug: 'station' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(projectDefaultEnvironment).not.toHaveBeenCalled();
    expect(executeForegroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ environment: { kind: 'current' } }),
      }),
    );
  });

  test('POST /chat accepts a caption-less image turn and forwards its bytes', async () => {
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:image',
      sessionId: 'session:image',
      providerTurnId: 'provider-turn-image',
      target: { kind: 'agent', id: 'station' },
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      executeForegroundMessage,
    });

    const attachment = {
      kind: 'image',
      name: 'pasted.png',
      mimeType: 'image/png',
      size: 3,
      dataUrl: 'data:image/png;base64,YWJj',
    };
    const res = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '',
        attachments: [attachment],
        target: {
          environment: { kind: 'current' },
          agent: 'station',
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(executeForegroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: '', attachments: [attachment] }),
    );
  });

  test('POST /chat logs the dispatch through a conversation-bound child logger, retrievable via ServerLogReader q=<conversationId> (station#1897)', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'orchestration-chat-correlation-test-'),
    );
    installServerLogSink({ directory });
    try {
      const realLogger = createLogger({
        name: 'orchestration-chat-correlation-test',
        level: 'debug',
      });
      const executeForegroundMessage = vi.fn().mockResolvedValue({
        conversationId: 'conversation:corr-1',
        sessionId: 'conversation:corr-1',
        providerTurnId: 'provider-turn-correlation',
        target: { kind: 'agent', id: 'codex' },
      });
      const app = createOrchestrationRoutes({} as any, {
        eventBus: new EventBus(),
        logger: realLogger,
        getUserId: () => 'bound-user',
        executeForegroundMessage,
      });

      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Inspect the target',
          target: {
            environment: { kind: 'saved', id: 'env-remote' },
            agent: 'codex',
          },
        }),
      });
      expect(res.status).toBe(200);

      // pino's multistream tee is async-ish; give the event loop a turn.
      await new Promise((resolve) => setImmediate(resolve));

      const reader = createServerLogReader({ directory });
      const result = await reader.query({ q: 'conversation:corr-1' });
      expect(result.entries).toHaveLength(1);
      const [entry] = result.entries;
      expect(entry.msg).toBe('Foreground chat message dispatched');
      expect(entry[LOG_BINDING_KEYS.CONVERSATION_ID]).toBe(
        'conversation:corr-1',
      );
      expect(entry[LOG_BINDING_KEYS.AGENT_SLUG]).toBe('codex');
      expect(entry[LOG_BINDING_KEYS.USER_ID]).toBe('bound-user');
    } finally {
      resetServerLogSinkForTests();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('POST /chat binds the RESOLVED conversationId, never the request body one (station#1897 verify round)', async () => {
    // Discriminating fixture: the request body carries a stale client-supplied
    // conversationId that differs from what execution resolves. The binding
    // must use the resolved handle — binding the request's id would attribute
    // the turn's logs to the wrong conversation. (An independent verifier
    // proved the shipped tests could not distinguish the two.)
    const directory = mkdtempSync(
      join(tmpdir(), 'orchestration-chat-resolved-id-test-'),
    );
    installServerLogSink({ directory });
    try {
      const realLogger = createLogger({
        name: 'orchestration-chat-resolved-id-test',
        level: 'debug',
      });
      const executeForegroundMessage = vi.fn().mockResolvedValue({
        conversationId: 'conversation:resolved-9',
        sessionId: 'conversation:resolved-9',
        providerTurnId: 'provider-turn-resolved',
        target: { kind: 'agent', id: 'codex' },
      });
      const app = createOrchestrationRoutes({} as any, {
        eventBus: new EventBus(),
        logger: realLogger,
        getUserId: () => 'bound-user',
        executeForegroundMessage,
      });

      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Inspect the target',
          conversationId: 'conversation:stale-from-request',
          target: {
            environment: { kind: 'saved', id: 'env-remote' },
            agent: 'codex',
          },
        }),
      });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));

      const reader = createServerLogReader({ directory });
      const byResolved = await reader.query({ q: 'conversation:resolved-9' });
      expect(byResolved.entries).toHaveLength(1);
      expect(byResolved.entries[0][LOG_BINDING_KEYS.CONVERSATION_ID]).toBe(
        'conversation:resolved-9',
      );
      const byStale = await reader.query({
        q: 'conversation:stale-from-request',
      });
      expect(byStale.entries).toHaveLength(0);
    } finally {
      resetServerLogSinkForTests();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('POST /chat/:conversationId/continue uses only the persisted binding key', async () => {
    const continueForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:1',
      sessionId: 'conversation:1',
      providerTurnId: 'provider-turn-continue-1',
      target: { kind: 'agent', id: 'codex' },
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      continueForegroundMessage,
    });

    const res = await app.request('/chat/conversation%3A1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Continue safely',
        clientTurnId: 'client-turn-2',
        environment: { kind: 'saved', id: 'env-remote' },
        target: {
          environment: { kind: 'saved', id: 'forged' },
          agent: 'claude',
        },
        model: 'forged-model',
        userId: 'spoofed-user',
      }),
    });

    expect(res.status).toBe(200);
    expect(continueForegroundMessage).toHaveBeenCalledWith({
      conversationId: 'conversation:1',
      message: 'Continue safely',
      clientTurnId: 'client-turn-2',
      environment: { kind: 'saved', id: 'env-remote' },
      model: undefined,
      userId: 'bound-user',
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
    });
  });

  // archive#4075 stage 2 review round 1 (F1, HIGH): /chat/:conversationId
  // /continue is the PRIMARY send path after session start (the composer's
  // own mutation) — it resolved a principal for `userId` but dropped it
  // from the payload to `continueForegroundMessage`, so most ordinary
  // turns got no attribution. Pins the fix by asserting `principal` reaches
  // the deps call.
  test('POST /chat/:conversationId/continue forwards the resolved principal, not only userId', async () => {
    const continueForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:1',
      sessionId: 'conversation:1',
      providerTurnId: 'provider-turn-continue-principal',
      target: { kind: 'agent', id: 'codex' },
    });
    const principal = {
      id: 'human:tailscale-serve:alice',
      kind: 'human' as const,
      display: 'Alice',
    };
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      resolvePrincipal: () => principal,
      continueForegroundMessage,
    });

    const res = await app.request('/chat/conversation%3A1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Continue safely' }),
    });

    expect(res.status).toBe(200);
    expect(continueForegroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:1',
        userId: principal.id,
        principal,
      }),
    );
  });

  test('POST /chat/:conversationId/continue forwards a validated next-turn model override', async () => {
    const continueForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:1',
      sessionId: 'conversation:1',
      providerTurnId: 'provider-turn-continue-model',
      target: { kind: 'agent', id: 'codex' },
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      continueForegroundMessage,
    });

    const res = await app.request('/chat/conversation%3A1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Switch models for this turn',
        model: { override: 'gpt-5.6-terra' },
      }),
    });

    expect(res.status).toBe(200);
    expect(continueForegroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:1',
        model: { override: 'gpt-5.6-terra' },
        userId: 'bound-user',
      }),
    );
  });

  test.each(['startSession', 'sendTurn'])(
    'POST /commands rejects public %s dispatch without an internal-header exception',
    async (type) => {
      const dispatchWithReceipt = vi.fn();
      const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
      });
      const input =
        type === 'startSession'
          ? { threadId: 'thread-1', provider: 'codex' }
          : { threadId: 'thread-1', input: 'bypass' };

      const res = await app.request('/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-station-internal-token': 'still-not-an-exception',
        },
        body: JSON.stringify({ type, input }),
      });

      expect(res.status).toBe(400);
      expect(dispatchWithReceipt).not.toHaveBeenCalled();
    },
  );

  test('POST /delegations binds the authenticated user and strips caller-supplied handle identities', async () => {
    const delegateTask = vi.fn().mockResolvedValue({
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'dispatched',
      resumable: true,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      delegateTask,
    });

    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Review the mobile shell',
        target: {
          environment: { kind: 'saved', id: 'env-remote' },
          agent: 'codex',
          model: { override: 'gpt-5.6-sol' },
        },
        userId: 'spoofed-user',
        taskId: 'task:poisoned',
        conversationId: 'conversation:poisoned',
        sessionId: 'session:poisoned',
        currentSessionId: 'session:current-poisoned',
      }),
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { taskId: 'task:1', resumable: true },
    });
    expect(delegateTask).toHaveBeenCalledWith({
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
      prompt: 'Review the mobile shell',
      principal: undefined,
      target: {
        environment: { kind: 'saved', id: 'env-remote' },
        agent: 'codex',
        model: { override: 'gpt-5.6-sol' },
      },
      userId: 'bound-user',
    });
  });

  test('POST /delegations accepts modelOptions and cwd and forwards them to delegateTask (#978)', async () => {
    const delegateTask = vi.fn().mockResolvedValue({
      taskId: 'task:2',
      sessionId: 'task:2',
      status: 'dispatched',
      resumable: true,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      delegateTask,
    });

    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Review the mobile shell',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: { kind: 'directory', cwd: '/work/mobile' },
          model: { options: { approvalMode: 'auto', effort: 'high' } },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(delegateTask).toHaveBeenCalledWith({
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
      prompt: 'Review the mobile shell',
      principal: undefined,
      target: {
        environment: { kind: 'current' },
        agent: 'codex',
        workspace: { kind: 'directory', cwd: '/work/mobile' },
        model: { options: { approvalMode: 'auto', effort: 'high' } },
      },
      userId: 'bound-user',
    });
  });

  test('POST /delegations/:taskId/continue accepts modelOptions and forwards it (#978)', async () => {
    const continueDelegatedTask = vi.fn().mockResolvedValue({
      taskId: 'task:2',
      sessionId: 'task:2',
      status: 'dispatched',
      resumable: true,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      continueDelegatedTask,
    });

    const res = await app.request('/delegations/task:2/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Keep going',
        modelOptions: { thinking: true },
      }),
    });

    expect(res.status).toBe(200);
    expect(continueDelegatedTask).toHaveBeenCalledWith({
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
      message: 'Keep going',
      modelOptions: { thinking: true },
      principal: undefined,
      taskId: 'task:2',
      userId: 'bound-user',
    });
  });

  test('POST /delegations rejects direct engine execution before dispatch', async () => {
    const delegateTask = vi.fn();
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      delegateTask,
    });

    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Do work',
        connection: 'codex',
      }),
    });

    expect(res.status).toBe(400);
    expect(delegateTask).not.toHaveBeenCalled();
  });

  test('POST /delegations/options discovers the selected Station without accepting identity fields', async () => {
    const discoverDelegationOptions = vi.fn().mockResolvedValue({
      environment: { id: 'env-remote', name: 'Remote', kind: 'ssh' },
      targets: [],
    });
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      discoverDelegationOptions,
    });

    const res = await app.request('/delegations/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environmentId: 'env-remote',
        projectPath: '/verified/project',
        userId: 'spoofed-user',
        localUrl: 'http://127.0.0.1:1234',
      }),
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { environment: { id: 'env-remote' }, targets: [] },
    });
    expect(discoverDelegationOptions).toHaveBeenCalledWith({
      environmentId: 'env-remote',
      projectPath: '/verified/project',
    });
  });

  test('bounds delegation discovery identifiers before connecting', async () => {
    const discoverDelegationOptions = vi.fn();
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      discoverDelegationOptions,
    });

    const res = await app.request('/delegations/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environmentId: 'e'.repeat(513) }),
    });

    expect(res.status).toBe(400);
    expect(discoverDelegationOptions).not.toHaveBeenCalled();
  });

  test('GET /delegations lists delegated tasks bound to the authenticated user', async () => {
    const listDelegatedTasks = vi.fn().mockResolvedValue({
      environment: { id: 'env-remote', name: 'Remote', kind: 'ssh' },
      tasks: [],
      truncated: false,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      listDelegatedTasks,
    });

    const res = await app.request(
      '/delegations?environmentId=env-remote&limit=10',
    );

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { tasks: [] },
    });
    expect(listDelegatedTasks).toHaveBeenCalledWith({
      environmentId: 'env-remote',
      limit: 10,
      userId: 'bound-user',
    });
  });

  test('GET /delegations is unavailable without a bound dep and rejects an invalid limit', async () => {
    const unavailable = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    const unavailableRes = await unavailable.request('/delegations');
    expect(unavailableRes.status).toBe(503);

    const listDelegatedTasks = vi.fn();
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      listDelegatedTasks,
    });
    const invalidRes = await app.request('/delegations?limit=0');
    expect(invalidRes.status).toBe(400);
    expect(listDelegatedTasks).not.toHaveBeenCalled();
  });

  test('GET /delegations surfaces a rejection from the service as 400', async () => {
    const listDelegatedTasks = vi
      .fn()
      .mockRejectedValue(new Error('Delegated task inventory is unavailable'));
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      listDelegatedTasks,
    });

    const res = await app.request('/delegations');
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task inventory is unavailable',
    });
  });

  test('GET /delegations/:taskId reads one task snapshot bound to the authenticated user', async () => {
    const observeDelegatedTask = vi.fn().mockResolvedValue({
      taskId: 'task:1',
      status: 'running',
      resumable: true,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      observeDelegatedTask,
    });

    const res = await app.request('/delegations/task:1?environmentId=env-1');

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { taskId: 'task:1', status: 'running' },
    });
    expect(observeDelegatedTask).toHaveBeenCalledWith({
      environmentId: 'env-1',
      taskId: 'task:1',
      userId: 'bound-user',
    });
  });

  test('GET /delegations/:taskId is unavailable without a bound dep and 400s on rejection', async () => {
    const unavailable = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    expect((await unavailable.request('/delegations/task:1')).status).toBe(503);

    const observeDelegatedTask = vi
      .fn()
      .mockRejectedValue(new Error('Delegated task not found'));
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      observeDelegatedTask,
    });
    const res = await app.request('/delegations/missing-task');
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task not found',
    });
  });

  test('GET /delegations/:taskId/events reads a bounded page using the opaque cursor', async () => {
    const observeDelegatedTaskEvents = vi.fn().mockResolvedValue({
      taskId: 'task:1',
      events: [],
      nextCursor: 'station-task-events:v1:5',
      hasMore: false,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      observeDelegatedTaskEvents,
    });

    const res = await app.request(
      '/delegations/task:1/events?cursor=station-task-events:v1:2&limit=25',
    );

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { nextCursor: 'station-task-events:v1:5' },
    });
    expect(observeDelegatedTaskEvents).toHaveBeenCalledWith({
      cursor: 'station-task-events:v1:2',
      limit: 25,
      taskId: 'task:1',
      userId: 'bound-user',
    });
  });

  test('GET /delegations/:taskId/events is unavailable without a bound dep and 400s on rejection', async () => {
    const unavailable = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    expect(
      (await unavailable.request('/delegations/task:1/events')).status,
    ).toBe(503);

    const observeDelegatedTaskEvents = vi
      .fn()
      .mockRejectedValue(new Error('Invalid task event cursor'));
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      observeDelegatedTaskEvents,
    });
    const res = await app.request(
      '/delegations/task:1/events?cursor=not-a-real-cursor',
    );
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Invalid task event cursor',
    });
  });

  test('POST /delegations/:taskId/continue sends a follow-up turn bound to the authenticated user', async () => {
    const continueDelegatedTask = vi.fn().mockResolvedValue({
      taskId: 'task:1',
      status: 'dispatched',
      resumable: true,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      continueDelegatedTask,
    });

    const res = await app.request('/delegations/task:1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Keep going',
        model: 'gpt-5.6-sol',
        userId: 'spoofed-user',
      }),
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { taskId: 'task:1', status: 'dispatched' },
    });
    expect(continueDelegatedTask).toHaveBeenCalledWith({
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
      message: 'Keep going',
      model: 'gpt-5.6-sol',
      principal: undefined,
      taskId: 'task:1',
      userId: 'bound-user',
    });
  });

  test('POST /delegations/:taskId/continue is unavailable without a bound dep and 400s on rejection', async () => {
    const unavailable = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    const unavailableRes = await unavailable.request(
      '/delegations/task:1/continue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Keep going' }),
      },
    );
    expect(unavailableRes.status).toBe(503);

    const continueDelegatedTask = vi
      .fn()
      .mockRejectedValue(new Error('Delegated task not found'));
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      continueDelegatedTask,
    });
    const res = await app.request('/delegations/task:1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Keep going' }),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task not found',
    });
  });

  test('POST /delegations/:taskId/respond resolves an open request bound to the authenticated user', async () => {
    const respondToDelegatedTaskRequest = vi.fn().mockResolvedValue({
      taskId: 'task:1',
      requestId: 'req-1',
      status: 'resolved',
      decision: 'accept',
      resumable: true,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      respondToDelegatedTaskRequest,
    });

    const res = await app.request('/delegations/task:1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'req-1',
        decision: 'accept',
        userId: 'spoofed-user',
      }),
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { requestId: 'req-1', decision: 'accept' },
    });
    expect(respondToDelegatedTaskRequest).toHaveBeenCalledWith({
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
      requestId: 'req-1',
      decision: 'accept',
      principal: undefined,
      taskId: 'task:1',
      userId: 'bound-user',
    });
  });

  test('POST /delegations/:taskId/respond is unavailable without a bound dep, rejects an invalid decision, and 400s on rejection', async () => {
    const unavailable = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    const unavailableRes = await unavailable.request(
      '/delegations/task:1/respond',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'req-1', decision: 'accept' }),
      },
    );
    expect(unavailableRes.status).toBe(503);

    const respondToDelegatedTaskRequest = vi.fn();
    const invalidApp = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      respondToDelegatedTaskRequest,
    });
    const invalidRes = await invalidApp.request('/delegations/task:1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-1', decision: 'not-a-decision' }),
    });
    expect(invalidRes.status).toBe(400);
    expect(respondToDelegatedTaskRequest).not.toHaveBeenCalled();

    const rejecting = vi
      .fn()
      .mockRejectedValue(new Error('Delegated task request is not open'));
    const rejectingApp = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      respondToDelegatedTaskRequest: rejecting,
    });
    const rejectingRes = await rejectingApp.request(
      '/delegations/task:1/respond',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'req-1', decision: 'decline' }),
      },
    );
    expect(rejectingRes.status).toBe(400);
    expect(await readJson(rejectingRes)).toMatchObject({
      success: false,
      error: 'Delegated task request is not open',
    });
  });

  test('POST /delegations/:taskId/interrupt stops the active turn bound to the authenticated user', async () => {
    const interruptDelegatedTask = vi.fn().mockResolvedValue({
      taskId: 'task:1',
      status: 'running',
      interruptRequested: true,
      resumable: true,
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
      interruptDelegatedTask,
    });

    const res = await app.request('/delegations/task:1/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: 'turn-1', userId: 'spoofed-user' }),
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { interruptRequested: true },
    });
    expect(interruptDelegatedTask).toHaveBeenCalledWith({
      clientOrigin: {
        version: 1,
        actor: { kind: 'unknown' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
      principal: undefined,
      turnId: 'turn-1',
      taskId: 'task:1',
      userId: 'bound-user',
    });
  });

  test('POST /delegations/:taskId/interrupt is unavailable without a bound dep and 400s on rejection', async () => {
    const unavailable = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    const unavailableRes = await unavailable.request(
      '/delegations/task:1/interrupt',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(unavailableRes.status).toBe(503);

    const interruptDelegatedTask = vi
      .fn()
      .mockRejectedValue(
        new Error('Delegated task cannot be interrupted while completed'),
      );
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      interruptDelegatedTask,
    });
    const res = await app.request('/delegations/task:1/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task cannot be interrupted while completed',
    });
  });

  test('GET /providers returns orchestration provider summaries', async () => {
    const service = {
      listProviders: vi.fn().mockResolvedValue([
        {
          provider: 'claude',
          prerequisites: [],
          activeSessions: 1,
        },
      ]),
      listSessions: vi.fn().mockResolvedValue([]),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
    });

    const res = await app.request('/providers');
    const body = await readJson(res);
    expect(body).toEqual({
      success: true,
      data: [
        {
          provider: 'claude',
          prerequisites: [],
          activeSessions: 1,
        },
      ],
    });
    expect(service.listProviders).toHaveBeenCalledWith(
      personalReadAuthority('bound-user'),
    );
  });

  test('GET /providers/:provider/models forwards cancellation to bounded discovery', async () => {
    const getProviderModels = vi
      .fn()
      .mockResolvedValue([
        { id: 'gpt-5.4', name: 'GPT-5.4', originalId: 'gpt-5.4' },
      ]);
    const service = {
      getProviderModels,
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
    });

    const request = new Request('http://localhost/providers/codex/models');
    const res = await app.request(request);

    expect(res.status).toBe(200);
    expect(getProviderModels).toHaveBeenCalledWith('codex', {
      signal: request.signal,
    });
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: [{ id: 'gpt-5.4' }],
    });
  });

  test('POST /commands rejects aggregate attachment bytes at the HTTP boundary', async () => {
    const dispatchWithReceipt = vi.fn();
    const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    const bytes = Buffer.alloc(4 * 1024 * 1024, 1);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    const response = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'sendTurn',
        input: {
          threadId: 'thread-aggregate-limit',
          input: 'Review these',
          attachments: Array.from({ length: 4 }, (_, index) => ({
            kind: 'image',
            name: `screen-${index}.png`,
            mimeType: 'image/png',
            size: bytes.byteLength,
            dataUrl,
          })),
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('POST /commands rejects declared oversized bodies before JSON parsing', async () => {
    const dispatchWithReceipt = vi.fn();
    const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });
    const response = await app.request('/commands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES + 1),
      },
      body: '{}',
    });

    expect(response.status).toBe(413);
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('POST /commands accepts adoption with only an opaque Station source id', async () => {
    const dispatchWithReceipt = vi.fn().mockResolvedValue({
      receipt: {
        commandId: 'cmd-adopt',
        threadId: 'external:claude:source',
        commandType: 'adoptSession',
        status: 'accepted',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
      result: { provider: 'claude', threadId: 'station-child' },
    });
    const actionOperations = {
      create: vi.fn().mockResolvedValue({ id: 'operation-1', revision: 1 }),
      update: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'updated',
          operation: { id: 'operation-1', revision: 2 },
        })
        .mockResolvedValue({ kind: 'updated' }),
    };
    const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
      actionOperations: actionOperations as any,
    });

    const res = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'adoptSession',
        sourceThreadId: 'external:claude:source',
        sourceSessionId: 'must-not-be-accepted',
        cwd: '/must/not/be/accepted',
      }),
    });

    expect(res.status).toBe(200);
    expect(dispatchWithReceipt).toHaveBeenCalledWith(
      {
        type: 'adoptSession',
        sourceThreadId: 'external:claude:source',
      },
      {
        userId: ROUTE_TEST_USER_ID,
        tenantExecutionContext: undefined,
        clientOrigin: {
          version: 1,
          actor: { kind: 'unknown' },
          reported: { version: 1, surface: 'unknown', build: null },
        },
      },
    );
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { threadId: 'station-child' },
    });
    expect(actionOperations.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ROUTE_TEST_USER_ID }),
      expect.objectContaining({
        scope: expect.objectContaining({ sessionId: 'external:claude:source' }),
        domain: {
          kind: 'session-handoff',
          sourceSessionId: 'external:claude:source',
        },
      }),
    );
    expect(actionOperations.update).toHaveBeenLastCalledWith(
      expect.any(Object),
      'operation-1',
      expect.objectContaining({
        status: 'succeeded',
        expectedRevision: 2,
        domain: {
          kind: 'session-handoff',
          sourceSessionId: 'external:claude:source',
          targetSessionId: 'station-child',
        },
        reentry: { kind: 'session', sessionId: 'station-child' },
      }),
    );
  });

  test('POST /commands rejects a malformed adoption idempotency key', async () => {
    const dispatchWithReceipt = vi.fn();
    const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });

    const response = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'adoptSession',
        sourceThreadId: 'external:claude:source',
        idempotencyKey: 'not-a-uuid',
      }),
    });

    expect(response.status).toBe(400);
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('POST /commands exposes retryable typed adoption contention', async () => {
    const dispatchWithReceipt = vi
      .fn()
      .mockRejectedValue(new AdoptionContinuationInProgressError());
    const actionOperations = {
      create: vi.fn().mockResolvedValue({ id: 'handoff-stable', revision: 1 }),
      update: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'updated',
          operation: { id: 'handoff-stable', revision: 2 },
        })
        .mockResolvedValue({ kind: 'updated' }),
    };
    const app = createOrchestrationRoutes({ dispatchWithReceipt } as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      actionOperations: actionOperations as any,
    });

    const response = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'adoptSession',
        sourceThreadId: 'external:claude:source',
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
      }),
    });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      success: false,
      error: 'Continuation is being created — retry shortly.',
      code: 'adoption_continuation_in_progress',
      retryable: true,
    });
    expect(actionOperations.update).toHaveBeenLastCalledWith(
      expect.any(Object),
      'handoff-stable',
      expect.objectContaining({
        expectedRevision: 2,
        status: 'running',
        progress: {
          kind: 'phase',
          code: 'reconciliation-required',
        },
      }),
    );
  });

  test('POST /commands rejects model selectors beyond the catalog bound', async () => {
    const service = {
      dispatchWithReceipt: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });

    const res = await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'startSession',
        input: {
          threadId: 'thread-oversized',
          provider: 'codex',
          modelId: 'x'.repeat(513),
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Validation failed',
    });
  });

  test('GET /commands/receipts exposes command receipt history and detail', async () => {
    const receipt = {
      commandId: 'cmd-9',
      threadId: 'thread-9',
      commandType: 'sendTurn',
      status: 'accepted',
      createdAt: '2026-03-28T00:00:00.000Z',
    };
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      listCommandReceipts: vi.fn().mockReturnValue([receipt]),
      readCommandReceipt: vi.fn().mockReturnValue(receipt),
      dispatchWithReceipt: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
    });

    const listRes = await app.request('/commands/receipts?threadId=thread-9');
    expect(await readJson(listRes)).toEqual({
      success: true,
      data: [receipt],
    });
    expect(service.listCommandReceipts).toHaveBeenCalledWith(
      personalReadAuthority(ROUTE_TEST_USER_ID),
      'thread-9',
    );

    const detailRes = await app.request('/commands/receipts/cmd-9');
    expect(await readJson(detailRes)).toEqual({
      success: true,
      data: receipt,
    });
    expect(service.readCommandReceipt).toHaveBeenCalledWith(
      'cmd-9',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
  });

  test('GET /sessions/read-model and /sessions/loaded expose stable read-model surfaces', async () => {
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionReadModel: vi.fn().mockResolvedValue([
        {
          provider: 'claude',
          threadId: 'thread-1',
          status: 'running',
          isLoaded: true,
          isPersisted: true,
          eventCount: 2,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:01.000Z',
        },
      ]),
      listLoadedSessionReadModel: vi.fn().mockResolvedValue([
        {
          provider: 'claude',
          threadId: 'thread-1',
          status: 'running',
          isLoaded: true,
          isPersisted: true,
          eventCount: 2,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:01.000Z',
        },
      ]),
      listAgentRuns: vi.fn(),
      readAgentRun: vi.fn(),
      readSession: vi.fn(),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const readModelRes = await app.request('/sessions/read-model');
    expect(await readJson(readModelRes)).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          threadId: 'thread-1',
          isLoaded: true,
          isPersisted: true,
        }),
      ],
    });

    const loadedRes = await app.request('/sessions/loaded');
    expect(await readJson(loadedRes)).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          threadId: 'thread-1',
          isLoaded: true,
        }),
      ],
    });
    expect(service.listSessionReadModel).toHaveBeenCalledWith(
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
    expect(service.listLoadedSessionReadModel).toHaveBeenCalledWith(
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
  });

  test('GET /sessions/read-model reconciles peer delegation evidence before publishing Activity (#847)', async () => {
    const refreshDelegatedTaskActivity = vi.fn().mockResolvedValue(undefined);
    const service = {
      listSessionReadModel: vi.fn().mockResolvedValue([
        {
          provider: 'station-agent',
          threadId: 'peer-delegation:847',
          status: 'closed',
          lifecycleState: 'completed',
          isLoaded: false,
          isPersisted: true,
          eventCount: 2,
          createdAt: '2026-08-29T00:00:00.000Z',
          updatedAt: '2026-08-29T00:00:01.000Z',
          delegation: {
            taskId: 'task-peer-847',
            environmentKind: 'peer',
            environmentId: 'environment-peer',
          },
        },
      ]),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
      refreshDelegatedTaskActivity,
    });

    const response = await app.request('/sessions/read-model');

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          lifecycleState: 'completed',
          delegation: expect.objectContaining({ environmentKind: 'peer' }),
        }),
      ],
    });
    expect(refreshDelegatedTaskActivity).toHaveBeenCalledWith({
      userId: ROUTE_TEST_USER_ID,
    });
    expect(
      refreshDelegatedTaskActivity.mock.invocationCallOrder[0],
    ).toBeLessThan(service.listSessionReadModel.mock.invocationCallOrder[0]);
  });

  // archive#4466: the test above mocks `OrchestrationService` entirely, so
  // it proves the route calls `listSessionReadModel` but says nothing about
  // how that method reads the store. This test enters through the REAL
  // route handler with a REAL `OrchestrationService`/`EventStore` pair (the
  // same real-service pattern the origin-preservation chat test above
  // uses), so the wiring from HTTP request to the batched store read is
  // proven end to end rather than asserted at the service boundary.
  test('GET /sessions/read-model reads every visible thread through the batched projection query, not one per thread (station#4466)', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'orchestration-route-read-model-batch-'),
    );
    const eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
    const eventBus = new EventBus();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const app = createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    try {
      const threadIds = Array.from(
        { length: 15 },
        (_, index) => `route-read-model-thread-${index}`,
      );
      for (const threadId of threadIds) {
        eventStore.upsertSession({
          provider: 'claude',
          threadId,
          status: 'ready',
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
        });
        eventStore.appendEvent({
          eventId: `${threadId}-started`,
          provider: 'claude',
          threadId,
          createdAt: '2026-08-26T00:00:00.000Z',
          method: 'session.started',
          sessionId: threadId,
          metadata: { agentSlug: 'claude', userId: ROUTE_TEST_USER_ID },
        });
        eventStore.appendEvent({
          eventId: `${threadId}-turn-started`,
          provider: 'claude',
          threadId,
          turnId: 'turn-1',
          createdAt: '2026-08-26T00:00:00.000Z',
          method: 'turn.started',
          prompt: `prompt for ${threadId}`,
        });
      }

      const batchedCalls: Array<readonly string[]> = [];
      const originalBatched =
        eventStore.listSessionProjectionEventsForThreads.bind(eventStore);
      eventStore.listSessionProjectionEventsForThreads = ((
        ids: readonly string[],
      ) => {
        batchedCalls.push(ids);
        return originalBatched(ids);
      }) as typeof eventStore.listSessionProjectionEventsForThreads;
      let singleThreadCalls = 0;
      const originalSingle =
        eventStore.listSessionProjectionEvents.bind(eventStore);
      eventStore.listSessionProjectionEvents = ((id: string) => {
        singleThreadCalls += 1;
        return originalSingle(id);
      }) as typeof eventStore.listSessionProjectionEvents;

      const response = await app.request('/sessions/read-model');
      const body = (await readJson(response)) as {
        data: Array<{ threadId: string; lastEventMethod?: string }>;
      };

      expect(response.status).toBe(200);
      expect(body.data).toHaveLength(threadIds.length);
      expect(body.data.map((session) => session.threadId)).toEqual(
        expect.arrayContaining(threadIds),
      );
      // A grouping bug that buckets every thread's rows under the wrong key
      // (e.g. the FIRST thread in the superset) still returns every
      // threadId — presence comes from the persisted-session read, which
      // this fix never touched — and a per-thread `undefined` fold would
      // simply omit `lastEventMethod` rather than throw. Pin the folded
      // CONTENT, not just presence: every seeded thread appended
      // `session.started` then `turn.started`, so a correct fold's latest
      // fact is that thread's OWN `turn.started`.
      for (const threadId of threadIds) {
        const session = body.data.find((entry) => entry.threadId === threadId);
        expect(session?.lastEventMethod).toBe('turn.started');
      }

      // The wiring proof: exactly one batched call, covering every visible
      // thread, and zero calls through the retired per-thread path this
      // route used to loop over.
      expect(batchedCalls).toHaveLength(1);
      expect([...batchedCalls[0]!].sort()).toEqual([...threadIds].sort());
      expect(singleThreadCalls).toBe(0);
    } finally {
      eventStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('hosted reads use only the ingress tenant authority, fail closed when it is absent, and never serialize it (#1707)', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'tenant-alpha', authority: 'alpha.station.test' },
        { id: 'tenant-bravo', authority: 'bravo.station.test' },
      ],
    });
    const sessionFor = (authority: {
      tenantExecutionContext?: { tenantId: string };
    }) =>
      authority.tenantExecutionContext?.tenantId === 'tenant-alpha'
        ? [{ threadId: 'thread-a', provider: 'claude' }]
        : authority.tenantExecutionContext?.tenantId === 'tenant-bravo'
          ? [{ threadId: 'thread-b', provider: 'codex' }]
          : [];
    const service = {
      listProviders: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockImplementation(sessionFor),
      listSessionReadModel: vi.fn().mockImplementation(sessionFor),
      listLoadedSessionReadModel: vi.fn().mockImplementation(sessionFor),
      listAgentRuns: vi.fn().mockResolvedValue([]),
      readAgentRun: vi.fn().mockResolvedValue(null),
      readSession: vi.fn().mockResolvedValue(null),
      readSessionMessages: vi.fn().mockReturnValue([]),
      readSessionEventPage: vi.fn().mockResolvedValue(null),
      readSessionFlowRun: vi.fn().mockResolvedValue(null),
      readSessionBuilderRun: vi.fn().mockResolvedValue(null),
      listCommandReceipts: vi.fn().mockReturnValue([]),
      readCommandReceipt: vi.fn().mockReturnValue(null),
      listProjectSessionBoard: vi.fn().mockResolvedValue([]),
    };
    const routes = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'shared-hosted-user',
      hostedTenantRegistry: registry,
    });
    const app = new Hono();
    app.use('*', createHostedTenantMiddleware(registry));
    app.route('', routes);
    const requestFor = (tenantId: string) =>
      app.fetch(
        new Request('http://station.test/sessions/read-model', {
          headers: {
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_TENANT_HEADER]: tenantId,
          },
        }),
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as any,
      );

    const alpha = await requestFor('tenant-alpha');
    const bravo = await requestFor('tenant-bravo');
    expect(await readJson(alpha)).toEqual({
      success: true,
      data: [{ threadId: 'thread-a', provider: 'claude' }],
    });
    expect(await readJson(bravo)).toEqual({
      success: true,
      data: [{ threadId: 'thread-b', provider: 'codex' }],
    });
    expect(service.listSessionReadModel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: 'shared-hosted-user',
        mode: 'hosted',
        tenantExecutionContext: { tenantId: 'tenant-alpha', source: 'request' },
      }),
    );
    expect(service.listSessionReadModel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: 'shared-hosted-user',
        mode: 'hosted',
        tenantExecutionContext: { tenantId: 'tenant-bravo', source: 'request' },
      }),
    );
    expect(
      JSON.stringify(await readJson(await requestFor('tenant-alpha'))),
    ).not.toContain('tenant-alpha');

    // The route itself remains fail-closed if hosted wiring reaches it
    // without trusted ingress context; a query/header/body cannot fill this.
    const unbound = await routes.request(
      '/sessions/read-model?tenantId=tenant-alpha',
      {
        headers: { [INTERNAL_TENANT_HEADER]: 'tenant-alpha' },
      },
    );
    expect(await readJson(unbound)).toEqual({ success: true, data: [] });
    expect(service.listSessionReadModel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'hosted',
        tenantExecutionContext: undefined,
      }),
    );
  });

  test('session board route lists project sessions and transition route validates actions', async () => {
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionReadModel: vi.fn(),
      listLoadedSessionReadModel: vi.fn(),
      listProjectSessionBoard: vi.fn().mockResolvedValue([
        {
          sessionId: 'thread-board',
          provider: 'codex',
          runtimeKind: 'codex',
          agentType: 'connected',
          lifecycleState: 'review_pending',
          pendingReview: true,
          projectSlug: 'alpha',
          status: 'running',
          createdAt: '2026-05-03T10:00:00.000Z',
          updatedAt: '2026-05-03T10:00:01.000Z',
          isLoaded: true,
          isPersisted: true,
          eventCount: 2,
          retryEligible: false,
          openHref: '/projects/alpha?chat=thread-board',
        },
      ]),
      sessionLifecycles: {
        transition: vi.fn().mockResolvedValue({
          provider: 'codex',
          threadId: 'thread-board',
          status: 'running',
          lifecycleState: 'blocked',
          createdAt: '2026-05-03T10:00:00.000Z',
          updatedAt: '2026-05-03T10:00:02.000Z',
          isLoaded: true,
          isPersisted: true,
          eventCount: 3,
        }),
      },
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const listRes = await app.request('/session-board/projects/alpha');
    expect(await readJson(listRes)).toEqual({
      success: true,
      data: [expect.objectContaining({ sessionId: 'thread-board' })],
    });
    expect(service.listProjectSessionBoard).toHaveBeenCalledWith(
      'alpha',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );

    const transitionRes = await app.request(
      '/sessions/thread-board/lifecycle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: 'blocked',
          reason: 'blocked_by_user',
          message: 'Needs review',
        }),
      },
    );
    expect(await readJson(transitionRes)).toEqual({
      success: true,
      data: expect.objectContaining({ lifecycleState: 'blocked' }),
    });
    expect(service.sessionLifecycles.transition).toHaveBeenCalledWith({
      threadId: 'thread-board',
      authority: personalReadAuthority(ROUTE_TEST_USER_ID),
      to: 'blocked',
      reason: 'blocked_by_user',
      source: 'user_action',
      message: 'Needs review',
    });
  });

  test('GET /runs exposes a read-only agent run ledger surface', async () => {
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionReadModel: vi.fn(),
      listLoadedSessionReadModel: vi.fn(),
      listAgentRuns: vi.fn().mockResolvedValue([
        {
          runId: 'thread-run',
          sessionId: 'thread-run',
          providerId: 'codex',
          source: 'orchestration',
          engineExecution: 'external',
          status: 'failed',
          startedAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:02.000Z',
          completedAt: '2026-03-28T00:00:02.000Z',
          failureKind: 'timeout',
          failureMessage: 'timeout',
          retryEligible: true,
          attempt: 1,
          eventCount: 2,
        },
      ]),
      readAgentRun: vi.fn().mockResolvedValue({
        runId: 'thread-run',
        sessionId: 'thread-run',
        providerId: 'codex',
        source: 'orchestration',
        engineExecution: 'external',
        status: 'failed',
        startedAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:02.000Z',
        completedAt: '2026-03-28T00:00:02.000Z',
        failureKind: 'timeout',
        failureMessage: 'timeout',
        retryEligible: true,
        attempt: 1,
        eventCount: 2,
      }),
      readSession: vi.fn(),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const listRes = await app.request('/runs');
    expect(await readJson(listRes)).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          runId: 'thread-run',
          status: 'failed',
          retryEligible: true,
        }),
      ],
    });

    const detailRes = await app.request('/runs/thread-run');
    expect(await readJson(detailRes)).toEqual({
      success: true,
      data: expect.objectContaining({
        runId: 'thread-run',
        failureKind: 'timeout',
      }),
    });
    expect(service.listAgentRuns).toHaveBeenCalledWith(
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
    expect(service.readAgentRun).toHaveBeenCalledWith(
      'thread-run',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
    expect(service.dispatch).not.toHaveBeenCalled();
  });

  test('GET /sessions/:threadId and /sessions/:threadId/events return detail and event history', async () => {
    const detail = {
      session: {
        provider: 'claude',
        threadId: 'thread-9',
        status: 'ready',
        isLoaded: false,
        isPersisted: true,
        eventCount: 1,
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:01.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'thread-9',
          createdAt: '2026-03-28T00:00:02.000Z',
          eventId: 'evt-9',
          method: 'session.configured',
          sessionId: 'thread-9',
        },
      ],
      recovery: {
        failureKind: 'rate-limit',
        scope: 'server',
        decision: 'wait-until-reset',
        outcome: 'armed',
        dueAt: '2026-03-28T00:01:00.000Z',
        attempts: 0,
        maxAttempts: 1,
        updatedAt: '2026-03-28T00:00:02.000Z',
      },
    };
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionReadModel: vi.fn(),
      listLoadedSessionReadModel: vi.fn(),
      readSession: vi.fn().mockResolvedValue(detail),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const detailRes = await app.request('/sessions/thread-9');
    expect(await readJson(detailRes)).toEqual({
      success: true,
      data: detail,
    });

    const eventsRes = await app.request('/sessions/thread-9/events');
    expect(await readJson(eventsRes)).toEqual({
      success: true,
      data: detail.events,
    });
    expect(service.readSession).toHaveBeenNthCalledWith(
      1,
      'thread-9',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
    expect(service.readSession).toHaveBeenNthCalledWith(
      2,
      'thread-9',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
  });

  test('GET /sessions/:threadId/event-page validates and forwards bounded pagination', async () => {
    const page = {
      session: { threadId: 'thread-9', eventCount: 9 },
      events: [{ sequence: 6, event: { method: 'turn.started' } }],
      hasMore: true,
      nextSequence: 6,
    };
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      readSessionEventPage: vi.fn().mockResolvedValue(page),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
    });

    const response = await app.request(
      '/sessions/thread-9/event-page?afterSequence=5&limit=25',
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: page });
    expect(service.readSessionEventPage).toHaveBeenCalledWith('thread-9', {
      afterSequence: 5,
      limit: 25,
      authority: personalReadAuthority('bound-user'),
    });

    const invalid = await app.request(
      '/sessions/thread-9/event-page?afterSequence=-1&limit=500',
    );
    expect(invalid.status).toBe(400);
    expect(service.readSessionEventPage).toHaveBeenCalledTimes(1);
  });

  test('GET /sessions/:threadId/event-window forwards the versioned turn cursor under request authority', async () => {
    const window = {
      protocolVersion: 1,
      session: { threadId: 'thread-window' },
      events: [],
      hasMore: true,
      nextCursor: 'opaque-older',
      watermark: 9,
    };
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      readSessionEventWindow: vi.fn().mockResolvedValue(window),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
    });

    const response = await app.request(
      '/sessions/thread-window/event-window?cursor=opaque-current&turnLimit=20',
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: window });
    expect(service.readSessionEventWindow).toHaveBeenCalledWith(
      'thread-window',
      {
        cursor: 'opaque-current',
        turnLimit: 20,
        authority: personalReadAuthority('bound-user'),
      },
    );

    const invalid = await app.request(
      '/sessions/thread-window/event-window?turnLimit=0',
    );
    expect(invalid.status).toBe(400);
    expect(service.readSessionEventWindow).toHaveBeenCalledTimes(1);
  });

  test('GET /sessions/:threadId/event-window keeps the hosted tenant authority at the read boundary', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'tenant-alpha', authority: 'alpha.station.test' }],
    });
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn(),
      readSessionEventWindow: vi.fn().mockResolvedValue({
        protocolVersion: 1,
        session: { threadId: 'thread-window' },
        events: [],
        hasMore: false,
        watermark: 0,
      }),
      dispatch: vi.fn(),
    };
    const routes = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'shared-hosted-user',
      hostedTenantRegistry: registry,
    });
    const app = new Hono();
    app.use('*', createHostedTenantMiddleware(registry));
    app.route('', routes);

    const response = await app.fetch(
      new Request('http://station.test/sessions/thread-window/event-window', {
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_TENANT_HEADER]: 'tenant-alpha',
        },
      }),
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as any,
    );

    expect(response.status).toBe(200);
    expect(service.readSessionEventWindow).toHaveBeenCalledWith(
      'thread-window',
      expect.objectContaining({
        authority: expect.objectContaining({
          mode: 'hosted',
          userId: 'shared-hosted-user',
          tenantExecutionContext: {
            tenantId: 'tenant-alpha',
            source: 'request',
          },
        }),
      }),
    );
  });

  test('GET /sessions/:threadId/flow-run resolves the session Flow run binding', async () => {
    const flowRun = {
      runId: 'session-thread-9',
      definitionId: 'delivery',
      cwd: '/workspace/project',
      run: {
        runId: 'session-thread-9',
        state: { status: 'active', current_step: 'build' },
        openGates: [{ id: 'build-gate', step: 'build' }],
      },
    };
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      readSessionFlowRun: vi
        .fn()
        .mockResolvedValueOnce(flowRun)
        .mockResolvedValueOnce(null),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const boundRes = await app.request('/sessions/thread-9/flow-run');
    expect(boundRes.status).toBe(200);
    expect(await readJson(boundRes)).toEqual({ success: true, data: flowRun });
    expect(service.readSessionFlowRun).toHaveBeenCalledWith(
      'thread-9',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );

    const unboundRes = await app.request('/sessions/thread-9/flow-run');
    expect(unboundRes.status).toBe(404);
    expect(await readJson(unboundRes)).toEqual({
      success: false,
      error: 'No Flow run bound to session',
    });
  });

  test('GET /sessions/:threadId/checkpoints lists recorded turn checkpoints behind session read authority', async () => {
    const checkpoints = [
      {
        threadId: 'thread-cp',
        turnId: 'turn-1',
        baseline: {
          status: 'not_applicable',
          reason: 'no_project_working_directory',
        },
        settle: {
          status: 'captured',
          checkpointId: 'cp-1',
          commitSha: 'sha-1',
          treeSha: 'tree-1',
          repoRoot: '/workspace/project',
          capturedAt: '2026-08-15T00:00:00.000Z',
        },
        updatedAt: '2026-08-15T00:00:01.000Z',
      },
    ];
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      canUserReadSession: vi.fn().mockReturnValue(true),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
      listThreadCheckpoints: async (threadId: string) =>
        threadId === 'thread-cp' ? checkpoints : [],
    });

    const okRes = await app.request('/sessions/thread-cp/checkpoints');
    expect(okRes.status).toBe(200);
    expect(await readJson(okRes)).toEqual({
      success: true,
      data: checkpoints,
    });
    expect(service.canUserReadSession).toHaveBeenCalledWith(
      'thread-cp',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );

    // A thread the requesting user cannot read is a 404, not a list — the
    // route must not become a cross-user thread-id oracle.
    service.canUserReadSession.mockReturnValue(false);
    const deniedRes = await app.request('/sessions/thread-cp/checkpoints');
    expect(deniedRes.status).toBe(404);

    // Unwired checkpoint layer: honest 503, never "no checkpoints".
    const unwired = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });
    const unavailableRes = await unwired.request('/sessions/x/checkpoints');
    expect(unavailableRes.status).toBe(503);
    expect(await readJson(unavailableRes)).toEqual({
      success: false,
      error: 'Workspace checkpoints are unavailable',
    });
  });

  test('POST checkpoint restore requires session authority and explicit confirmation', async () => {
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      canUserReadSession: vi.fn().mockReturnValue(true),
      dispatch: vi.fn(),
    };
    const restore = vi
      .fn()
      .mockResolvedValue({ id: 'restore-1', restored: true });
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
      restoreThreadCheckpoint: restore,
      listCheckpointRestoreEvents: (threadId) => [
        { id: 'restore-1', threadId },
      ],
    });
    const unconfirmed = await app.request(
      '/sessions/thread-cp/checkpoints/turn-1/restore',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: false }),
      },
    );
    expect(unconfirmed.status).toBe(400);
    expect(restore).not.toHaveBeenCalled();

    const ok = await app.request(
      '/sessions/thread-cp/checkpoints/turn-1/restore',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, phase: 'baseline' }),
      },
    );
    expect(ok.status).toBe(200);
    expect(restore).toHaveBeenCalledWith({
      threadId: 'thread-cp',
      turnId: 'turn-1',
      phase: 'baseline',
      confirmed: true,
    });
    const audit = await app.request('/sessions/thread-cp/checkpoint-restores');
    expect(audit.status).toBe(200);
    expect(await readJson(audit)).toEqual({
      success: true,
      data: [{ id: 'restore-1', threadId: 'thread-cp' }],
    });
    service.canUserReadSession.mockReturnValue(false);
    const denied = await app.request(
      '/sessions/thread-other/checkpoints/turn-1/restore',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      },
    );
    expect(denied.status).toBe(404);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('GET /sessions/:threadId/builder-run is its own route, separate from /flow-run', async () => {
    const builderRun = {
      identityStatus: 'present',
      matchKind: 'correlation-matched',
      taskSlug: 'kontourai-station-1388',
      runRef: '.kontourai/flow/runs/kontourai-station-1388',
      flowRun: {
        run_id: 'kontourai-station-1388',
        definition_id: 'builder.build',
        definition_version: '1.3',
        status: 'active',
        current_step: 'verify',
        run_ref: '.kontourai/flow/runs/kontourai-station-1388',
        open_gate_ids: ['verify-gate'],
      },
    };
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      readSessionBuilderRun: vi
        .fn()
        .mockResolvedValueOnce(builderRun)
        .mockResolvedValueOnce(null),
      // Deliberately NOT stubbed to return anything: the Builder-run route
      // must not consult the station-delivery run at all.
      readSessionFlowRun: vi.fn(),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => ROUTE_TEST_USER_ID,
    });

    const joinedRes = await app.request('/sessions/thread-9/builder-run');
    expect(joinedRes.status).toBe(200);
    expect(await readJson(joinedRes)).toEqual({
      success: true,
      data: builderRun,
    });
    expect(service.readSessionBuilderRun).toHaveBeenCalledWith(
      'thread-9',
      personalReadAuthority(ROUTE_TEST_USER_ID),
    );
    expect(service.readSessionFlowRun).not.toHaveBeenCalled();

    const unjoinedRes = await app.request('/sessions/thread-9/builder-run');
    expect(unjoinedRes.status).toBe(404);
    expect(await readJson(unjoinedRes)).toEqual({
      success: false,
      error: 'No Builder run joined to session',
    });
  });

  test('terminal process routes expose summaries, detail, and cleanup', async () => {
    const terminalService = {
      listProcessSummaries: vi.fn().mockReturnValue([
        {
          kind: 'terminal',
          sessionId: 'project:t1',
          projectSlug: 'project',
          terminalId: 't1',
          cwd: '/tmp/project',
          status: 'running',
          pid: 12345,
          exitCode: null,
          hasRunningSubprocess: true,
          cols: 80,
          rows: 24,
        },
      ]),
      readProcess: vi.fn().mockImplementation((id: string) =>
        id === 'project:t1'
          ? {
              process: {
                kind: 'terminal',
                sessionId: 'project:t1',
                projectSlug: 'project',
                terminalId: 't1',
                cwd: '/tmp/project',
                status: 'running',
                pid: 12345,
                exitCode: null,
                hasRunningSubprocess: true,
                cols: 80,
                rows: 24,
              },
              history: 'npm run dev\n',
            }
          : null,
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const service = {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionReadModel: vi.fn().mockResolvedValue([]),
      listLoadedSessionReadModel: vi.fn().mockResolvedValue([]),
      readSession: vi.fn(),
      dispatch: vi.fn(),
    };
    const app = createOrchestrationRoutes(service as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      terminalService,
    });

    const listRes = await app.request('/processes/terminals');
    expect(await readJson(listRes)).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          sessionId: 'project:t1',
          hasRunningSubprocess: true,
        }),
      ],
    });

    const detailRes = await app.request('/processes/terminals/project:t1');
    expect(await readJson(detailRes)).toEqual({
      success: true,
      data: expect.objectContaining({
        process: expect.objectContaining({ sessionId: 'project:t1' }),
        history: 'npm run dev\n',
      }),
    });

    const closeRes = await app.request('/processes/terminals/project:t1', {
      method: 'DELETE',
    });
    expect(await readJson(closeRes)).toEqual({
      success: true,
      data: { sessionId: 'project:t1' },
    });
    expect(terminalService.close).toHaveBeenCalledWith('project:t1');
  });

  test('hosted terminal routes are uniformly unavailable before TerminalService reads or closes', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'tenant-alpha', authority: 'alpha.station.test' }],
    });
    const terminalService = {
      listProcessSummaries: vi.fn(),
      readProcess: vi.fn(),
      close: vi.fn(),
    };
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      terminalService,
      hostedTenantRegistry: registry,
    });

    const [list, detail, close] = await Promise.all([
      app.request('/processes/terminals'),
      app.request('/processes/terminals/project:t1'),
      app.request('/processes/terminals/project:t1', { method: 'DELETE' }),
    ]);

    expect(list.status).toBe(404);
    expect(detail.status).toBe(404);
    expect(close.status).toBe(404);
    expect(terminalService.listProcessSummaries).not.toHaveBeenCalled();
    expect(terminalService.readProcess).not.toHaveBeenCalled();
    expect(terminalService.close).not.toHaveBeenCalled();
  });

  test('GET /events streams the initial snapshot and subsequent canonical events', async () => {
    const eventBus = new EventBus();
    const service = {
      listProviders: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([
        {
          provider: 'claude',
          threadId: 'thread-1',
          status: 'running',
          model: 'claude-sonnet',
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:01.000Z',
        },
      ]),
      listSessionReadModel: vi.fn().mockResolvedValue([
        {
          provider: 'claude',
          threadId: 'thread-1',
          status: 'running',
          model: 'claude-sonnet',
          isLoaded: true,
          isPersisted: true,
          eventCount: 1,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:01.000Z',
        },
      ]),
      canUserReadSession: vi.fn().mockReturnValue(true),
      dispatch: vi.fn(),
      readEventStreamHead: vi.fn().mockReturnValue(0),
      readEventGlobalSequence: vi.fn().mockReturnValue(undefined),
      readEventStreamReplay: vi.fn().mockReturnValue([]),
    };
    const app = createOrchestrationRoutes(service as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus,
      logger: { debug: vi.fn() },
    });

    const res = await app.request('/events');
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 0));
    eventBus.emit('orchestration:event', {
      event: {
        provider: 'claude',
        threadId: 'thread-1',
        createdAt: '2026-03-28T00:00:02.000Z',
        method: 'request.opened',
        requestId: 'req-1',
        requestType: 'approval',
        title: 'Allow Read',
      },
    });

    const payload = await readStreamUntil(res.body!, (text) => {
      return (
        text.includes('event: orchestration:snapshot') &&
        text.includes('event: orchestration:event')
      );
    });

    expect(payload).toContain('event: orchestration:snapshot');
    expect(payload).toContain('"threadId":"thread-1"');
    expect(payload).toContain('"isLoaded":true');
    expect(payload).toContain('event: orchestration:event');
    expect(payload).toContain('"requestId":"req-1"');
  });

  test('hosted SSE carries one request authority through snapshot, live buffering, and replay without placing a tenant on the wire (#1707)', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'tenant-alpha', authority: 'alpha.station.test' },
        { id: 'tenant-bravo', authority: 'bravo.station.test' },
      ],
    });
    const eventBus = new EventBus();
    const replayedEvent = {
      provider: 'claude',
      threadId: 'thread-a',
      turnId: 'turn-alpha',
      eventId: 'alpha-replay-event',
      createdAt: '2026-08-09T08:00:00.000Z',
      method: 'turn.completed',
    } as CanonicalRuntimeEvent;
    const service = {
      listSessionReadModel: vi
        .fn()
        .mockResolvedValue([{ threadId: 'thread-a', provider: 'claude' }]),
      canUserReadSession: vi.fn(
        (threadId: string, authority: any) =>
          authority.tenantExecutionContext?.tenantId === 'tenant-alpha' &&
          threadId === 'thread-a',
      ),
      readEventStreamHead: vi.fn().mockReturnValue(1),
      readEventGlobalSequence: vi.fn().mockReturnValue(1),
      readEventStreamReplay: vi.fn(
        (_cursor: number, _options: unknown, authority: any) =>
          authority.tenantExecutionContext?.tenantId === 'tenant-alpha'
            ? [{ payload: replayedEvent, globalSequence: 1 }]
            : [],
      ),
      readEventStreamReplayPlan: vi.fn(
        (_cursor: number, _options: unknown, authority: any) => ({
          count:
            authority.tenantExecutionContext?.tenantId === 'tenant-alpha'
              ? 1
              : 0,
          fitsBudget: true,
        }),
      ),
      replayTurnProvenanceSidecar: vi.fn((event: CanonicalRuntimeEvent) =>
        event.eventId === 'alpha-replay-event'
          ? { provenance: { marker: 'alpha-sidecar' } }
          : {},
      ),
    };
    const routes = createOrchestrationRoutes(service as any, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'shared-hosted-user',
      hostedTenantRegistry: registry,
    });
    const app = new Hono();
    app.use('*', createHostedTenantMiddleware(registry));
    app.route('', routes);
    const request = (
      tenantId = 'tenant-alpha',
      headers: Record<string, string> = {},
    ) =>
      app.fetch(
        new Request('http://station.test/events', {
          headers: {
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_TENANT_HEADER]: tenantId,
            ...headers,
          },
        }),
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as any,
      );

    const snapshotResponse = await request();
    // `streamSSE` registers its listener asynchronously after `fetch`
    // returns; let that setup complete before publishing the live controls.
    await new Promise((resolve) => setTimeout(resolve, 0));
    eventBus.emit('orchestration:event', {
      event: { threadId: 'thread-b', eventId: 'bravo-event', secret: 'bravo' },
    });
    eventBus.emit('orchestration:event', {
      event: { threadId: 'thread-a', eventId: 'alpha-event', secret: 'alpha' },
    });
    const livePayload = await readStreamUntil(snapshotResponse.body!, (text) =>
      text.includes('"secret":"alpha"'),
    );
    expect(livePayload).toContain('event: orchestration:snapshot');
    expect(livePayload).toContain('"secret":"alpha"');
    expect(livePayload).not.toContain('"secret":"bravo"');
    expect(livePayload).not.toContain('tenant-alpha');
    const snapshotAuthority = service.listSessionReadModel.mock.calls[0][0];
    expect(service.canUserReadSession).toHaveBeenCalledWith(
      'thread-a',
      snapshotAuthority,
    );

    const replayResponse = await request('tenant-alpha', {
      'Last-Event-ID': '0',
    });
    const replayPayload = await readStreamUntil(replayResponse.body!, (text) =>
      text.includes('alpha-sidecar'),
    );
    expect(replayPayload).toContain('alpha-replay-event');
    expect(replayPayload).toContain('alpha-sidecar');
    expect(service.readEventStreamReplay).toHaveBeenCalledWith(
      0,
      { limit: ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 1 },
      expect.objectContaining({
        mode: 'hosted',
        tenantExecutionContext: { tenantId: 'tenant-alpha', source: 'request' },
      }),
    );

    const deniedReplayResponse = await request('tenant-bravo', {
      'Last-Event-ID': '0',
    });
    const deniedReplayPayload = await readStreamUntil(
      deniedReplayResponse.body!,
      (text) => text.includes('event: orchestration:caughtUp'),
    );
    expect(deniedReplayPayload).not.toContain('alpha-replay-event');
    expect(deniedReplayPayload).not.toContain('alpha-sidecar');
    expect(service.readEventStreamReplay).toHaveBeenCalledWith(
      0,
      { limit: ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 1 },
      expect.objectContaining({
        mode: 'hosted',
        tenantExecutionContext: { tenantId: 'tenant-bravo', source: 'request' },
      }),
    );
  });

  /**
   * archive#1778 delta review, finding 1 — THE SEAM THE COMPILER DOES NOT
   * REACH.
   *
   * The SSE snapshot is one of the six claimed emission routes, and it is the
   * only one where the payload leaves through `JSON.stringify` rather than a
   * typed return: the handler at `orchestration.ts` serialises whatever
   * `listSessionReadModel` returned, and `JSON.stringify` accepts anything.
   * The verifier deleted `answerability` at the handler and both the 66-test
   * route suite and `typecheck:server` stayed green — "the compiler is the
   * enumerator" is true of construction, not of serialisation.
   *
   * So this asserts the BYTES on the frame, from the route handler, not the
   * service's return value round-tripped inside a test process.
   */
  test('the orchestration:snapshot frame carries answerability on the wire', async () => {
    const eventBus = new EventBus();
    const decorated = {
      provider: 'claude',
      threadId: 'thread-stranded',
      status: 'running',
      controlMode: 'station-owned',
      isLoaded: true,
      isPersisted: true,
      eventCount: 1,
      lifecycleState: 'review_pending',
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:01.000Z',
      answerability: {
        answerable: false,
        qualification: 'provider_absent',
        observedBy: 'station-under-test#7',
        observedAt: '2026-03-28T00:04:03.000Z',
      },
    };
    const service = {
      listProviders: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionReadModel: vi.fn().mockResolvedValue([decorated]),
      canUserReadSession: vi.fn().mockReturnValue(true),
      dispatch: vi.fn(),
      readEventStreamHead: vi.fn().mockReturnValue(0),
      readEventGlobalSequence: vi.fn().mockReturnValue(undefined),
      readEventStreamReplay: vi.fn().mockReturnValue([]),
    };
    const app = createOrchestrationRoutes(service as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus,
      logger: { debug: vi.fn() },
    });

    const res = await app.request('/events');
    expect(res.status).toBe(200);

    const payload = await readStreamUntil(res.body!, (text) =>
      text.includes('event: orchestration:snapshot'),
    );

    // Parse the frame rather than substring-matching the field name: a
    // `"answerability"` appearing anywhere in the buffer would satisfy a
    // `toContain`, including in a different frame.
    const line = payload
      .split('\n')
      .find((candidate) => candidate.startsWith('data: '));
    expect(line).toBeDefined();
    const frame = JSON.parse((line as string).slice('data: '.length)) as {
      sessions: Array<{ threadId: string; answerability?: unknown }>;
    };
    const session = frame.sessions.find(
      (entry) => entry.threadId === 'thread-stranded',
    );
    expect(session).toBeDefined();
    // The whole basis, not just presence: the observer and the moment are
    // what make this a record of an observation rather than a label, and
    // they have to survive the wire for a client to read them.
    expect(session?.answerability).toEqual({
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'station-under-test#7',
      observedAt: '2026-03-28T00:04:03.000Z',
    });
  });

  test('orchestrationEventMatchesThread filters by threadId', () => {
    const thread1 = { event: { threadId: 'thread-1', method: 'turn.started' } };
    // No filter → forward everything (the all-sessions stream).
    expect(orchestrationEventMatchesThread(thread1, undefined)).toBe(true);
    // Filter set → only the matching session passes.
    expect(orchestrationEventMatchesThread(thread1, 'thread-1')).toBe(true);
    expect(orchestrationEventMatchesThread(thread1, 'thread-2')).toBe(false);
    // Malformed payloads never match a set filter (fail-closed).
    expect(orchestrationEventMatchesThread({}, 'thread-1')).toBe(false);
    expect(orchestrationEventMatchesThread(undefined, 'thread-1')).toBe(false);
  });

  test('GET /events?threadId scopes the stream to one session', async () => {
    const eventBus = new EventBus();
    const service = {
      listSessionReadModel: vi.fn().mockResolvedValue([]),
      canUserReadSession: vi.fn().mockReturnValue(true),
      dispatch: vi.fn(),
      readEventStreamHead: vi.fn().mockReturnValue(0),
      readEventGlobalSequence: vi.fn().mockReturnValue(undefined),
      readEventStreamReplay: vi.fn().mockReturnValue([]),
    };
    const app = createOrchestrationRoutes(service as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus,
      logger: { debug: vi.fn() },
    });

    const res = await app.request('/events?threadId=thread-1');
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    // A different session's event must NOT reach this subscriber...
    eventBus.emit('orchestration:event', {
      event: {
        provider: 'claude',
        threadId: 'thread-2',
        createdAt: '2026-03-28T00:00:02.000Z',
        method: 'request.opened',
        requestId: 'req-other',
        requestType: 'approval',
        title: 'Other session',
      },
    });
    // ...only the subscribed session's event does.
    eventBus.emit('orchestration:event', {
      event: {
        provider: 'claude',
        threadId: 'thread-1',
        createdAt: '2026-03-28T00:00:03.000Z',
        method: 'request.opened',
        requestId: 'req-mine',
        requestType: 'approval',
        title: 'My session',
      },
    });

    const payload = await readStreamUntil(res.body!, (text) =>
      text.includes('"requestId":"req-mine"'),
    );
    expect(payload).toContain('"requestId":"req-mine"');
    expect(payload).not.toContain('"requestId":"req-other"');
  });

  describe('GET /events authorization gate (station#1164)', () => {
    // Integration coverage for archive#1164: every other test in this file mocks
    // `canUserReadSession` permanently open, so none of them prove the real
    // route actually consults it, or that a denied user's frames are
    // genuinely withheld. This suite stands up a REAL `OrchestrationService`
    // (real EventStore, real EventBus, a minimal-but-real adapter) so
    // ownership is resolved from durable storage exactly like production.
    let tmp: string;
    let eventStore: EventStore;
    let eventBus: EventBus;
    let adapter: GateTestAdapter;
    let service: OrchestrationService;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'orchestration-routes-gate-'));
      eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
      eventBus = new EventBus();
      adapter = new GateTestAdapter();
      service = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(adapter),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      service.initialize();
    });

    afterEach(() => {
      eventStore.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    test('returns one authorized root conversation with exact root and child events', async () => {
      const rootId = 'route-conversation-root';
      const childId = 'route-conversation-child';
      eventStore.upsertSession({
        provider: 'claude',
        threadId: rootId,
        status: 'closed',
        createdAt: '2026-08-24T02:00:00.000Z',
        updatedAt: '2026-08-24T02:00:01.000Z',
      });
      eventStore.reserveNextConversationSession({
        conversationId: rootId,
        predecessorSessionId: rootId,
        proposedSessionId: childId,
        createdAt: '2026-08-24T02:00:02.000Z',
      });
      eventStore.upsertSession({
        provider: 'claude',
        threadId: childId,
        status: 'closed',
        createdAt: '2026-08-24T02:00:02.000Z',
        updatedAt: '2026-08-24T02:00:03.000Z',
      });
      for (const [threadId, turnId, prompt] of [
        [rootId, 'route-turn-root', 'first route question'],
        [childId, 'route-turn-child', 'second route question'],
      ] as const) {
        eventStore.appendEvent({
          eventId: `${turnId}-configured`,
          provider: 'claude',
          threadId,
          createdAt: '2026-08-24T02:00:03.000Z',
          method: 'session.configured',
          sessionId: threadId,
          metadata: { userId: 'owner-user' },
        });
        eventStore.appendEvent({
          eventId: `${turnId}-started`,
          provider: 'claude',
          threadId,
          turnId,
          createdAt: '2026-08-24T02:00:04.000Z',
          method: 'turn.started',
          prompt,
        });
      }
      const app = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'owner-user',
      });

      const response = await app.request(
        `/conversations/${rootId}/event-window?turnLimit=10`,
      );
      const body = await readJson(response);

      expect(response.status).toBe(200);
      expect(body).toEqual({
        success: true,
        data: expect.objectContaining({
          conversationId: rootId,
          currentSessionId: childId,
          events: [
            expect.objectContaining({
              event: expect.objectContaining({ threadId: rootId }),
            }),
            expect.objectContaining({
              event: expect.objectContaining({ threadId: childId }),
            }),
            expect.objectContaining({
              event: expect.objectContaining({ threadId: childId }),
            }),
          ],
        }),
      });
    });

    test.each([
      ['reserved', undefined],
      ['failed', 'failed'],
      ['indeterminate', 'indeterminate'],
    ] as const)(
      'reload keeps an authorized %s boundary child as current while serving its predecessor transcript',
      async (_label, transition) => {
        const rootId = `route-boundary-${_label}`;
        const childId = `${rootId}:child`;
        eventStore.upsertSession({
          provider: 'claude',
          threadId: rootId,
          status: 'closed',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        });
        eventStore.appendEvent({
          eventId: `${rootId}:configured`,
          provider: 'claude',
          threadId: rootId,
          sessionId: rootId,
          createdAt: '2026-08-25T00:00:01.000Z',
          method: 'session.configured',
          metadata: { userId: 'owner-user' },
        });
        eventStore.appendEvent({
          eventId: `${rootId}:turn`,
          provider: 'claude',
          threadId: rootId,
          turnId: `${rootId}:turn`,
          createdAt: '2026-08-25T00:00:02.000Z',
          method: 'turn.started',
          prompt: 'predecessor transcript',
        });
        eventStore.reserveConversationContextBoundary({
          boundaryId: `route-boundary-${_label}`,
          conversationId: rootId,
          predecessorSessionId: rootId,
          successorSessionId: childId,
          idempotencyKey: `route-key-${_label}`,
          policy: 'empty-next-cold-start',
          status: 'reserved',
          actorId: 'owner-user',
          createdAt: '2026-08-25T00:00:03.000Z',
        });
        if (transition) {
          eventStore.claimConversationContextBoundaryColdStart(
            `route-boundary-${_label}`,
            `route-start-${_label}`,
            '2026-08-25T00:00:04.000Z',
          );
          if (transition === 'failed') {
            eventStore.releaseConversationContextBoundaryFailedClaim(
              `route-boundary-${_label}`,
              '2026-08-25T00:00:05.000Z',
            );
          } else {
            eventStore.markConversationContextBoundaryIndeterminate(
              `route-boundary-${_label}`,
              '2026-08-25T00:00:05.000Z',
            );
          }
        }
        const app = createOrchestrationRoutes(service, {
          eventBus,
          logger: { debug: vi.fn() },
          getUserId: () => 'owner-user',
        });

        const response = await app.request(
          `/conversations/${rootId}/event-window?turnLimit=10`,
        );
        const body = await readJson(response);

        expect(response.status).toBe(200);
        expect(body).toEqual({
          success: true,
          data: expect.objectContaining({
            conversationId: rootId,
            currentSessionId: childId,
            session: expect.objectContaining({ threadId: rootId }),
            events: [
              expect.objectContaining({
                event: expect.objectContaining({
                  eventId: `${rootId}:turn`,
                  threadId: rootId,
                }),
              }),
            ],
          }),
        });
      },
    );

    test('returns 404 for an unrelated latest missing child', async () => {
      const rootId = 'route-unrelated-missing-child';
      eventStore.upsertSession({
        provider: 'claude',
        threadId: rootId,
        status: 'closed',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      eventStore.appendEvent({
        eventId: `${rootId}:configured`,
        provider: 'claude',
        threadId: rootId,
        sessionId: rootId,
        createdAt: '2026-08-25T00:00:01.000Z',
        method: 'session.configured',
        metadata: { userId: 'owner-user' },
      });
      eventStore.reserveNextConversationSession({
        conversationId: rootId,
        predecessorSessionId: rootId,
        proposedSessionId: `${rootId}:missing`,
        createdAt: '2026-08-25T00:00:02.000Z',
      });
      const app = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'owner-user',
      });

      await expect(
        app.request(`/conversations/${rootId}/event-window?turnLimit=10`),
      ).resolves.toMatchObject({ status: 404 });
    });

    test.each(['boundary', 'handoff'] as const)(
      'returns 404 for a materialized foreign-owner %s child without disclosing its identity',
      async (kind) => {
        const rootId = `route-denied-${kind}`;
        const childId = `${rootId}:child`;
        eventStore.upsertSession({
          provider: 'claude',
          threadId: rootId,
          status: 'closed',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        });
        eventStore.appendEvent({
          eventId: `${rootId}:configured`,
          provider: 'claude',
          threadId: rootId,
          sessionId: rootId,
          createdAt: '2026-08-25T00:00:01.000Z',
          method: 'session.configured',
          metadata: { userId: 'owner-user' },
        });
        if (kind === 'boundary') {
          eventStore.reserveConversationContextBoundary({
            boundaryId: `${kind}-denied`,
            conversationId: rootId,
            predecessorSessionId: rootId,
            successorSessionId: childId,
            idempotencyKey: `${kind}-denied`,
            policy: 'empty-next-cold-start',
            status: 'reserved',
            actorId: 'owner-user',
            createdAt: '2026-08-25T00:00:02.000Z',
          });
        } else {
          eventStore.reserveConversationHandoff({
            conversationId: rootId,
            predecessorSessionId: rootId,
            sessionId: childId,
            idempotencyKey: `${kind}-denied`,
            targetAgentId: 'codex',
            targetEnvironmentId: 'environment-a',
            messageDigest: 'message-a',
            createdAt: '2026-08-25T00:00:02.000Z',
          });
        }
        eventStore.upsertSession({
          provider: 'claude',
          threadId: childId,
          status: 'closed',
          createdAt: '2026-08-25T00:00:03.000Z',
          updatedAt: '2026-08-25T00:00:03.000Z',
        });
        eventStore.appendEvent({
          eventId: `${childId}:configured`,
          provider: 'claude',
          threadId: childId,
          sessionId: childId,
          createdAt: '2026-08-25T00:00:04.000Z',
          method: 'session.configured',
          metadata: { userId: 'foreign-user' },
        });
        const app = createOrchestrationRoutes(service, {
          eventBus,
          logger: { debug: vi.fn() },
          getUserId: () => 'owner-user',
        });

        const response = await app.request(
          `/conversations/${rootId}/event-window?turnLimit=10`,
        );
        expect(response.status).toBe(404);
        expect(JSON.stringify(await readJson(response))).not.toContain(childId);
      },
    );

    test('the owning user receives their session events and a different user does not (station#1164)', async () => {
      const ownerApp = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'owner-user',
      });
      const otherApp = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'other-user',
      });

      const ownerRes = await ownerApp.request('/events');
      const otherRes = await otherApp.request('/events');
      expect(ownerRes.status).toBe(200);
      expect(otherRes.status).toBe(200);
      // Let both SSE subscriptions register before any event is pushed
      // (mirrors this file's other GET /events tests).
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Establishes ownership: the FIRST event for thread-owner is itself
      // subject to the gate, exactly like production — `canUserReadSession`
      // must resolve the owner from the just-persisted event before this
      // same event is forwarded.
      adapter.events.push({
        eventId: 'evt-owner-session-started',
        provider: 'claude',
        threadId: 'thread-owner',
        createdAt: '2026-07-28T00:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-owner',
        initialState: 'created',
        metadata: { userId: 'owner-user' },
      } as CanonicalRuntimeEvent);
      // A distinguishing follow-up event on the SAME (now-owned) thread —
      // this is the secret the owner must see and the other user must not.
      adapter.events.push({
        eventId: 'evt-owner-secret',
        provider: 'claude',
        threadId: 'thread-owner',
        createdAt: '2026-07-28T00:00:01.000Z',
        method: 'request.opened',
        requestId: 'req-owner-secret',
        requestType: 'approval',
        title: 'Owner-only request',
      } as CanonicalRuntimeEvent);

      const ownerPayload = await readStreamUntil(ownerRes.body!, (text) =>
        text.includes('"requestId":"req-owner-secret"'),
      );
      expect(ownerPayload).toContain('"requestId":"req-owner-secret"');

      // A second, unrelated thread the OTHER user genuinely owns — used
      // only to give `otherRes`'s stream a deterministic marker to wait
      // for, so the absence check below isn't a timing guess. Because both
      // threads' events are pushed through the same adapter queue in this
      // exact order, and a single SSE connection's frames are written in
      // the order `forward()` is invoked, if `req-owner-secret` had ever
      // been (incorrectly) forwarded to `otherRes` it would already be in
      // the accumulated text by the time `req-other-own` arrives.
      adapter.events.push({
        eventId: 'evt-other-session-started',
        provider: 'claude',
        threadId: 'thread-other',
        createdAt: '2026-07-28T00:00:02.000Z',
        method: 'session.started',
        sessionId: 'thread-other',
        initialState: 'created',
        metadata: { userId: 'other-user' },
      } as CanonicalRuntimeEvent);
      adapter.events.push({
        eventId: 'evt-other-own',
        provider: 'claude',
        threadId: 'thread-other',
        createdAt: '2026-07-28T00:00:03.000Z',
        method: 'request.opened',
        requestId: 'req-other-own',
        requestType: 'approval',
        title: "Other user's own request",
      } as CanonicalRuntimeEvent);

      const otherPayload = await readStreamUntil(otherRes.body!, (text) =>
        text.includes('"requestId":"req-other-own"'),
      );
      expect(otherPayload).toContain('"requestId":"req-other-own"');
      // The gate: the other user's connection never received the owner's
      // event, even though it was pushed through the identical real
      // pipeline (real EventStore-backed ownership resolution, real
      // EventBus fan-out) as an event the other user WAS allowed to see.
      expect(otherPayload).not.toContain('"requestId":"req-owner-secret"');
      expect(otherPayload).not.toContain('thread-owner');
    });

    // archive#1197: the two live-path tests above prove `canUserReadSession`
    // gates the *live* forwarding branch. Neither exercises a reconnect —
    // `Last-Event-ID` is never sent, so `resolveStreamResumePlan` always
    // takes `no_cursor` -> `snapshot`, and the *replay* branches
    // (`orchestration.ts:902-908` thread-scoped, `:929-933` global) never
    // run. These tests reuse the identical real-service harness but send a
    // real `Last-Event-ID` header to force the replay decision, proving the
    // reconnect-resume path applies the same ownership gate.
    describe('GET /events reconnect-replay ownership gate (station#1197)', () => {
      test('AC1: a thread-scoped replay of a thread the caller does not own yields no events, and the connection is proven alive first', async () => {
        // Establish thread-owner's history BEFORE anyone reconnects, so a
        // `Last-Event-ID: 0` reconnect lands squarely on the replay branch
        // (`orchestration.ts:902-908`) rather than the live-forwarding path.
        adapter.events.push({
          eventId: 'evt-owner-session-started',
          provider: 'claude',
          threadId: 'thread-owner',
          createdAt: '2026-07-28T00:00:00.000Z',
          method: 'session.started',
          sessionId: 'thread-owner',
          initialState: 'created',
          metadata: { userId: 'owner-user' },
        } as CanonicalRuntimeEvent);
        adapter.events.push({
          eventId: 'evt-owner-secret',
          provider: 'claude',
          threadId: 'thread-owner',
          createdAt: '2026-07-28T00:00:01.000Z',
          method: 'request.opened',
          requestId: 'req-owner-secret',
          requestType: 'approval',
          title: 'Owner-only request',
        } as CanonicalRuntimeEvent);
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Liveness control, part 1: the attacker's OWN global connection
        // (same service, same real gate implementation) legitimately
        // receives an event it owns. This rules out "the harness/adapter
        // pipeline is silently dead" as an explanation for a later absence.
        const attackerGlobalApp = createOrchestrationRoutes(service, {
          eventBus,
          logger: { debug: vi.fn() },
          getUserId: () => 'other-user',
        });
        const attackerGlobalRes = await attackerGlobalApp.request('/events');
        expect(attackerGlobalRes.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 0));
        adapter.events.push({
          eventId: 'evt-attacker-session-started',
          provider: 'claude',
          threadId: 'thread-attacker',
          createdAt: '2026-07-28T00:00:02.000Z',
          method: 'session.started',
          sessionId: 'thread-attacker',
          initialState: 'created',
          metadata: { userId: 'other-user' },
        } as CanonicalRuntimeEvent);
        adapter.events.push({
          eventId: 'evt-attacker-own',
          provider: 'claude',
          threadId: 'thread-attacker',
          createdAt: '2026-07-28T00:00:03.000Z',
          method: 'request.opened',
          requestId: 'req-attacker-own',
          requestType: 'approval',
          title: "Attacker's own legitimate request",
        } as CanonicalRuntimeEvent);
        const attackerGlobalPayload = await readStreamUntil(
          attackerGlobalRes.body!,
          (text) => text.includes('"requestId":"req-attacker-own"'),
        );
        expect(attackerGlobalPayload).toContain(
          '"requestId":"req-attacker-own"',
        );

        // The actual attack: a thread-scoped reconnect-replay targeting the
        // thread the attacker does NOT own, via `?threadId=` + a real
        // `Last-Event-ID` header (this is what forces `threadReplayCandidates`
        // to be computed and the `plan.decision === 'replay'` branch to run).
        const attackerThreadApp = createOrchestrationRoutes(service, {
          eventBus,
          logger: { debug: vi.fn() },
          getUserId: () => 'other-user',
        });
        const attackerThreadRes = await attackerThreadApp.request(
          '/events?threadId=thread-owner',
          { headers: { 'Last-Event-ID': '0' } },
        );
        expect(attackerThreadRes.status).toBe(200);

        // Liveness control, part 2: THIS specific connection is proven alive
        // by waiting for the deterministic `orchestration:caughtUp` marker,
        // which is only written after the replay loop (the exact vulnerable
        // code) finishes iterating. A hung/errored connection never emits
        // it, so `readStreamUntil` would never resolve the matcher and the
        // test would fail (not silently pass) instead of racing a timer.
        const attackerThreadPayload = await readStreamUntil(
          attackerThreadRes.body!,
          (text) => text.includes('event: orchestration:caughtUp'),
        );
        expect(attackerThreadPayload).toContain(
          'event: orchestration:caughtUp',
        );
        // The specific leaked payload — never a generic count/length check.
        expect(attackerThreadPayload).not.toContain(
          '"requestId":"req-owner-secret"',
        );
        expect(attackerThreadPayload).not.toContain('thread-owner');
      });

      test('AC2: a global replay (no threadId) yields only events on threads the caller can read', async () => {
        // Owner's private history, persisted before anyone reconnects.
        adapter.events.push({
          eventId: 'evt-owner-session-started',
          provider: 'claude',
          threadId: 'thread-owner',
          createdAt: '2026-07-28T00:00:00.000Z',
          method: 'session.started',
          sessionId: 'thread-owner',
          initialState: 'created',
          metadata: { userId: 'owner-user' },
        } as CanonicalRuntimeEvent);
        adapter.events.push({
          eventId: 'evt-owner-secret',
          provider: 'claude',
          threadId: 'thread-owner',
          createdAt: '2026-07-28T00:00:01.000Z',
          method: 'request.opened',
          requestId: 'req-owner-secret',
          requestType: 'approval',
          title: 'Owner-only request',
        } as CanonicalRuntimeEvent);
        // The attacker's OWN history, also persisted before reconnecting —
        // on a global (no threadId) replay this lands in the SAME batch as
        // the owner's history, so the single reconnecting connection can
        // legitimately receive its own event before we check for the leak
        // (archive#1197 AC4).
        adapter.events.push({
          eventId: 'evt-attacker-session-started',
          provider: 'claude',
          threadId: 'thread-attacker',
          createdAt: '2026-07-28T00:00:02.000Z',
          method: 'session.started',
          sessionId: 'thread-attacker',
          initialState: 'created',
          metadata: { userId: 'other-user' },
        } as CanonicalRuntimeEvent);
        adapter.events.push({
          eventId: 'evt-attacker-own',
          provider: 'claude',
          threadId: 'thread-attacker',
          createdAt: '2026-07-28T00:00:03.000Z',
          method: 'request.opened',
          requestId: 'req-attacker-own',
          requestType: 'approval',
          title: "Attacker's own legitimate request",
        } as CanonicalRuntimeEvent);
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Global reconnect-replay (no `threadId` query) — exercises
        // `orchestration.ts:929-933`.
        const attackerApp = createOrchestrationRoutes(service, {
          eventBus,
          logger: { debug: vi.fn() },
          getUserId: () => 'other-user',
        });
        const attackerRes = await attackerApp.request('/events', {
          headers: { 'Last-Event-ID': '0' },
        });
        expect(attackerRes.status).toBe(200);

        // Alive + received its own legitimate event first...
        const payload = await readStreamUntil(attackerRes.body!, (text) =>
          text.includes('"requestId":"req-attacker-own"'),
        );
        expect(payload).toContain('"requestId":"req-attacker-own"');
        // ...only then assert the specific leaked payload is absent.
        expect(payload).not.toContain('"requestId":"req-owner-secret"');
        expect(payload).not.toContain('thread-owner');
      });

      test('AC3: a legitimate owner reconnecting sees their own thread-scoped and global replay history unaffected', async () => {
        adapter.events.push({
          eventId: 'evt-owner-session-started',
          provider: 'claude',
          threadId: 'thread-owner',
          createdAt: '2026-07-28T00:00:00.000Z',
          method: 'session.started',
          sessionId: 'thread-owner',
          initialState: 'created',
          metadata: { userId: 'owner-user' },
        } as CanonicalRuntimeEvent);
        adapter.events.push({
          eventId: 'evt-owner-secret',
          provider: 'claude',
          threadId: 'thread-owner',
          createdAt: '2026-07-28T00:00:01.000Z',
          method: 'request.opened',
          requestId: 'req-owner-secret',
          requestType: 'approval',
          title: 'Owner-only request',
        } as CanonicalRuntimeEvent);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const ownerApp = createOrchestrationRoutes(service, {
          eventBus,
          logger: { debug: vi.fn() },
          getUserId: () => 'owner-user',
        });

        // Thread-scoped replay, as the legitimate owner (mirrors AC1's
        // attacker request shape exactly, minus the identity).
        const ownerThreadRes = await ownerApp.request(
          '/events?threadId=thread-owner',
          { headers: { 'Last-Event-ID': '0' } },
        );
        expect(ownerThreadRes.status).toBe(200);
        const ownerThreadPayload = await readStreamUntil(
          ownerThreadRes.body!,
          (text) => text.includes('"requestId":"req-owner-secret"'),
        );
        expect(ownerThreadPayload).toContain('"requestId":"req-owner-secret"');

        // Global replay, as the legitimate owner (mirrors AC2's attacker
        // request shape exactly, minus the identity).
        const ownerGlobalRes = await ownerApp.request('/events', {
          headers: { 'Last-Event-ID': '0' },
        });
        expect(ownerGlobalRes.status).toBe(200);
        const ownerGlobalPayload = await readStreamUntil(
          ownerGlobalRes.body!,
          (text) => text.includes('"requestId":"req-owner-secret"'),
        );
        expect(ownerGlobalPayload).toContain('"requestId":"req-owner-secret"');
      });
    });

    test('bounds the authenticated event-window HTTP body after near-ingress tool output', async () => {
      eventStore.upsertSession({
        provider: 'claude',
        threadId: 'thread-window-budget',
        status: 'ready',
        createdAt: '2026-08-09T04:00:00.000Z',
        updatedAt: '2026-08-09T04:00:02.000Z',
      });
      eventStore.appendEvent({
        eventId: 'window-owner',
        provider: 'claude',
        threadId: 'thread-window-budget',
        createdAt: '2026-08-09T04:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-window-budget',
        metadata: { userId: 'owner-user' },
      });
      eventStore.appendEvent({
        eventId: 'window-turn',
        provider: 'claude',
        threadId: 'thread-window-budget',
        turnId: 'turn-budget',
        createdAt: '2026-08-09T04:00:01.000Z',
        method: 'turn.started',
      } as CanonicalRuntimeEvent);
      eventStore.appendEvent({
        eventId: 'window-tool',
        provider: 'claude',
        threadId: 'thread-window-budget',
        turnId: 'turn-budget',
        createdAt: '2026-08-09T04:00:02.000Z',
        method: 'tool.completed',
        toolCallId: 'tool-budget',
        // EventStore's durable ingress backstop rejects megabyte payloads;
        // this remains far above the route's compact snapshot projection.
        output: 'x'.repeat(60_000),
      } as CanonicalRuntimeEvent);
      eventStore.appendEvent({
        eventId: 'window-delta',
        provider: 'claude',
        threadId: 'thread-window-budget',
        turnId: 'turn-budget',
        createdAt: '2026-08-09T04:00:03.000Z',
        method: 'content.text-delta',
        itemId: 'window-item',
        delta: 'y'.repeat(60_000),
      } as CanonicalRuntimeEvent);
      for (let turn = 0; turn < 10; turn += 1) {
        const turnId = `window-many-${turn}`;
        eventStore.appendEvent({
          eventId: `${turnId}-start`,
          provider: 'claude',
          threadId: 'thread-window-budget',
          turnId,
          createdAt: `2026-08-09T05:${String(turn).padStart(2, '0')}:00.000Z`,
          method: 'turn.started',
        } as CanonicalRuntimeEvent);
        for (let index = 0; index < 60; index += 1)
          eventStore.appendEvent({
            eventId: `${turnId}-${index}`,
            provider: 'claude',
            threadId: 'thread-window-budget',
            turnId,
            createdAt: `2026-08-09T05:${String(turn).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
            method: 'content.text-delta',
            itemId: `${turnId}-item-${index}`,
            delta: 'z'.repeat(2_048),
          } as CanonicalRuntimeEvent);
      }
      const app = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'owner-user',
      });

      // Provider cursors are opaque; this must not consume the bounded
      // recovery response's JSON budget.
      eventStore.upsertSession({
        provider: 'claude',
        threadId: 'thread-window-budget',
        status: 'ready',
        resumeCursor: 'resume-'.repeat(10_000),
        createdAt: '2026-08-09T04:00:00.000Z',
        updatedAt: '2026-08-09T04:00:02.000Z',
      });

      const response = await app.request(
        '/sessions/thread-window-budget/event-window',
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
        SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES,
      );
      expect(body).not.toContain('x'.repeat(1_000));
      expect(body).not.toContain('y'.repeat(1_000));

      // The stream snapshot has its own route contract; restore the normal
      // provider state before proving its bounded event projection.
      eventStore.upsertSession({
        provider: 'claude',
        threadId: 'thread-window-budget',
        status: 'ready',
        createdAt: '2026-08-09T04:00:00.000Z',
        updatedAt: '2026-08-09T04:00:02.000Z',
      });

      const streamResponse = await app.request(
        '/events?threadId=thread-window-budget',
      );
      const snapshotFrame = await readStreamUntil(
        streamResponse.body!,
        (text) => text.includes('orchestration:snapshot'),
      );
      expect(streamResponse.status).toBe(200);
      expect(Buffer.byteLength(snapshotFrame)).toBeLessThan(64_000);
      expect(snapshotFrame).not.toContain('x'.repeat(1_000));
    });

    test('the authenticated event-window route keeps max-shape cursors compact while traversing 20 UUID turns and a fan-out once', async () => {
      const threadId = 'thread-window-route-cursor';
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: '2026-08-09T06:00:00.000Z',
        updatedAt: '2026-08-09T06:00:03.000Z',
      });
      eventStore.appendEvent({
        eventId: 'cursor-owner',
        provider: 'claude',
        threadId,
        createdAt: '2026-08-09T06:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
        metadata: { userId: 'owner-user' },
      });
      const expectedIds = new Set<string>();
      for (let index = 1; index <= 21; index += 1) {
        const turnId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        const eventId = `cursor-turn-${index}`;
        eventStore.appendEvent({
          eventId,
          provider: 'claude',
          threadId,
          turnId,
          createdAt: new Date(Date.UTC(2026, 7, 9, 6, 0, index)).toISOString(),
          method: 'turn.started',
          prompt: `turn ${index}`,
        } as CanonicalRuntimeEvent);
        expectedIds.add(eventId);
        if (index === 21) {
          for (let fanOut = 1; fanOut <= 160; fanOut += 1) {
            const fanOutId = `cursor-fan-out-${fanOut}`;
            eventStore.appendEvent({
              eventId: fanOutId,
              provider: 'claude',
              threadId,
              turnId,
              createdAt: new Date(
                Date.UTC(2026, 7, 9, 6, 1, fanOut),
              ).toISOString(),
              method: 'content.text-delta',
              itemId: `fan-out-${fanOut}`,
              delta: String(fanOut),
            } as CanonicalRuntimeEvent);
            expectedIds.add(fanOutId);
          }
        }
      }
      const app = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'owner-user',
      });

      const pages = [
        await readJson(
          await app.request(`/sessions/${threadId}/event-window?turnLimit=20`),
        ),
      ];
      let cursor = pages[0].data.nextCursor as string | undefined;
      while (cursor) {
        expect(cursor.length).toBeLessThanOrEqual(512);
        const response = await app.request(
          `/sessions/${threadId}/event-window?turnLimit=20&cursor=${encodeURIComponent(cursor)}`,
        );
        expect(response.status).toBe(200);
        const page = await readJson(response);
        pages.push(page);
        cursor = page.data.nextCursor as string | undefined;
        expect(pages.length).toBeLessThanOrEqual(5);
      }
      const ids = pages.flatMap((page) =>
        page.data.events.map(
          (item: { event: { eventId: string } }) => item.event.eventId,
        ),
      );
      expect(new Set(ids)).toEqual(expectedIds);
      expect(ids).toHaveLength(expectedIds.size);
      expect(pages.at(-1)?.data.hasMore).toBe(false);
    });
  });

  describe('parseResumeCursor', () => {
    test('accepts a plain non-negative integer', () => {
      expect(parseResumeCursor('0')).toBe(0);
      expect(parseResumeCursor('42')).toBe(42);
    });

    test('rejects missing, malformed, or foreign-format values (fail-closed to snapshot)', () => {
      expect(parseResumeCursor(undefined)).toBeUndefined();
      expect(parseResumeCursor(null)).toBeUndefined();
      expect(parseResumeCursor('')).toBeUndefined();
      expect(parseResumeCursor('-1')).toBeUndefined();
      expect(parseResumeCursor('not-a-number')).toBeUndefined();
      expect(parseResumeCursor('12.5')).toBeUndefined();
      expect(parseResumeCursor('1e3')).toBeUndefined();
    });
  });

  describe('resolveStreamResumePlan', () => {
    test('no cursor always snapshots', () => {
      expect(resolveStreamResumePlan(undefined, 500)).toEqual({
        decision: 'snapshot',
        reason: 'no_cursor',
      });
    });

    test('a cursor ahead of head (stale/foreign/post-wipe) snapshots as invalid', () => {
      expect(resolveStreamResumePlan(10, 5)).toEqual({
        decision: 'snapshot',
        reason: 'invalid_cursor',
      });
    });

    test('a cursor exactly at the gap threshold still replays', () => {
      const head = ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 100;
      const cursor = head - ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD;
      expect(resolveStreamResumePlan(cursor, head)).toEqual({
        decision: 'replay',
        reason: 'within_threshold',
        gap: ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD,
      });
    });

    test('a cursor one past the gap threshold snapshots', () => {
      const head = ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 100;
      const cursor = head - ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD - 1;
      expect(resolveStreamResumePlan(cursor, head)).toEqual({
        decision: 'snapshot',
        reason: 'gap_exceeded',
        gap: ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 1,
      });
    });

    test('cursor equal to head replays zero events (nothing missed)', () => {
      expect(resolveStreamResumePlan(500, 500)).toEqual({
        decision: 'replay',
        reason: 'within_threshold',
        gap: 0,
      });
    });
  });

  describe('GET /events sequence-cursor resume (station#1092)', () => {
    let dir: string;
    let eventStore: EventStore;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'orchestration-resume-'));
      eventStore = new EventStore(join(dir, 'orchestration.sqlite'));
    });

    afterEach(() => {
      eventStore.close();
      rmSync(dir, { recursive: true, force: true });
    });

    function persistEvent(eventId: string, threadId: string, index: number) {
      eventStore.appendEvent({
        eventId,
        provider: 'claude',
        threadId,
        createdAt: `2026-03-28T00:00:${String(index).padStart(2, '0')}.000Z`,
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: eventId,
      });
    }

    test('a below-threshold oversized replay switches to a bounded snapshot frame', async () => {
      for (let index = 1; index <= 401; index += 1) {
        eventStore.appendEvent({
          eventId: `budget-${index}`,
          provider: 'claude',
          threadId: 'thread-replay-budget',
          createdAt: `2026-08-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
          method: 'content.text-delta',
          itemId: `item-${index}`,
          delta: 'x'.repeat(3_000),
        });
      }
      const app = createOrchestrationRoutes(
        makeResumeTestService(eventStore) as any,
        {
          getUserId: () => ROUTE_TEST_USER_ID,
          eventBus: new EventBus(),
          logger: { debug: vi.fn() },
        },
      );

      const payloadReads = vi.spyOn(
        eventStore,
        'listEventsAfterGlobalSequence',
      );
      const response = await app.request('/events', {
        headers: { 'Last-Event-ID': '0' },
      });
      const payload = await readStreamUntil(response.body!, (text) =>
        text.includes('orchestration:caughtUp'),
      );

      expect(response.status).toBe(200);
      expect(payload).toContain('orchestration:snapshot');
      expect(Buffer.byteLength(payload)).toBeLessThan(128_000);
      expect(
        payload.slice(0, payload.indexOf('orchestration:snapshot')),
      ).not.toContain('orchestration:event');
      expect(payloadReads).not.toHaveBeenCalled();
    });

    // archive#1410 (D2): a turn that completed while the client was
    // disconnected is delivered ONLY by this replay branch — the live publish
    // already happened, and nothing here triggers a REST refetch — so the
    // replayed frame must carry the same provenance sibling the live frame
    // did, or that turn's card is missing until the next remount.
    test('a turn completed during the disconnect replays with its provenance sidecar', async () => {
      eventStore.appendEvent({
        eventId: 'evt-seen',
        provider: 'claude',
        threadId: 'thread-replay',
        createdAt: '2026-08-01T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-r1',
        metadata: { effectiveModel: 'claude-sonnet-9' },
      });
      eventStore.appendEvent({
        eventId: 'evt-missed',
        provider: 'claude',
        threadId: 'thread-replay',
        createdAt: '2026-08-01T00:00:01.000Z',
        method: 'turn.completed',
        turnId: 'turn-r1',
        finishReason: 'stop',
      });

      const service = makeResumeTestService(eventStore);
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
      });

      // Client applied the turn.started (sequence 1), then dropped.
      const res = await app.request('/events', {
        headers: { 'Last-Event-ID': '1' },
      });
      expect(res.status).toBe(200);

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('orchestration:caughtUp'),
      );

      const frame = payload
        .split('\n')
        .find(
          (line) => line.startsWith('data: ') && line.includes('evt-missed'),
        );
      expect(frame).toBeDefined();
      const parsed = JSON.parse(frame!.slice('data: '.length));
      expect(parsed.event).toMatchObject({
        eventId: 'evt-missed',
        method: 'turn.completed',
      });
      expect(parsed.provenance).toMatchObject({
        envelopeVersion: 1,
        sessionId: 'thread-replay',
        turnId: 'turn-r1',
        outcome: 'completed',
        requestedModel: { state: 'observed', value: 'claude-sonnet-9' },
      });
      // The canonical event stays untouched — the envelope is a sibling.
      expect(parsed.event.provenance).toBeUndefined();
    });

    test('a replayed non-terminal event carries no provenance sibling', async () => {
      persistEvent('evt-a', 'thread-plain', 1);
      persistEvent('evt-b', 'thread-plain', 2);
      const service = makeResumeTestService(eventStore);
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
      });

      const res = await app.request('/events', {
        headers: { 'Last-Event-ID': '1' },
      });
      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('orchestration:caughtUp'),
      );
      const frame = payload
        .split('\n')
        .find((line) => line.startsWith('data: ') && line.includes('evt-b'));
      expect(
        JSON.parse(frame!.slice('data: '.length)).provenance,
      ).toBeUndefined();
    });

    test('AC1/R1: a cursor within the gap threshold replays exactly what was missed, then continues live with no duplicates', async () => {
      persistEvent('evt-1', 'thread-1', 1);
      persistEvent('evt-2', 'thread-1', 2);
      // Client already applied evt-1 (global_sequence 1) before disconnecting.
      const eventBus = new EventBus();
      const service = makeResumeTestService(eventStore);
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus,
        logger: { debug: vi.fn() },
      });

      const res = await app.request('/events', {
        headers: { 'Last-Event-ID': '1' },
      });
      expect(res.status).toBe(200);

      // A live event fired after the historical replay is captured too.
      persistEvent('evt-3', 'thread-1', 3);
      await new Promise((resolve) => setTimeout(resolve, 0));
      eventBus.emit('orchestration:event', {
        event: {
          eventId: 'evt-3',
          provider: 'claude',
          threadId: 'thread-1',
          createdAt: '2026-03-28T00:00:03.000Z',
          method: 'content.text-delta',
          itemId: 'item-1',
          delta: 'evt-3',
        },
      });

      const payload = await readStreamUntil(
        res.body!,
        (text) => text.includes('"eventId":"evt-3"') && text.includes('id: 3'),
      );

      // The missed event replays with its real global-sequence id...
      expect(payload).toMatch(
        /event: orchestration:event\ndata: .*evt-2.*\nid: 2/,
      );
      // ...the caught-up marker follows...
      expect(payload).toContain('event: orchestration:caughtUp');
      // ...and the live event arrives after, with its own id, exactly once.
      const liveOccurrences = payload.split('"eventId":"evt-3"').length - 1;
      expect(liveOccurrences).toBe(1);
      // No fresh snapshot was sent on the replay path.
      expect(payload).not.toContain('event: orchestration:snapshot');
      // The caught-up marker comes strictly before the live event in the
      // byte stream (R4 ordering fence).
      expect(payload.indexOf('orchestration:caughtUp')).toBeLessThan(
        payload.indexOf('"eventId":"evt-3"'),
      );
    });

    test('AC2/R2: a cursor further behind than the gap threshold falls back to a fresh snapshot with a new resume cursor', async () => {
      for (
        let index = 0;
        index < ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 5;
        index += 1
      ) {
        persistEvent(`evt-bulk-${index}`, 'thread-bulk', index);
      }
      const head = eventStore.headGlobalSequence();
      expect(head).toBe(ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 5);

      const eventBus = new EventBus();
      const service = makeResumeTestService(eventStore);
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus,
        logger: { debug: vi.fn() },
      });

      // Cursor at 1 is (head - 1) behind — well past the threshold.
      const res = await app.request('/events', {
        headers: { 'Last-Event-ID': '1' },
      });
      expect(res.status).toBe(200);

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('event: orchestration:snapshot'),
      );
      expect(payload).toContain('event: orchestration:snapshot');
      expect(payload).toContain(`id: ${head}`);
      // The bulk of individually-replayed old events never streams.
      expect(payload).not.toContain('"eventId":"evt-bulk-0"');
    });

    test('review fix (HIGH): a thread-scoped reconnect replays its own small gap even when a different thread produced far more than the gap threshold in between', async () => {
      persistEvent('mine-1', 'thread-mine', 0);
      persistEvent('other-0', 'thread-other', 1);
      persistEvent('mine-2', 'thread-mine', 2);
      persistEvent('mine-3', 'thread-mine', 3);

      // Foreign-thread traffic affects the global head but is not part of this
      // thread's replay candidates. Inject that independently observable head
      // at the service seam instead of materializing 1,000 unrelated SQLite
      // writes and making correctness depend on the host finishing them before
      // Vitest's test deadline.
      const head = ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 2;
      // The GLOBAL gap from cursor=1 (mine-1) is way past the threshold —
      // this is exactly the shape that forced an incorrect snapshot before
      // the fix (a threadId-scoped connection based its decision on
      // cross-thread head, not its own thread's missed count).
      expect(head - 1).toBeGreaterThan(
        ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD,
      );

      const eventBus = new EventBus();
      const readEventStreamHead = vi.fn(() => head);
      const service = makeResumeTestService(eventStore, {
        readEventStreamHead,
      });
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus,
        logger: { debug: vi.fn() },
      });
      expect(readEventStreamHead()).toBe(head);

      const res = await app.request('/events?threadId=thread-mine', {
        headers: { 'Last-Event-ID': '1' },
      });
      expect(res.status).toBe(200);

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"eventId":"mine-3"'),
      );

      // Own missed events replay, with their real global-sequence ids...
      expect(payload).toMatch(
        /event: orchestration:event\ndata: .*mine-2.*\nid: \d+/,
      );
      expect(payload).toMatch(
        /event: orchestration:event\ndata: .*mine-3.*\nid: \d+/,
      );
      // ...and NOT via a fresh snapshot (which would have silently dropped
      // them: the client skips its reconnect refetch when resume-capable,
      // and `Last-Event-ID` would have already advanced past them).
      expect(payload).not.toContain('event: orchestration:snapshot');
      expect(readEventStreamHead).toHaveBeenCalledTimes(2);
      // The representative foreign-thread event never streams to this
      // subscriber — scoping still works.
      expect(payload).not.toContain('"eventId":"other-0"');
    });

    test('review fix: a genuine per-thread overflow (threadId scoped) still falls back to snapshot', async () => {
      for (
        let index = 0;
        index < ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 5;
        index += 1
      ) {
        persistEvent(`big-${index}`, 'thread-big', index);
      }
      const head = eventStore.headGlobalSequence();

      const eventBus = new EventBus();
      const service = makeResumeTestService(eventStore);
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus,
        logger: { debug: vi.fn() },
      });

      const res = await app.request('/events?threadId=thread-big', {
        headers: { 'Last-Event-ID': '1' },
      });
      expect(res.status).toBe(200);

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('event: orchestration:snapshot'),
      );
      expect(payload).toContain('event: orchestration:snapshot');
      expect(payload).toContain(`id: ${head}`);
      expect(payload).not.toContain('"eventId":"big-0"');
    });

    test('AC4: a cursor-less connect keeps the pre-#1092 snapshot-first behavior byte-for-byte', async () => {
      persistEvent('evt-1', 'thread-1', 1);
      const eventBus = new EventBus();
      const service = makeResumeTestService(eventStore, {
        listSessionReadModel: vi
          .fn()
          .mockResolvedValue([
            { threadId: 'thread-1', provider: 'claude', status: 'running' },
          ]),
      });
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus,
        logger: { debug: vi.fn() },
      });

      const res = await app.request('/events');
      expect(res.status).toBe(200);

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('event: orchestration:caughtUp'),
      );
      expect(payload).toContain('event: orchestration:snapshot');
      expect(payload).toContain('"threadId":"thread-1"');
      expect(payload).not.toContain('event: orchestration:event');
    });

    test('an invalid (ahead-of-head) cursor falls back to snapshot rather than throwing', async () => {
      persistEvent('evt-1', 'thread-1', 1);
      const eventBus = new EventBus();
      const service = makeResumeTestService(eventStore);
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus,
        logger: { debug: vi.fn() },
      });

      const res = await app.request('/events', {
        headers: { 'Last-Event-ID': '999999' },
      });
      expect(res.status).toBe(200);

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('event: orchestration:snapshot'),
      );
      expect(payload).toContain('event: orchestration:snapshot');
    });

    test('R4 ordering fence: a live event emitted mid-snapshot-fetch never overtakes the caught-up marker', async () => {
      // Adversarial timing: hold `listSessionReadModel`'s promise open so a
      // live event fired *during* the historical-frame fetch has every
      // opportunity to race ahead if the subscribe-then-buffer fence didn't
      // hold. Without the fence, this event would land before (or
      // interleaved with) the snapshot/caught-up frames instead of after.
      let releaseSnapshotFetch: () => void = () => {};
      const snapshotFetchGate = new Promise<void>((resolve) => {
        releaseSnapshotFetch = resolve;
      });
      const eventBus = new EventBus();
      const service = makeResumeTestService(eventStore, {
        listSessionReadModel: vi.fn().mockImplementation(async () => {
          await snapshotFetchGate;
          return [];
        }),
      });
      const app = createOrchestrationRoutes(service as any, {
        getUserId: () => ROUTE_TEST_USER_ID,
        eventBus,
        logger: { debug: vi.fn() },
      });

      const resPromise = app.request('/events');
      // Give the route's synchronous subscribe-then-buffer setup a tick to
      // run before the racing event fires.
      await new Promise((resolve) => setTimeout(resolve, 0));
      persistEvent('evt-race', 'thread-1', 1);
      eventBus.emit('orchestration:event', {
        event: {
          eventId: 'evt-race',
          provider: 'claude',
          threadId: 'thread-1',
          createdAt: '2026-03-28T00:00:01.000Z',
          method: 'content.text-delta',
          itemId: 'item-1',
          delta: 'evt-race',
        },
      });
      // Only now does the snapshot fetch resolve and the historical +
      // caught-up frames get written.
      releaseSnapshotFetch();

      const res = await resPromise;
      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"eventId":"evt-race"'),
      );

      const snapshotIndex = payload.indexOf('event: orchestration:snapshot');
      const caughtUpIndex = payload.indexOf('event: orchestration:caughtUp');
      const liveEventIndex = payload.indexOf('"eventId":"evt-race"');
      expect(snapshotIndex).toBeGreaterThanOrEqual(0);
      expect(caughtUpIndex).toBeGreaterThan(snapshotIndex);
      expect(liveEventIndex).toBeGreaterThan(caughtUpIndex);
    });
  });
});
