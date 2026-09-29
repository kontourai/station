/**
 * @vitest-environment jsdom
 *
 * A run of tool calls lands in its final shape in its first commit. The batch
 * chunk is lazy; a lazy boundary suspends on every NEW mount, so before this
 * each batch that formed (a second call arriving, the streaming shell handing
 * the turn to the transcript) first painted its calls as standalone rows and
 * then snapped into the collapsed line. The rendering below is read
 * synchronously after `render`, i.e. the first committed frame.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
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

describe('tool-call batches in their first frame', () => {
  test('a settled run mounts collapsed, never as standalone rows first', () => {
    const { container } = render(
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
    const view = render(
      <StreamingMessageView
        {...props}
        contentParts={[call('a', 'git status')] as ChatContentPart[]}
        contentRevision={1}
      />,
    );
    expect(shape(view.container)).toEqual({ standalone: 1, batches: 0 });
    const soloGlyph = view.container
      .querySelector('.tool-call__glyph path')
      ?.getAttribute('d');
    view.rerender(
      <StreamingMessageView
        {...props}
        contentParts={
          [call('a', 'git status'), call('b', 'git log')] as ChatContentPart[]
        }
        contentRevision={2}
      />,
    );
    expect(shape(view.container)).toEqual({ standalone: 0, batches: 1 });
    // Same anatomy: the batch line keeps the solo row's kind glyph.
    expect(
      view.container
        .querySelector('.tool-call-batch__summary .tool-call__glyph path')
        ?.getAttribute('d'),
    ).toBe(soloGlyph);
  });
});
