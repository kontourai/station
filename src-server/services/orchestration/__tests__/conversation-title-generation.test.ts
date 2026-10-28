import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveTitleModel } from '../../../routes/chat/chat-title-generation.js';
import {
  ConversationTitleGeneration,
  subscribeConversationTitleGeneration,
} from '../conversation-title-generation.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';

const THREAD = 'claude:title-generation';
const OWNER = 'human:local:operator';
const AT = '2026-10-28T00:00:00.000Z';

describe('generated conversation titles (#4266)', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'title-generation-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(metadata: Record<string, unknown> = {}): void {
    store.upsertSession({
      provider: 'claude',
      threadId: THREAD,
      status: 'ready',
      createdAt: AT,
      updatedAt: AT,
    } as never);
    store.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId: THREAD,
      createdAt: AT,
      method: 'session.started',
      sessionId: THREAD,
      metadata: { userId: OWNER, agentSlug: 'claude', ...metadata },
    } as never);
  }

  /** One prompted turn and its completion; returns the completion event. */
  function exchange(n: number, prompt: string, reply: string) {
    store.appendEvent({
      eventId: `turn-${n}-started`,
      provider: 'claude',
      threadId: THREAD,
      turnId: `turn-${n}`,
      createdAt: AT,
      method: 'turn.started',
      prompt,
    } as never);
    const completed = {
      eventId: `turn-${n}-completed`,
      provider: 'claude',
      threadId: THREAD,
      turnId: `turn-${n}`,
      createdAt: AT,
      method: 'turn.completed',
      outputText: reply,
    } as const;
    store.appendEvent(completed as never);
    return completed as never;
  }

  function listedTitle() {
    return store.listConversationHistoryPage({ ownerUserId: OWNER, limit: 5 })
      .records[0];
  }

  function generation(
    generate: (input: {
      firstUserText: string;
      assistantText: string;
    }) => Promise<string | null>,
    enabled = true,
  ) {
    const generator = vi.fn(generate);
    const titles = new ConversationTitleGeneration({
      eventStore: store,
      enabled: () => enabled,
      generate: generator,
      logger: { warn: vi.fn() },
    });
    return { titles, generator };
  }

  test('titles the conversation from its first exchange and lists it as generated', async () => {
    start();
    const completed = exchange(
      1,
      'Why does the dock header overflow?',
      'It wraps.',
    );
    const { titles, generator } = generation(
      async () => 'Dock header overflow',
    );

    titles.observe(completed);
    await titles.settled();

    expect(generator).toHaveBeenCalledWith({
      firstUserText: 'Why does the dock header overflow?',
      assistantText: 'It wraps.',
    });
    expect(listedTitle()).toMatchObject({
      title: 'Dock header overflow',
      titleSource: 'generated',
    });
  });

  test('is off when no title model is configured', async () => {
    start();
    const completed = exchange(
      1,
      'Why does the dock header overflow?',
      'It wraps.',
    );
    const { titles, generator } = generation(async () => 'Never', false);

    titles.observe(completed);
    await titles.settled();

    expect(generator).not.toHaveBeenCalled();
    expect(listedTitle()).toMatchObject({
      title: 'Why does the dock header overflow?',
      titleSource: 'prompt',
    });
  });

  test.each([
    ['times out (the helper resolves null)', async () => null],
    ['fails', async () => Promise.reject(new Error('provider down'))],
    ['answers low-content', async () => 'Continue'],
  ])(
    'keeps the deterministic title when the model %s',
    async (_case, answer) => {
      start();
      const completed = exchange(
        1,
        'Why does the dock header overflow?',
        'It wraps.',
      );
      const { titles, generator } = generation(answer);

      titles.observe(completed);
      await titles.settled();

      expect(generator).toHaveBeenCalledTimes(1);
      expect(listedTitle()).toMatchObject({
        title: 'Why does the dock header overflow?',
        titleSource: 'prompt',
      });
    },
  );

  test('never replaces a title supplied with the start', async () => {
    start({ delegationTitle: 'Review the release notes' });
    const completed = exchange(1, 'Review the release notes\n\nbrief', 'Done.');
    const { titles, generator } = generation(async () => 'Generated');

    titles.observe(completed);
    await titles.settled();

    expect(generator).not.toHaveBeenCalled();
    expect(listedTitle()).toMatchObject({
      title: 'Review the release notes',
      titleSource: 'provider',
    });
  });

  test('a title that changed while the model ran is not overwritten', async () => {
    start();
    const completed = exchange(
      1,
      'Why does the dock header overflow?',
      'It wraps.',
    );
    const { titles } = generation(async () => {
      // Another generation (or a later writer) landed first.
      store.recordGeneratedConversationTitle(THREAD, 'Landed first');
      return 'Too late';
    });

    titles.observe(completed);
    await titles.settled();

    expect(listedTitle()).toMatchObject({ title: 'Landed first' });
  });

  test('only the first completed turn is titled, and a low-content first prompt is not sent', async () => {
    start();
    const first = exchange(1, 'Continue', 'Continuing.');
    const second = exchange(2, 'Fix the dock header', 'Fixed.');
    const { titles, generator } = generation(async () => 'Generated');

    titles.observe(first);
    titles.observe(second);
    await titles.settled();

    expect(generator).not.toHaveBeenCalled();
    // The deterministic rule still names it from the real prompt.
    expect(listedTitle()).toMatchObject({
      title: 'Fix the dock header',
      titleSource: 'prompt',
    });
  });
});

describe('resolveTitleModel (#4266)', () => {
  test('only an explicit titleModel turns titles on, and never on a hosted Station', () => {
    const personal = {};
    expect(resolveTitleModel({ titleModel: 'haiku' }, personal)).toBe('haiku');
    expect(resolveTitleModel({ titleModel: '  ' }, personal)).toBeUndefined();
    // The structure model is configured for another purpose.
    expect(
      resolveTitleModel(
        { structureModel: 'nova' } as Parameters<typeof resolveTitleModel>[0],
        personal,
      ),
    ).toBeUndefined();
    expect(
      resolveTitleModel(
        { titleModel: 'haiku' },
        { STATION_HOSTED_TENANT_REGISTRY_FILE: '/srv/tenants.json' },
      ),
    ).toBeUndefined();
  });
});

describe('subscribeConversationTitleGeneration (#4266)', () => {
  test('hands every committed turn.completed on the bus, and nothing else, to the generator', () => {
    const bus = new EventBus();
    const observe = vi.fn();
    const unsubscribe = subscribeConversationTitleGeneration(bus, { observe });
    const completed = { method: 'turn.completed', threadId: 't', turnId: 'x' };

    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event: completed });
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: { method: 'turn.started', threadId: 't' },
    });
    bus.emit(SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED, {
      event: completed,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(completed);

    unsubscribe();
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event: completed });
    expect(observe).toHaveBeenCalledTimes(1);
  });
});
