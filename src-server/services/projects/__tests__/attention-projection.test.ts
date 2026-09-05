import type { Notification } from '@kontourai/station-contracts/notification';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import { sessionAttentionDisposition } from '@kontourai/station-contracts/session-attention';
import {
  SESSION_LIFECYCLE_STATES,
  type SessionLifecycleState,
} from '@kontourai/station-contracts/session-lifecycle';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import { projectRequestAnswerability } from '../../orchestration/open-requests.js';
import {
  AttentionProjectionService,
  buildSessionFailedItem,
} from '../attention-projection.js';

const now = '2026-07-23T12:00:00.000Z';

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-default',
    createdAt: now,
    updatedAt: now,
    provider: 'test',
    status: 'idle',
    controlMode: 'station-owned',
    isLoaded: false,
    isPersisted: true,
    eventCount: 0,
    ...overrides,
  };
}

/**
 * archive#1779: the attention projection now reads `session.answerability`
 * off the summaries `listSessionReadModel` hands it — the decoration the
 * server computes once at emission (ADR 0012) — instead of calling a private
 * service channel. These fixtures therefore decorate through the REAL
 * derivation rather than pinning a constant: a stub that always answered
 * `answerable` would silently contradict production for every past-resuming
 * session, which is exactly the class of case the archive#1284 block below
 * exists to pin.
 *
 * The two process-local facts the pure function cannot know are supplied
 * here: threads are not attached in these fixtures, and providers are
 * registered unless the test names the thread in `unanswerable` (the
 * `provider_absent` arm).
 */
function decorate(unanswerable: string[]) {
  return (session: unknown) => {
    const summary = session as {
      threadId: string;
      lifecycleState?: SessionLifecycleState;
    };
    return {
      ...summary,
      answerability: projectRequestAnswerability({
        threadAttachment: 'detached',
        lifecycleState: summary.lifecycleState,
        providerRegistered: !unanswerable.includes(summary.threadId),
        observedBy: 'test-instance#0',
        observedAt: now,
      }),
    };
  };
}

function makeService(opts: {
  notifications?: Notification[];
  sessions?: unknown[];
  flowRuns?: Record<string, unknown>;
  console?: Record<string, { gates: unknown[] }>;
  approvalRegistry?: {
    has: (approvalId: string) => boolean;
    canRead?: (approvalId: string, authority: unknown) => boolean;
  };
  sessionEvents?: Record<string, unknown[]>;
  /** threadIds the read-time projection reports as unanswerable (archive#1745). */
  unanswerable?: string[];
  /** archive#1914: the acknowledgement store, and the identity that scopes it. */
  acknowledgementStore?: {
    get(userId: string, conversationId: string): string | undefined;
    acknowledge(input: {
      userId: string;
      conversationId: string;
      updatedAt: string;
    }): void;
  };
  getUserId?: () => string;
  /** #765 D5: the pairing service's current request list. */
  pairingRequests?: unknown[];
  /**
   * #1536 D8: what stands between Station's own Agent and running. A function
   * lets a test change the requirement between reads (review M2).
   */
  stationSetupRequirement?:
    | { agentSlug: string; agentName: string; reason: string }
    | null
    | (() => { agentSlug: string; agentName: string; reason: string } | null);
}) {
  const {
    notifications = [],
    sessions = [],
    flowRuns = {},
    console = {},
    approvalRegistry,
    sessionEvents = {},
    unanswerable = [],
    acknowledgementStore,
    getUserId,
    pairingRequests,
    stationSetupRequirement,
  } = opts;
  // Production receives a complete registry dependency. Keep older fixtures
  // terse while supplying its harmless personal-mode default explicitly.
  const projectionApprovalRegistry = approvalRegistry
    ? {
        has: approvalRegistry.has,
        canRead: approvalRegistry.canRead ?? (() => true),
      }
    : undefined;
  return new AttentionProjectionService(
    { list: () => notifications } as never,
    {
      listSessionReadModel: async () => sessions.map(decorate(unanswerable)),
      readSessionFlowRun: async (threadId: string) =>
        flowRuns[threadId] ?? null,
      // Defaults every thread to "no events" (never null) so a session with
      // no explicit `sessionEvents` entry falls through to the honest
      // lifecycle-only fallback rather than throwing — mirrors
      // OrchestrationService.readSession's real "session with no events"
      // shape, just never the "session not found at all" null case (no test
      // here needs that distinction).
      readSession: async (threadId: string) => ({
        session: {} as never,
        events: sessionEvents[threadId] ?? [],
      }),
    } as never,
    {
      getRunConsole: async (_cwd: string, runId: string) =>
        console[runId] ?? { gates: [] },
    } as never,
    projectionApprovalRegistry,
    acknowledgementStore,
    getUserId,
    pairingRequests
      ? () => ({ listRequests: () => pairingRequests as never })
      : undefined,
    stationSetupRequirement === undefined
      ? undefined
      : async () =>
          typeof stationSetupRequirement === 'function'
            ? stationSetupRequirement()
            : stationSetupRequirement,
  );
}

function requestOpened(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    provider: 'test',
    threadId: 'thread-default',
    createdAt: now,
    requestId: 'req-1',
    method: 'request.opened',
    requestType: 'approval',
    title: 'Allow bash',
    ...overrides,
  };
}

function requestResolved(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    provider: 'test',
    threadId: 'thread-default',
    createdAt: now,
    requestId: 'req-1',
    method: 'request.resolved',
    status: 'approved',
    ...overrides,
  };
}

function registryApproval(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'registry-approval-1',
    source: 'approval-inbox',
    category: 'approval-request',
    title: 'Allow tool',
    priority: 'high',
    status: 'delivered',
    createdAt: now,
    updatedAt: now,
    actions: [{ id: 'accept', label: 'Allow Once' }],
    metadata: {
      requestKind: 'registry',
      approvalId: 'approval-registry-1',
      sessionId: 'conversation-1',
      sessionKind: 'managed',
    },
    ...overrides,
  };
}

describe('AttentionProjectionService', () => {
  test('does not project bravo attention or acknowledgements to hosted alpha', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.example.test' },
        { id: 'bravo', authority: 'bravo.example.test' },
      ],
    });
    const alpha = sessionReadAuthorityFromRequest(
      'alpha',
      { tenantId: registry.tenants[0].id },
      registry,
    );
    const acknowledgementStore = {
      get: () => undefined,
      acknowledge: () => {},
    };
    const projection = new AttentionProjectionService(
      {
        list: () => [
          {
            id: 'bravo-notification',
            source: 'approval-inbox',
            category: 'approval-request',
            title: 'bravo secret',
            priority: 'high',
            status: 'delivered',
            createdAt: now,
            updatedAt: now,
            metadata: { sessionId: 'bravo-session' },
          },
        ],
      } as never,
      {
        listSessionReadModel: async (authority: any) =>
          authority.tenantExecutionContext?.tenantId === 'alpha'
            ? [
                baseSession({
                  threadId: 'alpha-session',
                  lifecycleState: 'needs_input',
                  answerability: { answerable: true },
                }),
              ]
            : [
                baseSession({
                  threadId: 'bravo-session',
                  lifecycleState: 'needs_input',
                  answerability: { answerable: true },
                }),
              ],
        readSessionFlowRun: async () => null,
        readSession: async () => ({ session: {} as never, events: [] }),
      } as never,
      { getRunConsole: async () => ({ gates: [] }) } as never,
      undefined,
      acknowledgementStore,
    );

    const result = await projection.list(alpha);
    expect(JSON.stringify(result)).not.toContain('bravo');
    expect(
      await projection.acknowledge('session-failed:bravo-session', alpha),
    ).toBe(false);
  });

  test('keeps active persisted approvals and suppresses their lifecycle duplicate', async () => {
    const notification: Notification = {
      id: 'approval-1',
      source: 'approval-inbox',
      category: 'approval-request',
      title: 'Allow tool',
      priority: 'high',
      status: 'delivered',
      createdAt: now,
      updatedAt: now,
      actions: [{ id: 'accept', label: 'Allow Once' }],
      metadata: { sessionId: 'thread/one', sessionKind: 'runtime' },
    };
    const projection = makeService({
      notifications: [notification],
      sessions: [
        baseSession({
          threadId: 'thread/one',
          lifecycleState: 'review_pending',
        }),
        baseSession({
          threadId: 'thread two',
          lifecycleState: 'needs_input',
        }),
      ],
    });

    await expect(projection.list()).resolves.toEqual({
      pendingCount: 2,
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'approval',
          openHref: activityDeepLink({ sessionId: 'thread/one' }),
        }),
        expect.objectContaining({
          kind: 'needs_input',
          openHref: activityDeepLink({ sessionId: 'thread two' }),
        }),
      ]),
    });
  });

  test('filters closed approval notifications and routes project sessions to chat', async () => {
    const projection = makeService({
      notifications: [
        {
          id: 'closed',
          source: 'approval-inbox',
          category: 'approval-request',
          title: 'Closed',
          priority: 'high',
          status: 'actioned',
          createdAt: now,
          updatedAt: now,
        },
      ],
      sessions: [
        baseSession({
          threadId: 'thread',
          lifecycleState: 'review_pending',
          projectSlug: 'my project',
        }),
      ],
    });

    await expect(projection.list()).resolves.toEqual({
      pendingCount: 1,
      items: [
        expect.objectContaining({
          kind: 'review_pending',
          // archive#1284 AC4: the project-scoped href now carries dock=open.
          openHref: '/projects/my%20project?chat=thread&dock=open',
        }),
      ],
    });
  });

  test('derives all three gate kinds from the Flow console projection', async () => {
    const sessions = [
      baseSession({
        threadId: 'thread-route-back',
        lifecycleState: 'running',
        projectSlug: 'proj-a',
      }),
      baseSession({
        threadId: 'thread-blocked',
        lifecycleState: 'running',
        projectSlug: 'proj-a',
      }),
      baseSession({
        threadId: 'thread-exception',
        lifecycleState: 'running',
        projectSlug: 'proj-a',
      }),
    ];
    const flowRuns = {
      'thread-route-back': {
        runId: 'run-1',
        definitionId: 'd1',
        cwd: '/proj-a',
        run: { openGates: [{ id: 'build-gate', step: 'build' }] },
      },
      'thread-blocked': {
        runId: 'run-2',
        definitionId: 'd1',
        cwd: '/proj-a',
        run: { openGates: [{ id: 'test-gate', step: 'test' }] },
      },
      'thread-exception': {
        runId: 'run-3',
        definitionId: 'd1',
        cwd: '/proj-a',
        run: { openGates: [{ id: 'verify-gate', step: 'verify' }] },
      },
    };
    const consoleByRun = {
      'run-1': {
        gates: [
          {
            id: 'build-gate',
            step_id: 'build',
            status: 'route-back',
            is_open: true,
            route_back_to: 'implement',
            attempt: 2,
            max_attempts: 3,
          },
        ],
      },
      'run-2': {
        gates: [
          {
            id: 'test-gate',
            step_id: 'test',
            status: 'block',
            is_open: true,
          },
        ],
      },
      'run-3': {
        gates: [
          {
            id: 'verify-gate',
            step_id: 'verify',
            status: 'block',
            is_open: true,
            limit_exceeded: true,
          },
        ],
      },
    };

    const service = makeService({ sessions, flowRuns, console: consoleByRun });
    const result = await service.list();

    expect(result.pendingCount).toBe(3);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'gate-route-back',
          title: 'Route back: build',
          routeBackTo: 'implement',
          attempt: 2,
          maxAttempts: 3,
          openHref: '/projects/proj-a/flow-console?run=run-1',
          source: {
            threadId: 'thread-route-back',
            runId: 'run-1',
            gateId: 'build-gate',
            projectSlug: 'proj-a',
          },
        }),
        expect.objectContaining({
          kind: 'gate-blocked',
          title: 'Blocked: test',
          openHref: '/projects/proj-a/flow-console?run=run-2',
        }),
        expect.objectContaining({
          kind: 'gate-exception',
          title: 'Exception pending: verify',
          limitExceeded: true,
          openHref: '/projects/proj-a/flow-console?run=run-3',
        }),
      ]),
    );
  });

  test('a gate-exception item takes precedence over the review lifecycle shadow for the same session', async () => {
    const sessions = [
      baseSession({
        threadId: 'thread-both',
        lifecycleState: 'review_pending',
        projectSlug: 'proj-b',
      }),
    ];
    const flowRuns = {
      'thread-both': {
        runId: 'run-9',
        definitionId: 'd1',
        cwd: '/proj-b',
        run: { openGates: [{ id: 'gate-9', step: 'verify' }] },
      },
    };
    const consoleByRun = {
      'run-9': {
        gates: [
          {
            id: 'gate-9',
            step_id: 'verify',
            status: 'block',
            is_open: true,
            limit_exceeded: true,
          },
        ],
      },
    };

    const service = makeService({ sessions, flowRuns, console: consoleByRun });
    const result = await service.list();

    expect(result.pendingCount).toBe(1);
    expect(result.items[0].kind).toBe('gate-exception');
  });

  test('does not surface a gate whose exception was already accepted', async () => {
    const sessions = [
      baseSession({
        threadId: 'thread-accepted',
        lifecycleState: 'running',
        projectSlug: 'proj-c',
      }),
    ];
    const flowRuns = {
      'thread-accepted': {
        runId: 'run-4',
        definitionId: 'd1',
        cwd: '/proj-c',
        run: { openGates: [{ id: 'gate-4', step: 'verify' }] },
      },
    };
    const consoleByRun = {
      'run-4': {
        gates: [
          {
            id: 'gate-4',
            step_id: 'verify',
            status: 'block',
            is_open: true,
            limit_exceeded: true,
            accepted_exception_id: 'ex-1',
          },
        ],
      },
    };

    const service = makeService({ sessions, flowRuns, console: consoleByRun });
    const result = await service.list();

    expect(result.pendingCount).toBe(0);
  });

  test('skips gate derivation for terminal sessions and sessions without an open Flow run', async () => {
    const sessions = [
      baseSession({ threadId: 'thread-done', lifecycleState: 'completed' }),
      baseSession({ threadId: 'thread-no-run', lifecycleState: 'running' }),
    ];
    const flowRuns = {
      'thread-no-run': null,
    };

    const service = makeService({ sessions, flowRuns });
    const result = await service.list();

    expect(result.pendingCount).toBe(0);
  });

  test('gate copy uses verdict vocabulary and never the word "approval"', async () => {
    const sessions = [
      baseSession({
        threadId: 'thread-route-back',
        lifecycleState: 'running',
        projectSlug: 'proj-a',
      }),
      baseSession({
        threadId: 'thread-blocked',
        lifecycleState: 'running',
        projectSlug: 'proj-a',
      }),
      baseSession({
        threadId: 'thread-exception',
        lifecycleState: 'running',
        projectSlug: 'proj-a',
      }),
    ];
    const flowRuns = {
      'thread-route-back': {
        runId: 'run-1',
        definitionId: 'd1',
        cwd: '/proj-a',
        run: { openGates: [{ id: 'build-gate', step: 'build' }] },
      },
      'thread-blocked': {
        runId: 'run-2',
        definitionId: 'd1',
        cwd: '/proj-a',
        run: { openGates: [{ id: 'test-gate', step: 'test' }] },
      },
      'thread-exception': {
        runId: 'run-3',
        definitionId: 'd1',
        cwd: '/proj-a',
        run: { openGates: [{ id: 'verify-gate', step: 'verify' }] },
      },
    };
    const consoleByRun = {
      'run-1': {
        gates: [
          {
            id: 'build-gate',
            step_id: 'build',
            status: 'route-back',
            is_open: true,
          },
        ],
      },
      'run-2': {
        gates: [
          { id: 'test-gate', step_id: 'test', status: 'block', is_open: true },
        ],
      },
      'run-3': {
        gates: [
          {
            id: 'verify-gate',
            step_id: 'verify',
            status: 'block',
            is_open: true,
            limit_exceeded: true,
          },
        ],
      },
    };

    const service = makeService({ sessions, flowRuns, console: consoleByRun });
    const result = await service.list();

    expect(result.pendingCount).toBe(3);
    for (const item of result.items) {
      expect(item.title.toLowerCase()).not.toContain('approval');
    }
    const kinds = result.items.map((item) => item.kind).sort();
    expect(kinds).toEqual([
      'gate-blocked',
      'gate-exception',
      'gate-route-back',
    ]);
  });

  test('an approval-request notification without resolvable session metadata omits openHref (no dead "Open session" link)', async () => {
    // Mirrors a synthetic notification POSTed to /notifications with only
    // {title, body, category: 'approval-request'} — no metadata at all, so
    // there is no session to deep-link into.
    const notification: Notification = {
      id: 'synthetic-1',
      source: 'api',
      category: 'approval-request',
      title: 'Synthetic notice',
      body: 'No session behind this one.',
      priority: 'normal',
      status: 'delivered',
      createdAt: now,
      updatedAt: now,
    };
    const projection = makeService({ notifications: [notification] });

    const result = await projection.list();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ kind: 'approval', title: 'Synthetic notice' }),
    );
    expect(result.items[0]).not.toHaveProperty('openHref');
  });

  test('an approval-request notification with a sessionId but no resolvable project/kind still omits openHref', async () => {
    // sessionId alone (no projectSlug, no runtime/managed sessionKind) is
    // not enough for approvalOpenHref to resolve a real deep link.
    const notification: Notification = {
      id: 'partial-1',
      source: 'api',
      category: 'approval-request',
      title: 'Partial metadata',
      priority: 'normal',
      status: 'delivered',
      createdAt: now,
      updatedAt: now,
      metadata: { sessionId: 'thread-partial' },
    };
    const projection = makeService({ notifications: [notification] });

    const result = await projection.list();

    expect(result.items[0]).not.toHaveProperty('openHref');
  });

  test('orphan expiry: a registry-backed approval whose ApprovalRegistry entry no longer exists is not projected as active', async () => {
    const projection = makeService({
      notifications: [registryApproval()],
      approvalRegistry: { has: () => false },
    });

    const result = await projection.list();

    expect(result.items).toHaveLength(0);
    expect(result.pendingCount).toBe(0);
  });

  test('orphan expiry: a registry-backed approval whose ApprovalRegistry entry still exists stays active', async () => {
    const projection = makeService({
      notifications: [registryApproval()],
      approvalRegistry: { has: (id) => id === 'approval-registry-1' },
    });

    const result = await projection.list();

    expect(result.items).toHaveLength(1);
    expect(result.pendingCount).toBe(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ kind: 'approval' }),
    );
  });

  test('orphan expiry: without an approvalRegistry dependency (unwired callers) registry-backed approvals keep projecting (unchanged behavior)', async () => {
    const projection = makeService({ notifications: [registryApproval()] });

    const result = await projection.list();

    expect(result.items).toHaveLength(1);
    expect(result.pendingCount).toBe(1);
  });

  test('hosted attention suppresses unbound approvals while personal attention remains unchanged', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
    });
    const hostedAuthority = sessionReadAuthorityFromRequest(
      'alpha-user',
      { tenantId: registry.tenants[0].id },
      registry,
    );
    const notification = registryApproval({
      metadata: { requestKind: 'registry', approvalId: 'unbound' },
    });
    const projection = makeService({
      notifications: [notification],
      approvalRegistry: { has: () => true, canRead: () => false },
    });

    expect((await projection.list(hostedAuthority)).items).toHaveLength(0);
    expect((await projection.list()).items).toHaveLength(1);
  });

  test('orphan expiry: an approval notification without requestKind metadata (synthetic/legacy) is never treated as orphaned', async () => {
    const projection = makeService({
      notifications: [
        {
          id: 'synthetic-2',
          source: 'api',
          category: 'approval-request',
          title: 'Synthetic notice',
          priority: 'normal',
          status: 'delivered',
          createdAt: now,
          updatedAt: now,
        },
      ],
      approvalRegistry: { has: () => false },
    });

    const result = await projection.list();

    expect(result.items).toHaveLength(1);
    expect(result.pendingCount).toBe(1);
  });

  test('a session with both an open approval and a gate-exception keeps both items (approval never dropped)', async () => {
    const notification: Notification = {
      id: 'approval-2',
      source: 'approval-inbox',
      category: 'approval-request',
      title: 'Allow tool',
      priority: 'high',
      status: 'delivered',
      createdAt: now,
      updatedAt: now,
      actions: [{ id: 'accept', label: 'Allow Once' }],
      metadata: { sessionId: 'thread-both', sessionKind: 'runtime' },
    };
    const projection = makeService({
      notifications: [notification],
      sessions: [
        baseSession({
          threadId: 'thread-both',
          lifecycleState: 'review_pending',
          projectSlug: 'proj-a',
        }),
      ],
      flowRuns: {
        'thread-both': {
          runId: 'run-both',
          definitionId: 'd1',
          cwd: '/proj-a',
          run: { openGates: [{ id: 'verify-gate', step: 'verify' }] },
        },
      },
      console: {
        'run-both': {
          gates: [
            {
              id: 'verify-gate',
              step_id: 'verify',
              status: 'block',
              is_open: true,
              limit_exceeded: true,
            },
          ],
        },
      },
    });

    const result = await projection.list();
    const kinds = result.items.map((item) => item.kind).sort();
    // Both decision surfaces survive; only the coarser lifecycle shadow
    // (review_pending) is suppressed.
    expect(kinds).toEqual(['approval', 'gate-exception']);
    expect(result.pendingCount).toBe(2);
  });

  // archive#1185: needs_input/review_pending items project from the open
  // request.opened event's requestType — the real evidence the owner asked
  // for — instead of a hardcoded "Input needed"/"Review pending" constant.
  describe('request evidence (station#1185)', () => {
    test('an approval request produces a title naming the tool', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-approval',
            lifecycleState: 'review_pending',
          }),
        ],
        sessionEvents: {
          'thread-approval': [
            requestOpened({
              threadId: 'thread-approval',
              requestType: 'approval',
              title: 'Allow bash',
              payload: { toolName: 'bash', toolInput: { command: 'ls -la' } },
            }),
          ],
        },
      });

      const result = await projection.list();

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          kind: 'review_pending',
          title: 'Tool call awaiting approval: bash',
          requestType: 'approval',
        }),
      );
      expect(result.items[0].body).toContain('args: {command}');
    });

    test('a permission request produces a title naming the tool', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-permission',
            lifecycleState: 'review_pending',
          }),
        ],
        sessionEvents: {
          'thread-permission': [
            requestOpened({
              threadId: 'thread-permission',
              requestType: 'permission',
              title: 'Approve permissions',
              payload: { tool: 'filesystem-write' },
            }),
          ],
        },
      });

      const result = await projection.list();

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          kind: 'review_pending',
          title: 'Tool call awaiting approval: filesystem-write',
          requestType: 'permission',
          // Exact match, not just toContain: this is the "permission" row
          // of the PR body's example table — previously only verified by
          // code trace (review finding #5).
          body: 'Approve permissions',
        }),
      );
    });

    test('an input request produces a question-shaped title carrying the actual ask', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-input',
            lifecycleState: 'needs_input',
          }),
        ],
        sessionEvents: {
          'thread-input': [
            requestOpened({
              threadId: 'thread-input',
              requestType: 'input',
              title: 'Which environment should I deploy to?',
            }),
          ],
        },
      });

      const result = await projection.list();

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          kind: 'needs_input',
          title:
            'The agent asked a question: Which environment should I deploy to?',
          requestType: 'input',
        }),
      );
    });

    test('a confirmation request produces a question-shaped title', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-confirm',
            lifecycleState: 'needs_input',
          }),
        ],
        sessionEvents: {
          'thread-confirm': [
            requestOpened({
              threadId: 'thread-confirm',
              requestType: 'confirmation',
              title: 'Delete the staging database?',
            }),
          ],
        },
      });

      const result = await projection.list();

      expect(result.items[0].title).toBe(
        'Confirmation needed: Delete the staging database?',
      );
      expect(result.items[0]).toEqual(
        expect.objectContaining({ requestType: 'confirmation' }),
      );
    });

    test('description reaches body', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-desc',
            lifecycleState: 'needs_input',
          }),
        ],
        sessionEvents: {
          'thread-desc': [
            requestOpened({
              threadId: 'thread-desc',
              requestType: 'input',
              title: 'Pick a plan',
              description: 'Free tier caps out at 10 requests/minute.',
            }),
          ],
        },
      });

      const result = await projection.list();

      expect(result.items[0].body).toBe(
        'Free tier caps out at 10 requests/minute.',
      );
    });

    test('a large/secret-ish payload is bounded and never leaks argument values', async () => {
      const secret = 'sk-live-super-secret-token-value-1234567890';
      const hugeBlob = 'x'.repeat(10_000);
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-secret',
            lifecycleState: 'review_pending',
          }),
        ],
        sessionEvents: {
          'thread-secret': [
            requestOpened({
              threadId: 'thread-secret',
              requestType: 'approval',
              title: 'Allow http_request',
              payload: {
                toolName: 'http_request',
                toolInput: {
                  apiKey: secret,
                  authorization: `Bearer ${secret}`,
                  body: hugeBlob,
                },
              },
            }),
          ],
        },
      });

      const result = await projection.list();
      const item = result.items[0];

      expect(item.body).not.toContain(secret);
      expect(item.body).not.toContain(hugeBlob);
      expect(item.title).not.toContain(secret);
      // Field-name shape summary, not values — bounded length overall.
      expect(item.body).toContain('apiKey');
      expect(item.body).toContain('authorization');
      expect((item.body ?? '').length).toBeLessThan(300);
      // Exact match, not just toContain: this is the secret-payload row of
      // the PR body's example table (title AND full body) — previously
      // only verified by code trace (review finding #5).
      expect(item.title).toBe('Tool call awaiting approval: http_request');
      expect(item.body).toBe(
        'Allow http_request — args: {apiKey, authorization, body}',
      );
    });

    test('a secret used as an object key (not just a value) is bounded per-key, never leaked verbatim (review finding #4)', async () => {
      const secretKey = 'sk-live-super-secret-token-value-ABC123';
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-secret-key',
            lifecycleState: 'review_pending',
          }),
        ],
        sessionEvents: {
          'thread-secret-key': [
            requestOpened({
              threadId: 'thread-secret-key',
              requestType: 'approval',
              title: 'Allow tool',
              payload: {
                toolName: 'call_tool',
                toolInput: { [secretKey]: 'value' },
              },
            }),
          ],
        },
      });

      const result = await projection.list();
      const item = result.items[0];

      expect(item.body).not.toContain(secretKey);
      expect(item.title).not.toContain(secretKey);
    });

    test('the no-open-request fallback yields an honest minimal needs_input item (no implied detail)', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-no-request',
            lifecycleState: 'needs_input',
          }),
        ],
        // session.state-changed-driven needs_input with no backing
        // request.opened at all — the genuine fallback case.
        sessionEvents: { 'thread-no-request': [] },
      });

      const result = await projection.list();

      expect(result.items[0]).toEqual(
        expect.objectContaining({ kind: 'needs_input', title: 'Input needed' }),
      );
      expect(result.items[0]).not.toHaveProperty('requestType');
      expect(result.items[0].body).toMatch(/no request details are available/i);
    });

    test('the no-open-request fallback yields an honest minimal review_pending item', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-no-request-review',
            lifecycleState: 'review_pending',
          }),
        ],
        sessionEvents: { 'thread-no-request-review': [] },
      });

      const result = await projection.list();

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          kind: 'review_pending',
          title: 'Review pending',
        }),
      );
      expect(result.items[0]).not.toHaveProperty('requestType');
    });

    test('a resolved request is not projected as open — falls back honestly', async () => {
      const projection = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-resolved',
            lifecycleState: 'needs_input',
          }),
        ],
        sessionEvents: {
          'thread-resolved': [
            requestOpened({
              threadId: 'thread-resolved',
              requestType: 'input',
              title: 'Old question, already answered',
            }),
            requestResolved({ threadId: 'thread-resolved' }),
          ],
        },
      });

      const result = await projection.list();

      expect(result.items[0].title).toBe('Input needed');
      expect(result.items[0]).not.toHaveProperty('requestType');
    });
  });

  // archive#1185 fix round: the verifier's scratch harness proved
  // `wireApprovalInboxNotifications` (approval-inbox.ts, unmodified by this
  // PR) creates a live `category: 'approval-request'` notification for
  // every `request.opened`, and this projection's own suppression (list()
  // filters lifecycleCandidates by approvalSessions) then drops that
  // session from the lifecycle path entirely — so for a LIVE tool-call
  // approval, `presentOpenRequest`'s detailed copy was never reached; the
  // item stayed on the old coarse notification-title/body presentation
  // (`{"title":"Allow bash","body":"test wants approval to use bash."}`).
  // This describe proves the two paths now converge (issue archive#1185 Ask #4).
  describe('live approval presentation convergence (station#1185 fix round, Ask #4)', () => {
    test('a live orchestration-kind approval notification converges onto the same evidenced presentation as the lifecycle path', async () => {
      // Mirrors exactly what wireApprovalInboxNotifications
      // (approval-inbox.ts) schedules for a live `request.opened`: the
      // notification's own title/body are the OLD coarse copy, and the
      // metadata carries requestKind/threadId/requestId — never the
      // request's payload/description directly.
      const notification: Notification = {
        id: 'notif-1',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Allow bash',
        body: 'test wants approval to use bash.',
        priority: 'high',
        status: 'delivered',
        createdAt: now,
        updatedAt: now,
        actions: [
          { id: 'accept', label: 'Allow Once' },
          { id: 'decline', label: 'Deny', variant: 'danger' },
        ],
        metadata: {
          requestKind: 'orchestration',
          requestId: 'req-1',
          threadId: 'thread-live-approval',
          sessionId: 'thread-live-approval',
          sessionKind: 'runtime',
          requestType: 'approval',
        },
      };
      const projection = makeService({
        notifications: [notification],
        sessions: [
          baseSession({
            threadId: 'thread-live-approval',
            lifecycleState: 'idle',
          }),
        ],
        sessionEvents: {
          'thread-live-approval': [
            requestOpened({
              threadId: 'thread-live-approval',
              requestId: 'req-1',
              requestType: 'approval',
              title: 'Allow bash',
              payload: { toolName: 'bash', toolInput: { command: 'ls -la' } },
            }),
          ],
        },
      });

      const result = await projection.list();
      const item = result.items.find(
        (candidate) => candidate.kind === 'approval',
      );

      expect(item).toBeDefined();
      // The converged, evidenced copy — NOT the notification's own
      // 'Allow bash' / 'test wants approval to use bash.' This assertion is
      // the one that fails against unconverged `projectApproval` (see the
      // red-output transcript in the PR).
      expect(item?.title).toBe('Tool call awaiting approval: bash');
      expect(item?.body).toBe('Allow bash — args: {command}');
      // Convergence must not regress the existing approval-kind contract:
      // kind, actions, and the approval-notification source shape stay put.
      expect(item?.kind).toBe('approval');
      expect(item).toEqual(
        expect.objectContaining({
          source: {
            notificationId: 'notif-1',
            notificationSource: 'approval-inbox',
          },
          actions: notification.actions,
        }),
      );
    });

    test('a registry-kind approval notification (no session/event stream behind it) keeps its own title/body untouched', async () => {
      const projection = makeService({
        notifications: [registryApproval()],
        approvalRegistry: { has: () => true },
      });

      const result = await projection.list();

      expect(result.items[0]).toEqual(
        expect.objectContaining({ kind: 'approval', title: 'Allow tool' }),
      );
    });

    test("an orchestration-kind approval notification whose request has already resolved (no longer open) falls back to the notification's own title/body", async () => {
      const notification: Notification = {
        id: 'notif-resolved',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Allow bash',
        body: 'test wants approval to use bash.',
        priority: 'high',
        status: 'delivered',
        createdAt: now,
        updatedAt: now,
        metadata: {
          requestKind: 'orchestration',
          requestId: 'req-1',
          threadId: 'thread-resolved-approval',
          sessionId: 'thread-resolved-approval',
          sessionKind: 'runtime',
        },
      };
      const projection = makeService({
        notifications: [notification],
        sessionEvents: {
          'thread-resolved-approval': [
            requestOpened({
              threadId: 'thread-resolved-approval',
              requestId: 'req-1',
              requestType: 'approval',
              title: 'Allow bash',
            }),
            requestResolved({ threadId: 'thread-resolved-approval' }),
          ],
        },
      });

      const result = await projection.list();

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          kind: 'approval',
          title: 'Allow bash',
          body: 'test wants approval to use bash.',
        }),
      );
    });
  });

  // archive#1185 fix round, review finding: projectLifecycle became async
  // (readSession per session, batched via Promise.all) with no per-session
  // catch — one session's readSession rejection used to take down the
  // whole list() call, approvals and gate items included.
  describe('readSession resilience (station#1185 fix round, review finding)', () => {
    test('a readSession rejection for one session does not blank the rest of the attention feed', async () => {
      const sessions = [
        baseSession({ threadId: 'thread-good', lifecycleState: 'needs_input' }),
        baseSession({
          threadId: 'thread-bad',
          lifecycleState: 'review_pending',
        }),
      ];
      const service = new AttentionProjectionService(
        { list: () => [] } as never,
        {
          // Both fixtures here are `needs_input`/`review_pending` with their
          // provider registered, so the real derivation answers `answerable`;
          // decorated through it rather than pinned as a constant, for the
          // reason `decorate` documents above.
          listSessionReadModel: async () => sessions.map(decorate([])),
          readSessionFlowRun: async () => null,
          readSession: async (threadId: string) => {
            if (threadId === 'thread-bad') {
              throw new Error('boom: session store unavailable');
            }
            return {
              session: {} as never,
              events: [
                requestOpened({
                  threadId: 'thread-good',
                  requestType: 'input',
                  title: 'Which environment should I deploy to?',
                }),
              ],
            };
          },
        } as never,
        { getRunConsole: async () => ({ gates: [] }) } as never,
      );

      const result = await service.list();

      expect(result.pendingCount).toBe(2);
      const good = result.items.find(
        (item) => item.sessionId === 'thread-good',
      );
      const bad = result.items.find((item) => item.sessionId === 'thread-bad');
      expect(good).toEqual(
        expect.objectContaining({
          kind: 'needs_input',
          title:
            'The agent asked a question: Which environment should I deploy to?',
        }),
      );
      // Degrades to the same honest fallback as "no resolvable open
      // request" — never rejects the whole batch.
      expect(bad).toEqual(
        expect.objectContaining({
          kind: 'review_pending',
          title: 'Review pending',
        }),
      );
    });
  });

  // archive#1548. archive#1296's own test asserted, in a comment, that a failed
  // session "still shows attention via lifecycleState === 'failed' itself" —
  // and nothing here implemented it. That unchecked premise is what made
  // zeroing `pendingReview` on a failed session read as safe, and the result
  // was a session that died mid-approval producing no attention item at all.
  describe('a failed session surfaces attention on its own (#1548)', () => {
    test('a failed session with no open request projects a session-failed item', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-boom',
            lifecycleState: 'failed',
            blockedReason: 'Engine exited with code 1',
          }),
        ],
      });

      const result = await service.list();

      expect(result.pendingCount).toBe(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'session-failed:thread-boom',
          kind: 'session-failed',
          // archive#3203: the SESSION's name, not a second copy of the kind
          // the UI already renders as the row's eyebrow. This fixture has no
          // `displayTitle`, so it reads the honest absence — never the
          // thread id (archive#3139).
          title: 'Untitled session',
          body: 'Engine exited with code 1',
          sessionId: 'thread-boom',
          openHref: activityDeepLink({ sessionId: 'thread-boom' }),
        }),
      );
    });

    // THE POWER TEST for this whole change: the item is derived from the
    // lifecycle state alone. `pendingReview: false` is exactly the shape
    // archive#1314's guard produced, so this stays true even if a producer zeroes
    // the flag again — which is the compensating path archive#1296 claimed and did
    // not have.
    test('the item does not depend on pendingReview — an explicitly false flag still surfaces it', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-boom',
            lifecycleState: 'failed',
            pendingReview: false,
          }),
        ],
      });

      const result = await service.list();

      expect(result.items.map((item) => item.kind)).toEqual(['session-failed']);
      // No cause was recorded, so no body is invented for one.
      expect(result.items[0]).not.toHaveProperty('body');
    });

    // End to end across the two positions archive#1548 named: the producer now
    // keeps `pendingReview` on a retryable failure, and the more specific
    // request outranks the coarser lifecycle state here, exactly as an open
    // approval already outranks every other lifecycle shadow.
    test('a failed session with a still-open approval projects the request, not the bare failure', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-boom',
            lifecycleState: 'failed',
            pendingReview: true,
          }),
        ],
        sessionEvents: {
          'thread-boom': [
            requestOpened({
              threadId: 'thread-boom',
              requestId: 'req-boom',
              requestType: 'approval',
              payload: { toolName: 'bash' },
            }),
          ],
        },
      });

      const result = await service.list();

      expect(result.pendingCount).toBe(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          kind: 'review_pending',
          title: 'Tool call awaiting approval: bash',
          sessionId: 'thread-boom',
        }),
      );
    });

    /*
     * archive#3203. The reported tray showed FOUR and three rows that were
     * byte-identical: title "Session failed", body "Session failed", eyebrow
     * "Session failed", nothing naming which session was which. These four
     * tests are the payload half of that fix.
     */
    describe('the row says what failed, why, and which session (#3203)', () => {
      test('three failures from three sessions are distinguishable, and each carries its own cause', async () => {
        const service = makeService({
          sessions: [
            baseSession({
              threadId: 'thread-a',
              lifecycleState: 'failed',
              displayTitle: 'Fix the login redirect',
              blockedReason: 'ECONNREFUSED api.example.com:443',
              provider: 'claude',
              assignedAgentSlug: 'reviewer',
              updatedAt: '2026-07-23T12:00:00.000Z',
            }),
            baseSession({
              threadId: 'thread-b',
              lifecycleState: 'failed',
              displayTitle: 'Migrate the invoice table',
              blockedReason: 'Engine exited with code 1',
              provider: 'codex',
              updatedAt: '2026-07-23T11:00:00.000Z',
            }),
            baseSession({
              threadId: 'thread-c',
              lifecycleState: 'failed',
              displayTitle: 'Draft the release notes',
              provider: 'claude',
              updatedAt: '2026-07-23T10:00:00.000Z',
            }),
          ],
        });

        const result = await service.list();
        const rows = result.items.map((item) => ({
          title: item.title,
          body: item.body,
          engine: (item as { engine?: string }).engine,
          agent: (item as { agent?: string }).agent,
        }));

        expect(rows).toEqual([
          {
            title: 'Fix the login redirect',
            body: 'ECONNREFUSED api.example.com:443',
            engine: 'claude',
            agent: 'reviewer',
          },
          {
            title: 'Migrate the invoice table',
            body: 'Engine exited with code 1',
            engine: 'codex',
            agent: undefined,
          },
          // No `blockedReason` was recorded, so no cause is invented for one
          // — the UI renders that absence as "no failure detail was
          // recorded", which is a different sentence from a real cause.
          {
            title: 'Draft the release notes',
            body: undefined,
            engine: 'claude',
            agent: undefined,
          },
        ]);
        // The whole point: no two rows read the same.
        expect(new Set(rows.map((row) => row.title)).size).toBe(3);
      });

      test('a delegation target outranks the assigned agent slug as the row identity', async () => {
        const service = makeService({
          sessions: [
            baseSession({
              threadId: 'thread-boom',
              lifecycleState: 'failed',
              assignedAgentSlug: 'reviewer',
              delegation: { targetId: 'worker-7' },
            }),
          ],
        });

        expect((await service.list()).items[0]).toEqual(
          expect.objectContaining({ agent: 'worker-7' }),
        );
      });

      /*
       * THE DESTINATION FIX. `sessionOpenHref`'s project branch opens the
       * chat dock, and the dock has no failure surface at all — `failureText`
       * is derived in `useMutableSessionDetailState` and rendered only by
       * `SessionDetailErrors`, inside the session detail pane. A failed
       * session must therefore land on the Activity surface, EVEN WHEN it
       * has a project slug that would otherwise route it to the dock.
       */
      test('a project-scoped failure opens the session detail, not the chat dock', async () => {
        const service = makeService({
          sessions: [
            baseSession({
              threadId: 'thread-boom',
              lifecycleState: 'failed',
              projectSlug: 'proj a',
            }),
            // Same project, but this one asks the user to ANSWER — the dock's
            // composer is what it needs, so its href is deliberately unchanged.
            baseSession({
              threadId: 'thread-ask',
              lifecycleState: 'needs_input',
              projectSlug: 'proj a',
            }),
          ],
        });

        const result = await service.list();

        expect(
          result.items.find((item) => item.sessionId === 'thread-boom')
            ?.openHref,
        ).toBe(activityDeepLink({ sessionId: 'thread-boom' }));
        expect(
          result.items.find((item) => item.sessionId === 'thread-ask')
            ?.openHref,
        ).toBe('/projects/proj%20a?chat=thread-ask&dock=open');
      });

      test('a display title longer than the row bound is truncated, not dropped', async () => {
        const service = makeService({
          sessions: [
            baseSession({
              threadId: 'thread-boom',
              lifecycleState: 'failed',
              displayTitle: 'x'.repeat(400),
            }),
          ],
        });

        const title = (await service.list()).items[0].title;

        expect(title.length).toBeLessThanOrEqual(120);
        expect(title.startsWith('xxx')).toBe(true);
      });
    });

    test('completed and canceled sessions still project nothing', async () => {
      const service = makeService({
        sessions: [
          baseSession({ threadId: 'thread-done', lifecycleState: 'completed' }),
          baseSession({ threadId: 'thread-cut', lifecycleState: 'canceled' }),
        ],
      });

      expect((await service.list()).pendingCount).toBe(0);
    });

    test('a failed session is still skipped by the Flow gate scan', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-boom',
            lifecycleState: 'failed',
            projectSlug: 'proj-a',
          }),
        ],
        flowRuns: {
          'thread-boom': {
            runId: 'run-1',
            definitionId: 'def',
            cwd: '/tmp/proj-a',
            run: { openGates: [{ id: 'gate-1' }] },
          },
        },
        console: {
          'run-1': [{ id: 'gate-1', step_id: 'build', status: 'block' }],
        } as never,
      });

      const result = await service.list();

      // Exactly one item, and it is the failure — not a gate item. The
      // "stopped" states carry no gate worth scanning, unchanged from the
      // hand-written TERMINAL_LIFECYCLE_STATES this file used to keep.
      expect(result.items.map((item) => item.kind)).toEqual(['session-failed']);
    });
  });

  describe('station#1914: session-failed items are clearable', () => {
    describe('terminality suppression — a dead engine binding is hopeless', () => {
      test('a session whose engine binding is dead contributes nothing actionable', async () => {
        const service = makeService({
          sessions: [
            baseSession({
              threadId: 'thread-dead',
              lifecycleState: 'failed',
              status: 'dead',
              blockedReason: 'No conversation found with session ID: abc',
            }),
          ],
        });

        const result = await service.list();

        expect(result.pendingCount).toBe(0);
        expect(result.items).toEqual([]);
      });

      // archive#1827/#1904: `error` stays retryable and must keep surfacing —
      // collapsing it into `dead`'s suppression would reintroduce the
      // archive#1090 regression this distinction exists to prevent.
      test('a session whose binding merely errored (not dead) still projects session-failed', async () => {
        const service = makeService({
          sessions: [
            baseSession({
              threadId: 'thread-retryable',
              lifecycleState: 'failed',
              status: 'error',
            }),
          ],
        });

        const result = await service.list();

        expect(result.pendingCount).toBe(1);
        expect(result.items[0]).toEqual(
          expect.objectContaining({ kind: 'session-failed' }),
        );
      });
    });

    describe('acknowledgement — a seen, non-hopeless failure can be cleared', () => {
      function memoryAckStore() {
        const data = new Map<string, Map<string, string>>();
        return {
          get(userId: string, conversationId: string) {
            return data.get(userId)?.get(conversationId);
          },
          acknowledge({
            userId,
            conversationId,
            updatedAt,
          }: {
            userId: string;
            conversationId: string;
            updatedAt: string;
          }) {
            if (!data.has(userId)) data.set(userId, new Map());
            data.get(userId)!.set(conversationId, updatedAt);
          },
        };
      }

      test('acknowledging drops the item from pendingCount but keeps it in items (history, never deleted)', async () => {
        const acknowledgementStore = memoryAckStore();
        const service = makeService({
          sessions: [
            baseSession({ threadId: 'thread-boom', lifecycleState: 'failed' }),
          ],
          acknowledgementStore,
        });

        const before = await service.list();
        expect(before.pendingCount).toBe(1);

        const acknowledged = await service.acknowledge(
          'session-failed:thread-boom',
        );
        expect(acknowledged).toBe(true);

        const after = await service.list();
        expect(after.pendingCount).toBe(0);
        expect(after.items).toHaveLength(1);
        expect(after.items[0]).toEqual(
          expect.objectContaining({
            id: 'session-failed:thread-boom',
            kind: 'session-failed',
            acknowledgedAt: now,
          }),
        );
      });

      // archive#1914 AC: "A test that the bell count returns to zero after
      // acking every item, with the sessions still failed."
      test('the bell count returns to zero after acking every item, with the sessions still failed', async () => {
        const acknowledgementStore = memoryAckStore();
        const service = makeService({
          sessions: [
            baseSession({ threadId: 'thread-a', lifecycleState: 'failed' }),
            baseSession({ threadId: 'thread-b', lifecycleState: 'failed' }),
            baseSession({ threadId: 'thread-c', lifecycleState: 'failed' }),
          ],
          acknowledgementStore,
        });

        const before = await service.list();
        expect(before.pendingCount).toBe(3);

        for (const item of before.items) {
          expect(await service.acknowledge(item.id)).toBe(true);
        }

        const after = await service.list();
        expect(after.pendingCount).toBe(0);
        // Still three items — every session is still, in fact, failed.
        expect(after.items).toHaveLength(3);
        expect(after.items.every((item) => Boolean(item.acknowledgedAt))).toBe(
          true,
        );
      });

      /*
       * archive#3203: the owner's complaint was that the count stayed at 4
       * after acting on ONE entry. The all-at-once case above proves the
       * count can reach zero; this proves the PARTIAL step — the one the
       * user actually performs — decrements by exactly one and leaves every
       * other row pending. An implementation that acked the whole list on
       * open would pass the test above and fail this one.
       */
      test('acknowledging one item decrements by one and leaves the others pending', async () => {
        const acknowledgementStore = memoryAckStore();
        const service = makeService({
          sessions: [
            baseSession({ threadId: 'thread-a', lifecycleState: 'failed' }),
            baseSession({ threadId: 'thread-b', lifecycleState: 'failed' }),
            baseSession({ threadId: 'thread-c', lifecycleState: 'failed' }),
          ],
          acknowledgementStore,
        });

        expect((await service.list()).pendingCount).toBe(3);
        expect(await service.acknowledge('session-failed:thread-b')).toBe(true);

        const after = await service.list();
        expect(after.pendingCount).toBe(2);
        expect(
          after.items
            .filter((item) => item.acknowledgedAt)
            .map((item) => item.id),
        ).toEqual(['session-failed:thread-b']);
      });

      test('an acknowledged item survives a reload AND a simulated restart (re-read from the store, not just in-memory)', async () => {
        const { mkdtempSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { FileConversationAcknowledgementStore } = await import(
          '../../orchestration/conversation-acknowledgement-store.js'
        );
        const dataDir = mkdtempSync(join(tmpdir(), 'station-attention-ack-'));
        const sessions = [
          baseSession({ threadId: 'thread-boom', lifecycleState: 'failed' }),
        ];

        const first = makeService({
          sessions,
          acknowledgementStore: new FileConversationAcknowledgementStore(
            dataDir,
          ),
        });
        expect(await first.acknowledge('session-failed:thread-boom')).toBe(
          true,
        );
        // Same instance, second read — "survives a reload".
        expect((await first.list()).pendingCount).toBe(0);

        // A FRESH service over a FRESH store instance pointed at the same
        // directory — nothing in-memory carries over, only the file does.
        // This is "a simulated restart".
        const restarted = makeService({
          sessions,
          acknowledgementStore: new FileConversationAcknowledgementStore(
            dataDir,
          ),
        });
        const result = await restarted.list();
        expect(result.pendingCount).toBe(0);
        expect(result.items[0]).toEqual(
          expect.objectContaining({ acknowledgedAt: now }),
        );
      });

      // "a fresh failure is a real fact worth surfacing; the defect is that
      // a seen or hopeless one never clears" (archive#1914) — a later
      // failure on the SAME thread (newer `updatedAt`) must not stay hidden
      // behind an ack recorded against an OLDER version.
      test('a fresh failure after acknowledgement surfaces again', async () => {
        const acknowledgementStore = memoryAckStore();
        const service = makeService({
          sessions: [
            baseSession({ threadId: 'thread-boom', lifecycleState: 'failed' }),
          ],
          acknowledgementStore,
        });
        expect(await service.acknowledge('session-failed:thread-boom')).toBe(
          true,
        );
        expect((await service.list()).pendingCount).toBe(0);

        const laterService = makeService({
          sessions: [
            baseSession({
              threadId: 'thread-boom',
              lifecycleState: 'failed',
              updatedAt: '2026-07-23T13:00:00.000Z',
            }),
          ],
          acknowledgementStore,
        });
        const result = await laterService.list();
        expect(result.pendingCount).toBe(1);
        expect(result.items[0]).not.toHaveProperty('acknowledgedAt');
      });

      test('acknowledge() is a no-op returning false when no store is configured', async () => {
        const service = makeService({
          sessions: [
            baseSession({ threadId: 'thread-boom', lifecycleState: 'failed' }),
          ],
        });
        expect(await service.acknowledge('session-failed:thread-boom')).toBe(
          false,
        );
        expect((await service.list()).pendingCount).toBe(1);
      });

      test('acknowledge() returns false for an id that does not currently resolve to an item', async () => {
        const service = makeService({
          sessions: [],
          acknowledgementStore: memoryAckStore(),
        });
        expect(await service.acknowledge('session-failed:no-such-thread')).toBe(
          false,
        );
      });
    });
  });

  describe('station#1284: stranded approval cards self-clear, and Open session targets the dock', () => {
    function orchestrationApproval(threadId: string): Notification {
      return {
        id: `approval-${threadId}`,
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Tool call awaiting approval: AskUserQuestion',
        priority: 'high',
        status: 'delivered',
        createdAt: now,
        updatedAt: now,
        actions: [{ id: 'accept', label: 'Allow Once' }],
        metadata: {
          requestKind: 'orchestration',
          requestId: `req-${threadId}`,
          sessionId: threadId,
          sessionKind: 'runtime',
          threadId,
        },
      } as Notification;
    }

    /**
     * PREDICATE PIN (do not weaken — this is the test the fix exists for).
     *
     * The filter must use `canSessionLifecycleStateResume` negated
     * (`{completed, canceled}`), never the name-alike
     * `isSessionLifecycleStateTerminal` (`{completed}`). archive#1284 was
     * reported against a CANCELED session's card, so swapping in the
     * narrower predicate silently restores the original bug. The `canceled`
     * case below is what turns that swap red; `completed` alone would pass
     * under either predicate and prove nothing.
     *
     * `failed` is the opposite guard: it is stopped but RESUMABLE
     * (`failed -> queued | running`), so widening to
     * `isSessionLifecycleStateStopped` would hide a retriable session's
     * genuinely outstanding approval — the defect archive#1548 was filed
     * for. Its card must survive.
     */
    test.each([
      ['completed', false],
      ['canceled', false],
      ['failed', true],
      ['review_pending', true],
      ['needs_input', true],
      ['blocked', true],
      ['queued', true],
      ['running', true],
    ])(
      'an orchestration approval card on a %s session survives: %s',
      async (lifecycleState, survives) => {
        const service = makeService({
          notifications: [orchestrationApproval('thread-x')],
          sessions: [baseSession({ threadId: 'thread-x', lifecycleState })],
        });

        const result = await service.list();

        expect(
          result.items.some((item) => item.id === 'approval:approval-thread-x'),
        ).toBe(survives);
      },
    );

    test('a registry-kind card is left to isApprovalLive, not to the session filter', async () => {
      // Scope boundary: no orchestration session backs it, so the
      // session-state filter must not claim jurisdiction and drop it.
      const service = makeService({
        notifications: [registryApproval()],
        sessions: [],
      });

      expect((await service.list()).pendingCount).toBe(1);
    });

    /**
     * archive#1779 delta review, M2 — THE BROADENED POPULATION, PINNED.
     *
     * The deleted boot pass short-circuited on `openRequests.size === 0`, so
     * a session with no open request was never touched by it. The read-time
     * suppression has no such short-circuit: an unanswerable session's
     * `needs_input` item is dropped even when the state came from a bare
     * `session.state-changed` with no backing request — the case
     * `getCachedOpenRequest`'s doc names explicitly.
     *
     * That is deliberate (an item offering "go answer this" is a lie on a
     * session nothing can answer), and it is the one behavioural difference
     * from the pass this change replaces, so it is asserted rather than left
     * to inference. `sessionEvents` is deliberately EMPTY here: that is what
     * makes it the no-open-request shape.
     */
    test('a needs_input state with no backing request is still suppressed when unanswerable', async () => {
      const suppressed = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-stateful-needs-input',
            lifecycleState: 'needs_input',
          }),
        ],
        sessionEvents: { 'thread-stateful-needs-input': [] },
        unanswerable: ['thread-stateful-needs-input'],
      });
      expect((await suppressed.list()).items).toEqual([]);
    });

    test('the same no-request session DOES project while it is answerable (control)', async () => {
      // Without this the assertion above would also pass if the fixture
      // simply produced no item for an unrelated reason.
      const projected = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-stateful-needs-input',
            lifecycleState: 'needs_input',
          }),
        ],
        sessionEvents: { 'thread-stateful-needs-input': [] },
      });
      const items = (await projected.list()).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual(
        expect.objectContaining({
          kind: 'needs_input',
          sessionId: 'thread-stateful-needs-input',
        }),
      );
    });

    test('an orchestration card whose session is not in the read model is left alone (absence is unknown, never ended)', async () => {
      const service = makeService({
        notifications: [orchestrationApproval('thread-missing')],
        sessions: [],
      });

      expect((await service.list()).pendingCount).toBe(1);
    });

    // AC4: "Open session" must actually open the dock. `dock=open` is what
    // navigation-store.ts's `isDockOpen` reads; without it the deep link
    // lands on the project layout with the dock still shut — defect 1 in
    // the issue. The surface deep link carries its own reveal; it must not
    // also stamp `dock=open`.
    test('sessionOpenHref stamps dock=open on the project-scoped href only', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-project',
            lifecycleState: 'needs_input',
            projectSlug: 'proj a',
          }),
          baseSession({
            threadId: 'thread-no-project',
            lifecycleState: 'needs_input',
          }),
        ],
      });

      const result = await service.list();

      expect(
        result.items.find((item) => item.sessionId === 'thread-project')
          ?.openHref,
      ).toBe('/projects/proj%20a?chat=thread-project&dock=open');
      expect(
        result.items.find((item) => item.sessionId === 'thread-no-project')
          ?.openHref,
      ).toBe(activityDeepLink({ sessionId: 'thread-no-project' }));
    });
  });
});

/*
 * archive#3203: the payload builder is pure — every field is a projection of
 * one session summary — so it is asserted directly rather than only through
 * `list()`. A field the summary did not record must be ABSENT from the
 * payload, not present-and-empty: the UI branches on absence to say "no
 * failure detail was recorded", and an empty string would render as a cause
 * that is simply blank.
 */
describe('buildSessionFailedItem (#3203)', () => {
  test('carries every recorded field and omits every unrecorded one', () => {
    const full = buildSessionFailedItem(
      baseSession({
        threadId: 'thread-boom',
        displayTitle: '  Fix the login redirect  ',
        blockedReason: 'ECONNREFUSED api.example.com:443',
        provider: 'claude',
        assignedAgentSlug: 'reviewer',
      }) as never,
    );
    expect(full).toEqual({
      id: 'session-failed:thread-boom',
      kind: 'session-failed',
      title: 'Fix the login redirect',
      body: 'ECONNREFUSED api.example.com:443',
      createdAt: now,
      updatedAt: now,
      sessionId: 'thread-boom',
      openHref: activityDeepLink({ sessionId: 'thread-boom' }),
      source: { threadId: 'thread-boom' },
      engine: 'claude',
      agent: 'reviewer',
    });

    const bare = buildSessionFailedItem(
      baseSession({ threadId: 'thread-bare', provider: 'codex' }) as never,
    );
    expect(bare.title).toBe('Untitled session');
    expect(bare).not.toHaveProperty('body');
    expect(bare).not.toHaveProperty('agent');
    expect(bare.engine).toBe('codex');
  });

  test('never returns the thread id as the title (#3139)', () => {
    // The precedence has two branches and neither may fall through to an
    // identifier — that regression is exactly what archive#3139 was.
    for (const session of [
      baseSession({ threadId: 'external:claude:5dfa0c9e' }),
      baseSession({
        threadId: 'external:claude:5dfa0c9e',
        displayTitle: '   ',
      }),
    ]) {
      expect(buildSessionFailedItem(session as never).title).toBe(
        'Untitled session',
      );
    }
  });
});

/*
 * archive#3227 B1. The predicate deciding WHETHER a session needs the user is
 * now the shared `sessionAttentionDisposition` fold — the same derivation the
 * client's canonical `orchestrationLifecycleLabel` renders lanes and badges
 * from. Before the extraction the two had drifted three probe-confirmed ways:
 * a `blocked` session sat under "Needs you" while the bell counted 0, and a
 * `status: 'closed'` session with a stale `needs_input` state or a sticky
 * `pendingReview` flag was counted by the bell while every client surface
 * filed it under Recently finished. These tests pin both fixes and then pin
 * the whole agreement, shape by shape.
 */
describe('the bell agrees with the client fold (station#3227 B1)', () => {
  describe('a blocked session projects the waiting-on-you item', () => {
    test('a bare blocked session projects needs_input, saying it is blocked and why', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-stuck',
            lifecycleState: 'blocked',
            status: 'running',
            blockedReason: 'Waiting on a human decision about the deploy',
          }),
        ],
      });

      const result = await service.list();

      expect(result.pendingCount).toBe(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'needs_input:thread-stuck',
          kind: 'needs_input',
          title: 'Session blocked',
          body: 'Waiting on a human decision about the deploy',
          sessionId: 'thread-stuck',
          openHref: activityDeepLink({ sessionId: 'thread-stuck' }),
        }),
      );
    });

    test('no recorded blockedReason yields the honest absence, never an invented cause', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-stuck',
            lifecycleState: 'blocked',
            status: 'running',
          }),
        ],
      });

      expect((await service.list()).items[0]).toEqual(
        expect.objectContaining({
          title: 'Session blocked',
          body: 'This session is blocked — no request details are available.',
        }),
      );
    });

    test('a blocked session with a resolvable open request presents the request itself', async () => {
      // Same request-evidence precedence as needs_input/review_pending
      // (archive#1185): a concrete request outranks the coarser state.
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-stuck',
            lifecycleState: 'blocked',
            status: 'running',
          }),
        ],
        sessionEvents: {
          'thread-stuck': [
            requestOpened({
              threadId: 'thread-stuck',
              requestId: 'req-ask',
              requestType: 'input',
              title: 'Which branch should I rebase onto?',
            }),
          ],
        },
      });

      expect((await service.list()).items[0]).toEqual(
        expect.objectContaining({
          kind: 'needs_input',
          title:
            'The agent asked a question: Which branch should I rebase onto?',
          requestType: 'input',
        }),
      );
    });

    test('an unanswerable blocked session projects nothing — the bell counts actionable items', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-stuck',
            lifecycleState: 'blocked',
            status: 'running',
          }),
        ],
        unanswerable: ['thread-stuck'],
      });

      expect((await service.list()).items).toEqual([]);
    });
  });

  describe('a closed session projects nothing, whatever stale shadow it carries', () => {
    test.each([
      ['a stale needs_input lifecycleState', { lifecycleState: 'needs_input' }],
      [
        'a sticky pendingReview flag',
        { lifecycleState: 'running', pendingReview: true },
      ],
      ['a stale blocked lifecycleState', { lifecycleState: 'blocked' }],
    ])('closed + %s → no item', async (_name, shape) => {
      const service = makeService({
        sessions: [
          baseSession({ threadId: 'thread-gone', status: 'closed', ...shape }),
        ],
      });

      expect((await service.list()).items).toEqual([]);
    });

    test('closed + failed still projects the failure — failed outranks closed (#1296)', async () => {
      const service = makeService({
        sessions: [
          baseSession({
            threadId: 'thread-crashed',
            lifecycleState: 'failed',
            status: 'closed',
            blockedReason: 'Engine exited with code 1',
          }),
        ],
      });

      expect((await service.list()).items.map((item) => item.kind)).toEqual([
        'session-failed',
      ]);
    });
  });

  /*
   * THE AGREEMENT MATRIX. For every lifecycleState × status × pendingReview ×
   * answerability shape, what this projection emits must be the shared
   * disposition's rendering plus exactly the three documented local rules:
   * the `answerable` suppression on awaiting items (archive#1745), the `dead`-binding
   * suppression on failures (archive#1914), and request-outranks-failure (archive#1548).
   * The client fold's own matrix test asserts its labels against the SAME
   * shared fold, so the two surfaces agreeing is transitive through these two
   * pins — a predicate that stops consulting the fold reds here with the
   * offending shape named in the failure text.
   */
  describe('agreement matrix over the shared disposition', () => {
    const STATUSES: readonly ProviderSession['status'][] = [
      'connecting',
      'ready',
      'running',
      'error',
      'dead',
      'closed',
    ];

    test('every shape projects exactly what the shared fold adjudicates', async () => {
      const cases: {
        threadId: string;
        lifecycleState: SessionLifecycleState | undefined;
        status: ProviderSession['status'];
        pendingReview: boolean;
        providerRegistered: boolean;
      }[] = [];
      for (const lifecycleState of [...SESSION_LIFECYCLE_STATES, undefined]) {
        for (const status of STATUSES) {
          for (const pendingReview of [true, false]) {
            for (const providerRegistered of [true, false]) {
              cases.push({
                threadId: `t-${lifecycleState ?? 'none'}-${status}-${pendingReview}-${providerRegistered}`,
                lifecycleState,
                status,
                pendingReview,
                providerRegistered,
              });
            }
          }
        }
      }

      const service = makeService({
        sessions: cases.map((shape) =>
          baseSession({
            threadId: shape.threadId,
            lifecycleState: shape.lifecycleState,
            status: shape.status,
            pendingReview: shape.pendingReview,
          }),
        ),
        unanswerable: cases
          .filter((shape) => !shape.providerRegistered)
          .map((shape) => shape.threadId),
      });

      const { items } = await service.list();
      const kindsBySession = new Map<string, string[]>();
      for (const item of items) {
        if (!item.sessionId) continue;
        kindsBySession.set(item.sessionId, [
          ...(kindsBySession.get(item.sessionId) ?? []),
          item.kind,
        ]);
      }

      for (const shape of cases) {
        // The same real answerability derivation the fixtures decorate with —
        // never a stubbed constant (archive#1779).
        const { answerable } = projectRequestAnswerability({
          threadAttachment: 'detached',
          lifecycleState: shape.lifecycleState,
          providerRegistered: shape.providerRegistered,
          observedBy: 'test-instance#0',
          observedAt: now,
        });
        const disposition = sessionAttentionDisposition(shape);
        let expected: string[] = [];
        if (disposition.state === 'failed') {
          expected =
            answerable && shape.pendingReview
              ? ['review_pending'] // archive#1548: the open request outranks the bare failure
              : shape.status !== 'dead'
                ? ['session-failed']
                : []; // archive#1914: a dead binding is hopeless
        } else if (disposition.state === 'awaiting') {
          expected = answerable
            ? [disposition.via === 'blocked' ? 'needs_input' : disposition.via]
            : []; // archive#1745: the bell counts actionable items only
        }
        expect({
          shape: shape.threadId,
          kinds: kindsBySession.get(shape.threadId) ?? [],
        }).toEqual({ shape: shape.threadId, kinds: expected });
      }
    });
  });
});

describe('device pairing requests need attention (#765 D5)', () => {
  const requestNow = Date.now();

  function pairingRequest(overrides: Record<string, unknown> = {}) {
    return {
      requestId: 'pair-req-1',
      offerId: 'offer-1',
      deviceName: 'Test Phone',
      scope: 'orchestration:read',
      createdAt: requestNow - 1_000,
      expiresAt: requestNow + 60_000,
      source: 'pairing-code',
      status: 'pending',
      ...overrides,
    };
  }

  test('a pending, unexpired request projects an actionable attention item', async () => {
    const projection = makeService({ pairingRequests: [pairingRequest()] });

    const result = await projection.list();
    expect(result.pendingCount).toBe(1);
    expect(result.items).toEqual([
      {
        id: 'device-pairing:pair-req-1',
        kind: 'device-pairing',
        title: 'A device is asking to pair',
        body: 'Test Phone is waiting for approval on this Station.',
        createdAt: new Date(requestNow - 1_000).toISOString(),
        updatedAt: new Date(requestNow - 1_000).toISOString(),
        deviceName: 'Test Phone',
        // No viewer capability supplied — an unknown caller fails closed:
        // the projection must never claim decidability nothing derived.
        viewerCanDecide: false,
        openHref: '/connections',
        source: { requestId: 'pair-req-1' },
      },
    ]);
  });

  test('a viewer the boundary would admit gets viewerCanDecide: true; one it would refuse gets false (#765 D5)', async () => {
    const projection = makeService({ pairingRequests: [pairingRequest()] });

    const decider = await projection.list(undefined, {
      mayDecidePairingRequests: true,
    });
    expect(decider.items).toEqual([
      expect.objectContaining({
        kind: 'device-pairing',
        viewerCanDecide: true,
      }),
    ]);

    const bystander = await projection.list(undefined, {
      mayDecidePairingRequests: false,
    });
    expect(bystander.items).toEqual([
      expect.objectContaining({
        kind: 'device-pairing',
        viewerCanDecide: false,
      }),
    ]);
  });

  test('confirmed, denied, and expired requests project nothing', async () => {
    const projection = makeService({
      pairingRequests: [
        // Approved — waiting on the device's exchange; the decision is made.
        pairingRequest({ requestId: 'pair-confirmed', status: 'confirmed' }),
        pairingRequest({ requestId: 'pair-denied', status: 'denied' }),
        // Pending but past its window — cannot be approved any more.
        pairingRequest({
          requestId: 'pair-expired',
          expiresAt: requestNow - 1,
        }),
      ],
    });

    await expect(projection.list()).resolves.toEqual({
      items: [],
      pendingCount: 0,
    });
  });

  test('no pairing source resolvable projects nothing (and never throws)', async () => {
    const projection = makeService({});
    await expect(projection.list()).resolves.toEqual({
      items: [],
      pendingCount: 0,
    });
  });

  test('joins the mirror activity notification for inbox dedupe', async () => {
    const projection = makeService({
      pairingRequests: [pairingRequest()],
      notifications: [
        {
          id: 'pairing-notification-1',
          source: 'device-pairing',
          category: 'pairing-request',
          title: 'A device is asking to pair',
          priority: 'high',
          status: 'delivered',
          createdAt: now,
          updatedAt: now,
          metadata: { requestId: 'pair-req-1' },
        } as Notification,
        // A different request's notification must not be joined.
        {
          id: 'pairing-notification-other',
          source: 'device-pairing',
          category: 'pairing-request',
          title: 'A device is asking to pair',
          priority: 'high',
          status: 'delivered',
          createdAt: now,
          updatedAt: now,
          metadata: { requestId: 'pair-req-other' },
        } as Notification,
      ],
    });

    const result = await projection.list();
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: 'device-pairing',
        source: {
          requestId: 'pair-req-1',
          notificationId: 'pairing-notification-1',
        },
      }),
    ]);
  });

  test('hosted reads never see host pairing requests', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
    });
    const alpha = sessionReadAuthorityFromRequest(
      'alpha',
      { tenantId: registry.tenants[0].id },
      registry,
    );
    const projection = makeService({ pairingRequests: [pairingRequest()] });

    await expect(projection.list(alpha)).resolves.toEqual({
      items: [],
      pendingCount: 0,
    });
  });

  test('acknowledging a pairing item drops it from the pending count without deleting it', async () => {
    const acked = new Map<string, string>();
    const projection = makeService({
      pairingRequests: [pairingRequest()],
      acknowledgementStore: {
        get: (userId, conversationId) =>
          acked.get(`${userId}:${conversationId}`),
        acknowledge: ({ userId, conversationId, updatedAt }) => {
          acked.set(`${userId}:${conversationId}`, updatedAt);
        },
      },
    });

    expect(await projection.acknowledge('device-pairing:pair-req-1')).toBe(
      true,
    );
    const result = await projection.list();
    expect(result.pendingCount).toBe(0);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'device-pairing:pair-req-1',
        acknowledgedAt: expect.any(String),
      }),
    ]);
  });
});

/**
 * #1536 D8. The inbox read "All caught up · Nothing needs you right now" on
 * a fresh home whose New Chat picker, one surface away, marked the Station
 * row "Needs: No enabled LLM provider connection is configured."
 */
describe('Station cannot run its own Agent (#1536 D8)', () => {
  const requirement = {
    agentSlug: 'station',
    agentName: 'Station',
    reason: 'No enabled LLM provider connection is configured.',
  };

  test("projects the requirement, in the picker's own sentence", async () => {
    const service = makeService({ stationSetupRequirement: requirement });

    const result = await service.list();

    expect(result.pendingCount).toBe(1);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'setup-incomplete:model-connection:station',
        kind: 'setup-incomplete',
        title: 'Station cannot run yet',
        body: 'No enabled LLM provider connection is configured.',
        openHref: '/connections/models',
        source: { requirement: 'model-connection', agentSlug: 'station' },
      }),
    ]);
  });

  test('projects nothing once the Agent resolves', async () => {
    const service = makeService({ stationSetupRequirement: null });

    await expect(service.list()).resolves.toEqual({
      items: [],
      pendingCount: 0,
    });
  });

  test('is unavailable, not assumed, when no resolver is wired', async () => {
    const service = makeService({});

    await expect(service.list()).resolves.toEqual({
      items: [],
      pendingCount: 0,
    });
  });

  /**
   * Review M1: "Dismiss all" mapped every item to the acknowledge route, and
   * the row only came back because its `updatedAt` moved on the next read — an
   * accident, not a refusal.
   */
  test('cannot be acknowledged away, because it is still true afterwards', async () => {
    const acked = new Map<string, string>();
    const service = makeService({
      stationSetupRequirement: requirement,
      acknowledgementStore: {
        get: (userId, conversationId) =>
          acked.get(`${userId}:${conversationId}`),
        acknowledge: ({ userId, conversationId, updatedAt }) => {
          acked.set(`${userId}:${conversationId}`, updatedAt);
        },
      },
    });

    expect(
      await service.acknowledge('setup-incomplete:model-connection:station'),
    ).toBe(false);
    expect(acked.size).toBe(0);
    const result = await service.list();
    expect(result.pendingCount).toBe(1);
    expect(result.items[0]?.acknowledgedAt).toBeUndefined();
  });

  /**
   * Review M2: a read-time stamp made this row outrank every live approval on
   * every read — an artefact of the timestamp, not a priority anyone chose —
   * and made acknowledgement versioning meaningless.
   */
  test('says since when it has been true, not when the projection last looked', async () => {
    const service = makeService({ stationSetupRequirement: requirement });

    const first = (await service.list()).items[0];
    await new Promise((settle) => setTimeout(settle, 3));
    const second = (await service.list()).items[0];

    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  test('a changed requirement is a new observation', async () => {
    let current = requirement;
    const service = makeService({
      stationSetupRequirement: () => current,
    });

    const before = (await service.list()).items[0]?.updatedAt;
    current = {
      ...requirement,
      reason:
        'Multiple enabled LLM provider connections require an explicit default.',
    };
    await new Promise((settle) => setTimeout(settle, 3));
    const after = (await service.list()).items[0];

    expect(after?.body).toContain('explicit default');
    expect(after?.updatedAt).not.toBe(before);
  });

  test('sorts below a live approval, whatever the clock says', async () => {
    const older = new Date(Date.parse(now) - 3_600_000).toISOString();
    const service = makeService({
      stationSetupRequirement: requirement,
      notifications: [registryApproval({ createdAt: older, updatedAt: older })],
      sessions: [baseSession({ threadId: 'conversation-1' })],
      approvalRegistry: { has: () => true },
    });

    const { items } = await service.list();

    // A live approval an hour old still leads a standing notice observed now.
    expect(items.map((item) => item.kind)).toEqual([
      'approval',
      'setup-incomplete',
    ]);
  });

  test('host model configuration is not projected to a hosted tenant read', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
    });
    const service = makeService({ stationSetupRequirement: requirement });

    const result = await service.list(
      sessionReadAuthorityFromRequest(
        'alpha',
        { tenantId: registry.tenants[0].id },
        registry,
      ),
    );

    expect(result.items).toEqual([]);
  });
});
