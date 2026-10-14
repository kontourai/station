import { describe, expect, test } from 'vitest';
import {
  describeReadFailure,
  READ_FAILURE_FALLBACK,
  READ_FAILURE_UNREACHABLE,
  READ_FAILURE_UNREADABLE,
} from '../describeReadFailure';

/**
 * One derivation for one fact: review found the same "error drawn as
 * empty" defect in three unrelated views, so the sentence a failed read is
 * allowed to show lives here rather than being retyped per view.
 */
describe('describeReadFailure', () => {
  test("prefers a thrown Error's own message — the most specific honest fact", () => {
    expect(describeReadFailure(new Error('skills read failed'))).toBe(
      'skills read failed',
    );
  });

  test('falls back for an Error with a blank message rather than showing nothing', () => {
    expect(describeReadFailure(new Error('   '))).toBe(READ_FAILURE_FALLBACK);
  });

  test('claims nothing about the cause for a non-Error rejection', () => {
    expect(describeReadFailure('boom')).toBe(READ_FAILURE_FALLBACK);
    expect(describeReadFailure({ status: 500 })).toBe(READ_FAILURE_FALLBACK);
    expect(describeReadFailure(true)).toBe(READ_FAILURE_FALLBACK);
  });

  test('names an unreadable response instead of printing the parser', () => {
    // What Chromium's Response.json() rejects with for an HTML error page.
    const parse = new SyntaxError(
      `Failed to execute 'json' on 'Response': Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    );
    expect(describeReadFailure(parse)).toBe(READ_FAILURE_UNREADABLE);
    // Older WebKit rejects with a DOMException named SyntaxError, which is
    // not an instance of the JS SyntaxError.
    expect(
      describeReadFailure(
        new DOMException(
          'The string did not match the expected pattern.',
          'SyntaxError',
        ),
      ),
    ).toBe(READ_FAILURE_UNREADABLE);
  });

  test('names a request that never reached Station', () => {
    for (const message of [
      'Failed to fetch',
      'Load failed',
      'NetworkError when attempting to fetch resource.',
    ]) {
      expect(describeReadFailure(new TypeError(message))).toBe(
        READ_FAILURE_UNREACHABLE,
      );
    }
    // A native transport's own phrase (src-desktop), on a plain Error.
    expect(
      describeReadFailure(
        new Error(
          'Native Station request failed: Station refused the connection',
        ),
      ),
    ).toBe(READ_FAILURE_UNREACHABLE);
    // Any other TypeError is a real message and stays.
    expect(describeReadFailure(new TypeError('agents is not iterable'))).toBe(
      'agents is not iterable',
    );
  });
});
