import { expect, it } from 'vitest';
import { resolveKernelLimits } from '../index.js';

it('rejects a resolved retention floor above the soft cap', () => {
  const limits = { turnDedupMaxEntries: 2, turnDedupMinResolvedEntries: 3 };
  expect(() => resolveKernelLimits(limits)).toThrow(
    'monument limit turnDedupMinResolvedEntries must not exceed turnDedupMaxEntries.',
  );
});

it('accepts an explicit resolved floor equal to the cap', () => {
  const limits = { turnDedupMaxEntries: 2, turnDedupMinResolvedEntries: 2 };
  expect(resolveKernelLimits(limits)).toMatchObject(limits);
});

it.each([0, -1, 1.5])('rejects the invalid resolved floor %s', (floor) => {
  const limits = { turnDedupMaxEntries: 2, turnDedupMinResolvedEntries: floor };
  expect(() => resolveKernelLimits(limits)).toThrow(
    'monument limit turnDedupMinResolvedEntries must be a positive integer.',
  );
});
