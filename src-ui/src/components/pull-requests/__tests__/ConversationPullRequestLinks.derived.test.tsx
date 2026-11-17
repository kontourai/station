// @vitest-environment jsdom

import type { PullRequestFeedbackView } from '@kontourai/station-contracts/pull-request-feedback';
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
 * A pull request Station found on the chat's Task branch: its row reads
 * "from this Task's branch", carries Agent feedback… only when no linked or
 * Task-kept row for the same pull request comes first, and offers "Remove
 * from this chat", which asks first and then removes it for good.
 */

const PR = (ref: string) => ({
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref,
});
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

const links = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: (...args: unknown[]) => {
    links.read(...args);
    const row = (
      ref: string,
      source: string,
      title: string,
      repository = { owner: 'acme', name: 'widgets' },
    ) => ({
      provider: 'github',
      host: 'github.com',
      repository,
      ref,
      source,
      observedAt: '2026-11-16T12:00:00Z',
      status: { state: 'current', title, pullRequestState: 'OPEN' },
    });
    return Promise.resolve({
      conversationId: 'c1',
      observedAt: '2026-11-16T12:00:00Z',
      links: [
        // Typed with the forge's capitals: still the same pull request.
        row('42', 'explicit', 'Linked by hand', {
          owner: 'Acme',
          name: 'Widgets',
        }),
        row('42', 'branch-derived', 'Linked by hand'),
        row('43', 'branch-derived', 'Opened by the Task'),
      ],
    });
  },
  linkConversationPullRequest: vi.fn(),
  unlinkConversationPullRequest: vi.fn(),
}));
const sdk = vi.hoisted(() => ({
  remove: vi.fn(async () => undefined),
  /** Whether #43's switches are on (it is owned here either way). */
  on43: true,
  viewerMayChange: true as boolean | undefined,
  readFails: false,
}));
vi.mock('@kontourai/station-sdk/pull-request-feedback', () => {
  const view = (ref: string): PullRequestFeedbackView => ({
    identity: {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'acme', name: 'widgets' },
      ref,
    },
    ownedHere: true,
    owner: { conversationId: 'c1' },
    settings: {
      fixFailingChecks: ref !== '43' || sdk.on43,
      addressReviewComments: ref !== '43' || sdk.on43,
      reviewEachHead: false,
    },
    status: ref !== '43' || sdk.on43 ? { state: 'watching' } : { state: 'off' },
    history: [],
  });
  return {
    pullRequestFeedbackOwnerOf: () => undefined,
    readPullRequestFeedbackCapability: vi.fn(async () => true),
    getConversationPullRequestFeedback: () =>
      sdk.readFails
        ? Promise.reject(new Error('Permission refresh failed'))
        : Promise.resolve({
            conversationId: 'c1',
            viewerMayChange: sdk.viewerMayChange,
            pullRequests: [view('42'), view('43')],
          }),
    writePullRequestFeedback: vi.fn(),
    sendPullRequestFeedbackAgain: vi.fn(),
    turnOffPullRequestFeedback: vi.fn(),
    removeDerivedPullRequest: (...args: unknown[]) =>
      sdk.remove(...(args as [])),
  };
});

import { ConversationPullRequestLinks } from '../ConversationPullRequestLinks';

let client = new QueryClient();
function renderLinks() {
  client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ConversationPullRequestLinks conversationId="c1" />
    </QueryClientProvider>,
  );
}

async function menuOf(rowIndex: number, reference: string) {
  await screen.findByText('Opened by the Task');
  // The feedback read answers after the links: let it land.
  await act(async () => {});
  await waitFor(() =>
    expect(screen.getAllByText('Auto-fix on').length).toBe(2),
  );
  fireEvent.click(
    screen.getAllByRole('button', { name: `More actions for ${reference}` })[
      rowIndex
    ]!,
  );
  return screen.findByRole('menu');
}

beforeEach(() => {
  flags.preview = true;
  sdk.remove.mockClear();
  sdk.on43 = true;
  sdk.viewerMayChange = true;
  sdk.readFails = false;
  links.read.mockClear();
});
afterEach(cleanup);

describe('a pull request from the Task branch', () => {
  test.each(['revoked', 'failed-refresh'])(
    'an open removal confirmation stops when permission is %s',
    async (change) => {
      renderLinks();
      const menu = await menuOf(0, 'github.com/acme/widgets #43');
      fireEvent.click(
        within(menu).getByRole('menuitem', { name: 'Remove from this chat' }),
      );
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Remove from this chat',
      });
      if (change === 'revoked') sdk.viewerMayChange = false;
      else sdk.readFails = true;
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['pull-request-feedback'] });
      });
      await waitFor(() =>
        expect(
          within(dialog).getByRole('button', { name: 'Remove' }),
        ).toHaveProperty('disabled', true),
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
      expect(sdk.remove).not.toHaveBeenCalled();
    },
  );
  test.each([false, undefined])(
    'a reader cannot remove a branch PR when writer permission is %s',
    async (permission) => {
      sdk.viewerMayChange = permission;
      renderLinks();
      const menu = await menuOf(0, 'github.com/acme/widgets #43');
      expect(
        within(menu).queryByRole('menuitem', { name: 'Remove from this chat' }),
      ).toBeNull();
      expect(sdk.remove).not.toHaveBeenCalled();
    },
  );
  test("reads as from this Task's branch", async () => {
    renderLinks();
    await screen.findByText('Opened by the Task');
    expect(screen.getAllByText("from this Task's branch")).toHaveLength(2);
  });

  test('Agent feedback goes on the first row for a pull request only', async () => {
    renderLinks();
    const linked = await menuOf(0, 'github.com/Acme/Widgets #42');
    expect(
      within(linked).getByRole('menuitem', { name: 'Agent feedback…' }),
    ).toBeTruthy();
    expect(
      within(linked).getByRole('menuitem', { name: 'Unlink' }),
    ).toBeTruthy();
    fireEvent.keyDown(linked, { key: 'Escape' });
    const derivedDuplicate = await menuOf(0, 'github.com/acme/widgets #42');
    expect(
      within(derivedDuplicate).queryByRole('menuitem', {
        name: 'Agent feedback…',
      }),
    ).toBeNull();
    expect(
      within(derivedDuplicate).getByRole('menuitem', {
        name: 'Remove from this chat',
      }),
    ).toBeTruthy();
    fireEvent.keyDown(derivedDuplicate, { key: 'Escape' });
    const derivedOnly = await menuOf(0, 'github.com/acme/widgets #43');
    expect(
      within(derivedOnly).getByRole('menuitem', { name: 'Agent feedback…' }),
    ).toBeTruthy();
  });

  test('removing the branch row of a pull request also linked here says it stays linked', async () => {
    renderLinks();
    const menu = await menuOf(0, 'github.com/acme/widgets #42');
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Remove from this chat' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove from this chat',
    });
    expect(confirm.textContent).toContain(
      'acme/widgets #42 stays linked here, with its agent feedback. Only its Task-branch row goes.',
    );
    expect(confirm.textContent).not.toContain("won't come back");
  });

  test('removing one whose feedback is off here does not say it turns feedback off', async () => {
    sdk.on43 = false;
    renderLinks();
    await screen.findByText('Opened by the Task');
    await act(async () => {});
    await waitFor(() =>
      expect(screen.getAllByText('Auto-fix on').length).toBe(1),
    );
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'More actions for github.com/acme/widgets #43',
      })[0]!,
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Remove from this chat' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove from this chat',
    });
    expect(confirm.textContent).toContain(
      "Station stops showing acme/widgets #43 here. It won't come back for this Task.",
    );
    expect(confirm.textContent).not.toContain('turns its agent feedback off');
  });

  test('Remove from this chat asks first, then removes it and reads the list again', async () => {
    renderLinks();
    const menu = await menuOf(0, 'github.com/acme/widgets #43');
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Remove from this chat' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove from this chat',
    });
    expect(confirm.textContent).toContain(
      "Station stops showing acme/widgets #43 here and turns its agent feedback off. It won't come back for this Task.",
    );
    expect(sdk.remove).not.toHaveBeenCalled();
    const reads = links.read.mock.calls.length;
    const invalidated = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(sdk.remove).toHaveBeenCalledWith(
        'http://station.test',
        'c1',
        PR('43'),
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(links.read.mock.calls.length).toBeGreaterThan(reads),
    );
    // The chat's feedback and the Project's still-on count are read again.
    expect(
      invalidated.mock.calls.map(([filters]) => filters?.queryKey),
    ).toEqual(
      expect.arrayContaining([
        ['pull-request-feedback'],
        ['pull-request-feedback-defaults'],
      ]),
    );
  });

  test('offers no removal while agent feedback is off', async () => {
    flags.preview = false;
    renderLinks();
    await screen.findByText('Opened by the Task');
    // A derived row has nothing else to offer: no overflow at all.
    expect(
      screen.queryByRole('button', {
        name: 'More actions for github.com/acme/widgets #43',
      }),
    ).toBeNull();
    expect(screen.queryByText('Remove from this chat')).toBeNull();
  });
});
