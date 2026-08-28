/**
 * archive#4543 regression: `station delegate status`/`events` could not
 * resolve a task the SAME create call had just dispatched, for every
 * delegation target (reproduced live against an ACP target).
 *
 * Root cause: `delegateTask`'s local session-start wrote
 * `metadata.environmentId` through the plain public
 * `orchestrationService.sessionCommands.execute` seam. archive#4024's
 * `ENVIRONMENT_ID_RESERVED_METADATA_KEY` (packages/contracts/src/provider.ts,
 * landed 2026-08-23) added `environmentId` to
 * `RESERVED_ORCHESTRATION_METADATA_KEYS`, which `OrchestrationService`'s
 * `prepareStart` strips from EVERY public `sessionCommands.execute` caller
 * unconditionally — so `environmentId` never reached the adapter or the
 * persisted `session.started`/`session.configured` event. `sessionBinding()`
 * (station-control-delegation.ts) only recognizes a delegation binding event
 * when `metadata.environmentId` is a string, so every freshly created task's
 * binding silently vanished and `status`/`events` failed closed with "The
 * requested task does not match a delegated-task binding in the selected
 * environment".
 *
 * `executeExecutionTargetMessage`'s own `startSession` closure — reached
 * indirectly by `continueDelegatedTask` via `continueExecutionTargetMessage`'s
 * tail call into it — already routed around the strip via
 * `orchestrationService.startSessionInternal`'s `conversationIdentity`
 * internal-only escape hatch (see its call site and
 * `orchestration-service.test.ts`'s "archive#2821 hardening L3" comment for
 * the established pattern). Commit a8a2dcb01 introduced BOTH the strip and
 * that escape-hatch fix together, migrating the foreground/continue path in
 * the same change that regressed this one — `delegateTask`'s own create path
 * alone was never migrated to it.
 *
 * This test exercises the REAL `OrchestrationService` (not a hand-rolled
 * `vi.fn()` double, unlike every other test in this file) so the real
 * `prepareStart` strip actually runs, proving the fix survives the seam that
 * let the regression ship silently: every existing delegation test mocks
 * `sessionCommands.execute`/`startSessionInternal` directly and never
 * exercises the metadata strip at all.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../providers/sessions/async-event-queue.js';
import { AgentPolicyService } from '../../services/agents/agent-policy-service.js';
import { WorkflowSidecarService } from '../../services/evidence/workflow-sidecar-service.js';
import { FlowRunService } from '../../services/flow/flow-run-service.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../services/orchestration/session-agent-resolution.js';

process.env.STATION_API_BASE = 'http://binding-regression.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const CURRENT_API = 'http://binding-regression.test';
const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A minimal ACP-provider adapter double that, unlike this suite's usual
 * `vi.fn()` service doubles, actually publishes `session.started`/
 * `session.configured` runtime events the way `acp-adapter.ts` does —
 * `metadata: { ...input.metadata, ... }` — spreading whatever `input`
 * (the `ProviderSessionStartInput` `OrchestrationService.prepareStart`
 * handed it, i.e. POST-strip) actually carries. This is what makes the
 * test capable of catching the regression: the strip already ran by the
 * time this adapter sees `input`.
 */
class AcpFakeAdapter implements ProviderAdapterShape {
  readonly provider = 'acp' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'ACP Runtime',
    description: 'Fake ACP adapter for station#4543 regression coverage',
    capabilities: ['agent-runtime'],
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: false,
      overrideAtResume: false,
      overridePerTurn: false,
    },
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly sessions = new Map<string, ProviderSession>();

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    // Mirrors acp-adapter.ts's real publish shape closely enough to prove
    // the point: whatever survives `prepareStart`'s strip is what a real
    // ACP session persists as its binding metadata.
    this.events.push({
      eventId: `${input.threadId}-started`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      initialState: 'created',
      metadata: { ...input.metadata },
    } as unknown as CanonicalRuntimeEvent);
    this.events.push({
      eventId: `${input.threadId}-configured`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.configured',
      sessionId: input.threadId,
      metadata: { ...input.metadata },
    } as unknown as CanonicalRuntimeEvent);
    return session;
  }

  private turnCounter = 0;

  async sendTurn(input: { threadId: string }) {
    // A distinct turnId per call: OrchestrationService's turn-boundary
    // coordinator (session-execution-coordinator.ts) rejects a REPEATED
    // turnId on the same thread as indeterminate (`markTurnAccepted`
    // returns false once a turnId is already known), so a constant id here
    // would make every turn after the first look like a duplicate.
    this.turnCounter += 1;
    return {
      threadId: input.threadId,
      turnId: `${this.provider}-turn-${this.turnCounter}`,
    };
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' as const };
  }

  async respondToRequest(): Promise<void> {}

  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    this.sessions.clear();
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
}

function createRegistry(
  adapters: ProviderAdapterShape[],
): IProviderAdapterRegistry {
  return {
    register() {},
    get(provider) {
      return adapters.find((adapter) => adapter.provider === provider);
    },
    list() {
      return adapters;
    },
  } as IProviderAdapterRegistry;
}

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition');
}

function installCurrentStationFetch(): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`) {
      return json({ environmentId: 'environment-current' });
    }
    if (url === `${CURRENT_API}/api/agents/opencode-agent`) {
      return json({
        success: true,
        data: {
          slug: 'opencode-agent',
          name: 'OpenCode Agent',
          available: true,
          execution: { agentConnectionId: 'opencode-connection' },
        },
      });
    }
    if (url === `${CURRENT_API}/api/connections/opencode-connection`) {
      return json({
        success: true,
        data: {
          id: 'opencode-connection',
          kind: 'agent',
          type: 'acp',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          config: { provider: 'acp' },
        },
      });
    }
    throw new Error(`Unexpected request in binding-regression test: ${url}`);
  });
}

describe('station#4543: delegate create -> status/events binding survives for an ACP target', () => {
  let tmp: string;
  let eventStore: EventStore;
  let service: OrchestrationService;
  let acp: AcpFakeAdapter;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    installCurrentStationFetch();

    tmp = mkdtempSync(join(tmpdir(), 'station-delegation-binding-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    acp = new AcpFakeAdapter();
    service = new OrchestrationService({
      adapterRegistry: createRegistry([acp]),
      eventBus: new EventBus(),
      eventStore,
      adoptionLedger: eventStore.createAdoptionLedger(),
      sessionOwnerCacheMaxEntries: 2,
      // Personal-mode default (runtime-initialize.ts): a delegated task
      // created with no explicit userId is still an ownerless session for
      // authorization purposes, and dispatch's `canReadSessionForCommand`
      // check requires this to read/act on it.
      ownerlessSessionAccess: 'single-user-compat',
      flowRunService: new FlowRunService(),
      listProjects: () => [],
      agentPolicyService: new AgentPolicyService({
        env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
        logger: { debug: vi.fn(), warn: vi.fn() },
      }),
      workflowSidecarService: new WorkflowSidecarService({
        logger: { debug: vi.fn(), warn: vi.fn() },
      }),
      // ACP is a session-delivery-capable provider (sessionDeliveryChannels
      // is defined for it), so `resolveSessionAgentForStart`'s fail-closed
      // authored-spec gate (archive#3027) requires a resolvable Agent spec
      // for 'opencode-agent' or every session start refuses before this
      // test can reach the binding logic under test.
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) =>
          slug === 'opencode-agent'
            ? { name: 'OpenCode Agent', prompt: '' }
            : null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    } as never);
  });

  afterEach(() => {
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('an ACP-target task created via delegateTask resolves through status, events, and continue — both id forms', async () => {
    const {
      delegateTask,
      observeDelegatedTask,
      observeDelegatedTaskEvents,
      continueDelegatedTask,
    } = await import('../station-control-delegation.js');

    const handle = await delegateTask(
      {
        prompt: 'Write the requested file',
        target: {
          environment: { kind: 'current' },
          agent: agentId('opencode-agent'),
        },
      },
      service,
    );

    expect(handle.target).toMatchObject({
      kind: 'agent',
      id: 'opencode-agent',
    });
    const taskId = handle.taskId;
    expect(taskId.startsWith('task:')).toBe(true);

    // The adapter published its session.started/session.configured events
    // synchronously inside the awaited startSession call, but
    // OrchestrationService persists them off a separate subscription loop —
    // wait for that persistence to land before asserting on it, exactly as
    // this codebase's other real-OrchestrationService tests do.
    await waitFor(
      () => eventStore.listEvents(taskId).map((event) => event.payload.method),
      (methods) => methods.includes('session.configured'),
    );

    // This is the exact regression: before the fix, `environmentId` never
    // reached the persisted event, so `sessionBinding()` never recognized
    // this event as a delegation binding and both calls below threw "The
    // requested task does not match a delegated-task binding in the
    // selected environment" for a task the create call just produced.
    await expect(
      observeDelegatedTask({ taskId }, service),
    ).resolves.toMatchObject({
      taskId,
      target: { kind: 'agent', id: 'opencode-agent' },
    });
    await expect(
      observeDelegatedTaskEvents({ taskId }, service),
    ).resolves.toMatchObject({ taskId });

    // archive#4543 MED-1 (issue-author ruling): both id forms RESOLVE — the
    // bare uuid is not a separate identity, just the same task missing its
    // prefix, and `loadDelegatedTask` retries under the prefixed form on a
    // primary miss. The CLI keeps printing the canonical `task:<uuid>` form
    // regardless of which form looked it up (`snapshotFor` derives `taskId`
    // from the bound metadata, never the caller's input string).
    const bareUuid = taskId.slice('task:'.length);
    await expect(
      observeDelegatedTask({ taskId: bareUuid }, service),
    ).resolves.toMatchObject({
      taskId,
      target: { kind: 'agent', id: 'opencode-agent' },
    });
    await expect(
      observeDelegatedTaskEvents({ taskId: bareUuid }, service),
    ).resolves.toMatchObject({ taskId });

    // archive#4543 LOW-5: `continueDelegatedTask` loads the same binding
    // through `loadDelegatedTask` before it can dispatch a follow-up turn —
    // the same strip broke it for a freshly created task pre-fix, and this
    // fix transitively repairs it. Pin that half of the verb surface too.
    await expect(
      continueDelegatedTask(
        { taskId, message: 'Now also write a second file' },
        service,
      ),
    ).resolves.toMatchObject({ taskId });
  });

  test('station#661: a task with more runtime events than the projection fold still resolves events, with the true thread event count', async () => {
    const { delegateTask, observeDelegatedTaskEvents } = await import(
      '../station-control-delegation.js'
    );

    const handle = await delegateTask(
      {
        prompt: 'Write the requested file',
        target: {
          environment: { kind: 'current' },
          agent: agentId('opencode-agent'),
        },
      },
      service,
    );
    const taskId = handle.taskId;

    await waitFor(
      () => eventStore.listEvents(taskId).map((event) => event.payload.method),
      (methods) => methods.includes('session.configured'),
    );

    // `listSessionProjectionEvents`'s fold only ever retains a handful of
    // NAMED slots (session.started, session.configured, the thread's overall
    // latest event, ...) — never every persisted row. Publish a run's worth
    // of ordinary content/tool events, none of which occupy a dedicated
    // fold slot except (at most) the very last one as "latest", so the fold
    // stays small while the thread's real event count keeps growing. This
    // is the exact shape of a real ACP run with text deltas and tool calls
    // that station#661 reported as "invalid task event state".
    const now = new Date().toISOString();
    for (let turn = 0; turn < 5; turn += 1) {
      const itemId = `item-${turn}`;
      const toolCallId = `tool-call-${turn}`;
      acp.events.push({
        eventId: `${taskId}-text-${turn}`,
        provider: 'acp',
        threadId: taskId,
        createdAt: now,
        method: 'content.text-delta',
        itemId,
        delta: `chunk ${turn}`,
      } as unknown as CanonicalRuntimeEvent);
      acp.events.push({
        eventId: `${taskId}-tool-started-${turn}`,
        provider: 'acp',
        threadId: taskId,
        createdAt: now,
        method: 'tool.started',
        itemId,
        toolCallId,
        toolName: 'write_file',
      } as unknown as CanonicalRuntimeEvent);
      acp.events.push({
        eventId: `${taskId}-tool-progress-${turn}`,
        provider: 'acp',
        threadId: taskId,
        createdAt: now,
        method: 'tool.progress',
        itemId,
        toolCallId,
        message: 'writing',
      } as unknown as CanonicalRuntimeEvent);
      acp.events.push({
        eventId: `${taskId}-tool-completed-${turn}`,
        provider: 'acp',
        threadId: taskId,
        createdAt: now,
        method: 'tool.completed',
        itemId,
        toolCallId,
        toolName: 'write_file',
        status: 'success',
      } as unknown as CanonicalRuntimeEvent);
    }
    // 2 (session.started/configured) + 5 * 4 (text-delta + tool triple) = 22.
    const expectedTotalEvents = 22;

    await waitFor(
      () => eventStore.listEvents(taskId).length,
      (count) => count >= expectedTotalEvents,
    );
    const trueEventCount = eventStore.countEventsByThread(taskId);
    expect(trueEventCount).toBe(expectedTotalEvents);
    // The fold staying smaller than the thread total is what makes this test
    // discriminating: if the projection fold ever grows to retain these
    // runtime methods, eventCount-from-fold would equal the true count and a
    // revert of the fix would pass unnoticed.
    expect(eventStore.listSessionProjectionEvents(taskId).length).toBeLessThan(
      expectedTotalEvents,
    );

    // Pre-fix, `readSessionEventPage` labeled the fold's own (much smaller)
    // length as `eventCount`, so the consumer guard's
    // `rawNextSequence > eventCount` tripped and threw "The selected Station
    // returned invalid task event state" for a perfectly healthy task. Both
    // the resolution and the reported count must reflect the thread's real
    // event total, not the projection fold's size.
    const page = await observeDelegatedTaskEvents({ taskId }, service);
    expect(page.taskId).toBe(taskId);
    expect(page.eventCount).toBe(trueEventCount);
  });
});
