/**
 * #2436 / #2418 / #2409: the approval-posture probe table, re-derived under
 * server order and driven end to end through the REAL HTTP routes
 * (`POST /api/orchestration/chat`, `/chat/:id/continue`, `/commands`), the
 * real foreground executor, the real `OrchestrationService` and the real
 * SQLite `EventStore`. Only the engine is a recording fake: each probe reads
 * the posture the engine was asked to run its LAST turn in.
 *
 * "Decide" is a `setApprovalMode` command from any device. A "report" is a
 * turn another device sends with no posture on it — a turn is not a
 * decision. An offline pick reaches the server riding the device's next
 * send (`setApprovalMode` on the `/chat` body) and is ordered by that
 * receipt. Each turn completes, so every continuation starts a new child
 * Session of the conversation: the recorded posture has to carry across
 * them (probes S1 and N).
 *
 * The hard bar: in no probe is the engine more permissive than the latest
 * decision by server order.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  ApprovalMode,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import type { ProviderAdapterMetadata } from '../../../providers/adapter-shape.js';
import {
  type ExecutionSessionBinding,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const OWNER = 'posture-owner';
const ENVIRONMENT = 'posture-station';
const CONVERSATION = 'conversation:posture';

class PostureAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Approval posture lifecycle adapter',
    capabilities: ['agent-runtime'],
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
  readonly starts: ProviderSessionStartInput[] = [];
  readonly turns: ProviderSendTurnInput[] = [];

  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:configured`,
      method: 'session.configured',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      metadata: input.metadata,
    } as CanonicalRuntimeEvent);
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = `posture-turn-${this.turns.length}`;
    const base = {
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
    } as const;
    this.events.push({
      ...base,
      eventId: `${turnId}:started`,
      method: 'turn.started',
      prompt: input.input,
    });
    this.events.push({
      ...base,
      eventId: `${turnId}:completed`,
      method: 'turn.completed',
      outputText: 'done',
    });
    return { threadId: input.threadId, turnId };
  }

  /** The posture the engine was asked to run its latest turn in. */
  lastTurnPosture(): unknown {
    return this.turns.at(-1)?.modelOptions?.approvalMode;
  }
}

function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = async () => {
      try {
        await assertion();
        resolve();
      } catch (error) {
        if (Date.now() - started >= timeoutMs) reject(error);
        else setTimeout(check, 10);
      }
    };
    check();
  });
}

function binding(
  store: EventStore,
  conversationId: string,
): ExecutionSessionBinding | null {
  const root = store.conversationSessions(conversationId)[0];
  if (!root) return null;
  const configured = [...store.listEvents(root.sessionId)]
    .reverse()
    .find((item) => item.payload.method === 'session.configured')?.payload;
  const metadata =
    configured?.method === 'session.configured'
      ? configured.metadata
      : undefined;
  if (!metadata || typeof metadata.environmentId !== 'string') return null;
  return {
    environmentId: metadata.environmentId,
    agentId: 'claude',
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness(roots: string[], stationDefault?: ApprovalMode) {
  const root = mkdtempSync(join(tmpdir(), 'station-approval-posture-'));
  roots.push(root);
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const adapter = new PostureAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore: store,
    resolveSessionAgent: async (input) => ({
      ...input,
      agent: { slug: 'claude' },
    }),
    resolveStationDefaultApprovalMode: async () => stationDefault,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ownerlessSessionAccess: 'single-user-compat',
  });
  const deps: ExecutionTargetExecutionDependencies = {
    resolveEnvironmentAccess: async () => ({
      apiBase: 'http://posture.station',
      environmentId: ENVIRONMENT,
      environmentName: 'Posture Station',
      kind: 'current',
    }),
    getAgent: async () => ({
      slug: 'claude',
      available: true,
      execution: { agentConnectionId: engineConnectionId('claude') },
    }),
    getConnection: async () => ({
      id: engineConnectionId('claude'),
      name: 'Claude Code',
      type: 'claude',
      kind: 'agent',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { provider: 'claude' },
    }),
    getProject: async () => undefined,
    getProviderAdapter: (provider) => service.getProviderAdapter(provider),
    readSessionBinding: async (_access, id) => binding(store, id),
    resolveConversationSession: async (_access, id, requested) =>
      service.resolveConversationContinuation(
        id,
        INTERNAL_SESSION_READ_SCOPE,
        requested,
      ),
    startSession: async (_access, input) => {
      const started = await service.startSessionInternal(
        { type: 'start-session', input },
        { userId: OWNER },
        {
          conversationIdentity: {
            conversationId: String(input.metadata?.conversationId),
            environmentId: String(input.metadata?.environmentId),
          },
        },
      );
      if (started.status !== 'accepted') throw new Error(started.message);
      await eventually(() => {
        expect(
          store
            .listEvents(input.threadId)
            .some((item) => item.payload.method === 'session.configured'),
        ).toBe(true);
      });
      return undefined;
    },
    sendTurn: async (_access, input) => {
      const dispatched = await service.dispatchWithReceipt(
        { type: 'sendTurn', input },
        { userId: OWNER },
      );
      if (!dispatched.result || !('turnId' in dispatched.result))
        throw new Error('dispatch returned no turn id');
      return { turnId: dispatched.result.turnId };
    },
    recordApprovalMode: (_access, pick) =>
      service.recordApprovalModeDecision(pick),
    createConversationId: () => CONVERSATION,
  };
  const execute = (input: {
    message: string;
    conversationId?: string;
    model?: { options?: Record<string, unknown> };
    setApprovalMode?: ApprovalMode;
    setApprovalModeBasedOn?: number | null;
  }) =>
    executeForegroundMessage(
      {
        message: input.message,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        target: {
          environment: { kind: 'current' },
          agent: agentId('claude'),
          ...(input.model ? { model: input.model } : {}),
        },
        ...(input.setApprovalMode
          ? {
              setApprovalMode: input.setApprovalMode,
              setApprovalModeBasedOn: input.setApprovalModeBasedOn,
            }
          : {}),
        userId: OWNER,
      },
      deps,
    );
  const routes = createOrchestrationRoutes(service, {
    eventBus,
    logger: { debug: vi.fn() },
    getUserId: () => OWNER,
    executeForegroundMessage: (input) => execute(input),
    continueForegroundMessage: (input) =>
      execute({ message: input.message, conversationId: input.conversationId }),
  });
  const app = new Hono();
  app.route('/api/orchestration', routes);

  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response;
  };
  const turnsSettled = async () =>
    eventually(async () => {
      const lineage = store.conversationSessions(CONVERSATION);
      const current = lineage.at(-1);
      expect(current).toBeDefined();
      expect(
        (
          await service.readSession(
            current!.sessionId,
            INTERNAL_SESSION_READ_SCOPE,
          )
        )?.session.lifecycleState,
      ).toBe('completed');
    });
  const currentThread = () =>
    store.conversationSessions(CONVERSATION).at(-1)?.sessionId;

  /**
   * The desktop's client: the latest decision sequence it has folded. It
   * learns sequences only from its own sends' results, never from the
   * phone's decisions (the probes model it missing them).
   */
  let seen: number | null = null;
  const composerSend = async (
    body: Record<string, unknown>,
    carried?: ApprovalMode,
    defaultChannel?: ApprovalMode,
  ) => {
    const response = await post('/api/orchestration/chat', {
      ...body,
      target: {
        environment: { kind: 'current' },
        agent: 'claude',
        ...(defaultChannel
          ? { model: { options: { approvalMode: defaultChannel } } }
          : {}),
      },
      ...(carried
        ? { setApprovalMode: carried, setApprovalModeBasedOn: seen }
        : {}),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const recorded = (
      JSON.parse(text) as {
        data?: { approvalMode?: { sequence: number; recorded: boolean } };
      }
    ).data?.approvalMode;
    if (recorded) seen = recorded.sequence;
    await turnsSettled();
    return recorded;
  };

  return {
    store,
    service,
    adapter,
    /** The composer's first send: `/chat`, optionally carrying a pick. */
    firstSend: (carried?: ApprovalMode, defaultChannel?: ApprovalMode) =>
      composerSend({ message: 'first' }, carried, defaultChannel),
    /** A composer send on the existing conversation, maybe carrying a pick. */
    send: (carried?: ApprovalMode, defaultChannel?: ApprovalMode) =>
      composerSend(
        { message: 'again', conversationId: CONVERSATION },
        carried,
        defaultChannel,
      ),
    /**
     * A turn from outside the composer (#2418): attention replies, the
     * delegated-task coordinator and the session-detail composer continue
     * the conversation with no posture on the request at all.
     */
    async continueWithoutPosture() {
      const response = await post(
        `/api/orchestration/chat/${encodeURIComponent(CONVERSATION)}/continue`,
        { message: 'reply' },
      );
      expect(response.status, await response.text()).toBe(200);
      await turnsSettled();
    },
    /** Any device's decision, through the public command route. */
    async decide(approvalMode: ApprovalMode) {
      const threadId = currentThread();
      expect(threadId).toBeDefined();
      const response = await post('/api/orchestration/commands', {
        type: 'setApprovalMode',
        threadId,
        approvalMode,
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return JSON.parse(text) as {
        data: { approvalMode: ApprovalMode; sequence: number };
      };
    },
    post,
    currentThread,
  };
}

describe('approval posture probe table under server order (#2436)', () => {
  const roots: string[] = [];
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.service.shutdown();
      harness.store.close();
    }
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  async function harness(stationDefault?: ApprovalMode) {
    const created = await createHarness(roots, stationDefault);
    harnesses.push(created);
    return created;
  }

  test('a pick made before the chat had a session spawns it and is recorded', async () => {
    const h = await harness();
    await h.firstSend('never');
    expect(h.adapter.starts[0]?.modelOptions?.approvalMode).toBe('never');
    expect(h.adapter.lastTurnPosture()).toBe('never');
    const decisions = h.store
      .listEvents(h.currentThread()!)
      .filter((row) => row.payload.method === 'session.approval-mode-set');
    expect(decisions).toHaveLength(1);
  });

  test('#2418: a turn continued from outside the composer runs at the recorded posture', async () => {
    const h = await harness();
    await h.firstSend('never');
    await h.decide('ask');
    await h.continueWithoutPosture();
    expect(h.adapter.lastTurnPosture()).toBe('ask');
    // A new child Session spawned for that turn, in the recorded posture.
    expect(h.adapter.starts.at(-1)?.modelOptions?.approvalMode).toBe('ask');
  });

  test('the command route refuses a posture that is not one', async () => {
    const h = await harness();
    await h.firstSend();
    const response = await h.post('/api/orchestration/commands', {
      type: 'setApprovalMode',
      threadId: h.currentThread(),
      approvalMode: 'yolo',
    });
    expect(response.status).toBe(400);
  });

  type Step =
    | { kind: 'first'; carried?: ApprovalMode; defaultChannel?: ApprovalMode }
    | { kind: 'decide'; mode: ApprovalMode }
    | { kind: 'send'; carried?: ApprovalMode; defaultChannel?: ApprovalMode }
    | { kind: 'report' };

  /**
   * The engine posture at the last turn. `undefined`: the engine was sent no
   * posture and keeps its own configuration.
   */
  const probes: Array<{
    probe: string;
    steps: Step[];
    expected: ApprovalMode | undefined;
    stationDefault?: ApprovalMode;
  }> = [
    {
      probe: 'E: desktop decides never, the phone decides Ask',
      steps: [
        { kind: 'first', carried: 'never' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe: 'G: the desktop decides never online, then the phone decides Ask',
      steps: [
        { kind: 'first' },
        { kind: 'decide', mode: 'never' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'G-off: the desktop picks never offline, the phone decides Ask, the desktop reconnects and sends: the pick it made without seeing Ask is dropped (compare-and-set)',
      steps: [
        { kind: 'first' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send', carried: 'never' },
      ],
      expected: 'ask',
    },
    {
      probe: 'R: the desktop decides Ask, then the phone decides never',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'decide', mode: 'never' },
        { kind: 'send' },
      ],
      expected: 'never',
    },
    {
      probe:
        'R-report: the desktop decides Ask; the phone only sends a turn (a report, not a decision)',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'report' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'T1: Ask picked offline reaches the server with the reconnect send',
      steps: [
        { kind: 'first', carried: 'auto' },
        { kind: 'report' },
        { kind: 'send', carried: 'ask' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'S1/Q: Ask decided, the phone decides never; the next session (a new child) runs at never',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'decide', mode: 'never' },
        { kind: 'send' },
      ],
      expected: 'never',
    },
    {
      probe:
        'T3: Ask decided; the default channel carries the Station default never',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'send', defaultChannel: 'never' },
      ],
      expected: 'ask',
    },
    {
      probe: 'S2: Auto decided, the phone tightens to Ask',
      steps: [
        { kind: 'first', carried: 'auto' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'H: Default decided on a conversation Station never set: nothing is sent',
      steps: [
        { kind: 'first' },
        { kind: 'decide', mode: 'connection-default' },
        { kind: 'send' },
      ],
      expected: undefined,
    },
    {
      probe: 'I: never decided, then Ask decided; the phone only reports never',
      steps: [
        { kind: 'first', carried: 'never' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'report' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'N: never decided, the session ends; the next child starts at never, not the Station default',
      stationDefault: 'auto',
      steps: [
        { kind: 'first', carried: 'never' },
        { kind: 'send', defaultChannel: 'auto' },
      ],
      expected: 'never',
    },
    {
      probe:
        'M1: Auto decided; the phone tightens to Ask while the desktop is disconnected; the desktop sends',
      steps: [
        { kind: 'first', carried: 'auto' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
  ];

  test.each(probes)('$probe', async ({ steps, expected, stationDefault }) => {
    const h = await harness(stationDefault);
    for (const step of steps) {
      if (step.kind === 'first')
        await h.firstSend(step.carried, step.defaultChannel);
      else if (step.kind === 'decide') await h.decide(step.mode);
      else if (step.kind === 'send')
        await h.send(step.carried, step.defaultChannel);
      else await h.continueWithoutPosture();
    }
    expect(h.adapter.lastTurnPosture()).toBe(expected);
  });
});
