/**
 * @vitest-environment jsdom
 *
 * The answer-scoped Chat inventory: what a per-answer Basis entry opens in the
 * dock. Real SDK query, real contract parser, real view model; only `fetch`
 * and the authority hook are replaced.
 *
 * `partial` is the exact projection a real Station returned for a real
 * colon-shaped session id while Surface could not resolve the answer: its
 * Basis answer is `unavailable`. Since #3853 the contract keeps such a
 * projection (partial owner outages preserve resolved regions), so it renders
 * its other groups. `refused()` is the same projection bound to a different
 * turn, which the contract still refuses for this scope. `accepted` is the
 * same projection with the answer resolved, built through the published
 * binding and Basis composers.
 */

import { createStationAnswerBinding } from '@kontourai/station-contracts/task-basis';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  composeBasisProjection,
  SURFACE_BASIS_VERSION,
} from '@kontourai/surface/basis';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import { useKeyboardShortcut } from '../../../hooks/useKeyboardShortcut';
import partial from './fixtures/current-answer-inventory.json';

const authority = vi.hoisted(() => ({
  apiBase: 'http://station.test',
  authorityKey: 'authority-a',
  isCurrent: () => true,
}));

vi.mock('../../../contexts/ApiBaseContext', async (original) => ({
  ...(await original<typeof import('../../../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => authority,
}));

const { SessionInventoryCompact } = await import('../SessionInventoryCompact');

const scope = {
  kind: 'current-answer' as const,
  sessionId: partial.scope.sessionId,
  turnId: partial.scope.turnId,
};

function accepted() {
  const binding = createStationAnswerBinding({
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    messageId: partial.basisBinding.answer.messageId,
  });
  const observedAt = '2026-10-19T16:10:00.000Z';
  return {
    ...partial,
    basisBinding: binding,
    basis: composeBasisProjection({
      version: SURFACE_BASIS_VERSION,
      answer: {
        owner: { authority: '@kontourai/thread' },
        state: 'available',
        observedAt,
        value: { ref: binding.answer, fact: 'answer-observed', observedAt },
      },
      assessment: {
        owner: { authority: '@kontourai/surface' },
        state: 'not-captured',
        observedAt,
      },
      contributions: [],
    }),
  };
}

/** Bound to another turn of the same session: refused for this scope. */
function refused() {
  return {
    ...partial,
    basisBinding: { ...partial.basisBinding, turnId: 'another-turn' },
  };
}

function ok(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// The SDK binds a scoped read to the connection's current authority; this
// is that connection, with no transport of its own, so reads use `fetch`.
beforeEach(() => {
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  }));
});
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function renderCompact(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <SessionInventoryCompact
        scope={scope}
        density="aside"
        chatStoreId={scope.sessionId}
        onClose={() => {}}
        onOpenFull={() => {}}
      />
    </QueryClientProvider>,
  );
  return client;
}

describe('SessionInventoryCompact, current-answer scope', () => {
  test('Escape closes inventory without also firing the real parent navigation shortcut', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(accepted())),
    );
    const navigateParent = vi.fn();
    const close = vi.fn();
    function ParentNavigation() {
      useKeyboardShortcut(
        'app.escapeUp',
        'Escape',
        [],
        'Go up one level',
        navigateParent,
        true,
        -100,
      );
      return null;
    }
    render(
      <KeyboardShortcutsProvider>
        <ParentNavigation />
        <QueryClientProvider client={new QueryClient()}>
          <SessionInventoryCompact
            scope={scope}
            density="aside"
            chatStoreId={scope.sessionId}
            onClose={close}
            onOpenFull={() => {}}
          />
        </QueryClientProvider>
      </KeyboardShortcutsProvider>,
    );
    await screen.findByRole('heading', { name: 'Chat inventory' });
    fireEvent.keyDown(screen.getByLabelText('Chat inventory'), {
      key: 'Escape',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(navigateParent).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(navigateParent).toHaveBeenCalledOnce();
  });

  test('a colon-shaped session id renders its inventory after the first read', async () => {
    expect(scope.sessionId).toMatch(/^[a-z]+:\d+$/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(accepted())),
    );
    renderCompact();

    expect(
      await screen.findByRole('heading', { name: 'Chat inventory' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Inventory highlights' }).textContent,
    ).toContain('Inputs');
  });

  test('a background refetch keeps the loaded inventory on screen', async () => {
    let release: (() => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ok(accepted()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(ok(accepted()));
          }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = renderCompact();
    await screen.findByRole('heading', { name: 'Chat inventory' });

    act(() => {
      void client.invalidateQueries({ queryKey: ['session-inventory'] });
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // In flight: the inventory stays; no skeleton replaces it.
    expect(
      screen.getByRole('heading', { name: 'Chat inventory' }),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Loading Chat inventory')).toBeNull();
    await act(async () => release?.());
    expect(
      screen.getByRole('heading', { name: 'Chat inventory' }),
    ).toBeTruthy();
  });

  test("an unavailable Basis answer keeps the scope's other groups (#3853)", async () => {
    expect(partial.basis.answer.state).toBe('unavailable');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(partial)),
    );
    renderCompact();

    expect(
      await screen.findByRole('heading', { name: 'Chat inventory' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Inventory highlights' }).textContent,
    ).toContain('Inputs');
    expect(screen.queryByText('Chat inventory is unavailable.')).toBeNull();
  });

  test('a refused projection settles as unavailable, with Retry, after one read', async () => {
    const fetchMock = vi.fn(async () => ok(refused()));
    vi.stubGlobal('fetch', fetchMock);
    renderCompact();

    expect(
      await screen.findByText('Chat inventory is unavailable.'),
    ).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('the loading state is the same sized aside as the loaded one', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderCompact();
    const loading = screen.getByLabelText('Chat inventory');
    expect(loading.className).toContain('session-inventory-compact--aside');
  });
});
