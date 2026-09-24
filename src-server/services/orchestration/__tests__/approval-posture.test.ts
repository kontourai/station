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

  async function start(
    threadId: string,
    provider: 'claude' | 'codex' | 'acp' = 'claude',
    approvalMode?: ApprovalMode,
    agentSlug?: string,
  ) {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider,
        ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
        ...(agentSlug ? { metadata: { agentSlug } } : {}),
      },
    });
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

  async function decide(
    threadId: string,
    approvalMode: ApprovalMode,
    clientOrigin?: ClientOrigin,
    basedOnSequence?: number | null,
  ): Promise<SetApprovalModeResult> {
    return (await service.dispatch(
      {
        type: 'setApprovalMode',
        threadId,
        approvalMode,
        ...(basedOnSequence !== undefined ? { basedOnSequence } : {}),
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

    test('the duplicate-carry race: the same pick sent twice on one basis is recorded once', async () => {
      await start('t-dup');
      const seen = await decide('t-dup', 'auto', desktop);
      // The command and a send carrying the same queued pick both arrive.
      const first = await decide('t-dup', 'ask', desktop, seen.sequence);
      const second = await decide('t-dup', 'ask', desktop, seen.sequence);
      expect(first.recorded).toBe(true);
      expect(second).toEqual({
        threadId: 't-dup',
        recorded: false,
        approvalMode: 'ask',
        sequence: first.sequence,
      });
    });

    test('the spawn window: a pick recorded before its session exists is the posture the session spawns in', async () => {
      const recorded = service.recordApprovalModeDecision({
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
      await start('t-agent', 'claude', undefined, 'builder');
      expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('never');
    });

    test('a member can tighten below it, and a Default pick returns to it', async () => {
      agentDefaults.builder = 'never';
      await start('t-agent-member', 'claude', undefined, 'builder');
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
      await start('t-agent-precedence', 'claude', undefined, 'builder');
      expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('auto');
      await start('t-no-agent-default', 'claude', undefined, 'other');
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
      await start('t-2409-spawn', 'claude', 'never');
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
