// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  connectionIndicatorActionLabel,
  connectionIndicatorLabel,
  connectionIndicatorState,
} from '../core/connectionIndicator';
import { ConnectionStatusDot } from '../react/ConnectionStatusDot';

/**
 * station#3297 part 2 — the credential-required state must be distinguishable
 * WITHOUT hover and WITHOUT relying on colour alone.
 *
 * Before this, the only thing separating "reconnecting, ignore it" from
 * "re-pair me" was a `title` tooltip (`HeaderActions.tsx`, station#1094). A
 * touch device has no hover, so on a phone that distinction did not exist.
 */
describe('connectionIndicatorState', () => {
  it('names the credential state only for an observed credential rejection', () => {
    expect(
      connectionIndicatorState({
        status: 'error',
        reason: 'authentication-failed',
      }),
    ).toBe('needs-credential');
  });

  it.each([
    'unreachable',
    'timeout',
    'undetermined',
    'unsupported-capability-version',
    'origin-not-allowed',
  ] as const)('leaves an ordinary %s failure as a plain error', (reason) => {
    expect(connectionIndicatorState({ status: 'error', reason })).toBe('error');
  });

  // station#4512 — the host answered but its identity changed underneath the
  // connection. No amount of retrying fixes this, so it gets its own state
  // rather than the generic `error` a genuinely unreachable host produces.
  it('names identity-mismatch as needing repair, not a plain error', () => {
    expect(
      connectionIndicatorState({
        status: 'error',
        reason: 'identity-mismatch',
      }),
    ).toBe('needs-repair');
  });

  it('never shows the repair badge for a connection that is not failing', () => {
    expect(
      connectionIndicatorState({
        status: 'connected',
        reason: 'identity-mismatch',
      }),
    ).toBe('connected');
  });

  // station#4512 — a locally-tracked pending access request is an independent
  // fact from `reason`: a device with no credential yet 401s on every probe,
  // which looks identical to a dead host. `pendingApproval` takes precedence
  // over every other reading, mirroring `ConnectionBannerSource`'s own
  // `!pendingApproval` gate.
  describe('pendingApproval precedence', () => {
    it('reads as awaiting-approval over an ordinary authentication failure', () => {
      expect(
        connectionIndicatorState({
          status: 'error',
          reason: 'authentication-failed',
          pendingApproval: true,
        }),
      ).toBe('awaiting-approval');
    });

    it('reads as awaiting-approval even over identity-mismatch', () => {
      expect(
        connectionIndicatorState({
          status: 'error',
          reason: 'identity-mismatch',
          pendingApproval: true,
        }),
      ).toBe('awaiting-approval');
    });

    it('reads as awaiting-approval with no reason at all', () => {
      expect(
        connectionIndicatorState({
          status: 'error',
          reason: null,
          pendingApproval: true,
        }),
      ).toBe('awaiting-approval');
    });

    it('does not apply to a non-error status', () => {
      expect(
        connectionIndicatorState({
          status: 'connected',
          reason: null,
          pendingApproval: true,
        }),
      ).toBe('connected');
    });

    it('is a no-op when omitted, so existing callers are unaffected', () => {
      expect(
        connectionIndicatorState({
          status: 'error',
          reason: 'authentication-failed',
        }),
      ).toBe('needs-credential');
    });
  });

  // station#4512 review (M8) — a SECOND door to the same state:
  // `ConnectionFailureReason`'s own vocabulary already has an
  // `awaiting-approval` value (a native `mid_authorization` refusal
  // produces it directly, with no locally-persisted `pendingApproval`
  // record for a caller to observe at all). Before this fix, a caller that
  // only ever passed `pendingApproval` and a native caller producing this
  // reason landed on two DIFFERENT states for what the reason vocabulary
  // already called the same thing — the identical-name-unwired trap.
  describe('reason: awaiting-approval (independent of pendingApproval)', () => {
    it('reads as awaiting-approval from the reason alone, with no pendingApproval passed', () => {
      expect(
        connectionIndicatorState({
          status: 'error',
          reason: 'awaiting-approval',
        }),
      ).toBe('awaiting-approval');
    });

    it('reads as awaiting-approval from the reason alone, with pendingApproval explicitly false', () => {
      expect(
        connectionIndicatorState({
          status: 'error',
          reason: 'awaiting-approval',
          pendingApproval: false,
        }),
      ).toBe('awaiting-approval');
    });

    it('does not apply to a non-error status', () => {
      expect(
        connectionIndicatorState({
          status: 'connecting',
          reason: 'awaiting-approval',
        }),
      ).toBe('connecting');
    });
  });

  it('never shows the credential badge for a connection that is not failing', () => {
    // A stale reason surviving a recovery must not keep the badge on screen.
    expect(
      connectionIndicatorState({
        status: 'connected',
        reason: 'authentication-failed',
      }),
    ).toBe('connected');
    expect(
      connectionIndicatorState({
        status: 'connecting',
        reason: 'authentication-failed',
      }),
    ).toBe('connecting');
  });

  it('passes every non-error status straight through', () => {
    for (const status of ['connected', 'connecting', 'idle'] as const) {
      expect(connectionIndicatorState({ status, reason: null })).toBe(status);
    }
  });
});

describe('ConnectionStatusDot — shape, not colour alone', () => {
  function renderDot(
    status: Parameters<typeof ConnectionStatusDot>[0]['status'],
  ) {
    const { container } = render(<ConnectionStatusDot status={status} />);
    return container.firstElementChild as Element;
  }

  it('renders a different ELEMENT for needs-credential, not a recoloured dot', () => {
    // The load-bearing assertion: strip every colour and the two states are
    // still different marks. A colour-blind reader, a monochrome screenshot,
    // and a forced-colors mode all survive this; none survives a hue change.
    const credential = renderDot('needs-credential');
    const error = renderDot('error');
    expect(credential.tagName.toLowerCase()).toBe('svg');
    expect(error.tagName.toLowerCase()).toBe('span');
    expect(credential.querySelector('path')).not.toBeNull();
    // A disc is drawn by border-radius; the credential mark must not be one.
    expect((error as HTMLElement).style.borderRadius).toBe('50%');
    expect((credential as HTMLElement).style.borderRadius).toBe('');
  });

  it('carries an accessible name that is not the raw status token', () => {
    render(<ConnectionStatusDot status="needs-credential" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'needs pairing',
    );
  });

  it('keeps the three original states rendering exactly as before', () => {
    for (const status of [
      'connected',
      'connecting',
      'error',
      'idle',
    ] as const) {
      const { container, unmount } = render(
        <ConnectionStatusDot status={status} size={7} />,
      );
      const dot = container.firstElementChild as HTMLElement;
      expect(dot.tagName.toLowerCase()).toBe('span');
      expect(dot.getAttribute('aria-label')).toBe(status);
      expect(dot.style.width).toBe('7px');
      unmount();
    }
  });

  // station#4512
  it('gives needs-repair the same distinct-shape triangle as needs-credential', () => {
    const repair = renderDot('needs-repair');
    expect(repair.tagName.toLowerCase()).toBe('svg');
    expect(repair.querySelector('path')).not.toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'needs re-pairing',
    );
  });

  it('renders awaiting-approval as an ordinary (amber) circle, not a triangle', () => {
    const waiting = renderDot('awaiting-approval');
    expect(waiting.tagName.toLowerCase()).toBe('span');
    expect((waiting as HTMLElement).style.borderRadius).toBe('50%');
    expect(waiting.getAttribute('aria-label')).toBe('awaiting-approval');
  });
});

describe('connection indicator labels', () => {
  it('names the action, not just the state, when a decision is needed', () => {
    expect(connectionIndicatorLabel('needs-credential')).toBe(
      'Pair this device again',
    );
    expect(connectionIndicatorActionLabel('needs-credential')).toBe('Pair');
  });

  it('leaves the healthy control named exactly as it always was', () => {
    // The header control's identity in the E2E suite, including an exact
    // `button[title="Manage Stations"]` selector. Adding a state phrase to a
    // state with nothing to report would break it for no reader benefit.
    expect(connectionIndicatorLabel('connected')).toBe('Manage Stations');
  });

  it('offers no visible word for a state with nothing to do', () => {
    // This is what keeps the indicator subtle when nothing is wrong.
    for (const state of ['connected', 'connecting', 'error', 'idle'] as const) {
      expect(connectionIndicatorActionLabel(state)).toBeNull();
      expect(connectionIndicatorLabel(state)).toMatch(/manage stations/i);
    }
  });

  // station#4512
  it('gives awaiting-approval and needs-repair their own visible words', () => {
    expect(connectionIndicatorActionLabel('awaiting-approval')).toBe(
      'Awaiting approval',
    );
    expect(connectionIndicatorActionLabel('needs-repair')).toBe(
      'Needs re-pairing',
    );
    expect(connectionIndicatorLabel('awaiting-approval')).toBe(
      'Manage Stations — Awaiting approval',
    );
    expect(connectionIndicatorLabel('needs-repair')).toBe(
      'Manage Stations — Needs re-pairing',
    );
  });
});
