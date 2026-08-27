import { describe, expect, test } from 'vitest';

/**
 * Trip-wire (station's established retire-a-mirror pattern, cf.
 * `intent-binding-mirror.ts`'s history): `workflow-process-projection-
 * mirror.ts` retains a small BEHAVIORAL mirror of flow-agents' critique-
 * detection helpers (`hasUnresolvedLiveCritique`, `filterCritiquesForSlug`)
 * because `@kontourai/flow-agents`' published `./console-contract` subpath
 * (verified against the pinned `5.3.0` tarball) deliberately re-exports only
 * the status-mapping contract, NOT these two functions (see the mirror
 * file's header).
 *
 * This test imports the REAL subpath and asserts it still does NOT export
 * either name. The moment a future flow-agents release starts exporting
 * `hasUnresolvedLiveCritique`/`filterCritiquesForSlug` from
 * `./console-contract`, this test fails with a clear "retire the mirror"
 * message — the same signal that let this file's status-table half be
 * deleted (see the header's "RETIREMENT" section) — rather than the mirror
 * silently drifting from an now-available real export.
 */
describe('console-contract export-surface trip-wire', () => {
  test('flow-agents/console-contract does not (yet) export the critique-detection helpers this file mirrors', async () => {
    const consoleContract = await import(
      '@kontourai/flow-agents/console-contract'
    );
    const exportNames = Object.keys(consoleContract);

    for (const mirroredName of [
      'hasUnresolvedLiveCritique',
      'filterCritiquesForSlug',
    ]) {
      expect(
        exportNames.includes(mirroredName),
        `@kontourai/flow-agents/console-contract now exports '${mirroredName}' -- ` +
          `RETIRE workflow-process-projection-mirror.ts's mirrored copy and switch ` +
          `every importer to the real export (see that file's header, "RETIREMENT").`,
      ).toBe(false);
    }
  });
});
