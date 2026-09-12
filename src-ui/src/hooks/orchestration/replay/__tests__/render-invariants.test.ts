// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { activeChatsStore } from '../../../../contexts/active-chats-store';
import { closeActiveReplay, openReplayFromTape } from '../controller';
import { tapeFromSessionEvents } from '../tape';

const source = { threadId: 'render-source', agentSlug: 'codex' };
const base = {
  provider: 'codex' as const,
  threadId: source.threadId,
  turnId: 'turn',
  createdAt: '2026-09-12T00:00:00Z',
};
function open() {
  return openReplayFromTape(
    tapeFromSessionEvents(source, [
      { ...base, eventId: 'start', method: 'turn.started', prompt: 'Question' },
      {
        ...base,
        eventId: 'text',
        itemId: 'text',
        method: 'content.text-delta',
        delta: 'Answer',
      },
      {
        ...base,
        eventId: 'done',
        method: 'turn.completed',
        outputText: 'Answer',
        finishReason: 'stop',
      },
    ]),
    { agentSlug: 'codex', agentName: 'Codex' },
  );
}
function transcript() {
  const container = document.createElement('div');
  container.innerHTML = '<div data-chat-message-key="retained">Question</div>';
  document.body.append(container);
  let top = 10;
  Object.defineProperties(container, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2000 },
  });
  vi.spyOn(container, 'getBoundingClientRect').mockImplementation(
    () => ({ top: 0, bottom: 600 }) as DOMRect,
  );
  vi.spyOn(
    container.firstElementChild!,
    'getBoundingClientRect',
  ).mockImplementation(() => ({ top, bottom: top + 30 }) as DOMRect);
  return {
    container,
    move: (value: number) => {
      top = value;
    },
  };
}
afterEach(() => {
  closeActiveReplay();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('terminal replay messages retain recorded time rather than the playback clock', () => {
  const { player, replayId } = open();
  player.seek(2);
  const messages = activeChatsStore.getSnapshot()[replayId].messages;
  expect(
    messages?.find((message) => message.role === 'assistant')?.timestamp,
  ).toBe(Date.parse(base.createdAt));
});

test('a settled answer absent from the mounted transcript is an issue', async () => {
  const { player } = open();
  const { container } = transcript();
  Object.defineProperty(container, 'scrollTop', { value: 1400 });
  player.seek(2);
  const observation = await player.observeRendered(() => container);
  expect(observation.issues.map((issue) => issue.code)).toContain(
    'completed-answer-not-rendered',
  );
});

test('a frozen virtual range outside the viewport is reported', async () => {
  const { player } = open();
  const { container, move } = transcript();
  move(-1000);
  const observation = await player.stepRendered(() => container);
  expect(observation.issues.map((issue) => issue.code)).toContain(
    'empty-transcript-viewport',
  );
});

test.each([false, true])(
  'forward playback detects an anchor jump unless the reader moved it (reader input=%s)',
  async (readerInput) => {
    const { player, replayId } = open();
    const { container, move } = transcript();
    await player.stepRendered(() => container);
    // Simulate a renderer defect during the actual event fold. A real input
    // event is the negative control; merely changing scroll geometry is not.
    const unsubscribe = activeChatsStore.subscribe(() => {
      if (
        activeChatsStore.getSnapshot()[replayId]?.streamingMessage?.content ===
        'Answer'
      ) {
        move(100);
        if (readerInput) document.dispatchEvent(new Event('wheel'));
      }
    });
    try {
      const observation = await player.stepRendered(() => container);
      expect(
        observation.issues.some(
          (issue) => issue.code === 'unexpected-scroll-jump',
        ),
      ).toBe(!readerInput);
      expect(
        player
          .observe(container)
          .issues.some((issue) => issue.code === 'unexpected-scroll-jump'),
      ).toBe(!readerInput);
    } finally {
      unsubscribe();
    }
  },
);

test('stable anchors and explicit seeks do not report scroll jumps', async () => {
  const { player } = open();
  const { container, move } = transcript();
  expect((await player.stepRendered(() => container)).issues).toEqual([]);
  expect((await player.stepRendered(() => container)).issues).toEqual([]);
  move(300);
  player.seek(0);
  expect((await player.observeRendered(() => container)).issues).toEqual([]);
});
