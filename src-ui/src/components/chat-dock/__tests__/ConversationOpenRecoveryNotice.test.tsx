/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from '@testing-library/react';
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
      expect(renderNotice(state)).toContain('“Cool chat” is read-only.');
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
    expect(text).toContain(
      "Station couldn't confirm “Cool chat” can continue.",
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('ConversationOpenRecoveryNotice copy and actions', () => {
  // The phone report: the default title, interpolated bare, read
  // "Station couldn't confirm New chat can continue." The title is the
  // user's own text, so it is quoted.
  test('quotes the chat title instead of splicing it into the sentence', () => {
    render(
      <ConversationOpenRecoveryNotice title="New chat" state="unverified" />,
    );
    const heading = screen.getByRole('alert').querySelector('strong');
    expect(heading?.textContent).toBe(
      "Station couldn't confirm “New chat” can continue.",
    );
  });

  test('Retry and Start new chat share one action row', () => {
    render(
      <ConversationOpenRecoveryNotice
        title="New chat"
        state="unverified"
        onRetry={() => {}}
        onStartNew={() => {}}
      />,
    );
    const retry = screen.getByRole('button', { name: 'Retry' });
    const startNew = screen.getByRole('button', { name: 'Start new chat' });
    const row = retry.parentElement;
    // The `__actions` row is what the global phone rule holds to the 44px
    // touch floor (index.css). This proves the structure, not the layout.
    expect(row?.className).toBe('session-history-error__actions');
    expect(startNew.parentElement).toBe(row);
    // Equal-weight actions: the same classes, so neither is sized apart.
    expect(retry.className).toBe(startNew.className);
  });

  // Owner direction: never offer an action the caller cannot take.
  test('renders no action the caller did not pass, and does not point at a missing Retry', () => {
    render(
      <ConversationOpenRecoveryNotice title="New chat" state="unverified" />,
    );
    const notice = screen.getByRole('alert');
    expect(within(notice).queryAllByRole('button')).toHaveLength(0);
    expect(notice.querySelector('.session-history-error__actions')).toBeNull();
    expect(notice.textContent).not.toContain('Retry');
    expect(notice.textContent).toContain('sending is paused');
  });
});
