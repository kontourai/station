/**
 * The two issue handoff label names, kept in a module with no imports.
 *
 * Both `issue-lifecycle-reducer.mjs` and `label-manifest.mjs` need these, and
 * the reducer also needs `backlog-priority-policy.mjs`, which imports the
 * manifest. Sourcing the names from the reducer closed that into a cycle
 * (#1312): whichever side loads first sees the other's `const` bindings in
 * their temporal dead zone, and the workflow enters through the reducer.
 */
export const NEEDS_MAINTAINER = 'needs:maintainer';
export const NEEDS_REPORTER = 'needs:reporter';
