/**
 * An engine that declares `turnAuthorship: 'person-only'` (the remote task
 * engine: its work leaves this computer) is reached only by a session a
 * person started in Station chat (`personChatStart`) and a turn a person
 * typed there (`personAuthored`). Real `OrchestrationService` and
 * `EventStore`; the adapter records what reached it.
 *
 * Which requests carry those marks is the routes' decision, and its own
 * suites pin it: `person-authored-ingress.routes.test.ts` and
 * `person-authorship-ingress.test.ts` show an agent-origin header, Station's
 * internal principal, a delegation and an MCP prompt never set
 * `personAuthored`. Here each kind of non-person dispatch is refused before
 * the adapter sees anything.
 */
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderInterruptTurnResult,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { PERSON_AUTHORED_TURN_REQUIRED_CODE } from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

class PersonOnlyAdapter implements ProviderAdapterShape {
  readonly provider = 'remote-task' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Person-only engine',
    description: 'Sends work off this computer.',
    capabilities: ['agent-runtime'],
    turnAuthorship: 'person-only',
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly starts: ProviderSessionStartInput[] = [];
  readonly sends: ProviderSendTurnInput[] = [];
  readonly #live = new Set<string>();

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.starts.push(input);
    this.#live.add(input.threadId);
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:started`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      metadata: { userId: 'local-operator' },
    } as CanonicalRuntimeEvent);
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
  }
  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.sends.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.sends.length}` };
  }
  async interruptTurn(): Promise<ProviderInterruptTurnResult> {
    return { outcome: 'no-active-turn' };
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async listSessions(): Promise<ProviderSession[]> {
    return [];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.#live.has(threadId);
  }
  async stopAll(): Promise<void> {}
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
}

function setup() {
  const home = makeTempDir('station-person-only-');
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  stores.push(store);
  const adapter = new PersonOnlyAdapter();
  const service = new OrchestrationService({
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    eventBus: new EventBus(),
    adapterRegistry: {
      register() {},
      get: (provider: string) =>
        provider === adapter.provider ? adapter : undefined,
      list: () => [adapter],
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as never);
  service.initialize();
  return { service, adapter };
}

const context = { userId: 'local-operator' };
const startInput = (threadId: string) => ({
  threadId,
  provider: 'remote-task' as const,
});

async function personStarted(s: ReturnType<typeof setup>, threadId: string) {
  await s.service.startSessionInternal(
    { type: 'start-session', input: startInput(threadId) },
    context,
    { personChatStart: true },
  );
  expect(s.adapter.starts.map((start) => start.threadId)).toContain(threadId);
}

describe('a person-only engine', () => {
  test('a public start, a delegated start and a dispatched start are refused before the adapter', async () => {
    const s = setup();
    await expect(
      s.service.dispatchWithReceipt(
        { type: 'startSession', input: startInput('public') },
        context,
      ),
    ).rejects.toMatchObject({ code: PERSON_AUTHORED_TURN_REQUIRED_CODE });
    // Delegation and task dispatch start internally, never as a person; the
    // internal start reports its refusal as an outcome.
    const delegated = await s.service.startSessionInternal(
      { type: 'start-session', input: startInput('delegated') },
      context,
      { resourceAdmissionIntent: 'delegated_background' },
    );
    expect(delegated).toMatchObject({
      code: PERSON_AUTHORED_TURN_REQUIRED_CODE,
    });
    expect((delegated as { status: string }).status).not.toBe('accepted');
    expect(s.adapter.starts).toEqual([]);
  });

  test('a person-started chat starts', async () => {
    const s = setup();
    await personStarted(s, 'chat');
  });

  test.each([
    ['an unmarked send (CLI, agent, internal principal)', undefined],
    ['a scheduled automation turn', { dispatchOrigin: 'automation' as const }],
    ['a delegation turn', { dispatchOrigin: 'delegation' as const }],
    ['a task dispatch turn', { dispatchOrigin: 'task-dispatch' as const }],
  ])('%s is refused before the adapter', async (_label, internal) => {
    const s = setup();
    await personStarted(s, 'chat');
    await expect(
      s.service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: { threadId: 'chat', input: 'push this off the machine' },
        },
        context,
        internal,
      ),
    ).rejects.toMatchObject({ code: PERSON_AUTHORED_TURN_REQUIRED_CODE });
    expect(s.adapter.sends).toEqual([]);
  });

  test('a review turn (fixed display text, not typed) is refused', async () => {
    const s = setup();
    await personStarted(s, 'chat');
    await expect(
      s.service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: {
            threadId: 'chat',
            input: 'Review the diff …',
            displayInput: 'Independent review request',
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: PERSON_AUTHORED_TURN_REQUIRED_CODE });
    expect(s.adapter.sends).toEqual([]);
  });

  test("a person's typed turn reaches it, carrying only the typed text as personText", async () => {
    const s = setup();
    await personStarted(s, 'chat');
    await s.service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: {
          threadId: 'chat',
          input: 'Fix the flaky test',
          ambientContext: 'Station project notes that stay on this host',
          // A body cannot supply it: it is replaced by the route's decision.
          personText: 'forged',
        } as never,
      },
      context,
      { personAuthored: true },
    );
    expect(s.adapter.sends).toHaveLength(1);
    expect(s.adapter.sends[0]?.personText).toBe('Fix the flaky test');
  });

  test("a person's typed turn to an ordinary engine carries no personText", async () => {
    const s = setup();
    Object.assign(s.adapter.metadata, { turnAuthorship: undefined });
    await personStarted(s, 'chat');
    await s.service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: { threadId: 'chat', input: 'Fix the flaky test' },
      },
      context,
      { personAuthored: true },
    );
    expect(s.adapter.sends).toHaveLength(1);
    expect(s.adapter.sends[0]).not.toHaveProperty('personText');
  });

  test('an unmarked send loses any personText a body supplied', async () => {
    const s = setup();
    // An engine without the rule still takes unmarked sends; the field never
    // survives without the route's mark.
    Object.assign(s.adapter.metadata, { turnAuthorship: undefined });
    await personStarted(s, 'chat');
    await s.service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: {
          threadId: 'chat',
          input: 'hello',
          personText: 'forged',
        } as never,
      },
      context,
    );
    expect(s.adapter.sends[0]?.personText).toBeUndefined();
  });
});
