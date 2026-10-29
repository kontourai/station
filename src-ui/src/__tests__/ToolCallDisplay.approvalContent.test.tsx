/**
 * @vitest-environment jsdom
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * docs/design/event-content-spill.md: an approval whose content was stored
 * out of line offers Allow only once the card has loaded all of it. The SDK
 * query is replaced by a controllable state; everything else is the real
 * card.
 */
const query = vi.hoisted(() => ({
  state: {} as {
    data?: unknown;
    isError?: boolean;
  },
  refetch: vi.fn(),
  inputs: [] as unknown[],
}));
vi.mock('@kontourai/station-sdk/runtime-event-content', () => ({
  useApprovalContentQuery: (input: unknown) => ({
    ...(query.inputs.push(input) ? {} : {}),
    data: query.state.data,
    isError: query.state.isError ?? false,
    refetch: query.refetch,
  }),
}));
const recorded = vi.hoisted(() => vi.fn());
vi.mock('../hooks/orchestration/answerRequest', async (original) => ({
  ...(await original<typeof import('../hooks/orchestration/answerRequest')>()),
  recordViewedContentDigest: recorded,
}));

const { ToolCallDisplay } = await import('../components/chat/ToolCallDisplay');

const ref = {
  $stationContent: 1,
  ref: `sha256-${'b'.repeat(64)}`,
  kind: 'string',
  bytes: 200_000,
  length: 200_000,
  preview: 'const x = 1;',
};
const request = {
  eventId: 'open-big',
  provider: 'claude',
  threadId: 'thread-1',
  createdAt: '2026-10-26T00:00:00.000Z',
  requestId: 'req-big',
  method: 'request.opened',
  requestType: 'approval',
  title: 'Allow Write',
  spilledContent: { v: 1, count: 1, bytes: 200_000 },
  payload: {
    toolName: 'Write',
    toolCallId: 'toolu_1',
    toolInput: { file_path: '/repo/big.ts', content: ref },
    suggestions: [],
  },
} as unknown as CanonicalRuntimeEvent;

const card = () =>
  render(
    <ToolCallDisplay
      toolCall={{
        type: 'tool-invocation',
        toolCallId: 'toolu_1',
        toolName: 'Write',
        args: { file_path: '/repo/big.ts', content: ref },
        needsApproval: true,
        state: 'awaiting-approval',
        approvalId: 'req-big',
        approvalThreadId: 'thread-1',
        approvalEventId: 'open-big',
        approvalContentEvent: request,
      }}
      onApprove={vi.fn()}
    />,
  );

describe('approval card whose bound call arrived spilled after the request', () => {
  test('offers only Deny while loading, though the request itself was not spilled', () => {
    query.state = {};
    query.inputs = [];
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'toolu_1',
          toolName: 'Write',
          args: { file_path: '/repo/big.ts', content: ref },
          needsApproval: true,
          state: 'awaiting-approval',
          approvalId: 'req-big',
          approvalThreadId: 'thread-1',
          approvalEventId: 'open-big',
        }}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });
});

describe('approval card with content stored out of line', () => {
  beforeEach(() => {
    query.state = {};
    query.inputs = [];
    recorded.mockClear();
  });

  test('offers only Deny while the full request loads', () => {
    card();
    expect(screen.getByRole('status').textContent).toContain(
      'Loading the full request',
    );
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });

  test('offers retry, and still no Allow, when the load fails', () => {
    query.state = { isError: true };
    card();
    expect(
      screen.getByText('The full request could not be loaded'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(query.refetch).toHaveBeenCalled();
  });

  test('shows the whole content and offers Allow once loaded', () => {
    const content = 'const x = 1;\n'.repeat(2_000);
    query.state = {
      data: {
        request: {
          ...request,
          payload: {
            ...(request as { payload: Record<string, unknown> }).payload,
            toolInput: { file_path: '/repo/big.ts', content },
          },
        },
        args: { file_path: '/repo/big.ts', content },
        required: true,
        viewedContentDigest: `sha256-${'c'.repeat(64)}`,
      },
    };
    const view = card();
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeTruthy();
    expect(recorded).toHaveBeenCalledWith(
      'thread-1',
      'open-big',
      `sha256-${'c'.repeat(64)}`,
    );
    // The details show the loaded value, not the reference's preview.
    const details = view.container.querySelector('.tool-call__details');
    expect(details?.textContent).toContain('const x = 1;');
    expect(details?.textContent).not.toContain('$stationContent');
  });

  test('asks the server binding by request, keyed on the references the row shows', () => {
    const view = card();
    expect(query.inputs.at(-1)).toMatchObject({
      threadId: 'thread-1',
      requestId: 'req-big',
      requestEventId: 'open-big',
      shownRefs: [ref.ref],
    });
    // A later bound tool.started with other references changes the key, so
    // the binding (and its digest) is fetched again rather than kept stale.
    const later = { ...ref, ref: `sha256-${'e'.repeat(64)}` };
    view.rerender(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'toolu_1',
          toolName: 'Write',
          args: { file_path: '/repo/big.ts', content: later },
          needsApproval: true,
          state: 'awaiting-approval',
          approvalId: 'req-big',
          approvalThreadId: 'thread-1',
          approvalEventId: 'open-big',
          approvalContentEvent: request,
        }}
        onApprove={vi.fn()}
      />,
    );
    expect(query.inputs.at(-1)).toMatchObject({ shownRefs: [later.ref] });
  });

  test('a server refusal for unloaded content makes a row with no reference load it', async () => {
    const { requestContentRefreshForTest } = await import(
      '../hooks/orchestration/answerRequest'
    );
    const view = render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'fc-1',
          toolName: 'apply_patch',
          args: { changes: 'small' },
          needsApproval: true,
          state: 'awaiting-approval',
          approvalId: 'req-fc',
          approvalThreadId: 'thread-1',
          approvalEventId: 'open-fc',
        }}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeTruthy();
    expect(query.inputs).toHaveLength(0);
    act(() => requestContentRefreshForTest('thread-1', 'open-fc'));
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
    expect(query.inputs.at(-1)).toMatchObject({ requestId: 'req-fc' });
    view.unmount();
  });
});
