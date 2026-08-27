/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The approval popover's restores are scheduled on the next frame (they have
 * to be: the outside-pointerdown path fires before the browser has moved focus
 * to whatever was tapped). Give that frame room, the way the
 * `ResponsiveDialogSurface` suite does.
 */
async function flushRestore() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const dismissToast = vi.fn();
const dismissAllToasts = vi.fn();
const setProject = vi.fn();
const setLayout = vi.fn();
const navigate = vi.fn();
let notifications: Array<Record<string, unknown>> = [];

vi.mock('../contexts/ToastContext', () => ({
  useNotificationHistory: () => notifications,
  useToast: () => ({
    dismissToast,
    dismissAllToasts,
  }),
}));

vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => ({
    'session-1': {},
  }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    setProject,
    setLayout,
    // Must be the module-level spy, not a fresh `vi.fn()` per render: the
    // navigateTo assertions below inspect `navigate`, and handing the component
    // a throwaway mock made them unfalsifiable (they asserted 0 calls forever).
    navigate,
  }),
}));

import { NotificationContainer } from '../components/notifications/NotificationContainer';

describe('NotificationContainer', () => {
  beforeEach(() => {
    dismissToast.mockClear();
    dismissAllToasts.mockClear();
    setProject.mockClear();
    setLayout.mockClear();
    notifications = [
      {
        id: 'tool-1',
        message: 'Dev Agent failed shell exec',
        type: 'tool-activity',
        timestamp: Date.now(),
        dismissed: false,
        conversationTitle: 'Repo Chat',
        sessionId: 'session-1',
        metadata: { detail: 'Permission denied' },
      },
    ];
  });

  test('renders tool activity toasts with their label and detail', () => {
    render(<NotificationContainer />);

    expect(screen.getByText('Tool Activity')).toBeTruthy();
    expect(screen.getByText('Dev Agent failed shell exec')).toBeTruthy();
    expect(screen.getByText('Permission denied')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss notification' }),
    );
    expect(dismissToast).toHaveBeenCalledWith('tool-1');
  });

  test('renders View and routes a notification navigateTo action', () => {
    notifications = [
      {
        id: 'rss-1',
        message: 'New article in Tech Feed',
        type: 'info',
        timestamp: Date.now(),
        dismissed: false,
        metadata: {
          navigateTo: { project: 'research', layout: 'rss-reader' },
        },
      },
    ];

    render(<NotificationContainer />);

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(navigate).toHaveBeenCalledWith(
      '/projects/research/layouts/rss-reader',
    );
    expect(dismissToast).toHaveBeenCalledWith('rss-1');
  });

  test('keeps approvals in a compact queue until the user opens it', () => {
    const allowOnce = vi.fn();
    const deny = vi.fn();
    notifications = [
      {
        id: 'approval-1',
        message: 'Codex wants to use shell exec',
        type: 'tool-approval',
        timestamp: Date.now(),
        dismissed: false,
        actions: [
          { label: 'Allow Once', variant: 'primary', onClick: allowOnce },
          { label: 'Deny', variant: 'danger', onClick: deny },
        ],
      },
      {
        id: 'approval-2',
        message: 'Claude wants to use browser',
        type: 'tool-approval',
        timestamp: Date.now(),
        dismissed: false,
        actions: [],
      },
    ];

    render(<NotificationContainer />);

    const queueTrigger = screen.getByRole('button', {
      name: '2 pending approvals',
    });
    const queuePanel = screen.getByRole('region', {
      name: 'Pending approvals',
    });
    expect(queuePanel.tagName).toBe('SECTION');
    expect(queuePanel.id).toBe('notification-approval-panel');
    expect(queueTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(queuePanel.className).not.toContain('is-open');

    fireEvent.click(queueTrigger);

    expect(queueTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(queuePanel.className).toContain('is-open');
    expect(screen.getByText('Codex wants to use shell exec')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    expect(allowOnce).toHaveBeenCalledOnce();
    expect(dismissToast).toHaveBeenCalledWith('approval-1');
  });

  test('collapses an open approval queue on Escape or an outside tap', async () => {
    notifications = [
      {
        id: 'approval-1',
        message: 'Codex wants to use shell exec',
        type: 'tool-approval',
        timestamp: Date.now(),
        dismissed: false,
        actions: [],
      },
    ];

    render(
      <div>
        <button type="button">Outside</button>
        <NotificationContainer />
      </div>,
    );

    const queueTrigger = screen.getByRole('button', {
      name: '1 pending approval',
    });
    // Focus has to be moved *into* the open panel before each close, or the
    // assertions below pass on a trigger that simply never lost focus — which
    // is exactly how a version of this test survived a build with no restore
    // wired in at all.
    const focusInsidePanel = () =>
      screen.getByRole('button', { name: 'Dismiss approval alert' }).focus();

    queueTrigger.focus();
    fireEvent.click(queueTrigger);
    focusInsidePanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queueTrigger.getAttribute('aria-expanded')).toBe('false');
    await flushRestore();
    expect(document.activeElement).toBe(queueTrigger);

    // station#1259: a tap on non-focusable chrome closed the popover and left
    // focus stranded on whatever the panel had — in a browser, on `<body>`.
    fireEvent.click(queueTrigger);
    focusInsidePanel();
    fireEvent.pointerDown(document.body);
    expect(queueTrigger.getAttribute('aria-expanded')).toBe('false');
    await flushRestore();
    expect(document.activeElement).toBe(queueTrigger);

    // …but a tap that landed on a real control keeps that control
    // (station#1206 gap 1). This is the assertion that stops the fix from
    // becoming focus theft on the pointer path.
    fireEvent.click(queueTrigger);
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(queueTrigger.getAttribute('aria-expanded')).toBe('false');
    await flushRestore();
    expect(document.activeElement).toBe(outside);
  });

  /**
   * station#1259, the case that made this popover worse than an ordinary
   * bypass: approving the last pending request empties `approvals`, which
   * unmounts the queue element *and the trigger inside it*. Nothing restored
   * on that path at all — focus was left on `<body>`, station#1126's outcome,
   * from the surface's own primary action.
   *
   * jsdom proves this half: it is about a node being removed from the document
   * and the walk continuing to an ancestor, both of which jsdom models
   * faithfully. What jsdom cannot prove — that an ancestor which is present but
   * cannot hold focus is skipped — is the browser half, covered by
   * `tests/dialog-return-focus.spec.ts` for the shared module and by
   * `tests/orchestration-chat-flow.spec.ts` for this surface.
   */
  test('restores past the trigger its own approval destroyed', async () => {
    const allowOnce = vi.fn();
    notifications = [
      {
        id: 'approval-1',
        message: 'Codex wants to use shell exec',
        type: 'tool-approval',
        timestamp: Date.now(),
        dismissed: false,
        actions: [
          { label: 'Allow Once', variant: 'primary', onClick: allowOnce },
        ],
      },
      {
        id: 'info-1',
        message: 'Build finished',
        type: 'info',
        timestamp: Date.now(),
        dismissed: false,
      },
    ];

    const { rerender } = render(<NotificationContainer />);
    const queueTrigger = screen.getByRole('button', {
      name: '1 pending approval',
    });
    queueTrigger.focus();
    fireEvent.click(queueTrigger);

    const allow = screen.getByRole('button', { name: 'Allow Once' });
    allow.focus();
    fireEvent.click(allow);
    expect(dismissToast).toHaveBeenCalledWith('approval-1');

    // What `ToastContext` does with that dismissal, applied to the store the
    // component reads.
    notifications = notifications.filter((item) => item.id !== 'approval-1');
    act(() => {
      rerender(<NotificationContainer />);
    });
    expect(
      screen.queryByRole('button', { name: '1 pending approval' }),
    ).toBeNull();
    expect(queueTrigger.isConnected).toBe(false);

    await flushRestore();
    const container = document.querySelector('.notification-container');
    expect(container).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(container);
  });

  /**
   * The same path when the approval was the only notification: the container
   * returns `null` too, so the walk has to carry on past it. This is the case a
   * fallback that stopped at the component's own root would fail.
   */
  test('walks past the container when the approval was the last notification', async () => {
    notifications = [
      {
        id: 'approval-1',
        message: 'Codex wants to use shell exec',
        type: 'tool-approval',
        timestamp: Date.now(),
        dismissed: false,
        actions: [{ label: 'Deny', variant: 'danger', onClick: vi.fn() }],
      },
    ];

    const { container, rerender } = render(<NotificationContainer />);
    const queueTrigger = screen.getByRole('button', {
      name: '1 pending approval',
    });
    queueTrigger.focus();
    fireEvent.click(queueTrigger);
    const deny = screen.getByRole('button', { name: 'Deny' });
    deny.focus();
    fireEvent.click(deny);

    notifications = [];
    act(() => {
      rerender(<NotificationContainer />);
    });
    expect(document.querySelector('.notification-container')).toBeNull();

    await flushRestore();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(container);
  });

  test('dismisses transient notifications without hiding pending approvals', () => {
    notifications = [
      {
        id: 'approval-1',
        message: 'Codex wants to use shell exec',
        type: 'tool-approval',
        timestamp: Date.now(),
        dismissed: false,
        actions: [],
      },
      ...['info-1', 'info-2', 'info-3'].map((id) => ({
        id,
        message: id,
        type: 'info',
        timestamp: Date.now(),
        dismissed: false,
      })),
    ];

    render(<NotificationContainer />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss notifications (3)' }),
    );

    expect(dismissToast.mock.calls).toEqual([
      ['info-1'],
      ['info-2'],
      ['info-3'],
    ]);
    expect(dismissAllToasts).not.toHaveBeenCalled();
  });

  test('stacks multiple transient toasts and marks behind cards collapsed', () => {
    notifications = ['a', 'b', 'c'].map((id) => ({
      id,
      message: `msg-${id}`,
      type: 'info',
      timestamp: Date.now(),
      dismissed: false,
    }));

    render(<NotificationContainer />);

    const stack = screen.getByTestId('toast-stack');
    expect(stack.getAttribute('data-count')).toBe('3');
    expect(stack.querySelectorAll('[data-front="true"]')).toHaveLength(1);
    expect(stack.querySelectorAll('[data-front="false"]')).toHaveLength(2);
    expect(screen.getAllByTestId('toast-card-collapsed')).toHaveLength(2);
  });

  test('card body activates onNavigate once; action buttons do not', () => {
    const onNavigate = vi.fn();
    const secondary = vi.fn();
    notifications = [
      {
        id: 'nav-1',
        message: 'Build finished',
        type: 'info',
        timestamp: Date.now(),
        dismissed: false,
        onNavigate,
        actions: [{ label: 'Retry', variant: 'secondary', onClick: secondary }],
      },
    ];

    render(<NotificationContainer />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(secondary).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(dismissToast).toHaveBeenCalledWith('nav-1');

    dismissToast.mockClear();
    notifications = [
      {
        id: 'nav-2',
        message: 'Build finished again',
        type: 'info',
        timestamp: Date.now(),
        dismissed: false,
        onNavigate,
      },
    ];
    render(<NotificationContainer />);
    fireEvent.click(screen.getByText('Build finished again'));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(dismissToast).toHaveBeenCalledWith('nav-2');
  });

  test('a coarse-pointer tap expands the stack instead of activating the front card', () => {
    // (hover: hover) does not match → a device that cannot hover, where CSS
    // :hover expansion can never fire (station#3308, #1960 follow-up).
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const onNavigate = vi.fn();
    notifications = ['a', 'b', 'c'].map((id) => ({
      id,
      message: `msg-${id}`,
      type: 'info',
      timestamp: Date.now(),
      dismissed: false,
      onNavigate,
    }));

    render(<NotificationContainer />);
    const stack = screen.getByTestId('toast-stack');
    expect(stack.hasAttribute('data-expanded')).toBe(false);

    // First tap: expand, never navigate.
    fireEvent.click(screen.getByTestId('toast-card'));
    expect(stack.getAttribute('data-expanded')).toBe('true');
    expect(onNavigate).not.toHaveBeenCalled();

    // Expanded: a tap on a card acts normally.
    fireEvent.click(screen.getByTestId('toast-card'));
    expect(onNavigate).toHaveBeenCalledOnce();

    // Outside tap collapses.
    fireEvent.pointerDown(document.body);
    expect(stack.hasAttribute('data-expanded')).toBe(false);

    // Escape collapses too.
    fireEvent.click(screen.getByTestId('toast-card'));
    expect(stack.getAttribute('data-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(stack.hasAttribute('data-expanded')).toBe(false);

    vi.unstubAllGlobals();
  });

  test('a hover-capable pointer keeps click-to-activate on the front card', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const onNavigate = vi.fn();
    notifications = ['a', 'b'].map((id) => ({
      id,
      message: `msg-${id}`,
      type: 'info',
      timestamp: Date.now(),
      dismissed: false,
      onNavigate,
    }));

    render(<NotificationContainer />);
    fireEvent.click(screen.getByTestId('toast-card'));
    // Hover already expands via CSS; the click must keep meaning "activate".
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(
      screen.getByTestId('toast-stack').hasAttribute('data-expanded'),
    ).toBe(false);

    vi.unstubAllGlobals();
  });

  test('card body activates metadata.navigateTo without double-firing View', () => {
    notifications = [
      {
        id: 'rss-2',
        message: 'New article',
        type: 'info',
        timestamp: Date.now(),
        dismissed: false,
        metadata: {
          navigateTo: { project: 'research', layout: 'rss-reader' },
        },
      },
    ];

    render(<NotificationContainer />);
    fireEvent.click(screen.getByTestId('toast-card'));
    expect(navigate).toHaveBeenCalledWith(
      '/projects/research/layouts/rss-reader',
    );
    expect(dismissToast).toHaveBeenCalledWith('rss-2');
  });
});
