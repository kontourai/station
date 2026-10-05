// @vitest-environment jsdom

import { StationHttpError } from '@kontourai/station-sdk/client';
import { getConversationPullRequestLinks } from '@kontourai/station-sdk/conversation-pull-request-links';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * Linking a pull request is one field behind a `+`: closed by default in a
 * session's Details (a rare action), open where the consumer asks. The field
 * reads a number against the suggested repository.
 */

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'k',
    isCurrent: () => true,
  }),
}));
const linkConversationPullRequest = vi.fn(async () => ({}));
vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: vi.fn().mockResolvedValue({
    conversationId: 'c1',
    observedAt: '2026-09-29T00:00:00Z',
    links: [],
  }),
  linkConversationPullRequest: (...args: unknown[]) =>
    linkConversationPullRequest(...(args as [])),
  unlinkConversationPullRequest: vi.fn(),
}));

import { ConversationPullRequestLinks } from '../ConversationPullRequestLinks';

function renderLinks(linkFormCollapsed?: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationPullRequestLinks
        conversationId="c1"
        linkFormCollapsed={linkFormCollapsed}
        suggested={{
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'team', name: 'repo' },
        }}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('ConversationPullRequestLinks link field', () => {
  test('is closed by default (a session’s Details) and the plus opens it', () => {
    renderLinks();
    expect(screen.queryByRole('textbox')).toBeNull();
    const plus = screen.getByRole('button', { name: 'Link a pull request' });
    expect(plus.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(plus);
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Pull request' })).toBeTruthy();
    // No paragraph explains the field; no five-field form.
    expect(screen.queryByText(/provenance/)).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  test('is open when the consumer asks, and a number links against the suggested repository', async () => {
    renderLinks(false);
    const field = screen.getByRole('textbox', { name: 'Pull request' });
    const link = screen.getByRole('button', { name: 'Link' });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'nonsense' } });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: '17' } });
    fireEvent.click(link);
    await waitFor(() =>
      expect(linkConversationPullRequest).toHaveBeenCalledWith(
        'http://station.test',
        'c1',
        {
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'team', name: 'repo' },
          ref: '17',
        },
        expect.anything(),
      ),
    );
  });

  test('says "Nothing linked" in one line when the chat has no links', async () => {
    renderLinks();
    expect(await screen.findByText('Nothing linked')).toBeTruthy();
    expect(screen.queryByText(/appear here|yet\./)).toBeNull();
  });
});

// #2708 A-3b: the read's refusal shows the server's reason, not the
// field-qualified message the SDK throws for CLI readers.
test('an unavailable read shows its reason, not its field key', async () => {
  vi.mocked(getConversationPullRequestLinks).mockRejectedValueOnce(
    new StationHttpError(
      400,
      'Validation failed: conversationId Unknown conversation.',
      {
        details: {
          formErrors: [],
          fieldErrors: { conversationId: ['Unknown conversation.'] },
        },
      },
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConversationPullRequestLinks conversationId="c1" />
    </QueryClientProvider>,
  );
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Unknown conversation.');
  expect(alert.textContent).not.toContain('conversationId');
});

test('a refused link shows its reason, not its field key', async () => {
  linkConversationPullRequest.mockRejectedValueOnce(
    new StationHttpError(
      400,
      'Validation failed: ref Use a pull request number.',
      {
        details: {
          formErrors: [],
          fieldErrors: { ref: ['Use a pull request number.'] },
        },
      },
    ),
  );
  renderLinks(false);
  await screen.findByText('Nothing linked');
  fireEvent.change(screen.getByRole('textbox', { name: 'Pull request' }), {
    target: { value: '12' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Use a pull request number.',
  );
});
