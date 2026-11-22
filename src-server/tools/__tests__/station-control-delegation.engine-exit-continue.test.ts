/**
 * Incident regression (2026-11-16): after a conversation's engine exited, every
 * continue went back to the dead Session until Station restarted.
 */
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderSession,
  type ProviderSessionStartInput,
  SendTurnRefusedError,
} from '../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../providers/sessions/async-event-queue.js';
import { AgentPolicyService } from '../../services/agents/agent-policy-service.js';
import { WorkflowSidecarService } from '../../services/evidence/workflow-sidecar-service.js';
import { FlowRunService } from '../../services/flow/flow-run-service.js';
import { FileDelegationAttemptClaimStore } from '../../services/orchestration/delegation-attempt-claim-store.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../services/orchestration/session-agent-resolution.js';

process.env.STATION_API_BASE = 'http://engine-exit-continue.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const CURRENT_API = 'http://engine-exit-continue.test';
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
    this.starts.push(input.threadId);
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
  readonly sends: string[] = [];
  readonly starts: string[] = [];

  /**
   * The engine of an idle Session is SIGTERMed. Published as the Claude
   * adapter does once it observes the exit: the stream's failure (no turn),
   * then `session.exited`, and the record is gone.
   */
  exitEngine(threadId: string): void {
    const now = new Date().toISOString();
    this.sessions.delete(threadId);
    this.events.push({
      eventId: `${threadId}-engine-failed`,
      provider: this.provider,
      threadId,
      createdAt: now,
      method: 'runtime.error',
      severity: 'error',
      message: 'Claude Code process exited with code 143',
    } as unknown as CanonicalRuntimeEvent);
    this.events.push({
      eventId: `${threadId}-engine-exited`,
      provider: this.provider,
      threadId,
      createdAt: now,
      method: 'session.exited',
      sessionId: threadId,
      exitCode: 143,
      reason: 'process-exit',
    } as unknown as CanonicalRuntimeEvent);
  }

  async sendTurn(input: { threadId: string }) {
    if (!this.sessions.has(input.threadId))
      throw new SendTurnRefusedError('The engine has stopped.', 'session_gone');
    this.sends.push(input.threadId);
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
    throw new Error(`Unexpected request in engine-exit-continue test: ${url}`);
  });
}

const OWNER = 'human:test:delegator';

/**
 * The incident, end to end through the continue path a `station chat`
 * continue and the chat composer take: a conversation's long-lived engine
 * is SIGTERMed while idle, then the person sends a message by the
 * conversation id. The message must run, in a new Session of the same
 * conversation, with no restart and nothing else done by hand.
 */
describe('an idle engine that exited, then a message by the conversation id', () => {
  const tempDir = trackTempDirs();
  let tmp: string;
  let eventStore: EventStore;
  let service: OrchestrationService;
  let acp: AcpFakeAdapter;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    installCurrentStationFetch();

    tmp = tempDir('station-delegation-binding-');
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    acp = new AcpFakeAdapter();
    service = new OrchestrationService({
      adapterRegistry: createRegistry([acp]),
      eventBus: new EventBus(),
      eventStore,
      adoptionLedger: eventStore.createAdoptionLedger(),
      sessionOwnerCacheMaxEntries: 2,
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
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('the message runs in a successor Session, without a restart', async () => {
    const { delegateTask, continueDelegatedTask } = await import(
      '../station-control-delegation.js'
    );
    const handle = await delegateTask(
      {
        prompt: 'Start the work',
        userId: OWNER,
        delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(tmp),
        target: {
          environment: { kind: 'current' },
          agent: agentId('opencode-agent'),
        },
      },
      service,
    );
    const conversationId = handle.taskId;
    await waitFor(
      () => eventStore.hasEventId(`${conversationId}-configured`),
      (persisted) => persisted,
    );
    expect(acp.sends).toEqual([conversationId]);

    acp.exitEngine(conversationId);
    await waitFor(
      () => eventStore.hasEventId(`${conversationId}-engine-exited`),
      (persisted) => persisted,
    );

    const continued = await continueDelegatedTask(
      {
        taskId: conversationId,
        message: 'are you still there?',
        userId: OWNER,
      },
      service,
    );
    expect(continued).toMatchObject({ taskId: conversationId });
    // One more turn ran, in a new Session the conversation now continues in.
    expect(acp.sends).toHaveLength(2);
    const successor = acp.sends[1]!;
    expect(successor).not.toBe(conversationId);
    expect(acp.starts).toContain(successor);
    expect(eventStore.conversationForSession(successor)?.conversationId).toBe(
      conversationId,
    );
  });
});
