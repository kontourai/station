/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveShareUiOrigin } from '../utils/shareUiOrigin';

/**
 * The mint affordance beside an answer (archive#1423).
 *
 * The claims worth pinning are honesty claims: the button mints for the turn
 * the ENVELOPE names (not a prop, not a position); a clipboard write that
 * failed is never reported as a copy; and the minted link stays on screen,
 * because the token exists exactly once and the server keeps only its digest.
 */

const mutate = vi.fn();
const mintState = { isPending: false, isError: false, error: null as unknown };

class FakeAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerShareAuthRequiredError';
  }
}

vi.mock('@kontourai/station-sdk', () => ({
  useMintAnswerShareMutation: () => ({ mutate, ...mintState }),
  AnswerShareAuthRequiredError: FakeAuthRequiredError,
}));

// The pairing path is lazy; this stands in for it so the 401 branch can be
// asserted without pulling the connect package into a unit test.
vi.mock('../components/chat/ShareAnswerPairingPrompt', () => ({
  ShareAnswerPairingPrompt: () => <span>PAIRING PATH OFFERED</span>,
}));

const { ShareAnswerButton } = await import(
  '../components/chat/ShareAnswerButton'
);

const observation = [{ eventId: 'e1', method: 'turn.completed' }];

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    envelopeVersion: 1,
    sessionId: 'thread-7',
    turnId: 'turn-9',
    outcome: 'completed',
    observedAt: '2026-08-01T00:00:00.000Z',
    engine: {
      state: 'observed',
      value: { provider: 'claude' },
      observedFrom: observation,
    },
    requestedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
    reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
    tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
    usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
    routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
    sources: { state: 'unavailable', reason: 'not-captured-by-station' },
    trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
    ...overrides,
  };
}

beforeEach(() => {
  mutate.mockReset();
  mintState.isPending = false;
  mintState.isError = false;
  mintState.error = null;
});

describe('ShareAnswerButton', () => {
  it.each([
    'tauri://localhost',
    'https://tauri.localhost',
    'http://tauri.localhost',
    'station://desktop',
    'null',
  ])(
    'fails closed for the non-network UI origin %s before minting',
    (uiOrigin) => {
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      render(<ShareAnswerButton provenance={envelope()} uiOrigin={uiOrigin} />);
      const button = screen.getByRole('button');
      // archive#2652 redesign: `aria-disabled`, not `disabled` — the control
      // stays reachable so activating it can explain WHY sharing is
      // unavailable (the explanation below only appears on that activation,
      // instead of printing under every answer forever).
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(button);

      expect(mutate).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByText(/Share link (copied|created)/)).toBeNull();
      expect(screen.queryByText(/share#t=/)).toBeNull();
      // #3689 removed the always-on per-turn alert — in a native shell every
      // answer is unshareable, so one beside each was noise firing before any
      // share intent existed. #3690 keeps that (asserted above, pre-click) and
      // answers the reachability half: the user has now ASKED, so the reason
      // is stated rather than left to a `title` no keyboard or touch user can
      // reach.
      expect(screen.getByRole('alert').textContent).toContain(
        'Open Station from a reachable HTTP(S) address',
      );
      expect(button.getAttribute('aria-label')).toContain(
        'Open Station from a reachable HTTP(S) address',
      );
      expect(button.getAttribute('title')).toContain(
        'Open Station from a reachable HTTP(S) address',
      );
    },
  );

  it('mints and copies an HTTPS fragment-token permalink', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mutate.mockImplementationOnce((_input, callbacks) => {
      callbacks?.onSuccess?.({
        token: 'https-token',
        permalink: 'https://server.invalid/share/https-token',
      });
    });

    render(
      <ShareAnswerButton
        provenance={envelope()}
        uiOrigin="https://station.example"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      'https://station.example/share#t=https-token',
    );
    expect(await screen.findByText(/Share link copied/)).toBeTruthy();
  });

  it.each(['http://localhost:5173', 'https://station.example'])(
    'verifies the network UI origin %s without changing it',
    (uiOrigin) => {
      expect(deriveShareUiOrigin(uiOrigin)).toEqual({
        verified: true,
        origin: uiOrigin,
      });
    },
  );

  it('mints for the session and turn the envelope names', () => {
    render(<ShareAnswerButton provenance={envelope()} />);
    fireEvent.click(screen.getByRole('button'));

    expect(mutate).toHaveBeenCalledWith(
      { sessionId: 'thread-7', turnId: 'turn-9' },
      expect.anything(),
    );
  });

  it.each([
    ['a version this build cannot read', { envelopeVersion: 99 }],
    ['a truncated envelope', { envelopeVersion: 1 }],
    ['a non-object payload', 'not-an-envelope'],
    ['nothing at all', undefined],
  ])('renders no affordance for %s', (_label, provenance) => {
    // An envelope that cannot be correlated to a turn cannot be shared: the
    // link would point at nothing. No button rather than a broken one.
    const { container } = render(
      <ShareAnswerButton provenance={provenance as unknown} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('reports a successful copy and keeps the link on screen', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    mutate.mockImplementation((_input, handlers) =>
      handlers.onSuccess({ share: {}, token: 'tok' }),
    );

    render(<ShareAnswerButton provenance={envelope()} />);
    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText(/Share link copied\. It expires in 7 days/),
    ).toBeTruthy();
    // The link stays rendered — a self-dismissing notification would take the
    // only copy of the token with it.
    expect(
      screen.getByText(`${window.location.origin}/share#t=tok`),
    ).toBeTruthy();
  });

  it('composes the permalink from the BROWSER origin, not anything the server sent', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mutate.mockImplementation((_input, handlers) =>
      // H-2: a server that (wrongly) volunteered an origin must not be the
      // one this component trusts. Behind the UI proxy the backend's own
      // Host names a port that serves neither the SPA nor /share.
      handlers.onSuccess({
        share: {},
        token: 'tok',
        permalink: 'http://backend-that-cannot-serve-this:3141/share#t=tok',
      }),
    );

    render(<ShareAnswerButton provenance={envelope()} />);
    fireEvent.click(screen.getByRole('button'));

    const expected = `${window.location.origin}/share#t=tok`;
    await screen.findByText(expected);
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(screen.queryByText(/backend-that-cannot-serve-this/)).toBeNull();
  });

  it('does not claim a copy that failed, and still surfaces the link', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    mutate.mockImplementation((_input, handlers) =>
      handlers.onSuccess({ share: {}, token: 'tok' }),
    );

    render(<ShareAnswerButton provenance={envelope()} />);
    fireEvent.click(screen.getByRole('button'));

    const status = await screen.findByText(/would not let Station copy it/);
    // Never "copied" — a browser can refuse the clipboard outright, and a
    // false claim here loses the token.
    expect(status.textContent).not.toContain('copied');
    expect(
      screen.getByText(`${window.location.origin}/share#t=tok`),
    ).toBeTruthy();
  });

  it("surfaces the server's own refusal rather than a generic failure", () => {
    mintState.isError = true;
    mintState.error = new Error('That turn has no answer on this Station.');
    render(<ShareAnswerButton provenance={envelope()} />);

    expect(screen.getByRole('alert').textContent).toBe(
      'That turn has no answer on this Station.',
    );
    expect(screen.queryByText(/share#t=/)).toBeNull();
  });

  it('offers the pairing path when the auth boundary refuses for want of a credential (H-1/N-4)', async () => {
    // Closing the mint floor means an unpaired browser now hits the auth
    // middleware, not the route. A bare error there would leave the operator
    // with no idea that pairing this browser is the fix.
    mintState.isError = true;
    mintState.error = new FakeAuthRequiredError(
      'This browser is not paired with Station yet, and sharing an answer needs it to be.',
    );
    render(<ShareAnswerButton provenance={envelope()} />);

    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain('not paired with Station');
    expect(alert).not.toContain('[object Object]');
    expect(await screen.findByText('PAIRING PATH OFFERED')).toBeTruthy();
  });

  it('does NOT offer the pairing path for a 403 (N-3)', async () => {
    // A 403 means a credential WAS presented and refused — an underscoped
    // device, or an origin refusal. "Pair this browser" is false there and
    // sends the operator to re-do something already done.
    mintState.isError = true;
    mintState.error = new Error(
      'This device is paired, but its access level does not allow managing shares.',
    );
    render(<ShareAnswerButton provenance={envelope()} />);

    expect(screen.getByRole('alert').textContent).toContain(
      'access level does not allow managing shares',
    );
    expect(screen.queryByText('PAIRING PATH OFFERED')).toBeNull();
  });
});
