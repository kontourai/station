/** @vitest-environment jsdom */
import { getConfig } from '@testing-library/dom';
import { expect, test } from 'vitest';

/**
 * #1531: `vitest.setup.ts` raises Testing Library's async wait from its 1 s
 * default to a figure that follows the test budget, for jsdom suites only.
 * Pinned here so an edit to the setup file that drops the `configure` call
 * reddens one named test instead of reappearing as a load-dependent nightly
 * failure in whichever `waitFor` happens to be slowest that night.
 */
test('Testing Library waits follow the vitest budget under jsdom, not the 1 s default', () => {
  expect(getConfig().asyncUtilTimeout).toBe(10_000);
});
