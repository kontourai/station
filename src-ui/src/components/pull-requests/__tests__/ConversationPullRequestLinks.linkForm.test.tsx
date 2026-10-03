// @vitest-environment jsdom

import { StationHttpError } from '@kontourai/station-sdk/client';
import { getConversationPullRequestLinks } from '@kontourai/station-sdk/conversation-pull-request-links';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * The manual link form is the pull requests panel's job (open by default
 * there) and a rare action in a session's Details (collapsed there). One
 * component, one prop, both consumers.
 */

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'k',
    isCurrent: () => true,
  }),
}));
vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: vi.fn().mockResolvedValue({
    conversationId: 'c1',
    observedAt: '2026-09-29T00:00:00Z',
    links: [],
  }),
  linkConversationPullRequest: vi.fn(),
  unlinkConversationPullRequest: vi.fn(),
}));

import { ConversationPullRequestLinks } from '../ConversationPullRequestLinks';

function renderLinks(linkFormCollapsed?: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationPullRequestLinks
        conversationId="c1"
        linkFormCollapsed={linkFormCollapsed}
      />
    </QueryClientProvider>,
  );
}

const disclosure = () =>
  screen
    .getByText('Link a pull request')
    .closest('details') as HTMLDetailsElement;

describe('ConversationPullRequestLinks link form', () => {
  test('is open by default (the pull requests panel)', () => {
    renderLinks();
    expect(disclosure().open).toBe(true);
  });

  test('is collapsed when the consumer asks (a session’s Details)', () => {
    renderLinks(true);
    expect(disclosure().open).toBe(false);
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
  expect(await screen.findByText('Unknown conversation.')).toBeTruthy();
  expect(screen.queryByText(/conversationId/)).toBeNull();
});
