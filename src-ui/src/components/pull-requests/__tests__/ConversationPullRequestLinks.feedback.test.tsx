// @vitest-environment jsdom

import type { PullRequestFeedbackView } from '@kontourai/station-contracts/pull-request-feedback';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * A linked pull request's agent feedback in a session's Details: one chip,
 * one quiet line of what Station last did, and the switches behind the row's
 * `⋯`. Another chat's feedback answers with its owner and a Move here.
 */

const IDENTITY = vi.hoisted(() => ({
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'k',
    isCurrent: () => true,
  }),
}));
const flags = vi.hoisted(() => ({ preview: true }));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(flags.preview ? ['pull-request-agent-feedback'] : []),
}));

vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: vi.fn().mockResolvedValue({
    conversationId: 'c1',
    observedAt: '2026-11-10T12:00:00Z',
    links: [
      {
        ...IDENTITY,
        source: 'explicit',
        observedAt: '2026-11-10T12:00:00Z',
        status: {
          state: 'current',
          title: 'Add the null check',
          pullRequestState: 'OPEN',
        },
      },
    ],
  }),
  linkConversationPullRequest: vi.fn(),
  unlinkConversationPullRequest: vi.fn(),
}));
const sdk = vi.hoisted(() => ({
  view: undefined as unknown,
  write: vi.fn(),
  sendAgain: vi.fn(async () => undefined),
  turnOff: vi.fn(async () => undefined),
  read: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/pull-request-feedback', async (original) => {
  const actual =
    await original<
      typeof import('@kontourai/station-sdk/pull-request-feedback')
    >();
  return {
    pullRequestFeedbackOwnerOf: actual.pullRequestFeedbackOwnerOf,
    pullRequestHeadReviewRefusal: actual.pullRequestHeadReviewRefusal,
    readPullRequestFeedbackCapability: vi.fn(async () => true),
    getConversationPullRequestFeedback: (...args: unknown[]) => {
      sdk.read(...args);
      return Promise.resolve({
        conversationId: 'c1',
        pullRequests: [sdk.view],
      });
    },
    writePullRequestFeedback: (...args: unknown[]) => sdk.write(...args),
    sendPullRequestFeedbackAgain: (...args: unknown[]) =>
      sdk.sendAgain(...(args as [])),
    turnOffPullRequestFeedback: (...args: unknown[]) =>
      sdk.turnOff(...(args as [])),
  };
});

import { ConversationPullRequestLinks } from '../ConversationPullRequestLinks';

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function view(
  overrides: Partial<PullRequestFeedbackView> = {},
): PullRequestFeedbackView {
  return {
    identity: IDENTITY,
    ownedHere: true,
    owner: { conversationId: 'c1' },
    settings: {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: false,
    },
    status: { state: 'watching' },
    history: [],
    ...overrides,
  };
}

function renderLinks() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationPullRequestLinks conversationId="c1" />
    </QueryClientProvider>,
  );
}

async function openDialog() {
  // The row offers Agent feedback once the chat's feedback has been read.
  await waitFor(() => expect(sdk.read).toHaveBeenCalled());
  await screen.findByText('Add the null check');
  await act(async () => {});
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'More actions for github.com/acme/widgets #42',
    }),
  );
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Agent feedback…' }),
  );
  return screen.findByRole('dialog', { name: 'Agent feedback' });
}

beforeEach(() => {
  flags.preview = true;
  sdk.write.mockReset();
  sdk.read.mockReset();
  sdk.sendAgain.mockClear();
});
afterEach(() => cleanup());

describe('agent feedback on a linked pull request', () => {
  test('the row reads like an instrument: one chip and what was last sent, with its time', async () => {
    const sent = {
      id: 'prf-1',
      at: minutesAgo(3),
      headSha: 'a1b2c3d4e5f6',
      categories: [{ category: 'failing-checks' as const, count: 2 }],
      state: 'sent' as const,
    };
    sdk.view = view({ last: sent, history: [sent] });
    renderLinks();
    expect(await screen.findByText('Auto-fix on')).toBeTruthy();
    expect(
      await screen.findByText('Sent 2 failing checks to the agent'),
    ).toBeTruthy();
    expect(screen.getByText('3m')).toBeTruthy();
  });

  test('the switches call the SDK with the new settings', async () => {
    sdk.view = view();
    sdk.write.mockResolvedValue(view());
    renderLinks();
    const dialog = await openDialog();
    const reviews = within(dialog).getByRole('switch', {
      name: 'Address review comments automatically',
    });
    expect(reviews.getAttribute('aria-checked')).toBe('false');
    expect(
      within(dialog)
        .getByRole('switch', { name: 'Fix failing checks automatically' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(reviews);
    await waitFor(() =>
      expect(sdk.write).toHaveBeenCalledWith(
        'http://station.test',
        'c1',
        {
          identity: IDENTITY,
          settings: { fixFailingChecks: true, addressReviewComments: true },
          move: false,
        },
        expect.anything(),
      ),
    );
  });

  test('turning the last switch off turns feedback off through the one turn-off path', async () => {
    sdk.view = view();
    sdk.turnOff.mockClear();
    renderLinks();
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole('switch', {
        name: 'Fix failing checks automatically',
      }),
    );
    await waitFor(() =>
      expect(sdk.turnOff).toHaveBeenCalledWith(
        'http://station.test',
        'c1',
        IDENTITY,
        expect.anything(),
      ),
    );
    expect(sdk.write).not.toHaveBeenCalled();
  });

  test('a 24-hour pause says so, not "3 rounds"', async () => {
    sdk.view = view({
      status: {
        state: 'paused',
        reason: 'round-limit',
        cap: 'day',
        headSha: 'a1b2c3d4e5f6',
      },
    });
    renderLinks();
    expect(
      await screen.findByText('Paused after 10 messages in 24 hours'),
    ).toBeTruthy();
    expect(screen.queryByText(/3 rounds/)).toBeNull();
  });

  test("another chat's feedback: 409 names it and Move here moves it", async () => {
    sdk.view = view({
      ownedHere: false,
      owner: null,
      status: { state: 'off' },
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      },
    });
    sdk.write.mockRejectedValueOnce(
      new StationHttpError(409, 'Feedback goes elsewhere.', {
        code: 'pull_request_feedback_owned_elsewhere',
        details: { owner: { conversationId: 'c2', title: 'Fix the parser' } },
      }),
    );
    renderLinks();
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole('switch', {
        name: 'Fix failing checks automatically',
      }),
    );
    expect(
      await within(dialog).findByText('Feedback goes to “Fix the parser”.'),
    ).toBeTruthy();
    // The switches wait for the move.
    expect(
      (
        within(dialog).getByRole('switch', {
          name: 'Fix failing checks automatically',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    sdk.write.mockResolvedValueOnce(view());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await waitFor(() =>
      expect(sdk.write).toHaveBeenLastCalledWith(
        'http://station.test',
        'c1',
        expect.objectContaining({ identity: IDENTITY, move: true }),
        expect.anything(),
      ),
    );
  });

  test('Move here from a chat that may not see the owner moves feedback with its switches on', async () => {
    // What the server now answers a reader who may not read the owning chat:
    // the owner hidden, its switches reported off.
    sdk.view = view({
      ownedHere: false,
      owner: {},
      status: { state: 'off' },
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      },
    });
    renderLinks();
    const dialog = await openDialog();
    expect(
      await within(dialog).findByText('Feedback goes to another chat.'),
    ).toBeTruthy();
    sdk.write.mockResolvedValueOnce(view());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await waitFor(() =>
      expect(sdk.write).toHaveBeenLastCalledWith(
        'http://station.test',
        'c1',
        expect.objectContaining({
          identity: IDENTITY,
          move: true,
          settings: expect.objectContaining({
            fixFailingChecks: true,
            addressReviewComments: true,
          }),
        }),
        expect.anything(),
      ),
    );
  });

  test('says why it cannot work: not signed in, or paused with Send again', async () => {
    sdk.view = view({ status: { state: 'unavailable', cause: 'credentials' } });
    const { unmount } = renderLinks();
    expect(await screen.findByText('Needs sign-in')).toBeTruthy();
    expect(
      screen.getByText('Sign in to GitHub on this Station to get feedback'),
    ).toBeTruthy();
    unmount();
    sdk.view = view({
      status: {
        state: 'paused',
        reason: 'round-limit',
        headSha: 'a1b2c3d4e5f6',
      },
    });
    renderLinks();
    expect(await screen.findByText('Paused')).toBeTruthy();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
    await waitFor(() =>
      expect(sdk.sendAgain).toHaveBeenCalledWith(
        'http://station.test',
        'c1',
        IDENTITY,
        expect.anything(),
      ),
    );
  });

  test('feedback off: the dialog shows no status badge, only the switches', async () => {
    sdk.view = view({
      status: { state: 'off' },
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      },
    });
    renderLinks();
    const dialog = await openDialog();
    expect(within(dialog).queryByText('Off')).toBeNull();
    expect(dialog.querySelector('.pr-feedback-dialog__status')).toBeNull();
    expect(
      within(dialog)
        .getByRole('switch', { name: 'Fix failing checks automatically' })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  test('held for checks still running: the row says it is waiting on checks', async () => {
    sdk.view = view({ status: { state: 'held', reason: 'checks-running' } });
    renderLinks();
    expect(await screen.findByText('Waiting on checks')).toBeTruthy();
    expect(
      screen.getByText('Failing checks wait for the rest to finish'),
    ).toBeTruthy();
  });

  test('a closed pull request says Station checks again if it reopens', async () => {
    sdk.view = view({ status: { state: 'closed' } });
    renderLinks();
    expect(
      await screen.findByText(
        'Pull request closed; Station checks again if it reopens',
      ),
    ).toBeTruthy();
  });

  test('with the preview off nothing is read and nothing is offered', async () => {
    flags.preview = false;
    sdk.view = view();
    renderLinks();
    expect(await screen.findByText('Add the null check')).toBeTruthy();
    expect(screen.queryByText('Auto-fix on')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'More actions for github.com/acme/widgets #42',
      }),
    );
    expect(
      screen.queryByRole('menuitem', { name: 'Agent feedback…' }),
    ).toBeNull();
    expect(sdk.read).not.toHaveBeenCalled();
  });
});
