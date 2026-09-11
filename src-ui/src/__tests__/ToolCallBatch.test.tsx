/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MessageContent } from '../components/chat/message-bubble/MessageContent';
import { StreamingMessageView } from '../components/chat/StreamingMessage';
import { ToolCallBatch } from '../components/chat/ToolCallBatch';
import { classifyToolCallRun } from '../components/chat/tool-call-groups';
import {
  splitToolCallRuns,
  type ToolCallLike,
  type ToolCallRun,
} from '../components/chat/tool-call-runs';

function renderCall(part: ToolCallLike, index: number) {
  return (
    <div key={index} data-testid={`tool-call-detail-${index}`}>
      {part.toolName ?? part.name}
    </div>
  );
}

function runFor(parts: ToolCallLike[]): ToolCallRun {
  const [block] = splitToolCallRuns(parts);
  if (block?.type !== 'tool-call-run') {
    throw new Error('expected a tool-call run');
  }
  return block;
}

describe('ToolCallBatch', () => {
  test('a multi-call run renders as a button with an accessible name from the summary', () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
      },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
    ]);
    const summary = classifyToolCallRun(run).summary;

    render(<ToolCallBatch run={run} renderCall={renderCall} />);

    const button = screen.getByRole('button', { name: summary });
    expect(button).toBeTruthy();
    expect(button.tagName).toBe('BUTTON');
  });

  test('opening the summary button reveals every individual call', async () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
      },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
      {
        type: 'tool-invocation',
        toolCallId: 'c',
        toolName: 'Bash',
        args: { command: 'npm build' },
      },
    ]);
    const summary = classifyToolCallRun(run).summary;

    render(<ToolCallBatch run={run} renderCall={renderCall} />);

    expect(screen.queryByTestId('tool-call-detail-0')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: summary }));

    expect(await screen.findByTestId('tool-call-detail-0')).toBeTruthy();
    expect(screen.getByTestId('tool-call-detail-1')).toBeTruthy();
    expect(screen.getByTestId('tool-call-detail-2')).toBeTruthy();
  });

  test('the sheet close button is a real button with an accessible name', async () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
      },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
    ]);
    const summary = classifyToolCallRun(run).summary;

    render(<ToolCallBatch run={run} renderCall={renderCall} />);
    fireEvent.click(screen.getByRole('button', { name: summary }));
    await screen.findByTestId('tool-call-detail-0');

    const closeButton = screen.getByRole('button', {
      name: 'Close tool call details',
    });
    expect(closeButton).toBeTruthy();
    expect(closeButton.tagName).toBe('BUTTON');
  });

  test('a single-call run renders the plain call detail with no batch button', () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'solo',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
      },
    ]);

    render(<ToolCallBatch run={run} renderCall={renderCall} />);

    expect(screen.getByTestId('tool-call-detail-0')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ToolCallBatch failure disclosure (station#2652 redesign)', () => {
  test('a collapsed batch containing a failed call says so without being opened', () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'Bash',
        args: { command: 'npm test' },
        result: 'ok',
      },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm run lint' },
        error: 'exit 1',
      },
    ]);

    render(<ToolCallBatch run={run} renderCall={renderCall} />);

    const flag = screen.getByText('1 failed');
    expect(flag.className).toContain('tool-call-batch__failed');
  });

  test('a batch with no failures renders no failure flag', () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'Bash',
        args: { command: 'npm test' },
        result: 'ok',
      },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        result: 'ok',
      },
    ]);

    render(<ToolCallBatch run={run} renderCall={renderCall} />);

    expect(screen.queryByText(/failed/)).toBe(null);
  });

  // station#1569 (item 3): a call the session ended on is not a failure and
  // not a success, and the header's verb can only decline to claim
  // completion — it cannot say how many.
  test('a collapsed batch discloses how many calls never reported', () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'Bash',
        args: { command: 'npm test' },
        result: 'ok',
      },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm run build' },
        state: 'unresolved',
      },
    ]);

    render(<ToolCallBatch run={run} renderCall={renderCall} />);

    const flag = screen.getByText('1 with no result');
    expect(flag.className).toContain('tool-call-batch__unresolved');
    // Never as a failure: nothing observed the tool fail.
    expect(screen.queryByText(/failed/)).toBe(null);
    // And the summary itself refuses the past tense.
    expect(screen.getByRole('button').textContent).toContain('Run 2 commands');
  });

  test('a batch with nothing unresolved renders no such flag', () => {
    const run = runFor([
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'Bash',
        args: { command: 'npm test' },
        result: 'ok',
      },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm run build' },
        result: 'ok',
      },
    ]);

    render(<ToolCallBatch run={run} renderCall={renderCall} />);

    expect(screen.queryByText(/with no result/)).toBe(null);
    expect(screen.getByRole('button').textContent).toContain('Ran 2 commands');
  });
});

test('explicit batch disclosure shows tool rows when inline details are hidden', async () => {
  render(
    <MessageContent
      contentParts={Array.from({ length: 4 }, (_, index) => ({
        type: 'tool-invocation' as const,
        toolCallId: `read-${index}`,
        toolName: 'Read',
        args: { file_path: `source-${index}.ts` },
        state: 'result' as const,
        result: 'file contents',
      }))}
      textContent=""
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      isStreamingMessage={false}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: /Read 4 files|Used 4 tools/ }),
  );
  expect(await screen.findByText('Read source-0.ts')).toBeTruthy();
  expect(screen.getByText('Read source-3.ts')).toBeTruthy();
});

test('two consecutive tool calls collapse to the batch summary, not two rows', async () => {
  render(
    <MessageContent
      contentParts={[
        {
          type: 'tool-invocation',
          toolCallId: 'read-0',
          toolName: 'Read',
          args: { file_path: 'source-0.ts' },
          state: 'result',
          result: 'file contents',
        },
        {
          type: 'tool-invocation',
          toolCallId: 'read-1',
          toolName: 'Read',
          args: { file_path: 'source-1.ts' },
          state: 'result',
          result: 'file contents',
        },
      ]}
      textContent=""
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      isStreamingMessage={false}
    />,
  );
  expect(
    await screen.findByRole('button', { name: /Read 2 files|Used 2 tools/ }),
  ).toBeTruthy();
  expect(screen.queryByText('Read source-0.ts')).toBeNull();
});

test('a run that still needs a grant stays inline so Allow Once is not behind a tap', () => {
  const onToolApproval = vi.fn();
  render(
    <MessageContent
      contentParts={[
        {
          type: 'tool-invocation',
          toolCallId: 'read-0',
          toolName: 'Read',
          args: { file_path: 'a.ts' },
          state: 'result',
          result: 'ok',
        },
        {
          type: 'tool-invocation',
          toolCallId: 'write-1',
          toolName: 'Write',
          args: { path: 'secrets.env' },
          needsApproval: true,
          state: 'awaiting-approval',
          approvalId: 'a1',
        },
      ]}
      textContent=""
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={true}
      isStreamingMessage={true}
      onToolApproval={onToolApproval}
    />,
  );
  expect(
    screen.queryByRole('button', { name: /Read 1 file, edit 1 file/ }),
  ).toBeNull();
  expect(screen.getByText('Edit secrets.env')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
  expect(onToolApproval).toHaveBeenCalled();
});

test('a solo tool call stays an inline row with no batch button', () => {
  render(
    <MessageContent
      contentParts={[
        {
          type: 'tool-invocation',
          toolCallId: 'read-0',
          toolName: 'Read',
          args: { file_path: 'source-0.ts' },
          state: 'result',
          result: 'file contents',
        },
      ]}
      textContent=""
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={true}
      isStreamingMessage={false}
    />,
  );
  expect(screen.getByText('Read source-0.ts')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: /Read 1 file|Used 1 tool/ }),
  ).toBeNull();
});

test('a collapsed batch discloses an awaiting-approval call without being opened', () => {
  const run = runFor([
    {
      type: 'tool-invocation',
      toolCallId: 'a',
      toolName: 'Read',
      args: { file_path: 'a.ts' },
      state: 'result',
      result: 'ok',
    },
    {
      type: 'tool-invocation',
      toolCallId: 'b',
      toolName: 'Write',
      args: { path: 'secrets.env' },
      needsApproval: true,
      state: 'awaiting-approval',
    },
  ]);

  render(<ToolCallBatch run={run} renderCall={renderCall} />);

  const button = screen.getByRole('button', {
    name: /Read 1 file, edit 1 file/,
  });
  expect(button.textContent).not.toMatch(/edited/i);
  const flag = screen.getByText('Awaiting approval');
  expect(flag.className).toContain('tool-call-batch__awaiting');
});

test('a live batch button names the latest running call; the sheet titles the inventory', async () => {
  const run = runFor([
    {
      type: 'tool-invocation',
      toolCallId: 'a',
      toolName: 'Read',
      args: { file_path: 'a.ts' },
      state: 'completed',
    },
    {
      type: 'tool-invocation',
      toolCallId: 'b',
      toolName: 'Bash',
      args: { command: 'npm test' },
      state: 'running',
    },
  ]);
  const group = classifyToolCallRun(run);

  render(<ToolCallBatch run={run} renderCall={renderCall} />);

  fireEvent.click(screen.getByRole('button', { name: group.summary }));
  expect(await screen.findByTestId('tool-call-detail-0')).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: group.aggregateSummary }),
  ).toBeTruthy();
  expect(group.summary).toBe('Running npm test…');
  expect(group.aggregateSummary).not.toBe(group.summary);
});

test('a collapsed in-progress streaming batch shows the call progress on the batch, not a second indicator', async () => {
  render(
    <StreamingMessageView
      sessionId="s1"
      agentIcon={null}
      agentIconStyle={{}}
      fontSize={14}
      streamingText=""
      hasContent
      contentParts={[
        {
          type: 'tool-invocation',
          toolCallId: 'a',
          toolName: 'Read',
          args: { file_path: 'a.ts' },
          state: 'completed',
        },
        {
          type: 'tool-invocation',
          toolCallId: 'b',
          toolName: 'Bash',
          args: { command: 'npm test' },
          state: 'running',
          progressMessage: 'still going',
        },
      ]}
      contentRevision={1}
      renderToolCall={(part, index) => (
        <div key={index}>{String(part.toolName ?? part.name)}</div>
      )}
    />,
  );
  expect(
    await screen.findByRole('button', { name: /Running npm test/ }),
  ).toBeTruthy();
  const progress = screen.getAllByText('still going');
  expect(progress).toHaveLength(1);
  expect(progress[0].className).toContain('tool-call__progress');
  expect(document.querySelector('.streaming-progress')).toBeNull();
});
