/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The operator's shared-answer management list (station#1423).
 *
 * Fixture completeness is deliberate here: every member of `AnswerShareState`
 * — `'active'`, `'revoked'`, `'expired'` — is rendered by a test below, so
 * the state copy table cannot gain a member whose sentence nobody ever
 * looked at (the #1184 discipline).
 */

const revokeMutate = vi.fn();
const sharesQuery = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  error: null as unknown,
  refetch: vi.fn(),
};

vi.mock('@kontourai/station-sdk', () => ({
  useAnswerSharesQuery: () => sharesQuery,
  useRevokeAnswerShareMutation: () => ({
    mutate: revokeMutate,
    isError: false,
    error: null,
  }),
}));

const { AnswerSharesSection } = await import(
  '../views/settings/AnswerSharesSection'
);

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share-1',
    sessionId: 'thread-1',
    turnId: 'turn-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z',
    state: 'active',
    ...overrides,
  };
}

beforeEach(() => {
  revokeMutate.mockClear();
  sharesQuery.data = undefined;
  sharesQuery.isLoading = false;
  sharesQuery.isError = false;
  sharesQuery.error = null;
});

describe('AnswerSharesSection', () => {
  it('describes a live share as live, in a sentence rather than a status word', () => {
    sharesQuery.data = [share({ state: 'active' })];
    const { container } = render(<AnswerSharesSection />);
    expect(container.textContent).toContain(
      'Live — anyone with the link can read this answer',
    );
  });

  it('describes a revoked share as revoked, and says the link now says so', () => {
    sharesQuery.data = [
      share({ state: 'revoked', revokedAt: '2026-08-02T00:00:00.000Z' }),
    ];
    const { container } = render(<AnswerSharesSection />);
    expect(container.textContent).toContain(
      'Revoked — the link now says so and shows nothing',
    );
    // A revoked share keeps its row rather than vanishing, so the operator
    // can see what they turned off and when.
    expect(container.textContent).toContain('revoked');
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
  });

  it('describes an expired share as expired', () => {
    sharesQuery.data = [share({ state: 'expired' })];
    const { container } = render(<AnswerSharesSection />);
    expect(container.textContent).toContain(
      'Expired — the link now says so and shows nothing',
    );
  });

  it('takes two deliberate clicks to revoke', () => {
    sharesQuery.data = [share()];
    render(<AnswerSharesSection />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke share of turn turn-1' }),
    );
    expect(revokeMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(revokeMutate).toHaveBeenCalledWith('share-1', expect.anything());
  });

  it('abandons a revoke on cancel', () => {
    sharesQuery.data = [share()];
    render(<AnswerSharesSection />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke share of turn turn-1' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(revokeMutate).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Revoke share of turn turn-1' }),
    ).toBeTruthy();
  });

  it('never renders a token or a digest', () => {
    sharesQuery.data = [share()];
    const { container } = render(<AnswerSharesSection />);
    // The store keeps only a digest and the summary carries neither; this
    // pins that the row has nothing capability-shaped to display.
    expect(container.textContent).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it('names an unparseable timestamp instead of printing an epoch date', () => {
    sharesQuery.data = [share({ createdAt: 'nonsense' })];
    const { container } = render(<AnswerSharesSection />);
    expect(container.textContent).toContain('date not recorded');
    expect(container.textContent).not.toContain('1970');
  });

  it('says nothing has been shared rather than rendering an empty list', () => {
    sharesQuery.data = [];
    const { container } = render(<AnswerSharesSection />);
    expect(container.textContent).toContain('Nothing shared yet');
  });

  it('reports a failed listing as a failure, not as an empty list', () => {
    sharesQuery.isError = true;
    sharesQuery.error = new Error('boom');
    const { container } = render(<AnswerSharesSection />);
    expect(container.textContent).toContain(
      'Shared answers could not be listed',
    );
    expect(container.textContent).not.toContain('Nothing shared yet');
  });
});
