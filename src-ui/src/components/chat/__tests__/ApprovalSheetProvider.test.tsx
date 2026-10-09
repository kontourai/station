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
