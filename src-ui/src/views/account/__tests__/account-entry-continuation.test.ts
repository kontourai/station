/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clearAccountEntryContinuation,
  INVITATION_STATE_KEY,
  readAccountEntryContinuation,
} from '../account-entry-continuation';

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('account entry continuation', () => {
  test('an older completion cannot clear a newer invitation', () => {
    sessionStorage.setItem(
      INVITATION_STATE_KEY,
      JSON.stringify({ token: 'b'.repeat(43), until: Date.now() + 3600_000 }),
    );
    clearAccountEntryContinuation('a'.repeat(43));
    expect(
      JSON.parse(sessionStorage.getItem(INVITATION_STATE_KEY)!),
    ).toMatchObject({ token: 'b'.repeat(43) });
    clearAccountEntryContinuation('b'.repeat(43));
    expect(sessionStorage.getItem(INVITATION_STATE_KEY)).toBeNull();
  });
  test('removes the invitation from the visible URL and retains a bounded tab continuation', () => {
    const token = 'a'.repeat(43);
    window.history.replaceState(null, '', `/account/join#invitation=${token}`);
    expect(readAccountEntryContinuation()).toEqual({
      invitation: token,
      resetToken: undefined,
    });
    expect(window.location.hash).toBe('');
    const stored = JSON.parse(
      sessionStorage.getItem(INVITATION_STATE_KEY) ?? 'null',
    );
    expect(stored.token).toBe(token);
    expect(stored.until).toBeGreaterThan(Date.now());
    expect(stored.until).toBeLessThanOrEqual(Date.now() + 3600_000);
    // A provider redirect back to the account page keeps the invitation, not a login credential.
    window.history.replaceState(null, '', '/account');
    expect(readAccountEntryContinuation().invitation).toBe(token);
  });

  test('a malformed new invitation cannot select the previous invitation', () => {
    sessionStorage.setItem(
      INVITATION_STATE_KEY,
      JSON.stringify({ token: 'a'.repeat(43), until: Date.now() + 3600_000 }),
    );
    window.history.replaceState(null, '', '/account/join#invitation=invalid');
    expect(readAccountEntryContinuation().invitation).toBeUndefined();
    expect(sessionStorage.getItem(INVITATION_STATE_KEY)).toBeNull();
  });

  test('expired continuation is removed, and reset proof remains only in page memory', () => {
    sessionStorage.setItem(
      INVITATION_STATE_KEY,
      JSON.stringify({ token: 'a'.repeat(43), until: Date.now() - 1 }),
    );
    window.history.replaceState(
      null,
      '',
      '/account/reset#token=reset-proof-1234567890',
    );
    expect(readAccountEntryContinuation()).toEqual({
      invitation: undefined,
      resetToken: 'reset-proof-1234567890',
    });
    expect(sessionStorage.getItem(INVITATION_STATE_KEY)).toBeNull();
    expect(window.location.hash).toBe('');
    expect(readAccountEntryContinuation().resetToken).toBeUndefined();
  });

  test('denied browser storage does not lose the invitation in the current page', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    window.history.replaceState(
      null,
      '',
      `/account/join#invitation=${'b'.repeat(43)}`,
    );
    expect(readAccountEntryContinuation().invitation).toBe('b'.repeat(43));
    expect(window.location.hash).toBe('');
  });
});
