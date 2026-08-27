import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handlePlanUpdatedEvent: typeof import('../planHandlers').handlePlanUpdatedEvent;
let handleTextDeltaEvent: typeof import('../streamHandlers').handleTextDeltaEvent;
let handleReasoningDeltaEvent: typeof import('../streamHandlers').handleReasoningDeltaEvent;

const threadId = 'thread-plan-1';

describe('handlePlanUpdatedEvent', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    vi.resetModules();

    vi.doMock('../../../contexts/active-chats-store', async () => {
      const actual = await vi.importActual<
        typeof import('../../../contexts/active-chats-store')
      >('../../../contexts/active-chats-store');
      const store = new actual.ActiveChatsStore({
        storage: { getItem: () => null, setItem: () => {} },
      });
      return { ...actual, activeChatsStore: store };
    });

    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    ({ handlePlanUpdatedEvent } = await import('../planHandlers'));
    ({ handleTextDeltaEvent, handleReasoningDeltaEvent } = await import(
      '../streamHandlers'
    ));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'kiro-agent',
      agentName: 'Kiro',
      title: 'Kiro Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('a first plan.updated event populates the typed plan artifact', () => {
    handlePlanUpdatedEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'plan.updated',
      entries: [
        { content: 'Read the plan', status: 'completed' },
        { content: 'Write the code', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.planArtifact).toEqual({
      source: 'canonical',
      rawText: 'Read the plan\nWrite the code\nRun the tests',
      steps: [
        { content: 'Read the plan', status: 'completed' },
        { content: 'Write the code', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
      updatedAt: '2026-07-03T00:00:00.000Z',
    });
  });

  test('a second plan.updated event with a changed status replaces the first (live update, not append)', () => {
    handlePlanUpdatedEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'plan.updated',
      entries: [
        { content: 'Read the plan', status: 'in_progress' },
        { content: 'Write the code', status: 'pending' },
      ],
    });

    handlePlanUpdatedEvent({
      eventId: 'evt-2',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:05.000Z',
      method: 'plan.updated',
      entries: [
        { content: 'Read the plan', status: 'completed' },
        { content: 'Write the code', status: 'in_progress' },
      ],
    });

    const artifact = activeChatsStore.getSnapshot()[threadId]?.planArtifact;
    expect(artifact?.steps).toEqual([
      { content: 'Read the plan', status: 'completed' },
      { content: 'Write the code', status: 'in_progress' },
    ]);
    expect(artifact?.updatedAt).toBe('2026-07-03T00:00:05.000Z');
  });

  test('a subsequent content.text-delta event does not clobber the typed plan artifact with plain prose', () => {
    handlePlanUpdatedEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'plan.updated',
      entries: [{ content: 'Read the plan', status: 'completed' }],
    });

    handleTextDeltaEvent({
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:10.000Z',
      method: 'content.text-delta',
      itemId: 'item-1',
      delta: 'Here is a normal sentence, not a plan.',
    });

    const artifact = activeChatsStore.getSnapshot()[threadId]?.planArtifact;
    expect(artifact?.source).toBe('canonical');
    expect(artifact?.steps).toEqual([
      { content: 'Read the plan', status: 'completed' },
    ]);
  });

  test('a subsequent content.reasoning-delta event does not clobber the typed plan artifact either', () => {
    handlePlanUpdatedEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'plan.updated',
      entries: [{ content: 'Read the plan', status: 'completed' }],
    });

    handleReasoningDeltaEvent({
      provider: 'acp',
      threadId,
      createdAt: '2026-07-03T00:00:10.000Z',
      method: 'content.reasoning-delta',
      itemId: 'item-1',
      delta: 'Thinking about the next step.',
    });

    const artifact = activeChatsStore.getSnapshot()[threadId]?.planArtifact;
    expect(artifact?.source).toBe('canonical');
    expect(artifact?.steps).toEqual([
      { content: 'Read the plan', status: 'completed' },
    ]);
  });

  test('ignores an event for a thread with no active chat', () => {
    handlePlanUpdatedEvent({
      eventId: 'evt-1',
      provider: 'acp',
      threadId: 'thread-does-not-exist',
      createdAt: '2026-07-03T00:00:00.000Z',
      method: 'plan.updated',
      entries: [{ content: 'Read the plan', status: 'completed' }],
    });

    expect(
      activeChatsStore.getSnapshot()['thread-does-not-exist'],
    ).toBeUndefined();
  });
});
