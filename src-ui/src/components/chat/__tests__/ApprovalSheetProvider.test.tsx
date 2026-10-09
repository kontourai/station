// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PendingApprovalRequest } from '../../../hooks/orchestration/pendingRequestRows';
import { REVEAL_APPROVAL_EVENT } from '../../status/approvalReveal';
import { ApprovalSheetProvider } from '../ApprovalSheetProvider';
import { ToolCallDisplay } from '../ToolCallDisplay';

const transport = vi.hoisted(() => ({ resolve: vi.fn(), inspect: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  resolveOrchestrationRequest: transport.resolve,
  inspectAttentionRequest: transport.inspect,
}));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => true }));
afterEach(cleanup);

function request(id: string): PendingApprovalRequest {
  return {
    type: 'tool-invocation',
    toolName: 'Bash',
    args: { command: `echo ${id}\nprintf done` },
    needsApproval: true,
    state: 'awaiting-approval',
    approvalId: id,
    approvalThreadId: 'approval-sheet-thread',
    approvalEventId: `event-${id}`,
  };
}

describe('the conversation approval sheet', () => {
  test('opens all current requests together and answers only the selected request', async () => {
    const requests = [request('group-first'), request('group-second')];
    const approve = vi.fn(async () => 'answered' as const);
    render(
      <ApprovalSheetProvider requests={requests} onApprove={approve}>
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'Needs approval (2)',
    });
    expect(
      within(sheet).getByText(/^echo group-first\s+printf done$/),
    ).toBeTruthy();
    expect(
      within(sheet).getByText(/^echo group-second\s+printf done$/),
    ).toBeTruthy();
    fireEvent.click(
      within(sheet).getAllByRole('button', { name: 'Allow Once' })[1],
    );
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(requests[1], 'once'),
    );
    expect(approve).toHaveBeenCalledTimes(1);
    expect(
      within(sheet)
        .getAllByRole('button', { name: 'Allow Once' })[0]
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  test('remembers dismissal across remounts, explicitly reopens, and opens a new prompt', async () => {
    const first = request('dismissed-first');
    const approve = vi.fn(async () => 'answered' as const);
    const tree = (requests: PendingApprovalRequest[]) => (
      <ApprovalSheetProvider requests={requests} onApprove={approve}>
        <ToolCallDisplay toolCall={first} onApprove={() => approve()} />
      </ApprovalSheetProvider>
    );
    const mounted = render(tree([first]));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Close and answer later',
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    mounted.unmount();
    const remounted = render(tree([first]));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    const reopened = await screen.findByRole('dialog');
    fireEvent.click(
      within(reopened).getByRole('button', { name: 'Close and answer later' }),
    );
    window.dispatchEvent(
      new CustomEvent(REVEAL_APPROVAL_EVENT, {
        detail: {
          requestId: first.approvalId,
          threadId: first.approvalThreadId,
        },
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Close and answer later',
      }),
    );
    remounted.rerender(tree([first, request('new-after-dismissal')]));
    expect(
      await screen.findByRole('dialog', { name: 'Needs approval (2)' }),
    ).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
  });

  test('keeps a sending decision and its late failure across dismissal', async () => {
    const pending = request('dismiss-while-sending');
    let rejectDecision!: (error: Error) => void;
    const approve = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectDecision = reject;
        }),
    );
    render(
      <ApprovalSheetProvider requests={[pending]} onApprove={approve}>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(REVEAL_APPROVAL_EVENT, {
                detail: {
                  requestId: pending.approvalId,
                  threadId: pending.approvalThreadId,
                },
              }),
            )
          }
        >
          Reopen approvals
        </button>
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Close and answer later' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen approvals' }));
    expect(
      within(await screen.findByRole('dialog'))
        .getByRole('button', { name: 'Allowing…' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Close and answer later' }),
    );
    rejectDecision(new Error('Connection refused'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'A decision needs attention',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open approvals' }));
    expect(await within(sheet).findByRole('alert')).toBeTruthy();
    expect(approve).toHaveBeenCalledTimes(1);
  });

  test('checking from the transcript recovers the same kept-mounted grouped card', async () => {
    const pending = request('cross-surface-recovery');
    const reference = {
      threadId: pending.approvalThreadId!,
      requestId: pending.approvalId!,
      requestEventId: pending.approvalEventId!,
    };
    const apiBase = 'http://cross-surface.test';
    const {
      answerOrchestrationRequest,
      inspectApprovalAnswer,
      forgetApprovalAnswer,
    } = await import('../../../hooks/orchestration/answerRequest');
    forgetApprovalAnswer(reference.threadId, reference.requestId);
    transport.resolve
      .mockReset()
      .mockRejectedValue(new TypeError('Reply lost'));
    transport.inspect
      .mockReset()
      .mockRejectedValue(new Error('Inspection unavailable'));
    const approve = () =>
      answerOrchestrationRequest(apiBase, { ...reference, decision: 'accept' });
    render(
      <ApprovalSheetProvider
        apiBase={apiBase}
        requests={[pending]}
        onApprove={approve}
        onCheck={() => inspectApprovalAnswer(apiBase, reference)}
      >
        <ToolCallDisplay toolCall={pending} onApprove={approve} />
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Allow Once' }));
    await within(sheet).findByText(/Delivery is not confirmed/);
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Close and answer later' }),
    );
    transport.inspect.mockResolvedValue({ state: 'open', canRespond: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    const reopened = await screen.findByRole('dialog');
    expect(
      within(reopened)
        .getByRole('button', { name: 'Allow Once' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(within(reopened).queryByRole('alert')).toBeNull();
    expect(transport.resolve).toHaveBeenCalledTimes(1);
    forgetApprovalAnswer(reference.threadId, reference.requestId);
  });

  test('leaves both decisions available after a transport refusal and exposes details', async () => {
    const approve = vi.fn(async () => {
      throw Object.assign(new Error('Station host could not be resolved.'), {
        code: 'transport_dns',
      });
    });
    render(
      <ApprovalSheetProvider
        requests={[request('refused')]}
        onApprove={approve}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Allow Once' }));
    const error = await within(sheet).findByRole('alert');
    expect(error.textContent).toContain(
      'Station address could not be resolved',
    );
    expect(within(error).getByText('Details')).toBeTruthy();
    expect(
      within(sheet)
        .getByRole('button', { name: 'Allow Once' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(
      within(sheet)
        .getByRole('button', { name: 'Deny' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
