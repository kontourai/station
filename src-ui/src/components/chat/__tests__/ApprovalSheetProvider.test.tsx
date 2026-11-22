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
import { forgetSettledRequests } from '../../../hooks/orchestration/heldDuringCatchUp';
import type { PendingApprovalRequest } from '../../../hooks/orchestration/pendingRequestRows';
import { REVEAL_APPROVAL_EVENT } from '../../status/approvalReveal';
import { ApprovalSheetProvider } from '../ApprovalSheetProvider';
import { ToolCallDisplay } from '../ToolCallDisplay';

const transport = vi.hoisted(() => ({ resolve: vi.fn(), inspect: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  resolveOrchestrationRequest: transport.resolve,
  inspectAttentionRequest: transport.inspect,
}));
vi.mock('../../../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useIsMobile')>()),
  useIsMobile: () => true,
}));
afterEach(() => {
  cleanup();
  forgetSettledRequests();
});

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
      within(sheet).getAllByRole('button', { name: 'Allow once' })[1],
    );
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(requests[1], 'once'),
    );
    expect(approve).toHaveBeenCalledTimes(1);
    expect(
      within(sheet)
        .getAllByRole('button', { name: 'Allow once' })[0]
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  // A view whose stream missed a resolution still lists the settled request.
  // Answering it got "no longer open" under live Deny / Allow once buttons,
  // and the sheet kept it as the request to answer while the one actually
  // blocking the turn was not on it.
  test('a request Station reports already settled leaves the sheet and its count, and the view catches up', async () => {
    const stale = request('settled-elsewhere');
    const open = request('still-open');
    const approve = vi.fn(async (answered: PendingApprovalRequest) =>
      answered === stale ? ('already-settled' as const) : ('answered' as const),
    );
    const settledElsewhere = vi.fn();
    render(
      <ApprovalSheetProvider
        requests={[stale, open]}
        onApprove={approve}
        onSettledElsewhere={settledElsewhere}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'Needs approval (2)',
    });
    fireEvent.click(
      within(sheet).getAllByRole('button', { name: 'Allow once' })[0],
    );
    await waitFor(() => expect(settledElsewhere).toHaveBeenCalledWith(stale));
    const updated = await screen.findByRole('dialog', {
      name: 'Needs approval',
    });
    expect(within(updated).queryByText(/echo settled-elsewhere/)).toBeNull();
    expect(
      within(updated).getByText(/^echo still-open\s+printf done$/),
    ).toBeTruthy();
    expect(within(updated).queryByText('Already answered.')).toBeNull();
    expect(
      within(updated)
        .getByRole('button', { name: 'Allow once' })
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
    fireEvent.click(within(sheet).getByRole('button', { name: 'Allow once' }));
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

  test.each(['open', 'resolved'] as const)(
    'checking %s from the transcript updates the kept-mounted grouped card',
    async (state) => {
      const pending = request(`cross-surface-recovery-${state}`);
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
        answerOrchestrationRequest(apiBase, {
          ...reference,
          decision: 'accept',
        });
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
      fireEvent.click(
        within(sheet).getByRole('button', { name: 'Allow once' }),
      );
      await within(sheet).findByText(/Delivery is not confirmed/);
      fireEvent.click(
        within(sheet).getByRole('button', { name: 'Close and answer later' }),
      );
      transport.inspect.mockResolvedValue(
        state === 'open'
          ? { state: 'open', canRespond: true }
          : { state: 'resolved' },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Check status' }),
        ).toBeNull(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
      const reopened = await screen.findByRole('dialog');
      expect(
        within(reopened)
          .getByRole('button', { name: 'Allow once' })
          .hasAttribute('disabled'),
      ).toBe(state === 'resolved');
      if (state === 'resolved')
        expect(within(reopened).getByText('Already answered.')).toBeTruthy();
      expect(within(reopened).queryByRole('alert')).toBeNull();
      expect(transport.resolve).toHaveBeenCalledTimes(1);
      forgetApprovalAnswer(reference.threadId, reference.requestId);
    },
  );

  // Seen live: after a reconnect, nine requests answered 24 minutes earlier
  // still filled the sheet, each "no longer open" only once answered again.
  test('opening the sheet asks Station about each request and drops the settled ones', async () => {
    const stale = request('opened-stale');
    const live = request('opened-live');
    const check = vi.fn(async (asked: PendingApprovalRequest) =>
      asked === stale ? ('already-settled' as const) : ('pending' as const),
    );
    render(
      <ApprovalSheetProvider
        requests={[stale, live]}
        onApprove={vi.fn(async () => 'answered' as const)}
        onCheck={check}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'Needs approval',
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(within(sheet).queryByText(/echo opened-stale/)).toBeNull();
    expect(
      within(sheet).getByText(/^echo opened-live\s+printf done$/),
    ).toBeTruthy();
  });

  test('a failed check never hides a request', async () => {
    render(
      <ApprovalSheetProvider
        requests={[request('check-fails'), request('check-fails-2')]}
        onApprove={vi.fn(async () => 'answered' as const)}
        onCheck={vi.fn(async () => {
          throw new Error('offline');
        })}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    expect(
      await screen.findByRole('dialog', { name: 'Needs approval (2)' }),
    ).toBeTruthy();
  });

  test('Allow all answers every listed approval once, and per session from its menu', async () => {
    const requests = [request('bulk-a'), request('bulk-b'), request('bulk-c')];
    const approve = vi.fn(async () => 'answered' as const);
    render(
      <ApprovalSheetProvider requests={requests} onApprove={approve}>
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'Needs approval (3)',
    });
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Allow all (3)' }),
    );
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(3));
    for (const listed of requests)
      expect(approve).toHaveBeenCalledWith(listed, 'once');

    approve.mockClear();
    fireEvent.click(
      within(sheet).getByRole('button', {
        name: 'More ways to allow every request',
      }),
    );
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Allow all for this session',
      }),
    );
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(3));
    for (const listed of requests)
      expect(approve).toHaveBeenCalledWith(listed, 'trust');
  });

  test('one refused answer does not stop Allow all', async () => {
    const requests = [request('bulk-refused'), request('bulk-after')];
    const approve = vi.fn(async (answered: PendingApprovalRequest) => {
      if (answered === requests[0]) throw new Error('refused');
      return 'answered' as const;
    });
    render(
      <ApprovalSheetProvider requests={requests} onApprove={approve}>
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Allow all (2)',
      }),
    );
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(requests[1], 'once'),
    );
  });

  test('a single request offers no Allow all', async () => {
    render(
      <ApprovalSheetProvider
        requests={[request('bulk-single')]}
        onApprove={vi.fn(async () => 'answered' as const)}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>,
    );
    const sheet = await screen.findByRole('dialog');
    expect(
      within(sheet).queryByRole('button', { name: /Allow all/ }),
    ).toBeNull();
  });

  // A reconnect replays missed events one at a time: requests opened and
  // resolved in the gap ran the count up and back down.
  test('holds what it shows while the stream catches up, then follows it', async () => {
    const first = request('held-first');
    const tree = (requests: PendingApprovalRequest[], catchingUp: boolean) => (
      <ApprovalSheetProvider
        requests={requests}
        catchingUp={catchingUp}
        onApprove={vi.fn(async () => 'answered' as const)}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>
    );
    // The first connection catches up and finishes: nothing is held then.
    const mounted = render(tree([], true));
    mounted.rerender(tree([first], true));
    mounted.rerender(tree([first], false));
    await screen.findByRole('dialog', { name: 'Needs approval' });
    // A reconnect replays the gap: what was shown stays put.
    mounted.rerender(
      tree([first, request('replayed-1'), request('replayed-2')], true),
    );
    expect(screen.getByRole('dialog', { name: 'Needs approval' })).toBeTruthy();
    mounted.rerender(tree([first], true));
    mounted.rerender(tree([first, request('after-replay')], false));
    expect(
      await screen.findByRole('dialog', { name: 'Needs approval (2)' }),
    ).toBeTruthy();
  });

  // The first connection also replays before it is caught up; holding then
  // hid what was already waiting (the pill and the sheet showed nothing).
  test('the first connection does not hold: requests show while it catches up', async () => {
    const tree = (requests: PendingApprovalRequest[]) => (
      <ApprovalSheetProvider
        requests={requests}
        catchingUp
        onApprove={vi.fn(async () => 'answered' as const)}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>
    );
    // The view mounts empty, then the first replay brings the requests in.
    const mounted = render(tree([]));
    mounted.rerender(tree([request('first-load-a'), request('first-load-b')]));
    // Well inside the hold's 5 s cap: a held list would still be empty here.
    expect(
      await screen.findByRole(
        'dialog',
        { name: 'Needs approval (2)' },
        { timeout: 1_000 },
      ),
    ).toBeTruthy();
  });

  // The live stream starts "unknown", turns "receiving" on its first frame,
  // and a stream that never reports catching up stays there. That is not a
  // reconnect: what arrives must show (the e2e smoke's live-emit shape).
  test('a stream that starts receiving after idle, never caught up, does not hold', async () => {
    const tree = (requests: PendingApprovalRequest[], catchingUp: boolean) => (
      <ApprovalSheetProvider
        requests={requests}
        catchingUp={catchingUp}
        onApprove={vi.fn(async () => 'answered' as const)}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>
    );
    const mounted = render(tree([], false));
    mounted.rerender(tree([], true));
    mounted.rerender(tree([request('live-1'), request('live-2')], true));
    expect(
      await screen.findByRole(
        'dialog',
        { name: 'Needs approval (2)' },
        { timeout: 1_000 },
      ),
    ).toBeTruthy();
  });

  test('a failed check is not retried on every render, only on the next opening', async () => {
    const check = vi.fn(async () => {
      throw new Error('offline');
    });
    const tree = (requests: PendingApprovalRequest[]) => (
      <ApprovalSheetProvider
        requests={requests}
        onApprove={vi.fn(async () => 'answered' as const)}
        onCheck={check}
      >
        <span>Conversation</span>
      </ApprovalSheetProvider>
    );
    const first = request('retry-once');
    const mounted = render(tree([first]));
    await screen.findByRole('dialog');
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 3; i++) mounted.rerender(tree([first]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(check).toHaveBeenCalledTimes(1);
  });

  describe('each choice in the sheet sends its own action', () => {
    const PREFIX = 'Allow "echo *" for this session';
    const WHOLE = 'Allow all Bash commands for this session';
    const BROWSER_TOOL =
      'Allow all station-browser.browser_click calls for this session';
    const BROWSER_SERVER = 'Allow the Station browser for this session';
    /** A Bash ask offering the prefix and whole-tool grants, as projected. */
    const bashAsk = (): PendingApprovalRequest => ({
      ...request('sheet-bash'),
      approvalToolName: 'Bash',
      approvalSessionGrant: 'tool',
      approvalRuleGrant: { rules: ['echo *'], label: PREFIX },
    });
    /** An authentic Station browser call, as projected. */
    const browserCall = (): PendingApprovalRequest => ({
      ...request('sheet-browser'),
      toolName: 'mcp__station-browser__browser_click',
      args: { ref: 'e1' },
      approvalToolName: 'mcp__station-browser__browser_click',
      approvalSessionGrant: 'tool',
      approvalServerGrant: 'server',
    });

    test.each([
      ['Deny', 'deny', bashAsk],
      ['Allow once', 'once', bashAsk],
      [PREFIX, 'trust-rule', bashAsk],
      [WHOLE, 'trust', bashAsk],
      [BROWSER_TOOL, 'trust', browserCall],
      [BROWSER_SERVER, 'trust-server', browserCall],
    ] as const)('"%s" sends %s', async (label, action, make) => {
      const pending = make();
      const approve = vi.fn(async () => 'answered' as const);
      render(
        <ApprovalSheetProvider requests={[pending]} onApprove={approve}>
          <span>Conversation</span>
        </ApprovalSheetProvider>,
      );
      const sheet = await screen.findByRole('dialog');
      const button = within(sheet).queryByRole('button', { name: label });
      if (button) fireEvent.click(button);
      else {
        fireEvent.click(
          within(sheet).getByRole('button', { name: 'Allow for this session' }),
        );
        fireEvent.click(await screen.findByRole('menuitem', { name: label }));
      }
      await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
      expect(approve).toHaveBeenCalledWith(pending, action);
    });

    test('Escape closes the grant menu only: the sheet stays open and focus returns to the trigger', async () => {
      render(
        <ApprovalSheetProvider
          requests={[bashAsk()]}
          onApprove={vi.fn(async () => 'answered' as const)}
        >
          <span>Conversation</span>
        </ApprovalSheetProvider>,
      );
      const sheet = await screen.findByRole('dialog');
      const trigger = within(sheet).getByRole('button', {
        name: 'Allow for this session',
      });
      fireEvent.click(trigger);
      const [first] = await screen.findAllByRole('menuitem');
      first.focus();
      fireEvent.keyDown(first, { key: 'Escape' });
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
      expect(screen.getByRole('dialog')).toBe(sheet);
      expect(document.activeElement).toBe(trigger);
    });

    test('a grant the request did not offer is not in the menu', async () => {
      render(
        <ApprovalSheetProvider
          requests={[{ ...bashAsk(), approvalRuleGrant: undefined }]}
          onApprove={vi.fn(async () => 'answered' as const)}
        >
          <span>Conversation</span>
        </ApprovalSheetProvider>,
      );
      const sheet = await screen.findByRole('dialog');
      fireEvent.click(
        within(sheet).getByRole('button', { name: 'Allow for this session' }),
      );
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((item) => item.textContent)).toEqual([WHOLE]);
    });
  });

  test('leaves both decisions available after a transport failure with safe recovery copy', async () => {
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
    fireEvent.click(within(sheet).getByRole('button', { name: 'Allow once' }));
    const error = await within(sheet).findByRole('alert');
    expect(error.textContent).toContain(
      'Could not reach Station. Check the connection, then try again.',
    );
    expect(error.textContent).not.toContain(
      'Station host could not be resolved',
    );
    expect(within(error).queryByText('Details')).toBeNull();
    expect(
      within(sheet)
        .getByRole('button', { name: 'Allow once' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(
      within(sheet)
        .getByRole('button', { name: 'Deny' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
