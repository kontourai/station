/** @vitest-environment jsdom */
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared-answer page's channel panel and its version gate (station#1598).
 *
 * A sibling of `SharedAnswerView.test.tsx` rather than an addition to it: that
 * file drives the page through the real `share-token` module and asserts the
 * #1423 refusal ladder against rendered human text, while everything here
 * needs a stubbed token capture and a payload shape it does not know about.
 * Both files render the same component; neither shares fixtures with the
 * other.
 *
 * Fixture completeness is deliberate, the way `AnswerSharesSection.test.tsx`
 * covers every `AnswerShareState`: every member of the computed channel
 * status — `reported` in both supersession states and all four `unavailable`
 * reasons — is rendered by a test here, so the copy table cannot gain a
 * sentence nobody ever looked at.
 *
 * AC8's assertion is the L0 copy gate: the panel is producer-asserted
 * ("this Station reports…"), and the words "verified" and "proven" must not
 * appear in it until the signing slice lands. It is asserted here rather than
 * as a repo-wide grep because `verified` is a legitimate identifier elsewhere
 * — `channel-assurance.ts` has a field by that name — and a blunt gate would
 * flag it.
 */

vi.mock('../views/share/share-token', () => ({
  captureShareToken: () => 'tok-abcdefghijklmnop',
  reloadSharePage: vi.fn(),
}));

const { SharedAnswerView } = await import('../views/share/SharedAnswerView');

const COORDINATE = { channelId: 'chan-team-alpha', epoch: 3, seq: 412 };

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
    ...overrides,
  };
}

function serve(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        json: () => Promise.resolve(body),
      } as Response),
    ),
  );
}

async function renderShare(body: unknown) {
  serve(body);
  render(<SharedAnswerView />);
  await waitFor(() => {
    expect(screen.queryByText(/Opening the shared answer/)).toBeNull();
  });
}

function channelPanel(): HTMLElement {
  return screen.getByLabelText('Channel log');
}

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trap 1 / AC5 — the version gate is a SET, not an equality', () => {
  it('renders a legacy version-1 payload rather than the unsupported notice', async () => {
    // The defect this pins: bumping the minted constant to 2 while the viewer
    // compared for equality against it made EVERY existing share render "this
    // page cannot read this format".
    await renderShare(payload());
    expect(screen.getByText('The shared answer.')).toBeTruthy();
    expect(screen.queryByText(/format this page cannot read/i)).toBeNull();
  });

  it('renders a version-2 channel-bearing payload', async () => {
    await renderShare(
      payload({
        schemaVersion: 2,
        channel: {
          status: 'reported',
          coordinate: COORDINATE,
          supersession: 'current',
        },
      }),
    );
    expect(screen.getByText('The shared answer.')).toBeTruthy();
  });

  it('still refuses a version this build does not read', async () => {
    await renderShare(payload({ schemaVersion: 3 }));
    expect(screen.getByText(/format this page cannot read/i)).toBeTruthy();
    expect(screen.queryByText('The shared answer.')).toBeNull();
  });
});

describe('AC8 — the channel panel is producer-asserted L0 copy', () => {
  const STATUSES = [
    {
      name: 'reported / current',
      channel: {
        status: 'reported',
        coordinate: COORDINATE,
        supersession: 'current',
      },
      expect: /this Station reports this answer in its channel log/i,
    },
    {
      name: 'reported / superseded',
      channel: {
        status: 'reported',
        coordinate: COORDINATE,
        supersession: 'superseded',
      },
      expect: /a later entry superseding that one/i,
    },
    {
      name: 'not-in-channel',
      channel: { status: 'unavailable', reason: 'not-in-channel' },
      expect: /was not committed to a channel log/i,
    },
    {
      name: 'predates-channel-addressing',
      channel: {
        status: 'unavailable',
        reason: 'predates-channel-addressing',
      },
      expect: /before this Station recorded channel positions/i,
    },
    {
      name: 'history-not-served',
      channel: { status: 'unavailable', reason: 'history-not-served' },
      expect: /does not serve channel history to this page/i,
    },
    {
      name: 'coordinate-mismatch',
      channel: { status: 'unavailable', reason: 'coordinate-mismatch' },
      expect: /disagrees with what this Station reports/i,
    },
  ];

  it.each(STATUSES)('$name has its own sentence', async (entry) => {
    await renderShare(payload({ schemaVersion: 2, channel: entry.channel }));
    expect(within(channelPanel()).getByText(entry.expect)).toBeTruthy();
  });

  it.each(STATUSES)(
    '$name never says "verified" or "proven"',
    async (entry) => {
      // "because 'we did not check' must never render as 'it verified'"
      // (`receipt-chain.ts`). Nothing in this slice is signed, so nothing in
      // this panel may claim to have been checked from outside.
      await renderShare(payload({ schemaVersion: 2, channel: entry.channel }));
      expect(channelPanel().textContent ?? '').not.toMatch(/verified|proven/i);
    },
  );

  it('the two "nothing to report" states do not read as each other', async () => {
    await renderShare(
      payload({
        schemaVersion: 1,
        channel: { status: 'unavailable', reason: 'not-in-channel' },
      }),
    );
    const notInChannel = channelPanel().textContent ?? '';

    vi.unstubAllGlobals();
    await renderShare(
      payload({
        schemaVersion: 1,
        channel: {
          status: 'unavailable',
          reason: 'predates-channel-addressing',
        },
      }),
    );
    const predates =
      screen.getAllByLabelText('Channel log')[1]?.textContent ?? '';

    expect(notInChannel).not.toBe(predates);
    expect(notInChannel).toMatch(/not committed to a channel log/i);
    expect(predates).toMatch(/nobody looked/i);
  });

  it('an unrecognised reason still says something, and claims nothing', async () => {
    // M-2. `reason` arrives off the wire, so a newer Station's reason must
    // not index a closed Record — and `constructor` must not return a
    // prototype member as a React child.
    for (const reason of ['invented-by-a-newer-station', 'constructor']) {
      vi.unstubAllGlobals();
      await renderShare(
        payload({
          schemaVersion: 2,
          channel: { status: 'unavailable', reason },
        }),
      );
    }
    const panels = screen.getAllByLabelText('Channel log');
    for (const panel of panels) {
      expect(panel.textContent ?? '').toMatch(/doesn't recognize/i);
      expect(panel.textContent ?? '').not.toMatch(/verified|proven/i);
    }
  });

  it('renders no panel at all when the payload carries no channel field', async () => {
    // A Station older than #1598. Inventing a status on the client would be
    // the read-time derivation this slice refuses.
    await renderShare(payload());
    expect(screen.queryByLabelText('Channel log')).toBeNull();
  });
});
