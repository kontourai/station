/** @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ConversationOpenRecoveryNotice,
  type ConversationOpenRecoveryNoticeProps,
} from '../ConversationOpenRecoveryNotice';

afterEach(cleanup);

function renderNotice(state: ConversationOpenRecoveryNoticeProps['state']) {
  render(
    <ConversationOpenRecoveryNotice
      title="Cool chat"
      state={state}
      onRetry={() => {}}
    />,
  );
  return screen.getByRole('alert').textContent ?? '';
}

// #2424: "read-only" is a verdict. Only a Session that is gone, or one the
// server resolved and refused, may be called read-only; a failed or unresolved
// open read is a failed check and must say so, with its Retry.
describe('ConversationOpenRecoveryNotice verdicts (#2424)', () => {
  // `resolved` reaches the notice only as a resolution that refused
  // continuation.
  test.each(['missing-session', 'resolved'] as const)(
    '%s is a verdict and says read-only',
    (state) => {
      expect(renderNotice(state)).toContain('Cool chat is read-only.');
    },
  );

  test.each([
    // The picker path passes its recovery status through unmapped: `error`
    // is a failed resolution request, `unavailable` a server that could not
    // resolve it.
    'error',
    'unavailable',
    // The open chat's own point-read failed.
    'unverified',
    undefined,
  ] as const)('%s is a failed check and never claims read-only', (state) => {
    const text = renderNotice(state);
    expect(text).not.toContain('read-only');
    expect(text).toContain("Station couldn't confirm Cool chat can continue.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
