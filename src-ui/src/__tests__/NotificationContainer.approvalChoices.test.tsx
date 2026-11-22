/**
 * @vitest-environment jsdom
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * chat-14: the approval toast, from the `request.opened` event to the answer
 * it sends. The handler builds the toast and the container draws it, both
 * real: Allow once and Deny are the only labelled buttons, every session
 * grant the request offered sits in one menu, each choice sends the decision
 * (and typed scope) it sent before, and a grant the request did not offer is
 * never shown.
 */

const navigate = vi.fn();

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  resolveOrchestrationRequest: vi.fn().mockResolvedValue(undefined),
  inspectAttentionRequest: vi.fn(),
}));

vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({
    setProject: vi.fn(),
    setLayout: vi.fn(),
    navigate,
  });
  return {
    navigationStore: {
      navigate,
      getSnapshot: () => ({ isDockOpen: false, activeChat: null }),
    },
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('../contexts/ToastContext', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../contexts/ToastContext')>();
  return {
    ...original,
    useToast: () => ({
      dismissToast: (id: string) => original.toastStore.dismiss(id),
      dismissAllToasts: vi.fn(),
    }),
  };
});

const { resolveOrchestrationRequest } = await import('@kontourai/station-sdk');
const { NotificationContainer } = await import(
  '../components/notifications/NotificationContainer'
);
const { activeChatsStore } = await import('../contexts/active-chats-store');
const { toastStore } = await import('../contexts/ToastContext');
const { handleRequestOpenedEvent } = await import(
  '../hooks/orchestration/approvalHandlers'
);
const { forgetApprovalAnswer } = await import(
  '../hooks/orchestration/answerRequest'
);

const MENU = 'Allow for this session';
const PREFIX = 'Allow "npm ls *" for this session';
const WHOLE_BASH = 'Allow all Bash commands for this session';
const BROWSER_TOOL =
  'Allow all station-browser.browser_click calls for this session';
const BROWSER_SERVER = 'Allow the Station browser for this session';

/** A Bash prefix suggestion, as Claude Code sends it with an ask. */
const rule = (ruleContent: string) => ({
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent }],
  behavior: 'allow',
  destination: 'localSettings',
});

/** A plain Claude Bash ask, as the Claude adapter publishes it. */
const claudeBash = (suggestions: unknown[]) => ({
  toolName: 'Bash',
  toolInput: { command: 'npm ls react' },
  decisionReason: 'This command requires approval',
  claudeAsk: { decisionReasonType: 'other' },
  suggestions,
});

/** A Station browser call; `stationBrowserServer` is the adapter's finding. */
const browserCall = (authentic: boolean) => ({
  toolName: 'mcp__station-browser__browser_click',
  toolInput: { ref: 'e1' },
  ...(authentic ? { stationBrowserServer: true } : {}),
});

function raise(payload: Record<string, unknown>, requestId = 'req-1') {
  handleRequestOpenedEvent('http://localhost:1', {
    eventId: `evt-${requestId}`,
    provider: 'claude',
    threadId: 'thread-1',
    createdAt: '2026-09-05T00:00:00.000Z',
    method: 'request.opened',
    requestId,
    requestType: 'approval',
    title: 'Allow a tool',
    payload,
  } as unknown as Parameters<typeof handleRequestOpenedEvent>[1]);
}

function openRequest(payload: Record<string, unknown>) {
  raise(payload);
  render(<NotificationContainer />);
  const cards = screen.getAllByTestId('toast-card');
  expect(cards).toHaveLength(1);
  return cards[0];
}

/** The card's labelled buttons: not its dismiss control, not its menu. */
function labelledButtons(card: HTMLElement) {
  return within(card)
    .getAllByRole('button')
    .filter(
      (button) =>
        button.getAttribute('aria-haspopup') !== 'menu' &&
        !button.classList.contains('toast-card__dismiss'),
    )
    .map((button) => button.textContent);
}

/** The menu's items, in order; empty when the card has no menu. */
async function menuItems(card: HTMLElement) {
  const trigger = within(card).queryByRole('button', { name: MENU });
  if (!trigger) return [];
  fireEvent.click(trigger);
  const items = await screen.findAllByRole('menuitem');
  return items.map((item) => item.textContent);
}

async function choose(card: HTMLElement, label: string) {
  const button = within(card).queryByRole('button', { name: label });
  if (button) fireEvent.click(button);
  else {
    fireEvent.click(within(card).getByRole('button', { name: MENU }));
    fireEvent.click(await screen.findByRole('menuitem', { name: label }));
  }
  await vi.waitFor(() =>
    expect(resolveOrchestrationRequest).toHaveBeenCalledTimes(1),
  );
  return vi.mocked(resolveOrchestrationRequest).mock.calls[0][0];
}

describe('chat-14: the approval toast offers Allow once, Deny and one menu of session grants', () => {
  beforeEach(() => {
    // Each case answers the same request identity afresh.
    forgetApprovalAnswer('thread-1', 'req-1');
    toastStore.clear();
    toastStore.clearHistory();
    for (const id of Object.keys(activeChatsStore.getSnapshot()))
      activeChatsStore.removeChat(id);
    activeChatsStore.initChat('thread-1');
    vi.mocked(resolveOrchestrationRequest)
      .mockReset()
      .mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    act(() => toastStore.clear());
  });

  test('a Claude Bash ask with a prefix shows two labelled buttons, and the prefix and whole-tool grants in the menu', async () => {
    const card = openRequest(claudeBash([rule('npm ls *')]));
    expect(labelledButtons(card)).toEqual(['Deny', 'Allow once']);
    expect(await menuItems(card)).toEqual([PREFIX, WHOLE_BASH]);
  });

  test('an authentic Station browser call shows the per-tool and browser grants in the menu', async () => {
    const card = openRequest(browserCall(true));
    expect(labelledButtons(card)).toEqual(['Deny', 'Allow once']);
    expect(await menuItems(card)).toEqual([BROWSER_TOOL, BROWSER_SERVER]);
  });

  test.each([
    [
      'an exact-command suggestion offers no prefix grant',
      claudeBash([rule('npm --version')]),
      [WHOLE_BASH],
    ],
    [
      'a browser call the adapter did not find authentic offers no browser grant',
      browserCall(false),
      [BROWSER_TOOL],
    ],
    [
      'a plan exit offers no session grant, and so no menu',
      { toolName: 'ExitPlanMode', toolInput: { plan: 'Step 1' } },
      [],
    ],
  ] as const)('%s', async (_case, payload, grants) => {
    const card = openRequest(payload);
    expect(labelledButtons(card)).toEqual(['Deny', 'Allow once']);
    expect(await menuItems(card)).toEqual(grants);
  });

  test('Deny is drawn in the same outline tone as the card and the sheet', () => {
    const card = openRequest(claudeBash([rule('npm ls *')]));
    const deny = within(card).getByRole('button', { name: 'Deny' });
    expect(deny.classList.contains('button--danger-outline')).toBe(true);
    expect(
      within(card)
        .getByRole('button', { name: 'Allow once' })
        .classList.contains('button--primary'),
    ).toBe(true);
  });

  test('a request joining the queue closes an open menu without answering anything', async () => {
    const card = openRequest(claudeBash([rule('npm ls *')]));
    fireEvent.click(within(card).getByRole('button', { name: MENU }));
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2);
    act(() => raise(browserCall(true), 'req-2'));
    expect(screen.getAllByTestId('toast-card')).toHaveLength(2);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(resolveOrchestrationRequest).not.toHaveBeenCalled();
  });

  test.each([
    ['Allow once', claudeBash([rule('npm ls *')]), 'accept', undefined],
    ['Deny', claudeBash([rule('npm ls *')]), 'decline', undefined],
    [PREFIX, claudeBash([rule('npm ls *')]), 'acceptForSession', 'rule'],
    [WHOLE_BASH, claudeBash([rule('npm ls *')]), 'acceptForSession', undefined],
    [BROWSER_TOOL, browserCall(true), 'acceptForSession', undefined],
    [BROWSER_SERVER, browserCall(true), 'acceptForSession', 'server'],
  ] as const)(
    '"%s" sends its own decision and scope',
    async (label, payload, decision, scope) => {
      const card = openRequest(payload);
      const sent = await choose(card, label);
      expect(sent).toMatchObject({
        threadId: 'thread-1',
        requestId: 'req-1',
        expectedRequestEventId: 'evt-req-1',
        decision,
      });
      if (scope) expect(sent.sessionGrantScope).toBe(scope);
      else expect(sent).not.toHaveProperty('sessionGrantScope');
    },
  );
});
