/** @vitest-environment jsdom */
import type { AnswerShareSummary } from '@kontourai/station-contracts/answer-share';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The operator's shared-answer management list (archive#1423).
 *
 * Fixture completeness is deliberate here: every member of `AnswerShareState`
 * — `'active'`, `'revoked'`, `'expired'` — is rendered by a test below, so
 * the state copy table cannot gain a member whose sentence nobody ever
 * looked at (the #1184 discipline).
 */

const revokeMutate = vi.fn();
const sdkHooks = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));
const sharesQuery = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  error: null as unknown,
  refetch: vi.fn(),
};

vi.mock('@kontourai/station-sdk', () => ({
  useAnswerSharesQuery: sdkHooks.list,
  useRevokeAnswerShareMutation: sdkHooks.revoke,
}));

const { AnswerSharesSection } = await import(
  '../views/settings/AnswerSharesSection'
);

function share(
  overrides: Partial<AnswerShareSummary> = {},
): AnswerShareSummary {
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
  sdkHooks.list.mockReset().mockImplementation(() => sharesQuery);
  sdkHooks.revoke.mockReset().mockImplementation(() => ({
    mutate: revokeMutate,
    isError: false,
    error: null,
  }));
  revokeMutate.mockClear();
  sharesQuery.data = undefined;
  sharesQuery.isLoading = false;
  sharesQuery.isError = false;
  sharesQuery.error = null;
});

afterEach(() => {
  setClientCredentialResolver();
  vi.unstubAllGlobals();
});

async function renderRealShares() {
  const sdk = await vi.importActual<typeof import('@kontourai/station-sdk')>(
    '@kontourai/station-sdk',
  );
  sdkHooks.list.mockImplementation(sdk.useAnswerSharesQuery);
  sdkHooks.revoke.mockImplementation(sdk.useRevokeAnswerShareMutation);
  const origin = 'http://station.test';
  sdk._setApiBase(origin);
  let current = true;
  setClientCredentialResolver(() => ({
    origin,
    credential: 'fixture-operator',
    transportBindingIsCurrent: () => current,
    mutationAllowed: () => current,
  }));
  let records = [share(), share({ id: 'share-2', turnId: 'turn-2' })];
  const pending = new Map<string, (response: Response) => void>();
  const requests: string[] = [];
  const response = (data: unknown) => Response.json({ success: true, data });
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (
        url.origin === origin &&
        url.pathname === '/api/shares' &&
        method === 'GET'
      ) {
        return response(records);
      }
      const id = url.pathname.slice('/api/shares/'.length);
      if (
        url.origin === origin &&
        method === 'DELETE' &&
        records.some((record) => record.id === id)
      ) {
        requests.push(id);
        return new Promise<Response>((resolve) => pending.set(id, resolve));
      }
      throw new Error(
        `Unexpected share fixture request: ${method} ${url.href}`,
      );
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AnswerSharesSection />
    </QueryClientProvider>,
  );
  const finish = (id: string, status = 200) => {
    const resolve = pending.get(id);
    if (!resolve) throw new Error(`No pending revoke for ${id}`);
    pending.delete(id);
    if (status === 200) {
      records = records.map((record) =>
        record.id === id ? { ...record, state: 'revoked' } : record,
      );
      resolve(response(records.find((record) => record.id === id)));
    } else {
      resolve(
        Response.json(
          { success: false, error: 'Revoke unavailable' },
          { status },
        ),
      );
    }
  };
  return {
    pending,
    requests,
    finish,
    retire: () => {
      current = false;
    },
    dispose: () => {
      view.unmount();
      for (const resolve of pending.values())
        resolve(
          Response.json(
            { success: false, error: 'Fixture disposed' },
            { status: 503 },
          ),
        );
      pending.clear();
      client.clear();
      sdk._setApiBase('');
    },
  };
}

async function confirmRevoke(turnId: string) {
  fireEvent.click(
    await screen.findByRole('button', {
      name: `Revoke share of turn ${turnId}`,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
}

describe('AnswerSharesSection', () => {
  it('keeps concurrent SDK revokes pending independently and retries only the failed share', async () => {
    const fixture = await renderRealShares();
    try {
      await confirmRevoke('turn-1');
      await waitFor(() => expect(fixture.pending.has('share-1')).toBe(true));
      await confirmRevoke('turn-2');
      await waitFor(() => expect(fixture.pending.has('share-2')).toBe(true));
      expect(
        screen
          .getByRole('button', { name: 'Revoke share of turn turn-1' })
          .hasAttribute('disabled'),
      ).toBe(true);
      expect(
        screen
          .getByRole('button', { name: 'Revoke share of turn turn-2' })
          .hasAttribute('disabled'),
      ).toBe(true);
      fixture.finish('share-1', 503);
      await waitFor(() =>
        expect(
          screen
            .getByRole('button', { name: 'Revoke share of turn turn-1' })
            .hasAttribute('disabled'),
        ).toBe(false),
      );
      expect(
        screen
          .getByRole('button', { name: 'Revoke share of turn turn-2' })
          .hasAttribute('disabled'),
      ).toBe(true);
      await confirmRevoke('turn-1');
      await waitFor(() =>
        expect(fixture.requests).toEqual(['share-1', 'share-2', 'share-1']),
      );
      fixture.finish('share-2');
      fixture.finish('share-1');
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /Revoke share/ }),
        ).toBeNull(),
      );
      expect(screen.queryByText('This share could not be revoked')).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it('rejects a delayed SDK revoke response after transport authority retires without affecting another share', async () => {
    const fixture = await renderRealShares();
    try {
      await confirmRevoke('turn-1');
      await waitFor(() => expect(fixture.pending.has('share-1')).toBe(true));
      fixture.retire();
      fixture.finish('share-1');
      expect(
        await screen.findByText(
          /requested Station authority is no longer available/,
        ),
      ).toBeTruthy();
      expect(
        screen
          .getByRole('button', { name: 'Revoke share of turn turn-2' })
          .hasAttribute('disabled'),
      ).toBe(false);
      expect(
        screen.getAllByText('Live — anyone with the link can read this answer'),
      ).toHaveLength(2);
      expect(fixture.requests).toEqual(['share-1']);
    } finally {
      fixture.dispose();
    }
  });

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
    expect(revokeMutate).toHaveBeenCalledWith('share-1');
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
    // "Share answer" lives in the Provenance dialog that TurnActionsMenu's
    // "Answer details" item opens, not beneath the answer (#4406: the copy
    // named a "Turn provenance" item that does not exist).
    expect(container.textContent).toContain('choose Answer details');
    expect(container.textContent).not.toContain('Turn provenance');
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
