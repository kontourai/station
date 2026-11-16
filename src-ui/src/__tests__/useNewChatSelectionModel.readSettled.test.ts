// @vitest-environment jsdom
/**
 * An armed handoff waits on `selectedContextSettled`, built from this: a read
 * that has answered either way, or one that is not running at all (disabled,
 * or refused for want of a request scope), is settled; only a read in flight
 * with no answer is not. A disabled read must not hold a send forever.
 */
import { expect, test } from 'vitest';
import { readSettled } from '../hooks/useNewChatSelectionModel';

test.each([
  ['answered', { isPending: false, isFetching: false }, true],
  ['answered and refetching', { isPending: false, isFetching: true }, true],
  ['failed (error, no data)', { isPending: false, isFetching: false }, true],
  [
    'disabled or unscoped (pending, idle)',
    { isPending: true, isFetching: false },
    true,
  ],
  ['first read in flight', { isPending: true, isFetching: true }, false],
])('%s → settled: %s', (_name, query, settled) => {
  expect(readSettled(query)).toBe(settled);
});
