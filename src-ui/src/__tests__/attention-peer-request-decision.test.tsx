/**
 * @vitest-environment jsdom
 */

import type {
  AttentionProjection,
  ReviewPendingAttentionItem,
} from '@kontourai/station-contracts/attention';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Phase 1 of answering a paired-Station task from here: an APPROVAL the
 * paired Station reported (`peerRequestReference`) is decided through
 * `POST /api/orchestration/delegations/:taskId/respond` with the record's
 * `environmentId` — never a local request route — and only when this
 * Station's own checks pass for the reader (`viewerCanRespond`).
 *
 * Drives the real `NotificationsPage` and the Activity detail's
 * `SessionDetailAttention`; the SDK respond client is the only stub, so the
 * assertion is on exactly what the card sends.
 */
let attention: AttentionProjection = { items: [], pendingCount: 0 };
const respond = vi.fn();
const continueTask = vi.fn();
const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'operator',
  isCurrent: () => true,
};

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  respondToDelegatedTaskRequest: (...args: unknown[]) => respond(...args),
  continueDelegatedTask: (...args: unknown[]) => continueTask(...args),
}));
const sendTurn = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => ({ data: [], error: null, isLoading: false }),
  useAttentionQuery: () => ({ data: attention, isLoading: false }),
  useOrchestrationSessionsQuery: () => ({ data: [], isSuccess: true }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  sendOrchestrationTurn: (...args: unknown[]) => sendTurn(...args),
  useClearNotificationActivityMutation: () => ({ mutate: vi.fn() }),
  useDismissNotificationMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useNotificationActionMutation: () => ({ isPending: false, mutate: vi.fn() }),
  DevicePairingRequestActionError: class extends Error {},
  useConfirmDevicePairingRequestMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useDenyDevicePairingRequestMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useAcknowledgeAttentionItemMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
  acknowledgeAttentionItem: vi.fn(),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => scope,
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { SessionDetailAttention } from '../components/session-detail/SessionDetailAttention';
import { NotificationsPage } from '../pages/NotificationsPage';

const now = '2026-10-04T12:00:00.000Z';
const THREAD = 'peer-delegation:abc';

function peerApproval(
  overrides: Partial<ReviewPendingAttentionItem> = {},
): ReviewPendingAttentionItem {
  return {
    id: `review_pending:${THREAD}`,
    kind: 'review_pending',
    title: 'Tool call awaiting approval: Allow bash',
    createdAt: now,
    updatedAt: now,
    sessionId: THREAD,
    openHref: activityDeepLink({ sessionId: THREAD }),
    source: { threadId: THREAD },
    environmentKind: 'peer',
    environmentName: 'Station B',
    peerRequestReference: {
      environmentId: 'environment-peer',
      taskId: 'task-peer',
      requestId: 'req-peer-1',
      requestType: 'approval',
    },
    viewerCanRespond: true,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationsPage />
    </QueryClientProvider>,
  );
}

function card(): HTMLElement {
  const match = screen
    .getAllByTestId('attention-item')
    .find((row) => within(row).queryByText(/Allow bash/) !== null);
  if (!match) throw new Error('No peer approval card');
  return match;
}

beforeEach(() => {
  continueTask.mockReset();
  continueTask.mockResolvedValue({ status: 'dispatched' });
  respond.mockReset();
  respond.mockResolvedValue({ status: 'resolved', requestId: 'req-peer-1' });
  attention = { items: [peerApproval()], pendingCount: 1 };
});

describe('Notifications inbox: a paired-Station approval', () => {
  test('Allow posts the paired request id and environment to the respond route', async () => {
    renderPage();
    fireEvent.click(within(card()).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(
      'http://station.test',
      'task-peer',
      {
        requestId: 'req-peer-1',
        decision: 'accept',
        environmentId: 'environment-peer',
      },
      { requestScope: scope },
    );
    // No local request inspection is offered for the other Station's id.
    expect(
      within(card()).queryByRole('button', { name: 'Inspect request' }),
    ).toBeNull();
  });

  test('Deny sends decline', async () => {
    renderPage();
    fireEvent.click(within(card()).getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(
        'http://station.test',
        'task-peer',
        expect.objectContaining({ decision: 'decline' }),
        expect.anything(),
      ),
    );
  });

  test("a paired Station's refusal is shown, not swallowed", async () => {
    respond.mockRejectedValue(
      new Error(
        'The paired Station refused this decision: the access this Station holds there does not allow answering its requests.',
      ),
    );
    renderPage();
    fireEvent.click(within(card()).getByRole('button', { name: 'Allow' }));
    expect((await within(card()).findByRole('alert')).textContent).toContain(
      'The paired Station refused this decision',
    );
  });

  test('without the grant: no decision, the note says why', () => {
    attention = {
      items: [peerApproval({ viewerCanRespond: false })],
      pendingCount: 1,
    };
    renderPage();
    expect(within(card()).queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(
      within(card()).getByTestId('attention-peer-elsewhere').textContent,
    ).toBe(
      "Your access to this Station doesn't allow answering paired-Station requests from here. Answer this on Station B, the paired Station that runs the task.",
    );
  });

  test('unknown grant (absent) fails closed', () => {
    const item = peerApproval();
    delete item.viewerCanRespond;
    attention = { items: [item], pendingCount: 1 };
    renderPage();
    expect(within(card()).queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  test('an older paired Station (no request data) keeps the note', () => {
    const item = peerApproval();
    delete item.peerRequestReference;
    attention = { items: [item], pendingCount: 1 };
    renderPage();
    expect(within(card()).queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(
      within(card()).getByTestId('attention-peer-elsewhere').textContent,
    ).toBe('Answer this on Station B, the paired Station that runs the task.');
  });

  test('an input question keeps the note in this phase', () => {
    attention = {
      items: [
        peerApproval({
          peerRequestReference: {
            environmentId: 'environment-peer',
            taskId: 'task-peer',
            requestId: 'req-peer-q',
            requestType: 'input',
          },
        }),
      ],
      pendingCount: 1,
    };
    renderPage();
    expect(within(card()).queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(within(card()).queryByRole('textbox')).toBeNull();
  });
});

describe('Activity detail: the same decision on a paired record', () => {
  test('a peer record (answerHere false) offers the forwarded decision', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionDetailAttention
          checkFailed={false}
          errorMessage=""
          onRetry={vi.fn()}
          items={[peerApproval()]}
          answerHere={false}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(
        'http://station.test',
        'task-peer',
        expect.objectContaining({
          requestId: 'req-peer-1',
          environmentId: 'environment-peer',
        }),
        expect.anything(),
      ),
    );
  });
});

function peerQuestion(
  reference: Partial<
    NonNullable<ReviewPendingAttentionItem['peerRequestReference']>
  > = {},
  overrides: Partial<ReviewPendingAttentionItem> = {},
): ReviewPendingAttentionItem {
  return peerApproval({
    title: 'Which bucket?',
    body: 'The release needs a destination bucket.',
    peerRequestReference: {
      environmentId: 'environment-peer',
      taskId: 'task-peer',
      requestId: 'req-question',
      requestType: 'input',
      threadId: 'peer-session',
      requestEventId: 'evt-question',
      callerCanRespond: true,
      ...reference,
    },
    ...overrides,
  });
}

function questionCard(): HTMLElement {
  const match = screen
    .getAllByTestId('attention-item')
    .find((row) => within(row).queryByText('Which bucket?') !== null);
  if (!match) throw new Error('No peer question card');
  return match;
}

describe('Notifications inbox: a paired-Station input question (bound answers)', () => {
  test('the answer posts to continue bound to exactly that request', async () => {
    attention = { items: [peerQuestion()], pendingCount: 1 };
    renderPage();
    fireEvent.change(
      within(questionCard()).getByLabelText('Answer on the paired Station'),
      { target: { value: 'Use staging' } },
    );
    fireEvent.click(
      within(questionCard()).getByRole('button', { name: 'Send answer' }),
    );
    await waitFor(() => expect(continueTask).toHaveBeenCalledTimes(1));
    expect(continueTask).toHaveBeenCalledWith(
      'http://station.test',
      'task-peer',
      {
        message: 'Use staging',
        environmentId: 'environment-peer',
        expectedInputRequest: {
          threadId: 'peer-session',
          requestId: 'req-question',
          requestEventId: 'evt-question',
        },
      },
      { requestScope: scope },
    );
  });

  test('without the binding (an older paired Station) there is no answer box', () => {
    attention = {
      items: [peerQuestion({ threadId: undefined, requestEventId: undefined })],
      pendingCount: 1,
    };
    renderPage();
    expect(within(questionCard()).queryByRole('textbox')).toBeNull();
    expect(
      within(questionCard()).getByTestId('attention-peer-elsewhere'),
    ).toBeTruthy();
  });

  test('the paired Station saying it would refuse shows the note, not a box', () => {
    attention = {
      items: [peerQuestion({ callerCanRespond: false })],
      pendingCount: 1,
    };
    renderPage();
    expect(within(questionCard()).queryByRole('textbox')).toBeNull();
    expect(
      within(questionCard()).getByTestId('attention-peer-elsewhere')
        .textContent,
    ).toContain(
      "The paired Station doesn't allow this Station to answer its requests.",
    );
  });

  test('an absent paired-Station check still offers the answer (refusal shown if it comes)', () => {
    attention = {
      items: [peerQuestion({ callerCanRespond: undefined })],
      pendingCount: 1,
    };
    renderPage();
    expect(
      within(questionCard()).getByLabelText('Answer on the paired Station'),
    ).toBeTruthy();
  });

  test('this Station withholding the grant shows the note', () => {
    attention = {
      items: [peerQuestion({}, { viewerCanRespond: false })],
      pendingCount: 1,
    };
    renderPage();
    expect(within(questionCard()).queryByRole('textbox')).toBeNull();
  });

  test('a changed request comes back as a visible refusal', async () => {
    continueTask.mockRejectedValue(
      new Error(
        'The input request changed or was answered. Refresh and answer the current request.',
      ),
    );
    attention = { items: [peerQuestion()], pendingCount: 1 };
    renderPage();
    fireEvent.change(
      within(questionCard()).getByLabelText('Answer on the paired Station'),
      { target: { value: 'Use staging' } },
    );
    fireEvent.click(
      within(questionCard()).getByRole('button', { name: 'Send answer' }),
    );
    expect(
      (await within(questionCard()).findByRole('alert')).textContent,
    ).toContain('The input request changed');
  });

  test('a paired-Station refusal flag also withholds Allow/Deny', () => {
    attention = {
      items: [
        peerApproval({
          peerRequestReference: {
            environmentId: 'environment-peer',
            taskId: 'task-peer',
            requestId: 'req-peer-1',
            requestType: 'approval',
            callerCanRespond: false,
          },
        }),
      ],
      pendingCount: 1,
    };
    renderPage();
    expect(within(card()).queryByRole('button', { name: 'Allow' })).toBeNull();
  });
});
