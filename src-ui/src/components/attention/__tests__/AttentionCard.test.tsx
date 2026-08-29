/**
 * @vitest-environment jsdom
 */

import type {
  ApprovalAttentionItem,
  AttentionItem,
  DevicePairingAttentionItem,
  SessionFailedAttentionItem,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const action = vi.fn();
const dismiss = vi.fn();
const acknowledge = vi.fn();
const acknowledgeAsync = vi.fn(() => Promise.resolve());
const navigate = vi.fn();

const pairingMocks = vi.hoisted(() => {
  class MockDevicePairingRequestActionError extends Error {
    constructor(
      readonly status: number,
      readonly code?: string,
    ) {
      super(`HTTP ${status}`);
    }
  }
  return {
    MockDevicePairingRequestActionError,
    confirmPairing: vi.fn(),
    denyPairing: vi.fn(),
    confirmPairingState: {
      isPending: false,
      error: null as unknown,
    },
    denyPairingState: {
      isPending: false,
      error: null as unknown,
    },
  };
});

vi.mock('../../../utils/attentionOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/attentionOpen')>()),
  navigateToAttentionTarget: (href: string) => navigate(href),
}));

vi.mock('@kontourai/station-sdk', () => ({
  acceptFlowException: vi.fn(),
  DevicePairingRequestActionError:
    pairingMocks.MockDevicePairingRequestActionError,
  evaluateFlowGate: vi.fn(),
  sendOrchestrationTurn: vi.fn(),
  useAcknowledgeAttentionItemMutation: () => ({
    isPending: false,
    error: null,
    mutate: acknowledge,
    mutateAsync: acknowledgeAsync,
  }),
  useConfirmDevicePairingRequestMutation: () => ({
    isPending: pairingMocks.confirmPairingState.isPending,
    error: pairingMocks.confirmPairingState.error,
    mutate: pairingMocks.confirmPairing,
  }),
  useDenyDevicePairingRequestMutation: () => ({
    isPending: pairingMocks.denyPairingState.isPending,
    error: pairingMocks.denyPairingState.error,
    mutate: pairingMocks.denyPairing,
  }),
  useDismissNotificationMutation: () => ({
    isPending: false,
    mutate: dismiss,
  }),
  useNotificationActionMutation: () => ({
    isPending: false,
    mutate: action,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { AttentionCard } from '../AttentionCard';

beforeEach(() => {
  action.mockReset();
  dismiss.mockReset();
  acknowledge.mockReset();
  acknowledgeAsync.mockReset();
  acknowledgeAsync.mockResolvedValue(undefined);
  navigate.mockReset();
  pairingMocks.confirmPairing.mockReset();
  pairingMocks.denyPairing.mockReset();
  pairingMocks.confirmPairingState.isPending = false;
  pairingMocks.confirmPairingState.error = null;
  pairingMocks.denyPairingState.isPending = false;
  pairingMocks.denyPairingState.error = null;
});

function baseFailure(
  overrides: Partial<SessionFailedAttentionItem> = {},
): SessionFailedAttentionItem {
  const now = new Date().toISOString();
  return {
    id: 'session-failed:thread-boom',
    kind: 'session-failed',
    title: 'Fix the login redirect',
    createdAt: now,
    updatedAt: now,
    sessionId: 'thread-boom',
    openHref: '/activity?session=thread-boom',
    source: { threadId: 'thread-boom' },
    ...overrides,
  };
}

function renderCard(item: AttentionItem) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AttentionCard item={item} />
    </QueryClientProvider>,
  );
}

function baseApproval(
  overrides: Partial<ApprovalAttentionItem> = {},
): ApprovalAttentionItem {
  const now = new Date().toISOString();
  return {
    id: 'approval:notif-1',
    kind: 'approval',
    title: 'Approval needed',
    createdAt: now,
    updatedAt: now,
    source: { notificationId: 'notif-1', notificationSource: 'approval-inbox' },
    actions: [{ id: 'accept', label: 'Allow Once', variant: 'primary' }],
    ...overrides,
  };
}

describe('AttentionCard — approval kind', () => {
  test('renders an "Open session" link that deep-links to the resolved target when metadata resolves a session', () => {
    renderCard(baseApproval({ openHref: '/projects/demo?chat=thread-1' }));

    const link = screen.getByRole('link', { name: 'Open session' });
    expect(link.getAttribute('href')).toBe('/projects/demo?chat=thread-1');
  });

  test('renders no "Open session" action when metadata does not resolve a session (synthetic notification)', () => {
    renderCard(baseApproval());

    expect(screen.queryByRole('link', { name: 'Open session' })).toBeNull();
    // Title/body/actions still render normally.
    expect(screen.getByText('Approval needed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeTruthy();
  });
});

describe('AttentionCard — dismiss affordance', () => {
  test('a genuinely-pending approval (live actions + resolvable session) shows a visually secondary dismiss, not the plain ghost one', () => {
    renderCard(baseApproval({ openHref: '/projects/demo?chat=thread-1' }));

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissButton.className).toContain('attention-dismiss-link');
    expect(dismissButton.className).not.toContain(
      'attention-item__action--ghost',
    );

    dismissButton.click();
    expect(dismiss).toHaveBeenCalledWith('notif-1');
  });

  test('a live approval with no resolvable session (the ACP tool-approval shape) still gets the quiet dismiss guard', () => {
    // ACP tool approvals never resolve an openHref but are genuinely
    // pending — live actions alone must trigger the guard (archive#750).
    renderCard(baseApproval());

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissButton.className).toContain('attention-dismiss-link');
    expect(dismissButton.className).not.toContain(
      'attention-item__action--ghost',
    );

    dismissButton.click();
    expect(dismiss).toHaveBeenCalledWith('notif-1');
  });

  test('a terminal approval with no live actions shows a plain dismiss', () => {
    renderCard(
      baseApproval({ actions: [], openHref: '/projects/demo?chat=thread-1' }),
    );

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissButton.className).toContain('attention-item__action--ghost');
  });

  // archive#1548: the kind that exists because archive#1296's test comment claimed
  // this surfacing already existed and nothing implemented it.
  test('a failed session renders its own kind label, its cause, and one way in', () => {
    const { container } = renderCard(
      baseFailure({ body: 'Engine exited with code 1' }),
    );

    // archive#3203: the eyebrow names the KIND and the title names the
    // SESSION. They used to be the same three words, which is what made the
    // reported tray unreadable. Assert each slot rather than a bare text
    // match, so a regression that drops one — or that collapses them back
    // into one string — is visible.
    expect(container.querySelector('.attention-item__type')?.textContent).toBe(
      'Session failed',
    );
    expect(
      container.querySelector('.attention-item__message')?.textContent,
    ).toBe('Fix the login redirect');
    expect(screen.getByText('Engine exited with code 1')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open session' });
    expect(link.getAttribute('href')).toBe('/activity?session=thread-boom');
  });

  // archive#1914: a failed session's failure is not an approval to decide,
  // but it IS derived-and-unclearable — so it gets its own Dismiss, which
  // acknowledges rather than approves/denies anything.
  test("a failed session's Dismiss acknowledges the item by id, not a notification", () => {
    renderCard(baseFailure());

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    dismissButton.click();
    expect(acknowledge).toHaveBeenCalledWith('session-failed:thread-boom');
    // The OTHER dismiss path (notification delete) must not fire for this kind.
    expect(dismiss).not.toHaveBeenCalled();
  });
});

/*
 * archive#3203. The owner's tray showed three rows reading "Session failed"
 * in every slot, with no cause and nothing naming which session each was.
 */
describe('AttentionCard — a failed session says what happened (#3203)', () => {
  test('the cause and the identity render alongside the session name', () => {
    renderCard(
      baseFailure({
        body: 'ECONNREFUSED api.example.com:443',
        engine: 'claude',
        agent: 'reviewer',
      }),
    );

    expect(screen.getByTestId('attention-cause').textContent).toBe(
      'ECONNREFUSED api.example.com:443',
    );
    // The raw provider id is labelled HERE, through the same table every
    // other engine chip uses — the projection deliberately ships the id.
    expect(screen.getByTestId('attention-identity').textContent).toBe(
      'Claude Code · reviewer',
    );
  });

  test('a provider this build does not know renders its observed id, not a guess', () => {
    renderCard(baseFailure({ engine: 'acme-engine' }));

    expect(screen.getByTestId('attention-identity').textContent).toBe(
      'acme-engine',
    );
  });

  test('no recorded engine or agent renders no identity line at all', () => {
    renderCard(baseFailure());

    expect(screen.queryByTestId('attention-identity')).toBeNull();
  });

  test('an unrecorded cause says so rather than rendering nothing', () => {
    // The reported symptom was a row that told the owner nothing. Silence
    // here is indistinguishable from "the surface forgot to show it".
    renderCard(baseFailure());

    expect(screen.getByTestId('attention-cause').textContent).toBe(
      'No failure detail was recorded for this session.',
    );
  });

  test('three failures from three sessions render three distinct rows', () => {
    const rows = [
      baseFailure({
        id: 'session-failed:a',
        title: 'Fix the login redirect',
        body: 'ECONNREFUSED api.example.com:443',
        engine: 'claude',
      }),
      baseFailure({
        id: 'session-failed:b',
        title: 'Migrate the invoice table',
        body: 'Engine exited with code 1',
        engine: 'codex',
      }),
      baseFailure({
        id: 'session-failed:c',
        title: 'Draft the release notes',
        engine: 'claude',
      }),
    ].map((item) => {
      const { container, unmount } = renderCard(item);
      const text = container.querySelector('.attention-item')?.textContent;
      unmount();
      return text;
    });

    expect(new Set(rows).size).toBe(3);
  });
});

function basePairing(
  overrides: Partial<DevicePairingAttentionItem> = {},
): DevicePairingAttentionItem {
  const now = new Date().toISOString();
  return {
    id: 'device-pairing:pair-req-1',
    kind: 'device-pairing',
    title: 'A device is asking to pair',
    body: 'Test Phone is waiting for approval on this Station.',
    createdAt: now,
    updatedAt: now,
    deviceName: 'Test Phone',
    openHref: '/connections',
    source: { requestId: 'pair-req-1' },
    ...overrides,
  };
}

/*
 * #765 D5: an inbound pairing request used to be passive activity with only
 * a Dismiss button; the host had no Approve/Deny anywhere but the CLI and
 * the Connections modal. The card now carries the decision, wired to the
 * SAME gated pairing routes the panel and CLI use.
 */
describe('AttentionCard — device pairing kind (#765 D5)', () => {
  test('renders Approve and Deny, and Approve confirms the exact request', () => {
    renderCard(basePairing());

    expect(
      screen.getByText('Test Phone is waiting for approval on this Station.'),
    ).toBeTruthy();
    screen.getByRole('button', { name: 'Approve' }).click();
    expect(pairingMocks.confirmPairing).toHaveBeenCalledWith('pair-req-1');
    expect(pairingMocks.denyPairing).not.toHaveBeenCalled();
  });

  test('Deny denies the exact request', () => {
    renderCard(basePairing());

    screen.getByRole('button', { name: 'Deny' }).click();
    expect(pairingMocks.denyPairing).toHaveBeenCalledWith('pair-req-1');
    expect(pairingMocks.confirmPairing).not.toHaveBeenCalled();
  });

  test('an in-flight decision disables both buttons — the confirmed state is the server projection resolving the item away', () => {
    pairingMocks.confirmPairingState.isPending = true;
    renderCard(basePairing());

    expect(
      screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  test('a 403 refusal renders the trusted-session remedy, naming the CLI approve', () => {
    pairingMocks.confirmPairingState.error =
      new pairingMocks.MockDevicePairingRequestActionError(
        403,
        'approval_requires_operator',
      );
    renderCard(basePairing());

    expect(
      screen.getByText(
        /needs a trusted Station session.*station environment access approve pair-req-1 --force/,
      ),
    ).toBeTruthy();
  });

  test('an expired request says so instead of a generic failure', () => {
    pairingMocks.denyPairingState.error =
      new pairingMocks.MockDevicePairingRequestActionError(410);
    renderCard(basePairing());

    expect(
      screen.getByText(
        'That access request has already expired or been removed.',
      ),
    ).toBeTruthy();
  });

  test('links to Connections and keeps the acknowledge-dismiss affordance', () => {
    renderCard(basePairing());

    expect(
      screen
        .getByRole('link', { name: 'Open connections' })
        .getAttribute('href'),
    ).toBe('/connections');
    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(acknowledge).toHaveBeenCalledWith('device-pairing:pair-req-1');
    expect(dismiss).not.toHaveBeenCalled();
  });
});

/*
 * archive#3203 defect 2: "clicking on a notification that needs attention
 * should probably make the notification number decrement as seen". Dismiss
 * already acknowledged; Open did not, and that asymmetry was the bug.
 */
describe('AttentionCard — opening acknowledges (#3203)', () => {
  test('opening a failed session acknowledges it, then navigates', async () => {
    renderCard(baseFailure());

    screen.getByRole('link', { name: 'Open session' }).click();

    expect(acknowledgeAsync).toHaveBeenCalledWith('session-failed:thread-boom');
    // The navigation is deferred until the ack resolves — otherwise the
    // destination's own `/api/attention` read races the write it depends on.
    expect(navigate).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/activity?session=thread-boom'),
    );
  });

  test('a failing acknowledgement still opens the session', async () => {
    acknowledgeAsync.mockRejectedValue(new Error('offline'));
    renderCard(baseFailure());

    screen.getByRole('link', { name: 'Open session' }).click();

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/activity?session=thread-boom'),
    );
  });

  test('an approval row still opens with the plain anchor and acknowledges nothing', () => {
    // Only `session-failed` is acknowledgeable; the projection ignores an ack
    // recorded against any other kind, so recording one here would be a write
    // that changes nothing while claiming the row was seen.
    renderCard(baseApproval({ openHref: '/projects/demo?chat=thread-1' }));

    screen.getByRole('link', { name: 'Open session' }).click();

    expect(acknowledgeAsync).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
