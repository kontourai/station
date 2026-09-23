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
  let service: OrchestrationService;

  function createService(): OrchestrationService {
    return new OrchestrationService({
      adapterRegistry: registry([claude, codex, acp]),
      eventBus: bus,
      eventStore: store,
      resolveStationDefaultApprovalMode: async () => stationDefault,
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
  ) {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider,
        ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
      },
    });
  }

  async function decide(
    threadId: string,
    approvalMode: ApprovalMode,
    clientOrigin?: ClientOrigin,
  ): Promise<SetApprovalModeResult> {
    return (await service.dispatch(
      { type: 'setApprovalMode', threadId, approvalMode },
      clientOrigin ? { clientOrigin } : undefined,
    )) as SetApprovalModeResult;
  }

  /** A turn with no posture on it: every #2418 surface sends exactly this. */
  async function turn(
    threadId: string,
    extra: Partial<ProviderSendTurnInput> & {
      setApprovalMode?: ApprovalMode;
    } = {},
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

  test('a decision a turn carries (an offline pick) is ordered by its receipt, after decisions already recorded', async () => {
    await start('t-carried');
    // The phone tightens while the desktop is offline with never picked.
    await decide('t-carried', 'ask', phone);
    // The desktop reconnects: its pick reaches the server now, with its turn.
    await turn('t-carried', { setApprovalMode: 'never' });
    expect(claude.lastTurnMode()).toBe('never');
    const decisions = store
      .listEvents('t-carried')
      .filter((row) => row.payload.method === 'session.approval-mode-set')
      .map((row) => (row.payload as { approvalMode: string }).approvalMode);
    expect(decisions).toEqual(['ask', 'never']);
    // It is never forwarded to the adapter as a field of its own.
    expect(claude.turns.at(-1)).not.toHaveProperty('setApprovalMode');
    // And the next turn, which carries nothing, keeps it.
    await turn('t-carried');
    expect(claude.lastTurnMode()).toBe('never');
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

  test('a session starts in a decision its starting send carries (Claude grants full access only at spawn)', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 't-spawn',
        provider: 'claude',
        setApprovalMode: 'never',
      },
    });
    expect(claude.starts.at(-1)?.modelOptions?.approvalMode).toBe('never');
    expect(claude.starts.at(-1)).not.toHaveProperty('setApprovalMode');
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
