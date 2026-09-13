/**
 * The two issue handoff label names, kept in a module with no imports.
 *
 * Both `issue-lifecycle-reducer.mjs` and `label-manifest.mjs` need these.
 * Sourcing them from the reducer once closed a cycle (#1312), because the
 * reducer then imported `backlog-priority-policy.mjs`, which imports the
 * manifest; whichever side loaded first saw the other's `const` bindings in
 * their temporal dead zone. The reducer dropped that policy import when the
 * bug-to-P1 derivation was removed, so the cycle can no longer form. These
 * names stay here anyway: an import-free leaf is what stops the next importer
 * reopening it.
 */
export const NEEDS_MAINTAINER = 'needs:maintainer';
export const NEEDS_REPORTER = 'needs:reporter';
