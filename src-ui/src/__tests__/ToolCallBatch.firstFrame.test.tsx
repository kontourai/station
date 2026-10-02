/**
 * @vitest-environment jsdom
 *
 * A run of tool calls lands in its final shape in its first commit. The batch
 * chunk is lazy; a lazy boundary suspends on every NEW mount, so before this
 * each batch that formed (a second call arriving, the streaming shell handing
 * the turn to the transcript) first painted its calls as standalone rows and
 * then snapped into the collapsed line.
 *
 * The first frame is read with a synchronous static render: whatever a
 * component draws before anything can resolve. It is also a guard — a
 * regression back to the suspending path shows its pending rows here and
 * FAILS, where a mounted render of the same regression never settled.
 */
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { MessageContent } from '../components/chat/message-bubble/MessageContent';
import { StreamingMessageView } from '../components/chat/StreamingMessage';
import { preloadToolCallBatch } from '../components/chat/ToolCallBatchBoundary';
import { ToolCallDisplay } from '../components/chat/ToolCallDisplay';
import type { ChatContentPart } from '../contexts/active-chats-state';

const call = (id: string, command: string) => ({
  type: 'tool-invocation',
  toolCallId: id,
  toolName: 'Bash',
  args: { command },
  state: 'completed',
  result: 'ok',
});

beforeAll(async () => {
  // What `usePreloadToolCallBatch` does when the first call appears.
  await preloadToolCallBatch();
});
afterEach(cleanup);

function shape(container: HTMLElement) {
  return {
    standalone: [...container.querySelectorAll('.tool-call')].filter(
      (row) => !row.closest('.tool-call-batch'),
    ).length,
    batches: container.querySelectorAll('.tool-call-batch__summary').length,
  };
}

/** The first frame of `element`, as DOM. */
function firstFrame(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe('tool-call batches in their first frame', () => {
  test('a settled run mounts collapsed, never as standalone rows first', () => {
    const container = firstFrame(
      <MessageContent
        contentParts={[call('a', 'git status'), call('b', 'git log -3')]}
        textContent=""
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        isStreamingMessage={false}
      />,
    );
    expect(shape(container)).toEqual({ standalone: 0, batches: 1 });
  });

  test('the streaming shell collapses a run the moment its second call arrives', () => {
    const renderToolCall = (part: ChatContentPart, index: number) => (
      <ToolCallDisplay key={index} toolCall={part} />
    );
    const props = {
      sessionId: 'chat-1',
      agentIcon: null,
      agentIconStyle: {},
      fontSize: 14,
      streamingText: '',
      hasContent: true,
      renderToolCall,
    };
    const solo = firstFrame(
      <StreamingMessageView
        {...props}
        contentParts={[call('a', 'git status')] as ChatContentPart[]}
        contentRevision={1}
      />,
    );
    expect(shape(solo)).toEqual({ standalone: 1, batches: 0 });
    const soloGlyph = solo
      .querySelector('.tool-call__glyph path')
      ?.getAttribute('d');
    const grown = firstFrame(
      <StreamingMessageView
        {...props}
        contentParts={
          [call('a', 'git status'), call('b', 'git log')] as ChatContentPart[]
        }
        contentRevision={2}
      />,
    );
    expect(shape(grown)).toEqual({ standalone: 0, batches: 1 });
    // Same anatomy: the batch line keeps the solo row's kind glyph.
    expect(
      grown
        .querySelector('.tool-call-batch__summary .tool-call__glyph path')
        ?.getAttribute('d'),
    ).toBe(soloGlyph);
  });

  test('a transcript warms the batch chunk itself: the second call lands collapsed', async () => {
    // A fresh module graph, as on a page that has never shown a batch; no
    // manual preload — the transcript's first tool call has to do it.
    vi.resetModules();
    const { MessageContent: FreshMessageContent } = await import(
      '../components/chat/message-bubble/MessageContent'
    );
    const props = {
      textContent: '',
      chatFontSize: 14,
      showReasoning: false,
      showToolDetails: false,
      isStreamingMessage: false,
    };
    const view = render(
      <FreshMessageContent
        {...props}
        contentParts={[call('a', 'git status')]}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    view.unmount();
    expect(
      shape(
        firstFrame(
          <FreshMessageContent
            {...props}
            contentParts={[call('a', 'git status'), call('b', 'git log -3')]}
          />,
        ),
      ),
    ).toEqual({ standalone: 0, batches: 1 });
  });

  test('a batch chunk that cannot load leaves the calls as standalone rows', async () => {
    vi.resetModules();
    vi.doMock('../components/chat/ToolCallBatch', () => {
      throw new Error('chunk failed to load');
    });
    const { MessageContent: FreshMessageContent } = await import(
      '../components/chat/message-bubble/MessageContent'
    );
    const view = render(
      <FreshMessageContent
        textContent=""
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        isStreamingMessage={false}
        contentParts={[call('a', 'git status'), call('b', 'git log -3')]}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(shape(view.container)).toEqual({ standalone: 2, batches: 0 });
    expect(view.container.textContent).not.toContain('Unable to load');
    vi.doUnmock('../components/chat/ToolCallBatch');
  });
});
