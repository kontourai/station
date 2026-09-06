import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId, engineId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSessionStartInput,
} from '../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../providers/sessions/async-event-queue.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import type { ForegroundInvocationAdmission } from '../../services/orchestration/foreground-invocation-admission.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';

process.env.STATION_API_BASE = 'http://control-delegation.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const CURRENT_API = 'http://control-delegation.test';
const REMOTE_API = 'http://127.0.0.1:45123';
const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bodyOf(call: Parameters<typeof fetch>) {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

function currentTarget(agent = 'reviewer') {
  return {
    environment: { kind: 'current' as const },
    agent: agentId(agent),
  };
}

function savedTarget(agent = 'codex') {
  return {
    environment: {
      kind: 'saved' as const,
      id: environmentId('environment-remote'),
    },
    agent: agentId(agent),
  };
}

function delegationHandle(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    sessionId: 'task-1',
    status: 'dispatched',
    environment: {
      id: 'environment-current',
      name: 'Current environment',
      kind: 'current',
    },
    target: { kind: 'agent', id: 'reviewer' },
    resolution: {
      schemaVersion: 'station.execution-resolution/v1',
      resolvedAt: '2026-08-01T00:00:00.000Z',
      environmentId: 'environment-current',
      agentId: 'reviewer',
      engine: { kind: 'station' },
      provider: 'station-agent',
      modelLaunchPlan: {
        kind: 'engine-selected',
        evidence: 'adapter-declared',
      },
    },
    ...overrides,
  };
}

function foregroundHandle(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conversation-1',
    sessionId: 'conversation-1',
    providerTurnId: 'provider-turn-1',
    target: { kind: 'agent', id: 'codex' },
    resolution: {
      schemaVersion: 'station.execution-resolution/v1',
      resolvedAt: '2026-08-01T00:00:00.000Z',
      environmentId: 'environment-remote',
      agentId: 'codex',
      engine: { kind: 'connection', connectionId: 'codex' },
      provider: 'codex',
      modelLaunchPlan: {
        kind: 'engine-selected',
        evidence: 'adapter-declared',
      },
    },
    ...overrides,
  };
}

function localService() {
  const sessionCommands = {
    execute: vi.fn(
      async (command: Record<string, unknown>, _context: unknown) => ({
        status: 'accepted' as const,
        receipt: { commandId: 'command-1', status: 'accepted' },
        session: command,
      }),
    ),
  };
  const startSessionInternal = vi.fn(
    async (
      command: Record<string, unknown>,
      context: unknown,
      _internal?: unknown,
    ) => sessionCommands.execute(command, context),
  );
  return {
    readSession: vi.fn(async (_sessionId?: string) => null),
    currentConversationSessionId: vi.fn(
      (conversationId: string) => conversationId,
    ),
    getProviderAdapter: vi.fn(() => ({
      metadata: {
        modelLaunch: {
          defaultAtStart: 'engine-selected',
          omissionAtResume: 'engine-selected',
          omissionPerTurn: 'engine-selected',
          overrideAtStart: true,
          overrideAtResume: true,
          overridePerTurn: true,
        },
      },
    })),
    dispatchWithReceipt: vi.fn(
      async (
        command: Record<string, unknown>,
        _context?: unknown,
        _internal?: unknown,
      ) => ({
        receipt: { commandId: 'command-1', status: 'accepted' },
        result:
          command.type === 'sendTurn'
            ? { turnId: 'provider-turn-local' }
            : command,
      }),
    ),
    sessionCommands,
    startSessionInternal,
  };
}

function foregroundAdmission(): ForegroundInvocationAdmission {
  return {
    agentId: agentId('reviewer'),
    agentSpec: { name: 'Captured reviewer', prompt: 'Captured instructions' },
    project: {
      id: 'project-id-workspace',
      slug: 'workspace',
      name: 'Workspace',
      workingDirectory: '/tmp/workspace',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    },
    message: 'Captured host action body',
    invoke: vi.fn(async (_phase, _actual, effect) => effect()),
  };
}

/** Minimal provider adapter for the real-lineage continuation test: only
 * startSession and sendTurn behavior matter; everything else is inert. */
class ContinuationFakeAdapter implements ProviderAdapterShape {
  readonly provider: 'claude' | 'station-agent';
  readonly sessions = new Map<
    string,
    {
      provider: 'claude' | 'station-agent';
      threadId: string;
      status: 'ready';
      createdAt: string;
      updatedAt: string;
    }
  >();
  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly startedThreadIds: string[] = [];
  readonly startSession = vi.fn(async (input: ProviderSessionStartInput) => {
    this.startedThreadIds.push(input.threadId);
    const session = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(input.threadId, session);
    // Like the real adapter, publish the server-owned start metadata used
    // to authorize native history; a session row alone has no Agent binding.
    this.events.push({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: input.metadata,
    });
    return session;
  });
  readonly sendTurn = vi.fn(async (input: { threadId: string }) => ({
    threadId: input.threadId,
    turnId: 'claude-turn',
  }));
  readonly interruptTurn = vi.fn(async () => ({
    outcome: 'no-active-turn' as const,
  }));
  readonly steerTurn = vi.fn(async () => undefined);
  readonly respondToRequest = vi.fn(async () => undefined);
  startedSessionThreadIds() {
    return this.startedThreadIds;
  }

  async listSessions() {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  async discardSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async stopSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async stopAll() {
    this.sessions.clear();
  }
  async getPrerequisites() {
    return [];
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
  readonly metadata: ProviderAdapterMetadata;

  constructor(provider: 'claude' | 'station-agent') {
    this.provider = provider;
    this.metadata = {
      displayName: `${provider} Runtime`,
      description: `${provider} adapter for tests`,
      capabilities: ['agent-runtime'],
      engineId: engineId(provider),
      builtin: true,
      // archive#980 shape (mirrors the orchestration-service test fake): the
      // private station-agent adapter carries the real engineId 'station'.
      ...(provider === 'station-agent'
        ? { engineId: engineId('station') }
        : {}),
      modelLaunch: {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'engine-selected',
        omissionPerTurn: 'engine-selected',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
      },
    };
  }
}

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.station.test' },
    { id: 'bravo', authority: 'bravo.station.test' },
  ],
});

function hostedAuthority(tenant: 'alpha' | 'bravo' | undefined) {
  return sessionReadAuthorityFromRequest(
    'shared-user',
    tenant
      ? {
          tenantId: hostedRegistry.tenants.find((entry) => entry.id === tenant)!
            .id,
        }
      : undefined,
    hostedRegistry,
  );
}

function localDelegatedTaskService(
  lifecycleState = 'running',
  provider?: string,
) {
  const session = {
    threadId: 'task-alpha',
    lifecycleState,
    ...(provider ? { provider } : {}),
    eventCount: 2,
    delegation: {
      taskId: 'task-alpha',
      environmentId: 'environment-current',
      environmentName: 'Current environment',
      targetKind: 'agent',
      targetId: 'reviewer',
    },
  };
  const events = [
    {
      method: 'session.configured',
      metadata: {
        taskId: 'task-alpha',
        environmentId: 'environment-current',
        environmentName: 'Current environment',
        targetKind: 'agent',
        targetId: 'reviewer',
        userId: 'shared-user',
      },
    },
    {
      method: 'request.opened',
      requestId: 'request-alpha',
      requestType: 'approval',
    },
  ];
  const detail = { session, events };
  const canRead = (authority: {
    tenantExecutionContext?: { tenantId: string };
  }) => authority.tenantExecutionContext?.tenantId === 'alpha';
  return {
    listSessionReadModel: vi.fn(async (authority) =>
      canRead(authority) ? [session] : [],
    ),
    readSession: vi.fn(async (_taskId, authority) =>
      canRead(authority) ? detail : null,
    ),
    readCurrentConversationSession: vi.fn(async (_conversationId, authority) =>
      canRead(authority) ? detail : null,
    ),
    currentConversationSessionId: vi.fn(() => 'task-alpha'),
    reservedConversationHandoff: vi.fn(() => undefined),
    resolveConversationContinuation: vi.fn(async () => ({
      sessionId:
        lifecycleState === 'completed'
          ? 'task-alpha:session:child-1'
          : 'task-alpha',
      startRequired: lifecycleState === 'completed',
    })),
    startSessionInternal: vi.fn(async (command) => ({
      status: 'accepted',
      // Every SessionCommandOutcome variant carries a receipt; archive#4232 made the
      // foreground seam read `receipt.commandId`, so a double that omits it
      // no longer models the real contract.
      receipt: { commandId: 'start-command-1', status: 'accepted' },
      session: { threadId: command.input.threadId },
    })),
    getProviderAdapter: vi.fn(() => undefined),
    readSessionEventPage: vi.fn(async (_taskId, { authority }) =>
      canRead(authority)
        ? {
            session,
            events: events.map((event, index) => ({
              sequence: index + 1,
              event,
            })),
            nextSequence: 2,
            hasMore: false,
          }
        : null,
    ),
    dispatchWithReceipt: vi.fn(async (command: Record<string, unknown>) => ({
      receipt: { commandId: 'command-1', status: 'accepted' },
      result:
        command.type === 'sendTurn'
          ? { turnId: 'provider-turn-local' }
          : command,
    })),
  };
}

function installCurrentStationFetch() {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`) {
      return json({ environmentId: 'environment-current' });
    }
    if (url === `${CURRENT_API}/api/agents/reviewer`) {
      return json({
        success: true,
        data: { slug: 'reviewer', name: 'Reviewer', available: true },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function installRemoteStationFetch(
  canonicalPath:
    | '/api/orchestration/delegations'
    | '/api/orchestration/chat'
    | '/api/orchestration/chat/delegated'
    | '/api/orchestration/chat/background'
    | '/api/orchestration/chat/conversation-1/continue',
  responseData: unknown,
  discovery?: {
    workingDirectory: string;
    remoteHome?: string | null;
    verifiedProjectPath?: string;
    projects?: Record<string, string>;
    existingSessionCwd?: string;
  },
) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`) {
      return json({ environmentId: 'environment-current' });
    }
    if (url === `${CURRENT_API}/api/environments/ssh`) {
      return json({
        success: true,
        data: [
          {
            profile: {
              id: 'profile-1',
              name: 'Brian media',
              environmentId: 'environment-remote',
              remoteHome:
                discovery && 'remoteHome' in discovery
                  ? discovery.remoteHome
                  : '/home/brian',
              verifiedProjectPath:
                discovery?.verifiedProjectPath ?? '/srv/station',
            },
            state: { phase: 'connected', localUrl: REMOTE_API },
          },
        ],
      });
    }
    if (url === `${CURRENT_API}/api/environments/ssh/profile-1/connect`) {
      return json({
        success: true,
        data: {
          profile: {
            id: 'profile-1',
            name: 'Brian media',
            environmentId: 'environment-remote',
            remoteHome:
              discovery && 'remoteHome' in discovery
                ? discovery.remoteHome
                : '/home/brian',
            verifiedProjectPath:
              discovery?.verifiedProjectPath ?? '/srv/station',
          },
          state: { phase: 'connected', localUrl: REMOTE_API },
        },
      });
    }
    if (
      url ===
      `${CURRENT_API}/api/environments/peers/environment-remote/credential`
    ) {
      return json({ success: false, error: 'not found' }, 404);
    }
    const projectPrefix = `${REMOTE_API}/api/projects/`;
    const projectSlug = url.startsWith(projectPrefix)
      ? decodeURIComponent(url.slice(projectPrefix.length))
      : undefined;
    const workingDirectory = projectSlug
      ? (discovery?.projects?.[projectSlug] ??
        (projectSlug === 'workspace' ? discovery?.workingDirectory : undefined))
      : undefined;
    if (workingDirectory) {
      return json({
        success: true,
        data: { workingDirectory },
      });
    }
    if (
      discovery?.existingSessionCwd &&
      url === `${REMOTE_API}/api/orchestration/sessions/conversation-1`
    ) {
      return json({
        success: true,
        data: {
          session: { cwd: discovery.existingSessionCwd },
          events: [],
        },
      });
    }
    if (discovery && url === `${REMOTE_API}/api/connections/agents`) {
      return json({ success: true, data: [] });
    }
    if (discovery && url === `${REMOTE_API}/api/agents`) {
      return json({ success: true, data: [] });
    }
    if (url === `${REMOTE_API}${canonicalPath}`) {
      return json({ success: true, data: responseData });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe('Station Control canonical Environment + Agent execution', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('rejects a tilde suffix collision while discovering remote delegation options', async () => {
    installRemoteStationFetch(
      '/api/orchestration/delegations',
      {},
      {
        workingDirectory: '~/work',
        verifiedProjectPath: '/srv/anything/work',
      },
    );
    const { discoverDelegationOptions } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      discoverDelegationOptions({
        environmentId: 'environment-remote',
        projectSlug: 'workspace',
      }),
    ).rejects.toThrow('configured project path differs from verified path');
  });

  test('accepts remote-home-expanded equality while preserving unverified label', async () => {
    installRemoteStationFetch(
      '/api/orchestration/delegations',
      {},
      {
        workingDirectory: '~/station',
        verifiedProjectPath: '/home/brian/station',
      },
    );
    const { discoverDelegationOptions } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      discoverDelegationOptions({
        environmentId: 'environment-remote',
        projectSlug: 'workspace',
      }),
    ).resolves.toMatchObject({
      project: { slug: 'workspace', slugJoin: 'unverified-cross-machine' },
    });
  });

  test('targets preserves the target Station authored-Agent refusal reason (#2845)', async () => {
    installRemoteStationFetch(
      '/api/orchestration/delegations',
      {},
      { workingDirectory: '/srv/station' },
    );
    const baseImplementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${REMOTE_API}/api/connections/agents`) {
        return json({
          success: true,
          data: [
            {
              id: 'claude',
              enabled: true,
              status: 'ready',
              capabilities: ['agent-runtime'],
              config: {},
            },
          ],
        });
      }
      if (url === `${REMOTE_API}/api/agents`) {
        return json({
          success: true,
          data: [
            {
              slug: 'claude',
              name: 'Claude Code',
              execution: { agentConnectionId: 'claude' },
              available: false,
              unavailableReason:
                "Agent 'claude' has no authored Agent definition, so Station cannot start new sessions or continue existing conversations with it. Enable this engine by creating an Agent for it — new chats will run as that Agent; existing conversations stay readable.",
            },
          ],
        });
      }
      return baseImplementation(input, init);
    });
    const { discoverDelegationOptions } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      discoverDelegationOptions({ environmentId: 'environment-remote' }),
    ).resolves.toMatchObject({
      targets: [
        {
          id: 'claude',
          ready: false,
          unavailableReason:
            "Agent 'claude' has no authored Agent definition, so Station cannot start new sessions or continue existing conversations with it. Enable this engine by creating an Agent for it — new chats will run as that Agent; existing conversations stay readable.",
        },
      ],
    });
  });

  test('fails closed for a tilde path when the profile predates remoteHome', async () => {
    installRemoteStationFetch(
      '/api/orchestration/delegations',
      {},
      {
        workingDirectory: '~/station',
        verifiedProjectPath: '/home/brian/station',
        remoteHome: null,
      },
    );
    const { discoverDelegationOptions } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      discoverDelegationOptions({
        environmentId: 'environment-remote',
        projectSlug: 'workspace',
      }),
    ).rejects.toThrow(/re-verify|remote home/i);
  });

  test('raw byte equality earns directory-corroborated', async () => {
    installRemoteStationFetch(
      '/api/orchestration/delegations',
      {},
      {
        workingDirectory: '/srv/station',
        verifiedProjectPath: '/srv/station',
      },
    );
    const { discoverDelegationOptions } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      discoverDelegationOptions({
        environmentId: 'environment-remote',
        projectSlug: 'workspace',
      }),
    ).resolves.toMatchObject({
      project: { slug: 'workspace', slugJoin: 'directory-corroborated' },
    });
  });

  test.each(['shared', 'worktree'] as const)(
    'persists the resolved %s Project isolation at delegated creation',
    async (mode) => {
      installCurrentStationFetch();
      const original = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) =>
        String(input) === `${CURRENT_API}/api/projects/workspace`
          ? json({
              success: true,
              data: {
                workingDirectory: '/tmp/workspace',
                defaultWorkspaceIsolation: mode,
              },
            })
          : original(input, init),
      );
      const service = localService();
      const { delegateTask } = await import('../station-control-delegation.js');
      await delegateTask(
        {
          prompt: 'Retain the resolved Project policy',
          target: {
            ...currentTarget(),
            workspace: { kind: 'project', projectSlug: 'workspace' },
          },
        },
        service as never,
      );
      expect(service.sessionCommands.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            workspaceIsolation: expect.objectContaining({ mode }),
            metadata: expect.objectContaining({
              projectSlug: 'workspace',
              workspaceIsolation: expect.objectContaining({ mode }),
            }),
          }),
        }),
        expect.anything(),
      );
    },
  );

  test('executes a local delegation through the injected canonical service', async () => {
    installCurrentStationFetch();
    const service = localService();
    const authority = hostedAuthority('alpha');
    const { delegateTask } = await import('../station-control-delegation.js');
    const clientOrigin = {
      version: 1 as const,
      actor: { kind: 'operator' as const },
      reported: { version: 1 as const, surface: 'web' as const, build: '1041' },
    };

    const result = await delegateTask(
      {
        prompt: 'Inspect the checkout',
        target: currentTarget(),
        sessionId: 'task:11111111-1111-4111-8111-111111111111',
        readAuthority: authority,
        clientOrigin,
      },
      service as never,
    );

    expect(result).toMatchObject({
      taskId: 'task:11111111-1111-4111-8111-111111111111',
      target: { kind: 'agent', id: 'reviewer' },
      resolution: { engine: { kind: 'station' } },
    });
    expect(service.sessionCommands.execute).toHaveBeenCalledTimes(1);
    expect(service.startSessionInternal.mock.calls[0]?.[2]).toMatchObject({
      resourceAdmissionIntent: 'delegated_background',
    });
    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(1);
    expect(service.sessionCommands.execute.mock.calls[0][0]).toMatchObject({
      type: 'start-session',
      input: {
        threadId: 'task:11111111-1111-4111-8111-111111111111',
        provider: 'station-agent',
        metadata: {
          agentId: 'reviewer',
          targetKind: 'agent',
          targetId: 'reviewer',
          environmentId: 'environment-current',
        },
      },
    });
    expect(service.dispatchWithReceipt.mock.calls[0][0]).toMatchObject({
      type: 'sendTurn',
      input: {
        threadId: 'task:11111111-1111-4111-8111-111111111111',
        input: 'Inspect the checkout',
      },
    });
    expect(service.sessionCommands.execute.mock.calls[0][1]).toEqual({
      userId: 'shared-user',
      tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
      clientOrigin,
    });
    expect(service.dispatchWithReceipt.mock.calls[0][1]).toEqual({
      userId: 'shared-user',
      tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
      clientOrigin,
    });
    const { buildOrchestrationSessionSummary } = await import(
      '../../services/orchestration/orchestration-session-state.js'
    );
    const summary = buildOrchestrationSessionSummary({
      persisted: {
        provider: 'station-agent',
        threadId: 'task:11111111-1111-4111-8111-111111111111',
        status: 'ready',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:01.000Z',
      },
      answerability: {
        threadAttachment: 'detached',
        providerRegistered: true,
        observedBy: 'test',
        observedAt: '2026-08-30T00:00:02.000Z',
      },
      events: [
        {
          eventId: 'delegated-turn-started',
          provider: 'station-agent',
          threadId: 'task:11111111-1111-4111-8111-111111111111',
          turnId: 'provider-turn-local',
          createdAt: '2026-08-30T00:00:01.000Z',
          method: 'turn.started',
          clientOrigin,
        } as never,
      ],
    });
    expect(summary.turnOrigin).toEqual({
      latest: clientOrigin,
      hasOtherOrigins: false,
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/orchestration/commands'),
      ),
    ).toBe(false);
  });

  test.each([true, false])(
    'does not retry an indeterminate delegation start (session returned: %s)',
    async (hasSession) => {
      installCurrentStationFetch();
      const service = localService();
      service.sessionCommands.execute.mockResolvedValueOnce({
        status: 'indeterminate',
        receipt: { commandId: 'command-1', status: 'accepted' },
        receiptStatus: 'unavailable',
        ...(hasSession
          ? {
              session: {
                threadId: 'task:22222222-2222-4222-8222-222222222222',
              },
            }
          : {}),
        message: 'Session started, but receipt persistence is unavailable.',
      } as never);
      const { delegateTask } = await import('../station-control-delegation.js');

      await expect(
        delegateTask(
          {
            prompt: 'Inspect the checkout',
            target: currentTarget(),
            sessionId: 'task:22222222-2222-4222-8222-222222222222',
            readAuthority: hostedAuthority('alpha'),
          },
          service as never,
        ),
      ).rejects.toThrow(
        'Session task:22222222-2222-4222-8222-222222222222 may already be running; do not retry automatically.',
      );
      expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    },
  );

  // archive#4543 LOW-2: a caller-supplied `sessionId` is stamped into
  // `metadata.conversationId` via the `conversationIdentity` internal
  // escape hatch — a reserved key whose contract (provider.ts's
  // `CONVERSATION_ID_RESERVED_METADATA_KEY` docblock) promises it is
  // "always resolved by Station". An MCP-tool caller can supply an
  // arbitrary custom `sessionId` (station-control-operations-tools.ts);
  // this proves a non-conforming one is rejected before it can be
  // laundered through that key, and before any resolution HTTP call runs.
  test('rejects a custom session id that is not the task:<uuid> form Station mints (station#4543 LOW-2)', async () => {
    installCurrentStationFetch();
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');

    await expect(
      delegateTask(
        {
          prompt: 'Inspect the checkout',
          target: currentTarget(),
          sessionId: 'not-a-task-id',
          readAuthority: hostedAuthority('alpha'),
        },
        service as never,
      ),
    ).rejects.toThrow(
      "Invalid session id 'not-a-task-id': a custom session id must match the 'task:<uuid>' form Station mints",
    );
    expect(service.sessionCommands.execute).not.toHaveBeenCalled();
    expect(service.startSessionInternal).not.toHaveBeenCalled();
    // The guard fires before Agent/connection resolution — only the
    // unavoidable current-environment handshake hits the network.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/agents/'),
      ),
    ).toBe(false);
  });

  test('rejects a hosted delegation with no trusted request authority before resolving a target', async () => {
    const previous = process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
    process.env.STATION_HOSTED_TENANT_REGISTRY_FILE =
      '/deployment/tenants.json';
    try {
      const { delegateTask } = await import('../station-control-delegation.js');
      await expect(
        delegateTask({ prompt: 'Run tests', target: savedTarget() }),
      ).rejects.toThrow('Delegation requires trusted hosted request authority');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
      } else {
        process.env.STATION_HOSTED_TENANT_REGISTRY_FILE = previous;
      }
    }
  });

  test('sends a remote delegation only to the target Station canonical route', async () => {
    const handle = delegationHandle({
      environment: {
        id: 'environment-remote',
        name: 'Brian media',
        kind: 'ssh',
      },
      target: { kind: 'agent', id: 'codex' },
    });
    installRemoteStationFetch('/api/orchestration/delegations', handle);
    const { delegateTask } = await import('../station-control-delegation.js');

    await expect(
      delegateTask({ prompt: 'Run tests', target: savedTarget() }),
    ).resolves.toEqual(handle);

    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === `${REMOTE_API}/api/orchestration/delegations`,
    );
    expect(call).toBeDefined();
    expect(bodyOf(call!)).toEqual({
      prompt: 'Run tests',
      target: {
        environment: { kind: 'current' },
        agent: 'codex',
        workspace: { kind: 'directory', cwd: '/srv/station' },
      },
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/orchestration/commands'),
      ),
    ).toBe(false);
  });

  test('records a peer dispatch on the delegating Station only after the peer accepts it (#847)', async () => {
    const recordPeerDelegationActivityDispatch = vi.fn();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/environments/ssh`) {
        return json({ success: true, data: [] });
      }
      if (
        url ===
        `${CURRENT_API}/api/environments/peers/environment-remote/credential`
      ) {
        return json({
          success: true,
          data: {
            environmentId: 'environment-remote',
            apiBase: REMOTE_API,
            scope: 'station:peer',
            credential: 'peer-secret',
            label: 'Station B',
          },
        });
      }
      if (url === `${REMOTE_API}/api/orchestration/delegations`) {
        return json({
          success: true,
          data: delegationHandle({
            taskId: 'task-peer-847',
            sessionId: 'task-peer-847',
            provider: 'codex',
            environment: {
              id: 'environment-remote',
              name: 'Current environment',
              kind: 'current',
            },
            target: { kind: 'agent', id: 'codex' },
          }),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { delegateTask } = await import('../station-control-delegation.js');

    await delegateTask(
      { prompt: 'Run the peer checks', target: savedTarget() },
      { recordPeerDelegationActivityDispatch } as never,
    );

    expect(recordPeerDelegationActivityDispatch).toHaveBeenCalledWith({
      taskId: 'task-peer-847',
      conversationId: 'task-peer-847',
      prompt: 'Run the peer checks',
      userId: expect.any(String),
      environment: {
        id: 'environment-remote',
        name: 'Station B',
        kind: 'peer',
      },
      target: { kind: 'agent', id: 'codex' },
    });
  });

  test('returns a successful peer observation when local Activity bookkeeping throws (#847 fix round)', async () => {
    const recordPeerDelegationActivityOutcome = vi.fn(() => {
      throw new Error('local projection failed');
    });
    const snapshot = {
      conversationId: 'task-peer-847-observe',
      taskId: 'task-peer-847-observe',
      sessionId: 'task-peer-847-observe',
      currentSessionId: 'task-peer-847-observe',
      status: 'needs_input',
      environment: {
        id: 'environment-current',
        name: 'Current environment',
        kind: 'current',
      },
      target: { kind: 'agent', id: 'codex' },
      eventCount: 1,
      canInterrupt: false,
      resumable: false,
    };
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/environments/ssh`) {
        return json({ success: true, data: [] });
      }
      if (
        url ===
        `${CURRENT_API}/api/environments/peers/environment-remote/credential`
      ) {
        return json({
          success: true,
          data: {
            environmentId: 'environment-remote',
            apiBase: REMOTE_API,
            scope: 'station:peer',
            credential: 'peer-secret',
            label: 'Station B',
          },
        });
      }
      if (
        url ===
        `${REMOTE_API}/api/orchestration/delegations/task-peer-847-observe`
      ) {
        return json({ success: true, data: snapshot });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTask(
        {
          taskId: 'task-peer-847-observe',
          environmentId: 'environment-remote',
        },
        { recordPeerDelegationActivityOutcome } as never,
      ),
    ).resolves.toMatchObject({ status: 'needs_input' });
    expect(recordPeerDelegationActivityOutcome).toHaveBeenCalledWith({
      taskId: 'task-peer-847-observe',
      environmentId: 'environment-remote',
      status: 'needs_input',
    });
  });

  test('bounds the older-peer 404 fallback session read with the observation timeout (#847 fix round)', async () => {
    let fallbackSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/environments/ssh`) {
        return json({ success: true, data: [] });
      }
      if (
        url ===
        `${CURRENT_API}/api/environments/peers/environment-remote/credential`
      ) {
        return json({
          success: true,
          data: {
            environmentId: 'environment-remote',
            apiBase: REMOTE_API,
            scope: 'station:peer',
            credential: 'peer-secret',
            label: 'Station B',
          },
        });
      }
      if (
        url === `${REMOTE_API}/api/orchestration/delegations/task-peer-legacy`
      ) {
        return json({ success: false, error: 'route not found' }, 404);
      }
      if (url === `${REMOTE_API}/api/orchestration/sessions/task-peer-legacy`) {
        fallbackSignal = init?.signal ?? undefined;
        return json({
          success: true,
          data: {
            session: {
              provider: 'codex',
              threadId: 'task-peer-legacy',
              lifecycleState: 'running',
            },
            events: [
              {
                method: 'session.started',
                metadata: {
                  taskId: 'task-peer-legacy',
                  conversationId: 'task-peer-legacy',
                  environmentId: 'environment-remote',
                  environmentName: 'Station B',
                  targetKind: 'agent',
                  targetId: 'codex',
                },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTask({
        taskId: 'task-peer-legacy',
        environmentId: 'environment-remote',
        readTimeoutMs: 1_500,
      }),
    ).resolves.toMatchObject({ status: 'running' });
    expect(fallbackSignal).toBeInstanceOf(AbortSignal);
  });

  test('relays target-side delegation validation errors without a fallback', async () => {
    installRemoteStationFetch('/api/orchestration/delegations', undefined);
    // Replace only the canonical target response with a rejection while the
    // SSH resolution requests continue through the installed implementation.
    const baseImplementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `${REMOTE_API}/api/orchestration/delegations`) {
        return json(
          { success: false, error: 'Agent is not currently launchable.' },
          400,
        );
      }
      return baseImplementation(input, init);
    });
    const { delegateTask } = await import('../station-control-delegation.js');

    await expect(
      delegateTask({ prompt: 'Run tests', target: savedTarget() }),
    ).rejects.toThrow('Agent is not currently launchable.');
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/api/orchestration/delegations'),
      ),
    ).toHaveLength(1);
  });

  test('executes a remote foreground message through /chat with the full target input', async () => {
    const handle = foregroundHandle();
    installRemoteStationFetch('/api/orchestration/chat', handle);
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      executeExecutionTargetMessage({
        target: savedTarget(),
        message: 'Inspect this',
        conversationId: 'conversation-1',
        ambientContext: '[Timezone: America/Denver]',
        clientTurnId: 'client-turn-1',
      }),
    ).resolves.toEqual(handle);

    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === `${REMOTE_API}/api/orchestration/chat`,
    );
    expect(bodyOf(call!)).toEqual({
      target: {
        environment: { kind: 'current' },
        agent: 'codex',
        workspace: { kind: 'directory', cwd: '/srv/station' },
      },
      message: 'Inspect this',
      conversationId: 'conversation-1',
      ambientContext: '[Timezone: America/Denver]',
      clientTurnId: 'client-turn-1',
    });
  });

  test('preserves remote foreground indeterminacy as typed no-retry evidence', async () => {
    installRemoteStationFetch('/api/orchestration/chat', {});
    const baseImplementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `${REMOTE_API}/api/orchestration/chat`) {
        return json(
          {
            success: false,
            error:
              'Session may already be running; do not retry automatically.',
            code: 'foreground_message_indeterminate',
            outcome: 'indeterminate',
            receipt: {
              commandId: 'command-uncertain',
              threadId: 'conversation-uncertain',
              commandType: 'startSession',
              status: 'accepted',
              createdAt: '2026-08-13T00:00:00.000Z',
            },
            receiptStatus: 'unavailable',
            session: {
              threadId: 'conversation-uncertain',
              provider: 'claude',
              status: 'ready',
              createdAt: '2026-08-13T00:00:00.000Z',
              updatedAt: '2026-08-13T00:00:00.000Z',
            },
          },
          409,
        );
      }
      return baseImplementation(input, init);
    });
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      executeExecutionTargetMessage({
        target: savedTarget(),
        message: 'Do not dispatch twice',
        conversationId: 'conversation-uncertain',
      }),
    ).rejects.toMatchObject({
      name: 'ForegroundMessageIndeterminateError',
      code: 'foreground_message_indeterminate',
      detail: {
        receiptStatus: 'unavailable',
        session: { threadId: 'conversation-uncertain' },
      },
    });
  });

  test('uses the fixed delegated route for a cross-Station child message', async () => {
    const handle = foregroundHandle();
    installRemoteStationFetch('/api/orchestration/chat/delegated', handle);
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );
    const delegation = {
      mode: 'isolated-child' as const,
      depth: 1,
      maxDepth: 2,
      parentAgentSlug: 'parent' as never,
      rootAgentSlug: 'root' as never,
    };

    await expect(
      executeExecutionTargetMessage({
        target: savedTarget(),
        message: 'Delegated remote work',
        conversationId: 'conversation-delegated-remote',
        delegation,
      }),
    ).resolves.toEqual(handle);

    const call = fetchMock.mock.calls.find(
      ([url]) =>
        String(url) === `${REMOTE_API}/api/orchestration/chat/delegated`,
    );
    expect(bodyOf(call!)).toMatchObject({ delegation });
  });

  test('preserves detail-less remote foreground indeterminacy and ambiguous responses', async () => {
    installRemoteStationFetch('/api/orchestration/chat', {});
    const baseImplementation = fetchMock.getMockImplementation()!;
    let response: 'detail-less' | 'invalid-json' | 'network' = 'detail-less';
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) !== `${REMOTE_API}/api/orchestration/chat`) {
        return baseImplementation(input, init);
      }
      if (response === 'network') throw new TypeError('socket closed');
      if (response === 'invalid-json') {
        return new Response('<not json>', { status: 200 });
      }
      return json(
        {
          success: false,
          error: 'The remote Station cannot confirm foreground delivery.',
          code: 'foreground_message_indeterminate',
          outcome: 'indeterminate',
        },
        409,
      );
    });
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );
    const send = () =>
      executeExecutionTargetMessage({
        target: savedTarget(),
        message: 'Do not retry this foreground dispatch',
      });

    await expect(send()).rejects.toMatchObject({
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
    response = 'invalid-json';
    await expect(send()).rejects.toMatchObject({
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
    response = 'network';
    await expect(send()).rejects.toMatchObject({
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
  });

  test('requires a typed provider turn receipt for remote continuation', async () => {
    installRemoteStationFetch(
      '/api/orchestration/chat/conversation-1/continue',
      { ...foregroundHandle(), providerTurnId: '' },
      { workingDirectory: '/srv/station', existingSessionCwd: '/srv/station' },
    );
    const { continueExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueExecutionTargetMessage({
        conversationId: 'conversation-1',
        environment: { kind: 'saved', id: environmentId('environment-remote') },
        message: 'Continue without a receipt',
      }),
    ).rejects.toMatchObject({
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
  });

  test('refuses a saved remote Environment before any handoff transport effect', async () => {
    const { handoffExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );
    await expect(
      handoffExecutionTargetMessage({
        target: savedTarget(),
        message: 'Do not serialize the handoff intent',
        idempotencyKey: 'handoff-remote-1',
      }),
    ).rejects.toThrow('only on the conversation current Environment');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('preserves detail-less remote continuation indeterminacy', async () => {
    installRemoteStationFetch(
      '/api/orchestration/chat/conversation-1/continue',
      {},
      { workingDirectory: '/srv/station', existingSessionCwd: '/srv/station' },
    );
    const baseImplementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (
        String(input) ===
        `${REMOTE_API}/api/orchestration/chat/conversation-1/continue`
      ) {
        return json(
          {
            success: false,
            code: 'foreground_message_indeterminate',
            outcome: 'indeterminate',
            error: 'Continuation may already be running.',
          },
          409,
        );
      }
      return baseImplementation(input, init);
    });
    const { continueExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueExecutionTargetMessage({
        conversationId: 'conversation-1',
        environment: { kind: 'saved', id: environmentId('environment-remote') },
        message: 'Do not continue twice',
      }),
    ).rejects.toMatchObject({
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
  });

  test('rejects remote foreground continuation when a pre-fix conversation cwd escapes the verified SSH workspace', async () => {
    installRemoteStationFetch(
      '/api/orchestration/chat/conversation-1/continue',
      foregroundHandle(),
      { workingDirectory: '/srv/station', existingSessionCwd: '/srv/secret' },
    );
    const { continueExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueExecutionTargetMessage({
        conversationId: 'conversation-1',
        environment: { kind: 'saved', id: environmentId('environment-remote') },
        message: 'Continue only in the verified checkout',
      }),
    ).rejects.toThrow('does not match the verified SSH environment workspace');
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url) ===
          `${REMOTE_API}/api/orchestration/chat/conversation-1/continue`,
      ),
    ).toBe(false);
  });

  test('continues remote foreground work only after confirming the persisted cwd matches the verified SSH workspace', async () => {
    const handle = foregroundHandle();
    installRemoteStationFetch(
      '/api/orchestration/chat/conversation-1/continue',
      handle,
      { workingDirectory: '/srv/station', existingSessionCwd: '/srv/station' },
    );
    const { continueExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueExecutionTargetMessage({
        conversationId: 'conversation-1',
        environment: { kind: 'saved', id: environmentId('environment-remote') },
        message: 'Continue only in the verified checkout',
      }),
    ).resolves.toEqual(handle);
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url) ===
          `${REMOTE_API}/api/orchestration/sessions/conversation-1`,
      ),
    ).toBe(true);
  });

  test('continues local project work with the persisted isolation after its project default changes', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/agents/codex`) {
        return json({
          success: true,
          data: { slug: 'codex', available: true },
        });
      }
      if (url === `${CURRENT_API}/api/projects/workspace`) {
        return json({
          success: true,
          data: {
            workingDirectory: '/srv/station',
            defaultWorkspaceIsolation: 'shared',
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const orchestrationService = localService();
    orchestrationService.currentConversationSessionId.mockReturnValue(
      'conversation:local-project:session:b',
    );
    orchestrationService.readSession.mockImplementation(
      async (sessionId?: string) =>
        ({
          session: { cwd: '/srv/station' },
          events: [
            {
              method: 'session.configured',
              metadata:
                sessionId === 'conversation:local-project:session:b'
                  ? {
                      environmentId: 'environment-current',
                      targetKind: 'agent',
                      targetId: 'codex',
                      connectionId: 'codex',
                    }
                  : {
                      environmentId: 'environment-current',
                      targetKind: 'agent',
                      targetId: 'legacy-agent-a',
                      projectSlug: 'workspace',
                      workspaceIsolation: { mode: 'worktree' },
                    },
            },
          ],
        }) as never,
    );
    const { continueExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueExecutionTargetMessage(
        {
          conversationId: 'conversation:local-project',
          message: 'Continue in the original isolation',
        },
        orchestrationService as never,
      ),
    ).resolves.toMatchObject({ conversationId: 'conversation:local-project' });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `${CURRENT_API}/api/agents/codex`,
      ),
    ).toBe(true);
    expect(orchestrationService.dispatchWithReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sendTurn' }),
      expect.anything(),
      expect.objectContaining({
        nativeMemoryReadAuthority: expect.objectContaining({ userId: '' }),
      }),
    );
  });

  // archive#3421: this is the seam the bug lived in. The pure binding function
  // is tested separately; what was broken is that a DIRECTORY-bound
  // conversation reached the continuation with no workspace at all, because
  // only the project shape was rebuilt. Swapping the session-cwd read for a
  // field nothing writes leaves the pure tests green and restores the bug, so
  // the seam needs its own proof.
  test('continues local work for a conversation bound to a directory rather than a project', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/agents/codex`) {
        return json({
          success: true,
          data: { slug: 'codex', available: true },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const orchestrationService = localService();
    const resolveConversationContinuation = vi.fn(async () => ({
      sessionId: 'conversation:local-directory:session:1',
      startRequired: true,
      transcriptSeed: 'Prior conversation transcript: token amber-42.',
    }));
    Object.assign(orchestrationService, { resolveConversationContinuation });
    orchestrationService.readSession.mockResolvedValue({
      session: { cwd: '/srv/scratch' },
      events: [
        {
          method: 'session.configured',
          metadata: {
            environmentId: 'environment-current',
            targetKind: 'agent',
            targetId: 'codex',
            // No projectSlug: a plain `station chat` from a shell.
          },
        },
      ],
    } as never);
    const { continueExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueExecutionTargetMessage(
        {
          conversationId: 'conversation:local-directory',
          message: 'Continue where this conversation already lives',
        },
        orchestrationService as never,
      ),
    ).resolves.toMatchObject({
      conversationId: 'conversation:local-directory',
    });
    // No project lookup: the binding names a directory, so nothing should try
    // to resolve a project's working directory for it.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/projects/'),
      ),
    ).toBe(false);
    expect(resolveConversationContinuation).toHaveBeenCalledWith(
      'conversation:local-directory',
      expect.anything(),
      { provider: 'station-agent' },
    );
    expect(orchestrationService.sessionCommands.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadId: 'conversation:local-directory:session:1',
          cwd: '/srv/scratch',
          metadata: expect.objectContaining({
            conversationId: 'conversation:local-directory',
          }),
        }),
      }),
      expect.anything(),
    );
    expect(orchestrationService.dispatchWithReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sendTurn',
        input: expect.objectContaining({
          threadId: 'conversation:local-directory:session:1',
          ambientContext: expect.stringContaining('amber-42'),
        }),
      }),
      expect.anything(),
      expect.objectContaining({
        nativeMemoryReadAuthority: expect.objectContaining({ userId: '' }),
      }),
    );
  });

  test('rejects direct remote delegation to a project outside the verified SSH workspace', async () => {
    installRemoteStationFetch(
      '/api/orchestration/delegations',
      {},
      {
        workingDirectory: '/srv/station',
        projects: { secret: '/srv/secret' },
      },
    );
    const { delegateTask } = await import('../station-control-delegation.js');

    await expect(
      delegateTask({
        prompt: 'Inspect the secret checkout',
        target: {
          ...savedTarget(),
          workspace: { kind: 'project', projectSlug: 'secret' },
        },
      }),
    ).rejects.toThrow('does not match the verified SSH environment workspace');
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url) === `${REMOTE_API}/api/orchestration/delegations`,
      ),
    ).toBe(false);
  });

  test('rejects remote foreground dispatch to a directory outside the verified SSH workspace', async () => {
    installRemoteStationFetch(
      '/api/orchestration/chat',
      {},
      {
        workingDirectory: '/srv/station',
      },
    );
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      executeExecutionTargetMessage({
        target: {
          ...savedTarget(),
          workspace: { kind: 'directory', cwd: '/srv/secret' },
        },
        message: 'Inspect the secret checkout',
      }),
    ).rejects.toThrow('does not match the verified SSH environment workspace');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `${REMOTE_API}/api/orchestration/chat`,
      ),
    ).toBe(false);
  });

  test('executes a local foreground message through the injected service', async () => {
    installCurrentStationFetch();
    const service = localService();
    const authority = hostedAuthority('alpha');
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    const result = await executeExecutionTargetMessage(
      {
        target: currentTarget(),
        message: 'Inspect this',
        conversationId: 'conversation-local',
        clientTurnId: 'client-turn-local',
        readAuthority: authority,
      },
      service as never,
    );

    expect(result).toMatchObject({
      conversationId: 'conversation-local',
      target: { kind: 'agent', id: 'reviewer' },
    });
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(service.startSessionInternal.mock.calls[0]?.[2]).toMatchObject({
      resourceAdmissionIntent: 'interactive_user',
    });
    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt.mock.calls[0][0]).toMatchObject({
      type: 'sendTurn',
      input: {
        threadId: 'conversation-local',
        input: 'Inspect this',
        clientTurnId: 'client-turn-local',
      },
    });
    expect(service.sessionCommands.execute.mock.calls[0][1]).toEqual({
      userId: 'shared-user',
      tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
    });
    expect(service.dispatchWithReceipt.mock.calls[0][1]).toEqual({
      userId: 'shared-user',
      tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
    });
  });

  test('carries captured Pane admission through the real foreground bridge', async () => {
    installCurrentStationFetch();
    const service = localService();
    const admission = foregroundAdmission();
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    const result = await executeExecutionTargetMessage(
      {
        target: {
          ...currentTarget(),
          workspace: { kind: 'project', projectSlug: 'workspace' },
        },
        message: admission.message,
        userId: 'shared-user',
        readAuthority: hostedAuthority('alpha'),
      },
      service as never,
      admission,
    );

    expect(result).toMatchObject({
      target: { kind: 'agent', id: 'reviewer' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.startSessionInternal.mock.calls[0]?.[2]).toMatchObject({
      foregroundInvocationAdmission: admission,
    });
    expect(service.dispatchWithReceipt.mock.calls[0]?.[2]).toMatchObject({
      foregroundInvocationAdmission: admission,
    });
  });

  test.each([
    ['saved Environment', { target: savedTarget('reviewer') }],
    [
      'model override',
      { target: { ...currentTarget(), model: { override: 'other' } } },
    ],
    [
      'attachment',
      {
        attachments: [
          {
            kind: 'file',
            name: 'x',
            mediaType: 'text/plain',
            dataUrl: 'data:text/plain,x',
          },
        ],
      },
    ],
    ['ambient context', { ambientContext: 'late replacement' }],
  ])(
    'refuses Pane admission with %s before local adapter effects',
    async (_name, overrides) => {
      installCurrentStationFetch();
      const service = localService();
      const admission = foregroundAdmission();
      const { executeExecutionTargetMessage } = await import(
        '../station-control-delegation.js'
      );
      const target = {
        ...currentTarget(),
        workspace: { kind: 'project' as const, projectSlug: 'workspace' },
      };
      await expect(
        executeExecutionTargetMessage(
          {
            target,
            message: admission.message,
            userId: 'shared-user',
            readAuthority: hostedAuthority('alpha'),
            ...overrides,
          } as never,
          service as never,
          admission,
        ),
      ).rejects.toThrow('captured Workspace Pane action is unavailable');
      expect(service.startSessionInternal).not.toHaveBeenCalled();
      expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    },
  );

  test('derives webhook admission from the server-owned ephemeral seam', async () => {
    installCurrentStationFetch();
    const service = localService();
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await executeExecutionTargetMessage(
      {
        target: currentTarget(),
        message: 'Webhook delivery',
        conversationId: 'conversation-webhook',
        ephemeral: true,
        webhookTokenId: 'token-1',
        readAuthority: hostedAuthority('alpha'),
      },
      service as never,
    );

    expect(service.startSessionInternal.mock.calls[0]?.[2]).toMatchObject({
      ephemeralSessionVisibility: true,
      resourceAdmissionIntent: 'webhook',
    });
  });

  test('derives delegated/background admission from server-carried delegation metadata', async () => {
    installCurrentStationFetch();
    const service = localService();
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await executeExecutionTargetMessage(
      {
        target: currentTarget(),
        message: 'Delegated delivery',
        conversationId: 'conversation-delegated',
        delegation: {
          mode: 'isolated-child',
          depth: 1,
          maxDepth: 2,
          parentAgentSlug: 'parent' as never,
          rootAgentSlug: 'root' as never,
        },
        readAuthority: hostedAuthority('alpha'),
      },
      service as never,
    );

    expect(service.startSessionInternal.mock.calls[0]?.[2]).toMatchObject({
      resourceAdmissionIntent: 'delegated_background',
    });
  });

  test('derives queued/background admission from the fixed background route seam', async () => {
    installCurrentStationFetch();
    const service = localService();
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await executeExecutionTargetMessage(
      {
        target: currentTarget(),
        message: 'Queued replay',
        conversationId: 'conversation-background',
        automaticBackground: true,
        readAuthority: hostedAuthority('alpha'),
      },
      service as never,
    );

    expect(service.startSessionInternal.mock.calls[0]?.[2]).toMatchObject({
      resourceAdmissionIntent: 'queued_background',
    });
  });

  test('refuses a foreground start without fabricating a session when provider creation is uncertain', async () => {
    installCurrentStationFetch();
    const service = localService();
    service.sessionCommands.execute.mockResolvedValueOnce({
      status: 'indeterminate',
      receipt: { commandId: 'unknown-creation', status: 'accepted' },
      receiptStatus: 'unavailable',
      message: 'Provider creation is unresolved.',
      code: 'SESSION_START_INDETERMINATE',
    } as never);
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );
    await expect(
      executeExecutionTargetMessage(
        {
          target: currentTarget(),
          message: 'Do not dispatch twice',
          conversationId: 'unknown-creation',
          readAuthority: hostedAuthority('alpha'),
        },
        service as never,
      ),
    ).rejects.toMatchObject({
      name: 'SessionStartIndeterminateError',
      code: 'SESSION_START_INDETERMINATE',
    });
    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('returns typed indeterminate foreground evidence instead of dispatching a second turn', async () => {
    installCurrentStationFetch();
    const service = localService();
    service.sessionCommands.execute.mockResolvedValueOnce({
      status: 'indeterminate',
      receipt: {
        commandId: 'command-uncertain',
        threadId: 'conversation-uncertain',
        commandType: 'startSession',
        status: 'accepted',
        createdAt: '2026-08-13T00:00:00.000Z',
      },
      receiptStatus: 'unavailable',
      session: {
        threadId: 'conversation-uncertain',
        provider: 'claude',
        status: 'ready',
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
      },
      message: 'Session started, but its accepted receipt is unavailable.',
    } as never);
    const { executeExecutionTargetMessage } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      executeExecutionTargetMessage(
        {
          target: currentTarget(),
          message: 'Do not dispatch twice',
          conversationId: 'conversation-uncertain',
          readAuthority: hostedAuthority('alpha'),
        },
        service as never,
      ),
    ).rejects.toMatchObject({
      name: 'ForegroundMessageIndeterminateError',
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
      detail: {
        receiptStatus: 'unavailable',
        session: { threadId: 'conversation-uncertain' },
      },
    });
    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('continues a remote task through its canonical delegation route', async () => {
    const followUp = {
      taskId: 'task-1',
      sessionId: 'task-1',
      status: 'dispatched',
      environment: {
        id: 'environment-remote',
        name: 'Brian media',
        kind: 'ssh',
      },
      target: { kind: 'agent', id: 'codex' },
    };
    installRemoteStationFetch('/api/orchestration/delegations', followUp);
    const baseImplementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (
        String(input) ===
        `${REMOTE_API}/api/orchestration/delegations/task-1/continue`
      ) {
        return json({ success: true, data: followUp });
      }
      return baseImplementation(input, init);
    });
    const { continueDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueDelegatedTask({
        taskId: 'task-1',
        environmentId: 'environment-remote',
        message: 'Continue',
        modelOptions: { reasoningEffort: 'high' },
      }),
    ).resolves.toMatchObject(followUp);

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/delegations/task-1/continue'),
    );
    expect(bodyOf(call!)).toEqual({
      message: 'Continue',
      modelOptions: { reasoningEffort: 'high' },
    });
  });

  test('supervises a remote conversation through its current child Session, never its completed root (station#3414)', async () => {
    const conversationId = 'task:remote-root';
    const currentSessionId = 'task:remote-root:session:child-2';
    const snapshot = {
      conversationId,
      taskId: conversationId,
      sessionId: currentSessionId,
      currentSessionId,
      status: 'running',
      environment: {
        id: 'environment-remote',
        name: 'Brian media',
        kind: 'ssh',
      },
      target: { kind: 'agent', id: 'codex' },
      eventCount: 2,
      canInterrupt: true,
      resumable: false,
    };
    installRemoteStationFetch('/api/orchestration/delegations', {});
    const baseImplementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (
        url ===
        `${REMOTE_API}/api/orchestration/delegations/${encodeURIComponent(conversationId)}`
      ) {
        return json({ success: true, data: snapshot });
      }
      if (
        url ===
        `${REMOTE_API}/api/orchestration/delegations/${encodeURIComponent(conversationId)}/events`
      ) {
        return json({
          success: true,
          data: {
            ...snapshot,
            events: [
              {
                sequence: 1,
                method: 'turn.started',
                kind: 'lifecycle',
              },
            ],
            nextCursor: 'station-task-events:v1:1',
            hasMore: false,
          },
        });
      }
      if (
        url ===
        `${REMOTE_API}/api/orchestration/delegations/${encodeURIComponent(conversationId)}/respond`
      ) {
        expect(bodyOf([input, init] as Parameters<typeof fetch>)).toEqual({
          requestId: 'request-child',
          decision: 'accept',
        });
        return json({
          success: true,
          data: {
            ...snapshot,
            requestId: 'request-child',
            status: 'resolved',
            decision: 'accept',
          },
        });
      }
      if (
        url ===
        `${REMOTE_API}/api/orchestration/delegations/${encodeURIComponent(conversationId)}/interrupt`
      ) {
        expect(bodyOf([input, init] as Parameters<typeof fetch>)).toEqual({});
        return json({
          success: true,
          data: { ...snapshot, interruptRequested: true },
        });
      }
      return baseImplementation(input, init);
    });
    const {
      interruptDelegatedTask,
      observeDelegatedTask,
      observeDelegatedTaskEvents,
      respondToDelegatedTaskRequest,
    } = await import('../station-control-delegation.js');

    await expect(
      observeDelegatedTask({
        taskId: conversationId,
        environmentId: 'environment-remote',
      }),
    ).resolves.toMatchObject({ currentSessionId });
    await expect(
      observeDelegatedTaskEvents({
        taskId: conversationId,
        environmentId: 'environment-remote',
      }),
    ).resolves.toMatchObject({ currentSessionId, events: [{ sequence: 1 }] });
    await expect(
      respondToDelegatedTaskRequest({
        taskId: conversationId,
        environmentId: 'environment-remote',
        requestId: 'request-child',
        decision: 'accept',
      }),
    ).resolves.toMatchObject({ currentSessionId });
    await expect(
      interruptDelegatedTask({
        taskId: conversationId,
        environmentId: 'environment-remote',
      }),
    ).resolves.toMatchObject({ currentSessionId, interruptRequested: true });

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(`/sessions/${encodeURIComponent(conversationId)}`),
      ),
    ).toBe(false);
  });

  /**
   * archive#3414. This is a Conversation capability, not a claim that its
   * current child Session itself can be reopened. A busy child refuses a
   * concurrent turn; a completed/failed/canceled child is continued by
   * reserving the next child.
   */
  test('reports continuation capability from the current child state, not as a constant', async () => {
    installCurrentStationFetch();
    const authority = hostedAuthority('alpha');
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        localDelegatedTaskService('running') as never,
      ),
    ).resolves.toMatchObject({ status: 'running', resumable: false });

    // A completed child is replaceable under the same durable Conversation.
    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        localDelegatedTaskService('completed') as never,
      ),
    ).resolves.toMatchObject({ status: 'completed', resumable: true });

    // Failed/canceled child Sessions also preserve the Conversation and can
    // start the next child.
    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        localDelegatedTaskService('failed') as never,
      ),
    ).resolves.toMatchObject({ status: 'failed', resumable: true });

    // A state this contract does not recognize projects as `unknown`, and a
    // capability nobody can compute is not claimed.
    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        localDelegatedTaskService('not-a-lifecycle-state') as never,
      ),
    ).resolves.toMatchObject({ status: 'unknown', resumable: false });

    // Every remaining lifecycle state, both directions, so the derivation is
    // pinned rather than sampled: a hand-listed set and this contract-derived
    // one agree on today's states and diverge on tomorrow's, and only an
    // exhaustive check can say which one is running.
    for (const [status, expected] of [
      ['queued', true],
      ['canceled', true],
      ['needs_input', false],
      ['review_pending', false],
      ['blocked', false],
    ] as const) {
      await expect(
        observeDelegatedTask(
          { taskId: 'task-alpha', readAuthority: authority },
          localDelegatedTaskService(status) as never,
        ),
      ).resolves.toMatchObject({ status, resumable: expected });
    }
  });

  /**
   * #764 diagnosis, pinned. A cleanly completed external-engine (ACP) turn —
   * `turn.completed` with a non-cancelled finishReason as its terminal event
   * — folds `completed` through the REAL lifecycle projection and therefore
   * reads resumable. The live "(no longer accepts follow-up turns)" reading
   * for a completed task is the OTHER fold: an unresolved `request.opened`
   * after the terminal event, which pins `review_pending`; that snapshot
   * correctly steers to `respond`, not continue, so its non-resumable line
   * is honest. resumable's derivation itself is not weakened.
   */
  test('folds a completed external-engine delegated task as resumable, and a trailing unresolved request as not (#764)', async () => {
    const { projectSessionLifecycle } = await import(
      '../../services/orchestration/session-lifecycle-service.js'
    );
    const baseSession = {
      provider: 'acp',
      threadId: 'task-acp',
      status: 'ready',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:05.000Z',
    } as never;
    const completedTurn = [
      { method: 'session.started', initialState: 'created' },
      { method: 'session.configured' },
      { method: 'turn.started', turnId: 'turn-1' },
      { method: 'turn.completed', turnId: 'turn-1', finishReason: 'stop' },
    ] as never[];
    const withTrailingRequest = [
      ...completedTurn,
      {
        method: 'request.opened',
        requestId: 'request-late',
        requestType: 'approval',
      },
    ] as never[];

    expect(
      projectSessionLifecycle({
        session: baseSession,
        events: completedTurn,
      }),
    ).toMatchObject({ lifecycleState: 'completed' });
    expect(
      projectSessionLifecycle({
        session: baseSession,
        events: withTrailingRequest,
      }),
    ).toMatchObject({ lifecycleState: 'review_pending' });

    installCurrentStationFetch();
    const authority = hostedAuthority('alpha');
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        localDelegatedTaskService('completed', 'acp') as never,
      ),
    ).resolves.toMatchObject({ status: 'completed', resumable: true });

    const reviewPending = localDelegatedTaskService('review_pending', 'acp');
    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        reviewPending as never,
      ),
    ).resolves.toMatchObject({
      status: 'review_pending',
      resumable: false,
      pendingRequest: { id: 'request-alpha' },
    });
  });

  test('status routes through the lineage-aware read when the current session id is not the root (routing pin only) (#764)', async () => {
    installCurrentStationFetch();
    const authority = hostedAuthority('alpha');
    const service = localDelegatedTaskService('completed');
    // This is a DOUBLE, not a lineage fixture: its readSession returns detail
    // for any id, so it cannot discriminate look-through from raw reads. It
    // pins only the ROUTING — loadDelegatedTask must call the lineage-aware
    // readCurrentConversationSession for a current-env task. The actual
    // reserved-but-unstarted look-through (and the retried continue through
    // it) is proven against the REAL service/store below.
    service.currentConversationSessionId = vi.fn(
      () => 'task-alpha:session:reserved-child',
    );
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        service as never,
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      resumable: true,
      sessionId: 'task-alpha',
    });
    expect(service.readCurrentConversationSession).toHaveBeenCalledWith(
      'task-alpha',
      expect.anything(),
    );
  });

  // #764 review round 2: the only tool-layer proof of the reserved-unstarted
  // tail used the stub double above, whose readSession answers for ANY id and
  // therefore cannot fail. This one builds the real EventStore and real
  // OrchestrationService so the reservation, the lineage read, and the
  // retried continue all run the production derivations.
  test('a reconciled continue after an uncertain start reuses the same reserved child through the real lineage store (#764)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegate-continuation-'));
    try {
      const eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
      const claude = new ContinuationFakeAdapter('claude');
      const stationAgent = new ContinuationFakeAdapter('station-agent');
      const adapters = [claude, stationAgent];
      const service = new OrchestrationService({
        adapterRegistry: {
          register() {},
          get(provider: string) {
            return adapters.find((adapter) => adapter.provider === provider);
          },
          list() {
            return adapters;
          },
        },
        eventBus: new EventBus(),
        eventStore,
        // The production bootstrap (runtime-initialize) configures exactly
        // this for the single-local-account deployment mode.
        ownerlessSessionAccess: 'single-user-compat',
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const authority = sessionReadAuthorityFromRequest(
        'shared-user',
        undefined,
        undefined,
      );
      const conversationId = 'task-continue-real';
      const binding = {
        taskId: 'task-continue-real',
        conversationId,
        environmentId: 'environment-current',
        environmentName: 'Current environment',
        targetKind: 'agent',
        targetId: 'reviewer',
        userId: 'shared-user',
      };
      const started = await service.sessionCommands.execute(
        {
          type: 'start-session',
          input: {
            threadId: conversationId,
            provider: 'claude',
            metadata: { userId: 'shared-user' },
          },
        },
        { userId: 'shared-user' },
      );
      if (started.status !== 'accepted') throw new Error(started.message);
      eventStore.appendEvent({
        eventId: 'continue-real-configured',
        provider: 'claude',
        threadId: conversationId,
        sessionId: conversationId,
        method: 'session.configured',
        metadata: binding,
        createdAt: '2026-08-28T00:00:00.500Z',
      });
      eventStore.appendEvent({
        eventId: 'continue-real-completed',
        provider: 'claude',
        threadId: conversationId,
        sessionId: conversationId,
        method: 'session.state-changed',
        from: 'running',
        to: 'completed',
        sessionState: 'completed',
        previousState: 'running',
        transitionReason: 'turn_completed',
        transitionSource: 'runtime',
        createdAt: '2026-08-28T00:00:01.000Z',
      });

      installCurrentStationFetch();
      const { continueDelegatedTask } = await import(
        '../station-control-delegation.js'
      );

      // The provider call throws after entry. Without a definitive provider
      // refusal receipt, this is uncertain rather than proof of no effects.
      // The reserved child must remain the sole lineage tail.
      stationAgent.startSession.mockImplementationOnce(async () => {
        throw new Error('simulated failed start');
      });
      await expect(
        continueDelegatedTask(
          {
            taskId: conversationId,
            message: 'first attempt',
            readAuthority: authority,
          },
          service as never,
        ),
      ).rejects.toThrow('simulated failed start');
      const lineage = eventStore.conversationSessions(conversationId);
      expect(lineage).toHaveLength(2);
      const reservedChildId = lineage.at(-1)!.sessionId;
      await expect(
        continueDelegatedTask(
          {
            taskId: conversationId,
            message: 'unsafe immediate retry',
            readAuthority: authority,
          },
          service as never,
        ),
      ).rejects.toThrow('no provider call was made');
      expect(stationAgent.startSession).toHaveBeenCalledTimes(1);
      // The existing trusted lifecycle observer supplies the missing terminal
      // evidence; elapsed time or the start exception is not enough.
      expect(
        eventStore.sessionTurnBoundaryAuthority().observe({
          eventId: 'confirmed-start-terminal',
          provider: 'claude',
          threadId: reservedChildId,
          sessionId: reservedChildId,
          method: 'session.exited',
          exitCode: 0,
          createdAt: new Date().toISOString(),
        }),
      ).toEqual({ kind: 'applied' });

      // The retry must look through the reserved-unstarted tail to the
      // predecessor's binding and REUSE the same reserved child identity,
      // not dead-end on a missing binding and not reserve a second child.
      const retry = await continueDelegatedTask(
        {
          taskId: conversationId,
          message: 'retry after failed start',
          readAuthority: authority,
        },
        service as never,
      );
      expect(retry).toMatchObject({
        conversationId,
        taskId: conversationId,
        sessionId: reservedChildId,
        currentSessionId: reservedChildId,
        status: 'dispatched',
      });
      expect(
        eventStore.conversationSessions(conversationId),
        'the retry must reuse the reservation, not mint a second child',
      ).toHaveLength(2);
      expect(stationAgent.startedSessionThreadIds()).toEqual([reservedChildId]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('continues an ended task through a child Session rather than reopening its predecessor', async () => {
    installCurrentStationFetch();
    const authority = hostedAuthority('alpha');
    const service = localDelegatedTaskService('completed');
    const { continueDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      continueDelegatedTask(
        {
          taskId: 'task-alpha',
          message: 'One more thing',
          readAuthority: authority,
        },
        service as never,
      ),
    ).resolves.toMatchObject({
      conversationId: 'task-alpha',
      taskId: 'task-alpha',
      sessionId: 'task-alpha:session:child-1',
      currentSessionId: 'task-alpha:session:child-1',
    });
    expect(service.startSessionInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadId: 'task-alpha:session:child-1',
        }),
      }),
      expect.anything(),
      expect.objectContaining({
        conversationIdentity: expect.objectContaining({
          conversationId: 'task-alpha',
        }),
      }),
    );
    expect(service.dispatchWithReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sendTurn',
        input: expect.objectContaining({
          threadId: 'task-alpha:session:child-1',
        }),
      }),
      expect.anything(),
      expect.objectContaining({ nativeMemoryReadAuthority: authority }),
    );
  });

  test('defers model-option capability to the current continuation resolver, not the predecessor provider (station#3414)', async () => {
    installCurrentStationFetch();
    const authority = hostedAuthority('alpha');
    const baseImplementation = fetchMock.getMockImplementation()!;
    const installCurrentEngine = (provider: 'codex' | 'acp') => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === `${CURRENT_API}/api/agents/reviewer`) {
          return json({
            success: true,
            data: {
              slug: 'reviewer',
              name: 'Reviewer',
              available: true,
              execution: { agentConnectionId: 'current-engine' },
            },
          });
        }
        if (url === `${CURRENT_API}/api/connections/current-engine`) {
          return json({
            success: true,
            data: {
              id: 'current-engine',
              kind: 'agent',
              type: provider === 'codex' ? 'codex' : 'acp',
              enabled: true,
              status: 'ready',
              capabilities: ['agent-runtime'],
              config: { provider },
            },
          });
        }
        return baseImplementation(input, init);
      });
    };
    const { continueDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    // The predecessor says station-agent, which used to reject every option
    // before the child could resolve. The current codex Agent accepts this
    // exact option, so it must reach the shared resolver and child dispatch.
    installCurrentEngine('codex');
    const accepted = localDelegatedTaskService('completed', 'station-agent');
    await expect(
      continueDelegatedTask(
        {
          taskId: 'task-alpha',
          message: 'Continue with current engine',
          modelOptions: { reasoningEffort: 'high' },
          readAuthority: authority,
        },
        accepted as never,
      ),
    ).resolves.toMatchObject({ sessionId: 'task-alpha:session:child-1' });
    expect(accepted.dispatchWithReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          modelOptions: { reasoningEffort: 'high' },
        }),
      }),
      expect.anything(),
      expect.objectContaining({ nativeMemoryReadAuthority: authority }),
    );

    // The inverse proves the old predecessor can no longer launder an option
    // through a child whose actual provider refuses it.
    installCurrentEngine('acp');
    const rejected = localDelegatedTaskService('completed', 'codex');
    await expect(
      continueDelegatedTask(
        {
          taskId: 'task-alpha',
          message: 'Reject against the current engine',
          modelOptions: { reasoningEffort: 'high' },
          readAuthority: hostedAuthority('alpha'),
        },
        rejected as never,
      ),
    ).rejects.toThrow(
      "Unsupported option 'reasoningEffort' for acp target 'reviewer'",
    );
    expect(rejected.startSessionInternal).not.toHaveBeenCalled();
  });

  test('uses trusted alpha authority for every local delegated-task callback without recursive HTTP', async () => {
    installCurrentStationFetch();
    const service = localDelegatedTaskService();
    const authority = hostedAuthority('alpha');
    const {
      continueDelegatedTask,
      interruptDelegatedTask,
      listDelegatedTasks,
      observeDelegatedTask,
      observeDelegatedTaskEvents,
      respondToDelegatedTaskRequest,
    } = await import('../station-control-delegation.js');

    await expect(
      listDelegatedTasks({ readAuthority: authority }, service as never),
    ).resolves.toMatchObject({ tasks: [{ taskId: 'task-alpha' }] });
    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: authority },
        service as never,
      ),
    ).resolves.toMatchObject({ taskId: 'task-alpha' });
    await expect(
      observeDelegatedTaskEvents(
        { taskId: 'task-alpha', readAuthority: authority },
        service as never,
      ),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ sequence: 1 }),
      ]),
    });
    await continueDelegatedTask(
      {
        taskId: 'task-alpha',
        message: 'Continue',
        readAuthority: authority,
      },
      service as never,
    );
    await respondToDelegatedTaskRequest(
      {
        taskId: 'task-alpha',
        requestId: 'request-alpha',
        decision: 'accept',
        readAuthority: authority,
      },
      service as never,
    );
    await interruptDelegatedTask(
      { taskId: 'task-alpha', readAuthority: authority },
      service as never,
    );

    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(3);
    const dispatchCalls = service.dispatchWithReceipt.mock
      .calls as unknown as Array<[unknown, unknown]>;
    for (const [, context] of dispatchCalls) {
      expect(context).toEqual({
        userId: 'shared-user',
        tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
      });
    }
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/orchestration/'),
      ),
    ).toBe(false);
  });

  test('fails closed for missing or bravo authority before local task control', async () => {
    installCurrentStationFetch();
    const service = localDelegatedTaskService();
    const { interruptDelegatedTask, observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTask(
        { taskId: 'task-alpha', readAuthority: hostedAuthority(undefined) },
        service as never,
      ),
    ).rejects.toThrow('Delegation requires trusted hosted request authority');
    await expect(
      interruptDelegatedTask(
        { taskId: 'task-alpha', readAuthority: hostedAuthority('bravo') },
        service as never,
      ),
    ).rejects.toThrow('Delegated task not found');

    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/orchestration/'),
      ),
    ).toBe(false);
  });
});

/**
 * archive#1783 (ADR 0012 residual) — the delegation tool is an HTTP client
 * to a TARGET environment's Station, and the delegating AGENT reads its
 * snapshot as a statement about that environment. Reporting an open request
 * with no qualification told the agent to wait for an answer that
 * environment can no longer produce: the same defect the UI surfaces had,
 * arriving through a tool result instead of a screen.
 *
 * The consumer is a machine, so the fix is a structured passthrough of the
 * target's own observation — never a local re-derivation, which this process
 * could not perform (it holds neither the target's adapter registry nor its
 * thread attachments).
 */
describe('observeDelegatedTask answerability passthrough (station#1783)', () => {
  const observation = {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'remote-station#99',
    observedAt: '2026-08-03T12:04:03.000Z',
  };

  function installTaskFetch(session: Record<string, unknown>) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/orchestration/delegations/task-1`) {
        return json({ success: false, error: 'route not found' }, 404);
      }
      if (url === `${CURRENT_API}/api/orchestration/sessions/task-1`) {
        return json({
          success: true,
          data: {
            session,
            events: [
              {
                method: 'session.configured',
                metadata: {
                  taskId: 'task-1',
                  environmentId: 'environment-current',
                  targetKind: 'agent',
                  targetId: 'reviewer',
                },
              },
              {
                method: 'request.opened',
                requestId: 'req-stranded',
                requestType: 'approval',
                title: 'Allow write',
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('forwards the target Station observation verbatim on the pending request', async () => {
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );
    installTaskFetch({ threadId: 'task-1', answerability: observation });

    const snapshot = await observeDelegatedTask({ taskId: 'task-1' });

    // Anti-filter: the pending request is still reported.
    expect(snapshot.pendingRequest?.id).toBe('req-stranded');
    // ...and the delegating agent is told, in structured form, that nothing
    // in the target environment could answer it as of that timestamp.
    expect(snapshot.pendingRequest?.answerability).toEqual(observation);
  });

  test('control: an answerable target reports the positive arm', async () => {
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );
    installTaskFetch({
      threadId: 'task-1',
      answerability: { answerable: true },
    });

    const snapshot = await observeDelegatedTask({ taskId: 'task-1' });
    expect(snapshot.pendingRequest?.answerability).toEqual({
      answerable: true,
    });
  });

  test('a pre-ADR-0012 target sending no decoration is not claimed unanswerable', async () => {
    // The response is parsed, not validated, so the required member is
    // `undefined` at runtime against an older peer. Normalizing at this
    // boundary is what stops a consumer folding `answerability.answerable`
    // and throwing — and the reader has no standing to claim `unanswerable`
    // about a registry it cannot see.
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );
    installTaskFetch({ threadId: 'task-1' });

    const snapshot = await observeDelegatedTask({ taskId: 'task-1' });
    expect(snapshot.pendingRequest?.answerability).toEqual({
      answerable: true,
    });
  });

  test('a negative arm with no basis is downgraded, not laundered through the tool', async () => {
    const { observeDelegatedTask } = await import(
      '../station-control-delegation.js'
    );
    installTaskFetch({
      threadId: 'task-1',
      answerability: { answerable: false, qualification: 'provider_absent' },
    });

    const snapshot = await observeDelegatedTask({ taskId: 'task-1' });
    expect(snapshot.pendingRequest?.answerability).toEqual({
      answerable: true,
    });
  });

  // archive#3963: `message` is pinned alongside `name`/`kind`/`status` for
  // every row here. The http rows (401/403/500) carry the target's own
  // `payload.error` text through unmodified; `timeout` (transport) and
  // `malformed` have no body to read a message from, so `getCanonical` falls
  // back to its fixed `unavailableMessage` — that fallback sentence is the
  // one archive#3963 found silently collapsing distinct conditions when nothing
  // pinned its wording, so it is asserted explicitly here rather than left
  // to drift in either direction.
  test.each([
    [
      '401',
      () => json({ success: false, error: 'unauthorized' }, 401),
      401,
      'http',
      'unauthorized',
    ],
    [
      '403',
      () => json({ success: false, error: 'forbidden' }, 403),
      403,
      'http',
      'forbidden',
    ],
    [
      '500',
      () => json({ success: false, error: 'remote failure' }, 500),
      500,
      'http',
      'remote failure',
    ],
    [
      'timeout',
      () => Promise.reject(new Error('timeout')),
      undefined,
      'transport',
      'The selected Station could not read the delegated task',
    ],
    [
      'malformed',
      () => new Response('not-json', { status: 200 }),
      200,
      'malformed',
      'The selected Station could not read the delegated task',
    ],
  ])(
    'does not degrade a canonical %s failure into the legacy root Session',
    async (_label, canonicalResult, status, kind, message) => {
      let legacyReads = 0;
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === `${CURRENT_API}/.well-known/station/v1`) {
          return json({ environmentId: 'environment-current' });
        }
        if (url === `${CURRENT_API}/api/orchestration/delegations/task-1`) {
          return await canonicalResult();
        }
        if (url === `${CURRENT_API}/api/orchestration/sessions/task-1`) {
          legacyReads += 1;
          return json({ success: true, data: { session: {}, events: [] } });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const { observeDelegatedTask } = await import(
        '../station-control-delegation.js'
      );

      await expect(
        observeDelegatedTask({ taskId: 'task-1' }),
      ).rejects.toMatchObject({
        name: 'CanonicalDelegationReadError',
        kind,
        message,
        ...(status === undefined ? {} : { status }),
      });
      expect(legacyReads).toBe(0);
    },
  );

  // archive#3963: `observeDelegatedTaskEvents` shares `getCanonical` with
  // `observeDelegatedTask` above but has no equivalent coverage of its own
  // canonical-failure classification. Only the two classifications that
  // actually fall back to the generic `unavailableMessage` are pinned here
  // (an http failure's own `payload.error` is already covered by the
  // sibling table above and by the wired-route regression test).
  test.each([
    [
      'timeout',
      () => Promise.reject(new Error('timeout')),
      undefined,
      'transport',
    ],
    [
      'malformed',
      () => new Response('not-json', { status: 200 }),
      200,
      'malformed',
    ],
  ])(
    'observeDelegatedTaskEvents pins the generic fallback sentence for a canonical %s failure',
    async (_label, canonicalResult, status, kind) => {
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === `${CURRENT_API}/.well-known/station/v1`) {
          return json({ environmentId: 'environment-current' });
        }
        if (
          url === `${CURRENT_API}/api/orchestration/delegations/task-1/events`
        ) {
          return await canonicalResult();
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const { observeDelegatedTaskEvents } = await import(
        '../station-control-delegation.js'
      );

      await expect(
        observeDelegatedTaskEvents({ taskId: 'task-1' }),
      ).rejects.toMatchObject({
        name: 'CanonicalDelegationReadError',
        kind,
        message: 'The selected Station could not read delegated task events',
        ...(status === undefined ? {} : { status }),
      });
    },
  );
});

describe('observeDelegatedTaskEvents production summary binding (station#2843)', () => {
  const authority = hostedAuthority('alpha');

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function productionEventPageService(environmentId = 'environment-current') {
    const calls: number[] = [];
    const events = [
      {
        method: 'session.configured',
        createdAt: '2026-08-16T05:50:00.000Z',
        metadata: {
          taskId: 'task-production',
          environmentId,
          environmentName: 'Current environment',
          targetKind: 'agent',
          targetId: 'codex',
        },
      },
      { method: 'turn.completed', createdAt: '2026-08-16T05:51:00.000Z' },
    ];
    const session = {
      threadId: 'task-production',
      lifecycleState: 'completed',
      eventCount: events.length,
      delegation: {
        taskId: 'task-production',
        environmentId,
        environmentName: 'Current environment',
        targetKind: 'agent-app',
        targetId: 'codex',
      },
    };
    const detail = { session, events };
    return {
      calls,
      readSession: vi.fn(async () => detail),
      readCurrentConversationSession: vi.fn(async () => detail),
      readSessionEventPage: vi.fn(
        async (
          _taskId: string,
          options: { afterSequence: number; limit: number },
        ) => {
          calls.push(options.afterSequence);
          const allEvents = events.map((event, index) => ({
            sequence: index + 1,
            event,
          }));
          const pageEvents = allEvents
            .filter((entry) => entry.sequence > options.afterSequence)
            .slice(0, options.limit);
          const nextSequence =
            pageEvents.at(-1)?.sequence ?? options.afterSequence;
          return {
            // This is the real buildOrchestrationSessionSummary shape for an
            // Agent-app delegation. The public task API deliberately projects
            // both internal Agent and Agent-app targets as kind: "agent".
            session,
            events: pageEvents,
            nextSequence,
            hasMore: nextSequence < allEvents.length,
          };
        },
      ),
    };
  }

  test('reads the first page and continues from its opaque cursor', async () => {
    installCurrentStationFetch();
    const service = productionEventPageService();
    const { observeDelegatedTaskEvents } = await import(
      '../station-control-delegation.js'
    );

    const first = await observeDelegatedTaskEvents(
      { taskId: 'task-production', limit: 1, readAuthority: authority },
      service as never,
    );
    expect(first).toMatchObject({
      taskId: 'task-production',
      target: { kind: 'agent', id: 'codex' },
      events: [{ sequence: 1 }],
      nextCursor: 'station-task-events:v1:1',
      hasMore: true,
    });

    const second = await observeDelegatedTaskEvents(
      {
        taskId: 'task-production',
        cursor: first.nextCursor,
        limit: 1,
        readAuthority: authority,
      },
      service as never,
    );
    expect(second).toMatchObject({
      events: [{ sequence: 2 }],
      nextCursor: 'station-task-events:v1:2',
      hasMore: false,
    });
    expect(service.calls).toEqual([0, 1]);
  });

  test('still rejects a production-shaped task bound to another environment', async () => {
    installCurrentStationFetch();
    const service = productionEventPageService('environment-other');
    const { observeDelegatedTaskEvents } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTaskEvents(
        { taskId: 'task-production', readAuthority: authority },
        service as never,
      ),
    ).rejects.toThrow(
      'The requested task does not match a delegated-task binding in the selected environment',
    );
  });

  // archive#3408: the message must name only what this branch checks. User
  // ownership is enforced by the authority-filtered session read, not here.
  test('the binding refusal does not claim to have checked the Station user (station#3408)', async () => {
    installCurrentStationFetch();
    const service = productionEventPageService('environment-other');
    const { observeDelegatedTaskEvents } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTaskEvents(
        { taskId: 'task-production', readAuthority: authority },
        service as never,
      ),
    ).rejects.toThrow(/^(?!.*Station user).*$/);
  });

  /**
   * archive#3408, the contract the issue is actually about: `delegate status`
   * and `delegate events` must agree about one task.
   *
   * They read the SAME launch binding through two different paths — status
   * reads the raw `session.configured` event, events reads the delegation
   * record `buildOrchestrationSessionSummary` projects from it. Both launch
   * writers persist `targetKind: 'agent'`, and the projection's allowlist
   * dropped exactly that value, so `events` saw a delegation record with no
   * target and refused the caller's own task while `status` accepted it.
   *
   * This drives ONE event through the REAL summary builder rather than
   * hand-feeding a delegation record to the mock — the projection is the only
   * thing that was broken, so a fixture that supplies its output tests
   * nothing. `userId` is present in the binding and must not appear in the
   * projected record or gate either read.
   */
  test('status and events agree on the binding of a locally-launched task (station#3408)', async () => {
    installCurrentStationFetch();
    const { buildOrchestrationSessionSummary } = await import(
      '../../services/orchestration/orchestration-session-state.js'
    );
    const { observeDelegatedTask, observeDelegatedTaskEvents } = await import(
      '../station-control-delegation.js'
    );

    const bindingEvent = {
      provider: 'station-agent',
      threadId: 'task:local',
      eventId: 'evt-local-1',
      createdAt: '2026-08-19T00:00:01.000Z',
      method: 'session.configured',
      sessionId: 'task:local',
      metadata: {
        taskId: 'task:local',
        environmentId: 'environment-current',
        environmentName: 'Current environment',
        targetKind: 'agent',
        targetId: 'reviewer',
        userId: 'shared-user',
      },
    };
    const summary = buildOrchestrationSessionSummary({
      answerability: {
        threadAttachment: 'detached',
        providerRegistered: true,
        observedBy: 'test-instance#0',
        observedAt: '2026-08-19T00:00:00.000Z',
      },
      persisted: {
        provider: 'station-agent',
        threadId: 'task:local',
        status: 'ready',
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:01.000Z',
      },
      events: [bindingEvent as never],
    });
    const service = {
      // `delegate status` reads the raw binding event.
      readSession: vi.fn(async () => ({
        session: { threadId: 'task:local', lifecycleState: 'running' },
        events: [bindingEvent],
      })),
      readCurrentConversationSession: vi.fn(async () => ({
        session: { threadId: 'task:local', lifecycleState: 'running' },
        events: [bindingEvent],
      })),
      // `delegate events` reads the projected summary built from that event.
      readSessionEventPage: vi.fn(async () => ({
        session: summary,
        events: [{ sequence: 1, event: bindingEvent }],
        nextSequence: 1,
        hasMore: false,
      })),
    };

    const status = await observeDelegatedTask(
      { taskId: 'task:local', readAuthority: authority },
      service as never,
    );
    const page = await observeDelegatedTaskEvents(
      { taskId: 'task:local', readAuthority: authority },
      service as never,
    );

    // The archive#3408 contract itself, asserted first so a regression in the
    // projection reads as "the two verbs disagree" rather than as a shape nit.
    expect(status.target).toEqual({ kind: 'agent', id: 'reviewer' });
    expect(page.target).toEqual(status.target);
    expect(page.taskId).toBe(status.taskId);

    // And the projected record carries the target without having started
    // disclosing the binding user to session-list clients.
    expect(summary.delegation).toMatchObject({
      taskId: 'task:local',
      targetKind: 'agent',
      targetId: 'reviewer',
    });
    expect(summary.delegation).not.toHaveProperty('userId');
  });

  test('still delegates user ownership to the authority-filtered session read', async () => {
    installCurrentStationFetch();
    const readSession = vi.fn(async () => null);
    const readSessionEventPage = vi.fn(async () => null);
    const { observeDelegatedTaskEvents } = await import(
      '../station-control-delegation.js'
    );

    await expect(
      observeDelegatedTaskEvents(
        {
          taskId: 'task-production',
          readAuthority: hostedAuthority('bravo'),
        },
        { readSession, readSessionEventPage } as never,
      ),
    ).rejects.toThrow('Delegated task not found');
    expect(readSession).toHaveBeenCalledWith(
      'task-production',
      hostedAuthority('bravo'),
    );
    expect(readSessionEventPage).not.toHaveBeenCalled();
  });
});
