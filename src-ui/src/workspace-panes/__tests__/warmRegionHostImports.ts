/**
 * The region host, its built-in pane renderer and the Activity shell arrive
 * through staged dynamic imports (`RegionShells` -> `RegionPaneHost` ->
 * `RegionBuiltinPane`), and the FIRST mount in a test file pays every stage's
 * transform cost in this runner. That cost is host load, not product
 * behavior: on a saturated host it was measured at 1-20s, against testing
 * library's 1s `waitFor` default, and `vi.dynamicImportSettled()` can return
 * between stages because the next import starts after a React commit.
 *
 * Call this from `beforeAll` so the cost is paid once, under the hook
 * timeout, which still fails a genuine import hang. Every later wait in the
 * file then measures rendering only and keeps its default bound. The mocks a
 * file declares apply, because these imports resolve through the same module
 * registry the lazy boundaries use.
 */
export async function warmRegionHostImports(): Promise<void> {
  await Promise.all([
    import('../RegionPaneHost'),
    import('../RegionBuiltinPane'),
    import('../../app-shell/ActivityRegionShell'),
  ]);
}
