/**
 * #2436 / #2409: the approval posture is a server-ordered session decision.
 * Every test drives the real `OrchestrationService` command path
 * (`dispatchWithReceipt`) and the real SQLite `EventStore`; only the engine
 * is a recording fake, so each assertion reads the exact `modelOptions` an
 * adapter would receive at a session start or turn start.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { SetApprovalModeResult } from '@kontourai/station-contracts/orchestration';
import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
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
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

class RecordingAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly sessions = new Map<string, ProviderSession>();
  readonly starts: ProviderSessionStartInput[] = [];
  readonly turns: ProviderSendTurnInput[] = [];
  private turnCount = 0;

  constructor(readonly provider: 'claude' | 'codex' | 'acp') {
    this.metadata = {
      displayName: provider,
      description: `${provider} posture test adapter`,
      capabilities: ['agent-runtime'],
    };
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.starts.push(input);
    const now = new Date().toISOString();
    // Like every real adapter: the start's metadata (the Agent slug the
    // server reads for the Agent's default) rides `session.started`.
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
    this.turns.push(input);
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

  /** The posture the engine was last asked to run a turn in. */
  lastTurnMode(): unknown {
    return this.turns.at(-1)?.modelOptions?.approvalMode;
  }
}

function registry(adapters: ProviderAdapterShape[]): IProviderAdapterRegistry {
  return {
    register() {},
    get: (provider) => adapters.find((a) => a.provider === provider),
    list: () => adapters,
  };
}

const phone: ClientOrigin = {
  version: 1,
  actor: { kind: 'device', deviceId: 'phone' },
  reported: { version: 1, surface: 'mobile', build: '1' },
};
const desktop: ClientOrigin = {
  version: 1,
  actor: { kind: 'device', deviceId: 'desktop' },
  reported: { version: 1, surface: 'desktop', build: '1' },
};

describe('server-ordered approval posture (#2436)', () => {
  let tmp: string;
  let store: EventStore;
  let bus: EventBus;
  let claude: RecordingAdapter;
  let codex: RecordingAdapter;
  let acp: RecordingAdapter;
  let stationDefault: ApprovalMode | undefined;
  let agentDefaults: Record<string, ApprovalMode | undefined>;
  let service: OrchestrationService;

  function createService(): OrchestrationService {
    return new OrchestrationService({
      adapterRegistry: registry([claude, codex, acp]),
      eventBus: bus,
      eventStore: store,
      resolveStationDefaultApprovalMode: async () => stationDefault,
      // The authored-Agent start gate (resolveSessionAgent) is satisfied the
      // way production resolves a defined Agent.
      resolveSessionAgent: async (input) => ({
        ...input,
        agent: { slug: String(input.metadata?.agentSlug ?? 'claude') },
      }),
      loadAgentExecutionConfig: async (slug) =>
        agentDefaults[slug] ? { approvalMode: agentDefaults[slug] } : undefined,
      logger: { debug: vi.fn(), warn: vi.fn() },
      ownerlessSessionAccess: 'single-user-compat',
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'approval-posture-'));
    store = new EventStore(join(tmp, 'orchestration.sqlite'));
    bus = new EventBus();
    claude = new RecordingAdapter('claude');
    codex = new RecordingAdapter('codex');
    acp = new RecordingAdapter('acp');
    stationDefault = undefined;
    agentDefaults = {};
    service = createService();
  });

  afterEach(async () => {
    await service.shutdown();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A session start. `operator` starts it as a caller that may grant full
   * access (the routes mint that grant from the request, #2493); without it
   * the start is an unattended one (a webhook, a monitor, an agent's tool).
   */
  async function start(
    threadId: string,
    provider: 'claude' | 'codex' | 'acp' = 'claude',
    approvalMode?: ApprovalMode,
    agentSlug?: string,
    options: { operator?: boolean } = {},
  ) {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider,
          ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
          ...(agentSlug ? { metadata: { agentSlug } } : {}),
        },
      },
      options.operator
        ? { fullAccessGrant: fullAccessGrantForTesting() }
        : undefined,
    );
    const deadline = Date.now() + 2000;
    while (
      !store
        .listEvents(threadId)
        .some((row) => row.payload.method === 'session.started')
    ) {
      if (Date.now() > deadline) throw new Error('session.started not seen');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** The latest decision recorded on `threadId`: what an up-to-date client folded. */
  function latestDecisionSequence(threadId: string): number | null {
    const sequences = store
      .listEvents(threadId)
      .filter((row) => row.payload.method === 'session.approval-mode-set')
      .map((row) => row.globalSequence);
    return sequences.length > 0 ? Math.max(...sequences) : null;
  }

  /** A pick; without an explicit basis, made having seen every decision. */
  async function decide(
    threadId: string,
    approvalMode: ApprovalMode,
    clientOrigin?: ClientOrigin,
    basedOnSequence: number | null = latestDecisionSequence(threadId),
  ): Promise<SetApprovalModeResult> {
    return (await service.dispatch(
      {
        type: 'setApprovalMode',
        threadId,
        approvalMode,
        basedOnSequence,
      },
      clientOrigin ? { clientOrigin } : undefined,
    )) as SetApprovalModeResult;
  }

  /** A turn with no posture on it: every #2418 surface sends exactly this. */
  async function turn(
    threadId: string,
    extra: Partial<ProviderSendTurnInput> = {},
  ) {
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'go', ...extra },
    });
  }

  test('a decision is recorded as a session event at its server sequence, and published', async () => {
    await start('t-record');
    const published: CanonicalRuntimeEvent[] = [];
    bus.subscribe((frame) => {
      if (frame.event === SERVER_EVENTS.ORCHESTRATION_EVENT)
        published.push((frame.data as { event: CanonicalRuntimeEvent }).event);
    });

    const recorded = await decide('t-record', 'ask', phone);

    const persisted = store
      .listEvents('t-record')
      .find((row) => row.payload.method === 'session.approval-mode-set');
    expect(persisted?.payload).toMatchObject({
      method: 'session.approval-mode-set',
      approvalMode: 'ask',
      clientOrigin: phone,
    });
    expect(recorded).toEqual({
      threadId: 't-record',
      recorded: true,
      approvalMode: 'ask',
      sequence: persisted?.globalSequence,
    });
    expect(
      published.some((event) => event.method === 'session.approval-mode-set'),
    ).toBe(true);
  });

  test('#2418: a turn that carries no posture runs at the recorded one', async () => {
    await start('t-2418');
    await decide('t-2418', 'ask');
    await turn('t-2418');
    expect(claude.lastTurnMode()).toBe('ask');
  });

  test('the recorded posture replaces a posture the turn carried on the default channel', async () => {
    await start('t-replace');
    await decide('t-replace', 'ask');
    await turn('t-replace', { modelOptions: { approvalMode: 'never' } });
    expect(claude.lastTurnMode()).toBe('ask');
  });

  test('with nothing recorded, the default channel passes through unchanged', async () => {
    await start('t-default-channel');
    await turn('t-default-channel', { modelOptions: { approvalMode: 'auto' } });
    expect(claude.lastTurnMode()).toBe('auto');
    await turn('t-default-channel');
    expect(claude.turns.at(-1)?.modelOptions).toBeUndefined();
  });

  test('the latest decision by server order wins, whichever device made it', async () => {
    await start('t-order');
    const first = await decide('t-order', 'never', desktop);
    const second = await decide('t-order', 'ask', phone);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    await turn('t-order');
    expect(claude.lastTurnMode()).toBe('ask');
    await decide('t-order', 'never', desktop);
    await turn('t-order');
    expect(claude.lastTurnMode()).toBe('never');
  });

  test('a re-pick of the same posture is recorded again and ordered after the decision it follows', async () => {
    await start('t-repick');
    const desktopAsk = await decide('t-repick', 'ask', desktop);
    const phoneNever = await decide('t-repick', 'never', phone);
    // The desktop re-picks Ask. Nothing changes on the chip it already
    // shows, but it is a decision and must outrank the phone's.
    const desktopAgain = await decide('t-repick', 'ask', desktop);
    expect(desktopAgain.sequence).toBeGreaterThan(phoneNever.sequence);
    expect(
      store
        .listEvents('t-repick')
        .filter((row) => row.payload.method === 'session.approval-mode-set')
        .map((row) => row.globalSequence),
    ).toEqual([
      desktopAsk.sequence,
      phoneNever.sequence,
      desktopAgain.sequence,
    ]);
    await turn('t-repick');
    expect(claude.lastTurnMode()).toBe('ask');
  });

  describe('compare-and-set (#2436 MEDIUM-1)', () => {
    test('G-off: an offline pick made before a decision it never saw is dropped; the newer decision stands', async () => {
      await start('t-goff');
      const seen = await decide('t-goff', 'auto', desktop);
      // The desktop goes offline having seen `auto`, and picks never.
      // Meanwhile the phone tightens to Ask.
      const phoneAsk = await decide('t-goff', 'ask', phone);
      // The desktop reconnects: its pick names the decision it had seen.
      const late = await decide('t-goff', 'never', desktop, seen.sequence);
      expect(late).toEqual({
        threadId: 't-goff',
        recorded: false,
        approvalMode: 'ask',
        sequence: phoneAsk.sequence,
      });
      await turn('t-goff');
      expect(claude.lastTurnMode()).toBe('ask');
      expect(
        store
          .listEvents('t-goff')
          .filter((row) => row.payload.method === 'session.approval-mode-set'),
      ).toHaveLength(2);
    });

    test('a pick made on the latest decision is recorded', async () => {
      await start('t-cas-ok');
      const seen = await decide('t-cas-ok', 'ask', phone);
      const pick = await decide('t-cas-ok', 'never', desktop, seen.sequence);
      expect(pick.recorded).toBe(true);
      await turn('t-cas-ok');
      expect(claude.lastTurnMode()).toBe('never');
    });

    test('a pick made having seen no decision loses to one that exists', async () => {
      await start('t-cas-null');
      await decide('t-cas-null', 'ask', phone);
      const pick = await decide('t-cas-null', 'never', desktop, null);
      expect(pick).toMatchObject({ recorded: false, approvalMode: 'ask' });
      // With none recorded, the same pick is recorded.
      await start('t-cas-null-empty');
      expect(
        (await decide('t-cas-null-empty', 'never', desktop, null)).recorded,
      ).toBe(true);
    });

    test('the duplicate-carry race: the same pick sent twice on one basis leaves the posture unchanged', async () => {
      await start('t-dup');
      const seen = await decide('t-dup', 'auto', desktop);
      // The command and a send carrying the same queued pick both arrive.
      const first = await decide('t-dup', 'ask', desktop, seen.sequence);
      const second = await decide('t-dup', 'ask', desktop, seen.sequence);
      expect(first.recorded).toBe(true);
      // As strict as the decision that stands, so it is recorded again; the
      // posture does not move.
      expect(second).toMatchObject({ recorded: true, approvalMode: 'ask' });
      expect(second.sequence).toBeGreaterThan(first.sequence);
      await turn('t-dup');
      expect(claude.lastTurnMode()).toBe('ask');
    });

    test("a fresh device's stricter pick is recorded, whatever it has seen", async () => {
      await start('t-fresh');
      await decide('t-fresh', 'never', desktop);
      // A phone that has seen no decision tightens: never refused.
      const phoneAuto = await decide('t-fresh', 'auto', phone, null);
      expect(phoneAuto).toMatchObject({ recorded: true, approvalMode: 'auto' });
      const phoneAsk = await decide('t-fresh', 'ask', phone, null);
      expect(phoneAsk).toMatchObject({ recorded: true, approvalMode: 'ask' });
      // Loosening on the same stale basis is still held to it.
      const phoneNever = await decide('t-fresh', 'never', phone, null);
      expect(phoneNever).toMatchObject({
        recorded: false,
        approvalMode: 'ask',
        sequence: phoneAsk.sequence,
      });
      await turn('t-fresh');
      expect(claude.lastTurnMode()).toBe('ask');
    });

    test('a Default pick is always held to its basis: a stale one is refused even if it resolves stricter now', async () => {
      // The reviewer's sequence: the phone decides Ask; the desktop, having
      // seen only its own Auto, picks Default while the Agent default is
      // Ask; the operator later raises the Agent default to full access.
      agentDefaults.builder = 'ask';
      await start('t-default-stale', 'claude', undefined, 'builder');
      const seen = await decide('t-default-stale', 'auto', desktop);
      const phoneAsk = await decide('t-default-stale', 'ask', phone);
      const stale = await decide(
        't-default-stale',
        'connection-default',
        desktop,
        seen.sequence,
      );
      expect(stale).toEqual({
        threadId: 't-default-stale',
        recorded: false,
        approvalMode: 'ask',
        sequence: phoneAsk.sequence,
      });
      agentDefaults.builder = 'never';
      await turn('t-default-stale');
      expect(claude.lastTurnMode()).toBe('ask');
      // A Default made on the latest decision is recorded as ever.
      expect(
        await decide(
          't-default-stale',
          'connection-default',
          desktop,
          phoneAsk.sequence,
        ),
      ).toMatchObject({ recorded: true });
    });

    test('a fresh device with no basis cannot pick Default over any decision', async () => {
      await start('t-default-fresh');
      await decide('t-default-fresh', 'never', desktop);
      expect(
        await decide('t-default-fresh', 'connection-default', phone, null),
      ).toMatchObject({ recorded: false, approvalMode: 'never' });
    });

    test("a fresh device's Ask is recorded over a standing Default; its Auto is held", async () => {
      // A standing Default is ranked by nothing: what it resolves to can
      // change. Ask is at least as strict as any posture, so it is recorded
      // all the same.
      await start('t-default-standing');
      await decide('t-default-standing', 'connection-default', desktop);
      expect(
        await decide('t-default-standing', 'ask', phone, null),
      ).toMatchObject({ recorded: true, approvalMode: 'ask' });
      // A looser Auto on the same stale basis is still held to it.
      expect(
        await decide('t-default-standing', 'auto', phone, null),
      ).toMatchObject({ recorded: false, approvalMode: 'ask' });
    });

    test('Auto is held over a standing Default even while that Default resolves to full access', async () => {
      stationDefault = 'never';
      await start('t-default-auto');
      await decide('t-default-auto', 'connection-default', desktop);
      // Auto is stricter than what the Default resolves to NOW, but the
      // Default could be lowered later; a stale Auto stays held.
      expect(await decide('t-default-auto', 'auto', phone, null)).toMatchObject(
        { recorded: false, approvalMode: 'connection-default' },
      );
    });

    test('the spawn window: a pick recorded before its session exists is the posture the session spawns in', async () => {
      const recorded = await service.recordApprovalModeDecision({
        threadId: 't-spawn-window',
        provider: 'claude',
        approvalMode: 'never',
        basedOnSequence: null,
      });
      expect(recorded.recorded).toBe(true);
      await start('t-spawn-window');
      expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('never');
    });
  });

  test('M1: a device that missed a tightening cannot resend a looser posture, because it sends none', async () => {
    await start('t-m1');
    await decide('t-m1', 'auto', desktop);
    await turn('t-m1');
    expect(claude.lastTurnMode()).toBe('auto');
    // The desktop is disconnected; the phone tightens.
    await decide('t-m1', 'ask', phone);
    // The desktop comes back and sends; a client no longer carries a
    // confirmed posture on its turns, so there is nothing to resend.
    await turn('t-m1');
    expect(claude.lastTurnMode()).toBe('ask');
  });

  test('a restored dormant session respawns in its recorded posture', async () => {
    store.upsertSession({
      provider: 'claude',
      threadId: 't-dormant',
      status: 'ready',
      resumeCursor: { cursor: 'resume-dormant' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:05.000Z',
    });
    store.appendEvent({
      eventId: 'posture-before-restart',
      provider: 'claude',
      threadId: 't-dormant',
      createdAt: '2026-09-01T00:00:01.000Z',
      method: 'session.approval-mode-set',
      sessionId: 't-dormant',
      approvalMode: 'never',
    });
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    await turn('t-dormant');
    expect(claude.starts.at(-1)?.threadId).toBe('t-dormant');
    expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('never');
  });

  test('Codex takes the recorded posture on every turn start', async () => {
    await start('t-codex', 'codex');
    await decide('t-codex', 'auto');
    await turn('t-codex');
    expect(codex.lastTurnMode()).toBe('auto');
  });

  test('an engine with no approval control refuses the command and its turns carry no posture', async () => {
    await start('t-acp', 'acp');
    await expect(decide('t-acp', 'ask')).rejects.toThrow(
      'This engine has no approval control.',
    );
    await turn('t-acp');
    expect(acp.turns.at(-1)?.modelOptions).toBeUndefined();
  });

  test('an unknown session refuses the command', async () => {
    await expect(decide('t-missing', 'ask')).rejects.toThrow(
      'Session not found',
    );
  });

  describe("an Agent's default posture (#2436 owner request)", () => {
    test("a session of an Agent whose default is never starts at never, and a member's turn runs at it", async () => {
      agentDefaults.builder = 'never';
      await start('t-agent', 'claude', undefined, 'builder', {
        operator: true,
      });
      expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('never');
    });

    test('a member can tighten below it, and a Default pick returns to it', async () => {
      agentDefaults.builder = 'never';
      await start('t-agent-member', 'claude', undefined, 'builder', {
        operator: true,
      });
      await decide('t-agent-member', 'ask', phone);
      await turn('t-agent-member');
      expect(claude.lastTurnMode()).toBe('ask');
      await decide('t-agent-member', 'connection-default', phone);
      await turn('t-agent-member');
      expect(claude.lastTurnMode()).toBe('never');
    });

    test("the Agent's default outranks the Station default, and a recorded decision outranks both", async () => {
      agentDefaults.builder = 'auto';
      stationDefault = 'never';
      await start('t-agent-precedence', 'claude', undefined, 'builder', {
        operator: true,
      });
      expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('auto');
      await start('t-no-agent-default', 'claude', undefined, 'other', {
        operator: true,
      });
      expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('never');
    });

    test('a live session is not reconfigured by a default: a turn with nothing recorded sends no posture', async () => {
      agentDefaults.builder = 'never';
      await start('t-agent-turn', 'claude', undefined, 'builder');
      await turn('t-agent-turn');
      expect(claude.turns.at(-1)?.modelOptions).toBeUndefined();
    });
  });

  test('HIGH-2: a credential-profile recovery replay runs at the recorded posture, not the source turn', async () => {
    await start('t-recovery', 'claude', 'never');
    // The source turn ran at full access and failed on credentials. The
    // user then tightens.
    await decide('t-recovery', 'ask', phone);
    claude.starts.length = 0;
    await (
      service as unknown as {
        restartCredentialProfileRecoverySession(input: {
          threadId: string;
          input: string;
          modelOptions?: Record<string, string>;
          recoveryCorrelationId: string;
          signal: AbortSignal;
          credentialProfileRef?: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileRecoverySession({
      threadId: 't-recovery',
      input: 'retry',
      modelOptions: { approvalMode: 'never' },
      recoveryCorrelationId: 'posture-recovery',
      signal: new AbortController().signal,
      credentialProfileRef: 'backup',
    });
    expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('ask');
    expect(claude.lastTurnMode()).toBe('ask');
  });

  describe('#2493: confinement is a server-derived axis beside the approval mode', () => {
    /** The confinement stamp on the thread's latest stored `session.started`. */
    function startStamp(threadId: string): unknown {
      const started = store
        .listEvents(threadId)
        .filter((row) => row.payload.method === 'session.started')
        .at(-1)?.payload as { metadata?: Record<string, unknown> } | undefined;
      return started?.metadata?.stationConfinement;
    }

    function restartForCredentialProfile(threadId: string) {
      return (
        service as unknown as {
          restartCredentialProfileRecoverySession(input: {
            threadId: string;
            input: string;
            modelOptions?: Record<string, string>;
            recoveryCorrelationId: string;
            signal: AbortSignal;
            credentialProfileRef?: string;
          }): Promise<unknown>;
        }
      ).restartCredentialProfileRecoverySession({
        threadId,
        input: 'retry',
        // The source turn's own posture: exactly what a confined caller
        // controls, so it must not decide confinement.
        modelOptions: { approvalMode: 'never' },
        recoveryCorrelationId: `recovery-${threadId}`,
        signal: new AbortController().signal,
        credentialProfileRef: 'backup',
      });
    }

    /** A session this process restored at boot without an engine. */
    function dormant(
      threadId: string,
      provider: 'claude' | 'codex',
      stamp: string | undefined,
      recordedNever = false,
    ) {
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
        metadata: stamp === undefined ? {} : { stationConfinement: stamp },
      } as CanonicalRuntimeEvent);
      if (recordedNever)
        store.appendEvent({
          eventId: `${threadId}-never-before-restart`,
          provider,
          threadId,
          createdAt: '2026-09-01T00:00:02.000Z',
          method: 'session.approval-mode-set',
          sessionId: threadId,
          approvalMode: 'never',
        } as CanonicalRuntimeEvent);
    }

    test('an unattended start that reaches never through a default is confined: Codex keeps never sandboxed, Claude applies auto', async () => {
      stationDefault = 'never';
      await start('c-codex-station', 'codex');
      expect(codex.starts.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: 'never' },
      });
      await start('c-claude-station', 'claude');
      expect(claude.starts.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: 'auto' },
      });

      stationDefault = undefined;
      agentDefaults.builder = 'never';
      await start('c-claude-agent', 'claude', undefined, 'builder');
      expect(claude.starts.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: 'auto' },
      });
      expect(startStamp('c-claude-agent')).toBe('workspace');
    });

    test('the operator starting at never, picked or by default, is host on both engines', async () => {
      stationDefault = 'never';
      await start('c-op-codex', 'codex', undefined, undefined, {
        operator: true,
      });
      expect(codex.starts.at(-1)).toMatchObject({
        confinement: 'host',
        modelOptions: { approvalMode: 'never' },
      });
      await start('c-op-claude', 'claude', 'never', undefined, {
        operator: true,
      });
      expect(claude.starts.at(-1)).toMatchObject({
        confinement: 'host',
        modelOptions: { approvalMode: 'never' },
      });
      expect(startStamp('c-op-claude')).toBe('host');
    });

    test('#2569: an engine with no approval knob still gets its confinement, so an ACP full-access mode can be withheld', async () => {
      await start('c-acp-unattended', 'acp');
      expect(acp.starts.at(-1)?.confinement).toBe('workspace');
      await turn('c-acp-unattended', { modelOptions: { mode: 'yolo' } });
      expect(acp.turns.at(-1)?.confinement).toBe('workspace');
      await start('c-acp-operator', 'acp', undefined, undefined, {
        operator: true,
      });
      expect(acp.starts.at(-1)?.confinement).toBe('host');
    });

    test('a caller-supplied confinement, stamp or grant look-alike is ignored', async () => {
      stationDefault = 'never';
      await service.dispatch(
        {
          type: 'startSession',
          input: {
            threadId: 'c-forged',
            provider: 'claude',
            confinement: 'host',
            metadata: { stationConfinement: 'host' },
          } as never,
        },
        // What a JSON body could carry: never the minted proof.
        { fullAccessGrant: {} as never },
      );
      expect(claude.starts.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: 'auto' },
        metadata: { stationConfinement: 'workspace' },
      });
      expect(startStamp('c-forged')).toBe('workspace');

      // On the options bag it is not an option any engine takes.
      const before = claude.starts.length;
      await expect(
        service.dispatch({
          type: 'startSession',
          input: {
            threadId: 'c-forged-options',
            provider: 'claude',
            modelOptions: { approvalMode: 'never', confinement: 'host' },
          },
        }),
      ).rejects.toThrow();
      expect(claude.starts).toHaveLength(before);
    });

    test('a confined session applies a carried never as auto on every turn; a host one keeps it', async () => {
      await start('c-turn-confined', 'claude', 'never');
      await turn('c-turn-confined', {
        modelOptions: { approvalMode: 'never' },
      });
      expect(claude.turns.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: 'auto' },
      });

      await start('c-turn-host', 'claude', 'never', undefined, {
        operator: true,
      });
      await turn('c-turn-host', { modelOptions: { approvalMode: 'never' } });
      expect(claude.turns.at(-1)).toMatchObject({
        confinement: 'host',
        modelOptions: { approvalMode: 'never' },
      });
    });

    test('the operator recording never on a confined conversation makes its turns and respawns host', async () => {
      stationDefault = 'never';
      await start('c-elevate', 'claude');
      expect(claude.starts.at(-1)?.confinement).toBe('workspace');

      await decide('c-elevate', 'never');
      await turn('c-elevate');
      expect(claude.turns.at(-1)).toMatchObject({
        confinement: 'host',
        modelOptions: { approvalMode: 'never' },
      });
      await restartForCredentialProfile('c-elevate');
      expect(claude.starts.at(-1)).toMatchObject({
        threadId: 'c-elevate',
        confinement: 'host',
        modelOptions: { approvalMode: 'never' },
      });
    });

    test('a credential-profile restart keeps the confinement its session started with', async () => {
      stationDefault = 'never';
      await start('c-cred-confined', 'claude');
      await restartForCredentialProfile('c-cred-confined');
      expect(claude.starts.at(-1)).toMatchObject({
        threadId: 'c-cred-confined',
        confinement: 'workspace',
        modelOptions: { approvalMode: 'auto' },
      });
      expect(claude.lastTurnMode()).toBe('auto');
      expect(startStamp('c-cred-confined')).toBe('workspace');

      await start('c-cred-host', 'claude', undefined, undefined, {
        operator: true,
      });
      await restartForCredentialProfile('c-cred-host');
      expect(claude.starts.at(-1)).toMatchObject({
        threadId: 'c-cred-host',
        confinement: 'host',
        modelOptions: { approvalMode: 'never' },
      });
      expect(claude.lastTurnMode()).toBe('never');
      expect(startStamp('c-cred-host')).toBe('host');
    });

    test.each([
      {
        label: 'a workspace stamp',
        stamp: 'workspace',
        recordedNever: false,
        expected: 'workspace',
      },
      {
        label: 'a host stamp',
        stamp: 'host',
        recordedNever: false,
        expected: 'host',
      },
      {
        label: 'no stamp (a session from before #2493)',
        stamp: undefined,
        recordedNever: false,
        expected: 'workspace',
      },
      {
        label: 'no stamp but a recorded never',
        stamp: undefined,
        recordedNever: true,
        expected: 'host',
      },
    ] as const)(
      'a dormant respawn with $label runs $expected',
      async ({ stamp, recordedNever, expected }) => {
        stationDefault = 'never';
        dormant('c-dormant', 'codex', stamp, recordedNever);
        service.initialize();
        await awaitSessionRecoveryCompleted(service);
        await turn('c-dormant');
        expect(codex.starts.at(-1)).toMatchObject({
          threadId: 'c-dormant',
          confinement: expected,
        });
        // The respawn's own start event carries the stamp forward, so the
        // next respawn reads the same answer rather than "legacy".
        expect(startStamp('c-dormant')).toBe(
          stamp === 'host' ? 'host' : 'workspace',
        );
      },
    );
  });

  describe('a Default pick (#2409)', () => {
    test('leaves full access Station applied: it resolves to Ask when no default is configured', async () => {
      await start('t-2409', 'claude', 'never');
      await decide('t-2409', 'never');
      await turn('t-2409');
      expect(claude.lastTurnMode()).toBe('never');

      await decide('t-2409', 'connection-default');
      await turn('t-2409');
      expect(claude.lastTurnMode()).toBe('ask');
    });

    test('resolves to the Station default when one is configured', async () => {
      stationDefault = 'auto';
      await start('t-2409-station', 'codex');
      await decide('t-2409-station', 'never');
      await turn('t-2409-station');
      await decide('t-2409-station', 'connection-default');
      await turn('t-2409-station');
      expect(codex.lastTurnMode()).toBe('auto');
    });

    test('also moves a posture Station applied at spawn from the default channel', async () => {
      // e.g. `station chat --approval-mode never`: nothing recorded.
      await start('t-2409-spawn', 'claude', 'never', undefined, {
        operator: true,
      });
      // #2493: the operator's start really spawns at full access.
      expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('never');
      await decide('t-2409-spawn', 'connection-default');
      await turn('t-2409-spawn');
      expect(claude.lastTurnMode()).toBe('ask');
    });

    test('sends nothing on a session Station never set a posture on: the engine config is the default', async () => {
      await start('t-2409-untouched');
      await decide('t-2409-untouched', 'connection-default');
      await turn('t-2409-untouched');
      expect(claude.turns.at(-1)?.modelOptions).toBeUndefined();
    });
  });
});
