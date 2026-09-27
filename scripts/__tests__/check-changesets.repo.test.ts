import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { checkChangesets } from '../check-changesets.mjs';

const root = resolve(import.meta.dirname, '../..');

/**
 * #2781: the suite a `.changeset/**` edit selects. It runs the same release
 * planner as `ci:fast`'s check-changesets static gate over the repository's
 * own changesets and config, so a changeset that names an unknown package or
 * bumps wrongly fails here, in the pull request's affected selection, instead
 * of deferring the whole selection as an unknown path.
 */
test('the repository changesets parse and plan a release', async () => {
  const plan = await checkChangesets(root);
  expect(Number.isInteger(plan.changesets)).toBe(true);
  expect(plan.changesets).toBeGreaterThanOrEqual(0);
  // A pending changeset always releases at least one package.
  if (plan.changesets > 0) expect(plan.packages.length).toBeGreaterThan(0);
});
