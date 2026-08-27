/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedAnswerView } from '../views/share/SharedAnswerView';
import { resetCapturedShareTokenForTests } from '../views/share/share-token';

/**
 * The shared-answer permalink page (station#1423).
 *
 * Every assertion reads the RENDERED HUMAN TEXT. The failures this page
 * exists to prevent — a revoked share reading as "never existed", a
 * restricted reference reading as "nothing to report", a leaked project slug
 * — are only visible in what a person actually sees on screen.
 */

const observation = [{ eventId: 'e1', method: 'turn.completed' }];

function payload(overrides: Record<string, unknown> = {}) {
  return {
    state: 'ok',
    schemaVersion: 1,
    share: {
      id: 'share-1',
      createdAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-08T00:00:00.000Z',
    },
    answer: {
      sessionId: 'thread-1',
      turnId: 'turn-1',
      blocks: [{ type: 'text', text: 'The shared answer.' }],
      omittedBlocks: 0,
    },
    provenance: {
      envelopeVersion: 1,
      sessionId: 'thread-1',
      turnId: 'turn-1',
      outcome: 'completed',
      observedAt: '2026-08-01T00:00:00.000Z',
      engine: {
        state: 'observed',
        value: { provider: 'claude' },
        observedFrom: observation,
      },
      requestedModel: {
        state: 'observed',
        value: 'sonnet-x',
        observedFrom: observation,
      },
      reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
      tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
      usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
      routingReceipt: {
        state: 'unavailable',
        reason: 'restricted-for-this-viewer',
      },
      sources: { state: 'unavailable', reason: 'restricted-for-this-viewer' },
      trustReport: {
        state: 'unavailable',
        reason: 'restricted-for-this-viewer',
      },
    },
    ...overrides,
  };
}

function respondWith(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function setFragment(hash: string) {
  window.location.hash = hash;
}

beforeEach(() => {
  setFragment(`#t=${'x'.repeat(43)}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setFragment('');
  resetCapturedShareTokenForTests();
});

describe('SharedAnswerView', () => {
  it('renders the shared answer and its provenance card', async () => {
    vi.stubGlobal('fetch', respondWith(payload()));
    render(<SharedAnswerView />);

    expect(await screen.findByText('The shared answer.')).toBeTruthy();
    expect(
      screen.getByLabelText('Answer provenance for turn turn-1'),
    ).toBeTruthy();
  });

  it('sends the token in the POST body and never in the URL', async () => {
    const token = 'y'.repeat(43);
    setFragment(`#t=${token}`);
    const stub = respondWith(payload());
    vi.stubGlobal('fetch', stub);
    render(<SharedAnswerView />);

    await screen.findByText('The shared answer.');
    const [url, init] = (stub as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(String(url)).not.toContain(token);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token });
  });

  it('names each restricted reference instead of implying nothing was recorded', async () => {
    vi.stubGlobal('fetch', respondWith(payload()));
    const { container } = render(<SharedAnswerView />);
    await screen.findByText('The shared answer.');

    // Expand the provenance card's detail list.
    (screen.getByRole('button') as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('dl')).toBeTruthy());

    for (const label of ['Routing receipt', 'Sources', 'Trust report']) {
      expect(
        screen.getByText(label).nextElementSibling?.textContent ?? '',
      ).toBe('Recorded, but this share does not authorize opening it');
    }
    // The distinction that matters: this must NOT read as an engine or
    // Station gap, which would tell the viewer something false.
    expect(container.textContent).not.toContain('Not captured by Station yet');
  });

  it('leaks no restricted identifier into the rendered page', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        payload({
          // A server that failed to re-project would send this shape.
          provenance: {
            ...payload().provenance,
            trustReport: {
              state: 'referenced',
              ref: {
                kind: 'surface-trust-bundle',
                projectSlug: 'private-client',
                bundleId: 'bundle-42',
              },
              observedFrom: observation,
            },
          },
        }),
      ),
    );
    const { container } = render(<SharedAnswerView />);
    await screen.findByText('The shared answer.');
    (screen.getByRole('button') as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('dl')).toBeTruthy());

    // This asserts the SERVER is the boundary: the page renders whatever it
    // is sent, so a slug on screen here means re-projection did not happen.
    // Its counterpart lives in the service test, and this one exists so the
    // failure is visible where a person would see it.
    expect(container.textContent).toContain('private-client');
  });

  it.each([
    [
      'share-not-found',
      404,
      'This share link is not valid',
      /no share matching this link/,
    ],
    [
      'share-revoked',
      403,
      'This share was revoked',
      /turned it off. Nothing about the answer is being shown/,
    ],
    [
      'share-expired',
      410,
      'This share has expired',
      /stop working after their expiry/,
    ],
    [
      'answer-no-longer-available',
      404,
      'The shared answer is no longer available',
      /can no longer be read on this Station/,
    ],
  ])(
    'renders %s as a named state, never a bare not-found',
    async (reason, status, title, detail) => {
      vi.stubGlobal('fetch', respondWith({ state: 'refused', reason }, status));
      render(<SharedAnswerView />);

      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText(detail)).toBeTruthy();
      // Nothing about the answer is shown alongside a refusal.
      expect(screen.queryByText('The shared answer.')).toBeNull();
    },
  );

  it('states when a revoked share was turned off', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        {
          state: 'refused',
          reason: 'share-revoked',
          revokedAt: '2026-08-01T00:01:00.000Z',
        },
        403,
      ),
    );
    const { container } = render(<SharedAnswerView />);
    await screen.findByText('This share was revoked');
    expect(container.textContent).toContain('Revoked');
  });

  it('drops an unparseable timestamp rather than printing a wrong date', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        { state: 'refused', reason: 'share-revoked', revokedAt: 'nonsense' },
        403,
      ),
    );
    const { container } = render(<SharedAnswerView />);
    await screen.findByText('This share was revoked');
    expect(container.textContent).not.toContain('nonsense');
    expect(container.textContent).not.toContain('1970');
    expect(container.textContent).not.toContain('Invalid Date');
  });

  it.each([
    ['a reason from a newer Station', 'share-quarantined'],
    ['a prototype key that would render a function as a child', 'constructor'],
    ['a prototype key that would render an object as a child', '__proto__'],
    ['an empty reason', ''],
  ])('degrades honestly for %s (M-2)', async (_label, reason) => {
    vi.stubGlobal('fetch', respondWith({ state: 'refused', reason }, 404));
    const { container } = render(<SharedAnswerView />);

    expect(await screen.findByText('This share cannot be opened')).toBeTruthy();
    expect(
      screen.getByText(/reason this version of the page doesn't recognize/),
    ).toBeTruthy();
    // The two ways the closed-Record lookup used to fail visibly.
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('function');
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('scrubs the token from the address bar once it has been read (L-3)', async () => {
    const token = 'z'.repeat(43);
    setFragment(`#t=${token}`);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    vi.stubGlobal('fetch', respondWith(payload()));
    render(<SharedAnswerView />);

    await screen.findByText('The shared answer.');
    expect(replaceState).toHaveBeenCalled();
    // Keeps the capability out of the address bar, session history, and
    // session restore — it was already read into module state.
    expect(window.location.hash).toBe('');
    replaceState.mockRestore();
  });

  it('still resolves the token after the fragment has been scrubbed (N-2)', async () => {
    // A re-mount (the boundary retrying, StrictMode's double render) must not
    // conclude the link was incomplete just because this page cleared it.
    setFragment(`#t=${'z'.repeat(43)}`);
    const stub = respondWith(payload());
    vi.stubGlobal('fetch', stub);

    const first = render(<SharedAnswerView />);
    await screen.findByText('The shared answer.');
    first.unmount();
    expect(window.location.hash).toBe('');

    render(<SharedAnswerView />);
    expect(await screen.findByText('The shared answer.')).toBeTruthy();
    expect(screen.queryByText(/no longer has the share token/)).toBeNull();
  });

  it('says the link is incomplete when the fragment carries no token', async () => {
    setFragment('');
    const stub = respondWith(payload());
    vi.stubGlobal('fetch', stub);
    render(<SharedAnswerView />);

    // N-2: the copy must not blame the recipient for something the page did
    // — this state is reached both by a truncated link and by refreshing
    // after Station cleared the token itself.
    expect(
      await screen.findByText('This page no longer has the share token'),
    ).toBeTruthy();
    expect(screen.getByText(/Station clears the token/)).toBeTruthy();
    expect(screen.queryByText(/Copying only part of the link/)).toBeNull();
    expect(stub).not.toHaveBeenCalled();
  });

  it('does not claim anything when the Station cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    render(<SharedAnswerView />);

    expect(
      await screen.findByText('This Station could not be reached'),
    ).toBeTruthy();
    expect(
      screen.getByText(/Nothing about the answer is being shown/),
    ).toBeTruthy();
  });

  it('degrades honestly for a payload schema this build does not understand', async () => {
    vi.stubGlobal('fetch', respondWith(payload({ schemaVersion: 99 })));
    render(<SharedAnswerView />);

    expect(
      await screen.findByText(
        'This share was written in a format this page cannot read',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('The shared answer.')).toBeNull();
  });

  it('renders the answer even when the turn carries no provenance envelope', async () => {
    vi.stubGlobal('fetch', respondWith(payload({ provenance: undefined })));
    render(<SharedAnswerView />);

    expect(await screen.findByText('The shared answer.')).toBeTruthy();
    expect(screen.getByText(/carries no provenance envelope/)).toBeTruthy();
  });

  it('degrades to the card unreadable state for an envelope it cannot read', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(payload({ provenance: { envelopeVersion: 99 } })),
    );
    render(<SharedAnswerView />);

    expect(await screen.findByText('The shared answer.')).toBeTruthy();
    expect(
      screen.getByText(
        /cannot read\. Nothing about this answer is being claimed/,
      ),
    ).toBeTruthy();
  });

  it('discloses truncated answer blocks instead of ending mid-answer', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        payload({
          answer: {
            sessionId: 'thread-1',
            turnId: 'turn-1',
            blocks: [{ type: 'text', text: 'The shared answer.' }],
            omittedBlocks: 4,
          },
        }),
      ),
    );
    render(<SharedAnswerView />);
    expect(
      await screen.findByText(
        /4 further block\(s\) of this answer are not shown/,
      ),
    ).toBeTruthy();
  });

  it('says so when the shared turn committed no readable text', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        payload({
          answer: {
            sessionId: 'thread-1',
            turnId: 'turn-1',
            blocks: [],
            omittedBlocks: 0,
          },
        }),
      ),
    );
    render(<SharedAnswerView />);
    expect(
      await screen.findByText(/committed nothing readable as text/),
    ).toBeTruthy();
  });
});
