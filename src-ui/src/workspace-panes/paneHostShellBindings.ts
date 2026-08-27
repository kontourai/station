import type {
  PaneNavigationTarget,
  PaneUnavailableReason,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import { APP_SURFACE_REGISTRY } from '../app-shell/surface-registry';
import { BANNER_PRIORITY, bannerStore } from '../contexts/banner-store';

/**
 * The shell half of the pane-host contract, shared by BOTH transports
 * (station#4201, `docs/design/pane-host-contract.md`).
 *
 * The design's claim is that one interface serves two runtime tiers. That
 * claim is only worth something if the two adapters agree about what a
 * contract value MEANS — where `{ kind: 'app-surface', surfaceId: 'agents' }`
 * lands, what sentence `presentUnavailable('no-builder-run')` puts on screen.
 * Two adapters each mapping the vocabulary their own way is the divergence
 * the contract exists to end, so the mapping lives here, once, and the
 * adapters own only their transport: direct calls in-process
 * (`inProcessPaneHost.tsx`), postMessage across the frame
 * (`components/plugins/framePaneHost.tsx`).
 *
 * Nothing here renders. These are derivations over shell state — the surface
 * registry, the banner stack — so both adapters can share them without either
 * one importing the other's chrome.
 */

/** A contract target resolved onto the shell's own path grammar. */
export interface PaneNavigationRoute {
  pathname: string;
  /**
   * Query fields to write with the navigation. `null` CLEARS a field, which
   * is load-bearing rather than cosmetic — see the project-layout case.
   */
  params: Record<string, string | null>;
}

/** Slugs are the identifier grammar the project/layout routes already parse. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True for a slug the project/layout routes can actually parse. */
export function isPaneRouteSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

/**
 * Where a {@link PaneNavigationTarget} lands, or `null` when the shell has no
 * such destination.
 *
 * `null` is not an error path for first-party panes — their targets are
 * built from identities the shell handed them — but it IS the refusal path
 * for a frame, whose target arrived as untrusted bytes. Resolving here rather
 * than at either call site is what makes those two cases one rule.
 */
export function resolvePaneNavigationRoute(
  target: PaneNavigationTarget,
): PaneNavigationRoute | null {
  switch (target.kind) {
    case 'project-workspace': {
      if (!isPaneRouteSlug(target.projectSlug)) return null;
      if (target.taskSlug !== undefined && !isPaneRouteSlug(target.taskSlug))
        return null;
      return {
        pathname: `/projects/${target.projectSlug}`,
        params: target.taskSlug ? { task: target.taskSlug } : {},
      };
    }
    case 'project-layout': {
      if (
        !isPaneRouteSlug(target.projectSlug) ||
        !isPaneRouteSlug(target.layoutSlug)
      )
        return null;
      return {
        pathname: `/projects/${target.projectSlug}/layouts/${target.layoutSlug}`,
        // A project-layout target is the one that can CHANGE project, and
        // `navigate` starts from the live URL: without clearing these, a
        // navigation away from `/projects/alpha/...?previewPath=src/secret.ts`
        // would carry the fields onto beta and reconstitute the intent as
        // `beta:src/secret.ts`. Project identity is route-owned
        // (`openFilePreviewIntent.ts`); a preview must never survive a project
        // switch. (`setLayout` clears them as a side effect; panes
        // deliberately do not go through `setLayout` — see the frame
        // adapter's note on not recording a pane's choice as the user's.)
        params: {
          previewPath: null,
          previewLineStart: null,
          previewLineEnd: null,
        },
      };
    }
    case 'app-surface': {
      // The registry is the app's own inventory of navigable surfaces, so the
      // vocabulary cannot drift from what the shell actually renders — and an
      // unknown id is refused rather than turned into a path. `view` is what
      // marks a surface's route as an exact, navigable root; a surface
      // without one has no destination to offer.
      const surface = APP_SURFACE_REGISTRY.get(target.surfaceId);
      if (!surface?.view) return null;
      return { pathname: surface.route, params: {} };
    }
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

/**
 * The id a surface is known by in {@link PaneNavigationTarget}, for a route
 * the shell resolves exactly — or `null`.
 *
 * The frame's documented `navigate` message still carries a path
 * (`docs/guides/plugins.md`), so its decoder needs the inverse of the
 * `app-surface` case above. Deriving it from the same registry keeps the two
 * directions from disagreeing about which routes exist.
 */
export function paneAppSurfaceIdForRoute(pathname: string): string | null {
  const surface = APP_SURFACE_REGISTRY.getRegistered().find(
    (definition) => definition.view && definition.route === pathname,
  );
  return surface?.id ?? null;
}

/**
 * D8's one-line redirect notice, and the banner id it is presented under.
 * Exported so both adapters, the mounter's unit test and the durable E2E all
 * name the same sentence rather than four copies that can drift.
 */
export const BOARD_UNAVAILABLE_NOTICE =
  'This project has no Builder runs yet; the Board appears when one starts';
export const BOARD_UNAVAILABLE_BANNER_ID = 'project:board-unavailable';

/**
 * What the shell shows for a pane's unavailable derivation.
 *
 * The REASON is a derivation the pane owns (for `no-builder-run`: the server
 * said it knows no Builder run for this project); the sentence and the banner
 * id are the shell's, which is why they live here and not in the pane. Keyed
 * by reason so a second reason is a row in this table rather than a second
 * hardcoded sentence beside the first — the shape C1's review asked for.
 */
const PANE_UNAVAILABLE_PRESENTATION: Record<
  PaneUnavailableReason,
  { bannerId: string; notice: string }
> = {
  'no-builder-run': {
    bannerId: BOARD_UNAVAILABLE_BANNER_ID,
    notice: BOARD_UNAVAILABLE_NOTICE,
  },
};

/**
 * Present a pane's unavailable derivation: the one notice on the banner stack
 * (which outlives the pane's unmount, exactly what a redirect notice needs)
 * and the destination the shell leaves for.
 *
 * Returns the redirect target so the CALLER navigates — the two adapters
 * reach the navigation seam differently, and only the caller knows whether
 * its own transport bounds the move.
 *
 * `userInitiated` because the reader just navigated here and the guard
 * redirected them — their own action, not a background condition
 * (station#3823).
 */
export function presentPaneUnavailable(
  reason: PaneUnavailableReason,
  projectSlug: string | undefined,
): PaneNavigationTarget | null {
  if (!isPaneRouteSlug(projectSlug)) return null;
  const presentation = PANE_UNAVAILABLE_PRESENTATION[reason];
  if (!presentation) return null;
  bannerStore.present({
    id: presentation.bannerId,
    occurrence: projectSlug,
    priority: BANNER_PRIORITY.info,
    tone: 'info',
    ariaLive: 'polite',
    message: presentation.notice,
    dismissible: true,
    userInitiated: true,
  });
  return { kind: 'project-workspace', projectSlug };
}
