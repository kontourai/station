import type { DockRegionId } from './region-model';

/**
 * A mounted region shell's own show/hide, as the shell performs it (#2155).
 *
 * `useDockShellChrome.setRegionOpen` — the expression the region bar's
 * chevron presses — routed through `applyDockSnap`, so the shell records its
 * snap and its height and writes `maximized` alongside `visible`. A bare
 * `setRegion(region, { visible })` does none of that, which is why a region
 * hidden from the toolbar used to come back maximized while one hidden from
 * its own chevron came back at the snap the chevron stored.
 */
export type RegionVisibilityApplier = (open: boolean) => void;

/**
 * The applier each mounted region shell publishes, keyed by the region it
 * renders. At most one entry per region: `RegionShells` mounts one host per
 * dock region, and only that ambient host registers (a fullscreen Chat
 * pane's own chrome instance renders no region and publishes nothing).
 *
 * Module-level rather than a field on `RegionModelValue` because this is a
 * DOM-lifetime fact — which shells are mounted right now — and the model is
 * the persisted arrangement's authority. Putting it there would add a member
 * to the one interface every region consumer and every test double
 * implements, and would re-render every consumer whenever a shell mounted;
 * the registry is read at press time by one caller and needs neither.
 *
 * An absent entry is a real state, not a failure: a HIDDEN EMPTY region
 * mounts no host at all (#2153), so nothing has an `applyDockSnap` for it and
 * `RegionToggle.onToggle` writes the model directly instead.
 */
const appliers = new Map<DockRegionId, RegionVisibilityApplier>();

/** Publishes a mounted shell's applier; returns its unregister. */
export function registerRegionVisibilityApplier(
  region: DockRegionId,
  applier: RegionVisibilityApplier,
): () => void {
  appliers.set(region, applier);
  return () => {
    // Only if it is still OURS. React can commit a replacement shell before
    // running the departing one's cleanup (the same ordering
    // `registerRegionSurfaceHost` counts for), and an unconditional delete
    // would then drop the live shell's applier and leave the region on the
    // model-write fallback for the rest of its life.
    if (appliers.get(region) === applier) appliers.delete(region);
  };
}

/** The mounted shell's applier for this region, or `undefined` if none is. */
export function regionVisibilityApplier(
  region: DockRegionId,
): RegionVisibilityApplier | undefined {
  return appliers.get(region);
}
