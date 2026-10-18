/**
 * #2494: every session start resolves its confinement in the start path,
 * next to the #2493 `stationConfinement` stamp: the level its policy
 * requires, the mechanism that meets it, and a refusal before anything
 * starts when none can. Drives the real `OrchestrationService` command path
 * and the real SQLite `EventStore`; only the engines are recording fakes, so
 * each assertion reads the exact start input an adapter would receive.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConfinementMechanism,
  ConfinementPlan,
} from '@kontourai/station-contracts/execution-confinement';
import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { fullAccessGrantForTesting } from '../../../security/coding-authority.js';
import type { ConfinementProvider } from '../../../security/confinement/confinement-provider.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

class RecordingAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly sessions = new Map<string, ProviderSession>();
  readonly starts: ProviderSessionStartInput[] = [];
  private turnCount = 0;

  constructor(readonly provider: 'claude' | 'codex') {
    this.metadata = {
      displayName: provider,
      description: `${provider} confinement test adapter`,
      capabilities: ['agent-runtime'],
    };
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.starts.push(input);
    const now = new Date().toISOString();
    // Like every real adapter: the start's metadata rides `session.started`.
    this.events.push({
      eventId: `${input.threadId}:started:${this.starts.length}`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      metadata: input.metadata,
    } as CanonicalRuntimeEvent);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.turnCount += 1;
    return { threadId: input.threadId, turnId: `turn-${this.turnCount}` };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
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
  async stopAll(): Promise<void> {}
  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
}

/** A test-only provider: no real copied or wrapping provider exists yet. */
function testProvider(
  overrides: Omit<Partial<ConfinementProvider>, 'mechanism'> & {
    mechanism: string;
  },
): ConfinementProvider {
  return {
    level: 'os-profile',
    workspaceAccess: 'mounted',
    supportedIsolationModes: ['shared', 'worktree'],
    engagement: 'engine-native',
    engines: ['codex'],
    availability: () => ({ available: true, reason: 'test provider' }),
    confine: (spec) => ({
      spec,
      pending: { observe: () => 'configured-but-failed' },
    }),
    ...overrides,
    mechanism: overrides.mechanism as ConfinementMechanism,
  };
}

const CODEX_REQUIRED_PLAN: ConfinementPlan = {
  requiredLevel: 'os-profile',
  policyBasis: 'workspace-floor',
  mechanism: 'codex-sandbox',
  level: 'os-profile',
  workspaceAccess: 'mounted',
};

describe('#2494: a start resolves its confinement before the engine is touched', () => {
  let tmp: string;
  let store: EventStore;
  let bus: EventBus;
  let claude: RecordingAdapter;
  let codex: RecordingAdapter;
  let stationDefault: ApprovalMode | undefined;
  let service: OrchestrationService;

  function createService(
    confinementProviders?: readonly ConfinementProvider[],
  ): OrchestrationService {
    const adapters = [claude, codex];
    const registry: IProviderAdapterRegistry = {
      register() {},
      get: (provider) => adapters.find((a) => a.provider === provider),
      list: () => adapters,
    };
    return new OrchestrationService({
      adapterRegistry: registry,
      eventBus: bus,
      eventStore: store,
      resolveStationDefaultApprovalMode: async () => stationDefault,
      resolveSessionAgent: async (input) => ({
        ...input,
        agent: { slug: String(input.metadata?.agentSlug ?? 'agent') },
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
      ...(confinementProviders ? { confinementProviders } : {}),
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'confinement-start-'));
    store = new EventStore(join(tmp, 'orchestration.sqlite'));
    bus = new EventBus();
    claude = new RecordingAdapter('claude');
    codex = new RecordingAdapter('codex');
    stationDefault = undefined;
    service = createService();
  });

  afterEach(async () => {
    await service.shutdown();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function replaceService(providers: readonly ConfinementProvider[]) {
    await service.shutdown();
    service = createService(providers);
  }

  function start(
    threadId: string,
    provider: 'claude' | 'codex',
    options: {
      approvalMode?: ApprovalMode;
      operator?: boolean;
      metadata?: Record<string, unknown>;
      isolation?: WorkspaceIsolationMode;
    } = {},
  ) {
    return service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider,
          ...(options.approvalMode
            ? { modelOptions: { approvalMode: options.approvalMode } }
            : {}),
          metadata: {
            ...options.metadata,
            ...(options.isolation
              ? { workspaceIsolation: { mode: options.isolation } }
              : {}),
          },
        },
      },
      options.operator
        ? { fullAccessGrant: fullAccessGrantForTesting() }
        : undefined,
    );
  }

  /** The record the thread's latest persisted `session.started` carries. */
  function persistedRecord(threadId: string): unknown {
    const started = store
      .listEvents(threadId)
      .filter((row) => row.payload.method === 'session.started')
      .at(-1);
    return (started?.payload as { metadata?: Record<string, unknown> })
      ?.metadata?.stationConfinementRecord;
  }

  async function waitForStarted(threadId: string, count = 1) {
    await vi.waitFor(() =>
      expect(
        store
          .listEvents(threadId)
          .filter((row) => row.payload.method === 'session.started'),
      ).toHaveLength(count),
    );
  }

  test('a workspace Codex start running at never requires os-profile, met by Codex’s own sandbox', async () => {
    await start('codex-never', 'codex', { approvalMode: 'never' });
    const input = codex.starts.at(-1)!;
    expect(input.modelOptions?.approvalMode).toBe('never');
    expect(input.confinementPlan).toEqual(CODEX_REQUIRED_PLAN);
    // The adapter observes and records the posture; the start path claims
    // nothing about a process that does not exist yet.
    expect(input.metadata).not.toHaveProperty('stationConfinementRecord');
  });

  test('a host Codex start engages the same sandbox without requiring it, by operator policy', async () => {
    await start('codex-host', 'codex', {
      approvalMode: 'never',
      operator: true,
    });
    expect(codex.starts.at(-1)!.confinementPlan).toEqual({
      ...CODEX_REQUIRED_PLAN,
      requiredLevel: 'host',
      policyBasis: 'operator-policy',
    });
  });

  test('a workspace Claude start at never is unchanged (auto) and recorded honestly: host, no mechanism, not required', async () => {
    await start('claude-never', 'claude', { approvalMode: 'never' });
    const input = claude.starts.at(-1)!;
    expect(input.modelOptions?.approvalMode).toBe('auto');
    expect(input).not.toHaveProperty('confinementPlan');
    const record = {
      level: 'host',
      required: false,
      posture: 'no-mechanism',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
    };
    expect(input.metadata?.stationConfinementRecord).toEqual(record);
    await waitForStarted('claude-never');
    expect(persistedRecord('claude-never')).toEqual(record);
  });

  test('a required level with no mechanism on this host is refused before start, naming the missing mechanism', async () => {
    await replaceService([]);
    const refused = start('codex-no-mechanism', 'codex', {
      approvalMode: 'never',
    });
    // The dispatch boundary carries the refusal's typed code.
    await expect(refused).rejects.toMatchObject({
      code: 'confinement_mechanism_unavailable',
      message: expect.stringMatching(
        /requires os-profile confinement, which needs .+; none is available/,
      ),
    });
    expect(codex.starts).toHaveLength(0);

    // Fail closed only where the policy requires it: the operator's own
    // start resolves to `host` and runs, recorded as policy.
    await start('codex-no-mechanism-host', 'codex', {
      approvalMode: 'never',
      operator: true,
    });
    expect(codex.starts.at(-1)!.metadata?.stationConfinementRecord).toEqual({
      level: 'host',
      required: false,
      posture: 'no-mechanism',
      workspaceAccess: 'mounted',
      policyBasis: 'operator-policy',
    });
  });

  test('an unavailable provider is not used, and the refusal says why', async () => {
    await replaceService([
      testProvider({
        mechanism: 'test-unavailable',
        availability: () => ({
          available: false,
          reason: 'its profile failed to apply',
        }),
      }),
    ]);
    await expect(
      start('codex-unavailable', 'codex', { approvalMode: 'never' }),
    ).rejects.toMatchObject({
      code: 'confinement_mechanism_unavailable',
      message: expect.stringContaining(
        'test-unavailable: its profile failed to apply',
      ),
    });
    expect(codex.starts).toHaveLength(0);
  });

  test('a copied provider cannot run a shared live checkout: the pair is refused, whatever the provider declares', async () => {
    // The provider claims `shared` support; a copied provider has its own
    // filesystem, so it still cannot write the live checkout.
    await replaceService([
      testProvider({ mechanism: 'test-copied', workspaceAccess: 'copied' }),
    ]);
    await expect(
      start('codex-copied-shared', 'codex', { approvalMode: 'never' }),
    ).rejects.toMatchObject({ code: 'confinement_workspace_incompatible' });
    expect(codex.starts).toHaveLength(0);
  });

  test('a provider that does not support the start’s isolation mode is refused as incompatible', async () => {
    await replaceService([
      testProvider({
        mechanism: 'test-worktree-only',
        supportedIsolationModes: ['worktree'],
      }),
    ]);
    await expect(
      start('codex-worktree-only', 'codex', { approvalMode: 'never' }),
    ).rejects.toMatchObject({ code: 'confinement_workspace_incompatible' });
    expect(codex.starts).toHaveLength(0);
  });

  test('a caller-supplied confinement record never reaches the engine; the server’s own is written', async () => {
    const forged = {
      level: 'microvm',
      required: true,
      posture: 'confined',
      mechanism: 'codex-sandbox',
      workspaceAccess: 'mounted',
      policyBasis: 'operator-policy',
    };
    // Codex: the adapter writes the record, so the start input carries none.
    await start('codex-forged', 'codex', {
      approvalMode: 'never',
      metadata: { stationConfinementRecord: forged, keep: 'yes' },
    });
    expect(codex.starts.at(-1)!.metadata).toMatchObject({ keep: 'yes' });
    expect(codex.starts.at(-1)!.metadata).not.toHaveProperty(
      'stationConfinementRecord',
    );
    // Claude: the start path writes its own over nothing the caller sent.
    await start('claude-forged', 'claude', {
      metadata: { stationConfinementRecord: forged },
    });
    expect(claude.starts.at(-1)!.metadata?.stationConfinementRecord).toEqual(
      expect.objectContaining({ posture: 'no-mechanism', level: 'host' }),
    );
  });

  test('a dormant respawn re-resolves its confinement for the new process and never copies the old record forward', async () => {
    stationDefault = 'never';
    const stale = {
      level: 'os-profile',
      required: true,
      posture: 'confined',
      mechanism: 'codex-sandbox',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
    };
    for (const [threadId, provider] of [
      ['codex-dormant', 'codex'],
      ['claude-dormant', 'claude'],
    ] as const) {
      store.upsertSession({
        provider,
        threadId,
        status: 'ready',
        resumeCursor: { cursor: `resume-${threadId}` },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:05.000Z',
      });
      store.appendEvent({
        eventId: `${threadId}-started-before-restart`,
        provider,
        threadId,
        createdAt: '2026-09-01T00:00:01.000Z',
        method: 'session.started',
        sessionId: threadId,
        metadata: {
          stationConfinement: 'workspace',
          stationConfinementRecord: stale,
        },
      } as CanonicalRuntimeEvent);
    }
    service.initialize();
    await awaitSessionRecoveryCompleted(service);

    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: 'codex-dormant', input: 'go' },
    });
    const codexRespawn = codex.starts.at(-1)!;
    expect(codexRespawn.threadId).toBe('codex-dormant');
    expect(codexRespawn.confinementPlan).toEqual(CODEX_REQUIRED_PLAN);
    // The respawned engine reports its own posture; the first process's
    // `confined` is not evidence about this one.
    expect(codexRespawn.metadata).not.toHaveProperty(
      'stationConfinementRecord',
    );

    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: 'claude-dormant', input: 'go' },
    });
    const claudeRespawn = claude.starts.at(-1)!;
    expect(claudeRespawn.threadId).toBe('claude-dormant');
    expect(claudeRespawn.metadata?.stationConfinementRecord).toEqual({
      level: 'host',
      required: false,
      posture: 'no-mechanism',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
    });
    await waitForStarted('claude-dormant', 2);
    expect(persistedRecord('claude-dormant')).toEqual(
      claudeRespawn.metadata?.stationConfinementRecord,
    );
  });

  test('a respawn whose required level has no mechanism is refused like a first start', async () => {
    await replaceService([]);
    stationDefault = 'never';
    store.upsertSession({
      provider: 'codex',
      threadId: 'codex-dormant-refused',
      status: 'ready',
      resumeCursor: { cursor: 'resume-codex-dormant-refused' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:05.000Z',
    });
    store.appendEvent({
      eventId: 'codex-dormant-refused-started',
      provider: 'codex',
      threadId: 'codex-dormant-refused',
      createdAt: '2026-09-01T00:00:01.000Z',
      method: 'session.started',
      sessionId: 'codex-dormant-refused',
      metadata: { stationConfinement: 'workspace' },
    } as CanonicalRuntimeEvent);
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: { threadId: 'codex-dormant-refused', input: 'go' },
      }),
    ).rejects.toThrow(/requires os-profile confinement/);
    expect(codex.starts).toHaveLength(0);
  });
});
