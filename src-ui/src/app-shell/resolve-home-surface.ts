import type {
  ConnectionFailureReason,
  ConnectionStatus,
} from '@kontourai/station-connect';
import type { NavigationView } from '../types';

/** The subset of a project record `resolveHomeSurface` needs. */
export interface HomeSurfaceProjectSummary {
  slug: string;
}

/** The subset of a layout record `resolveHomeSurface` needs. */
export interface HomeSurfaceLayoutSummary {
  slug: string;
}

export interface ResolveHomeSurfaceInput {
  /** Shared host reachability state. Only `connected` proves query failures are independent. */
  connectionStatus: ConnectionStatus;
  /**
   * The typed failure reason from the same `useConnectionStatus` snapshot as
   * `connectionStatus` (station#3711). Carried through so the renderer can use
   * the per-reason copy that already exists (`connectionFailureCopy`) instead
   * of collapsing every non-connected state into the word "offline" — an
   * authentication rejection and a version mismatch are not network states.
   */
  connectionFailureReason: ConnectionFailureReason | null;
  /** `useProjectsQuery()`'s `isLoading` — whether the projects list has ever loaded. */
  projectsLoading: boolean;
  /** `useProjectsQuery()`'s `isError` — a fetch failure, not an empty list. */
  projectsError: boolean;
  /** `useProjectsQuery()`'s `data` (defaulted to `[]` by the caller). */
  projects: HomeSurfaceProjectSummary[];
  /** Persisted restore target from `navigation-store.ts` (localStorage). */
  lastProject: string | null;
  /** Persisted restore target from `navigation-store.ts` (localStorage). */
  lastProjectLayout: string | null;
  /** `projects[0]?.slug ?? ''` — empty string means "no projects" once `projectsLoading` is false. */
  firstProjectSlug: string;
  /** `useProjectLayoutsQuery(firstProjectSlug)`'s `isLoading`. */
  firstProjectLayoutsLoading: boolean;
  /** `useProjectLayoutsQuery(firstProjectSlug)`'s `isError`. */
  firstProjectLayoutsError: boolean;
  /** `useProjectLayoutsQuery(firstProjectSlug)`'s `data` (defaulted to `[]` by the caller). */
  firstProjectLayouts: HomeSurfaceLayoutSummary[];
}

/** The best safe project continuation that Home may offer without navigating. */
export type HomeSurfaceTarget = Extract<
  NavigationView,
  { type: 'layout' } | { type: 'project' }
>;

export type HomeSurfaceResult =
  | { status: 'pending' }
  | { status: 'resolved'; target: HomeSurfaceTarget }
  | { status: 'empty' }
  /**
   * A query failed while the host connection is not `connected` — the failure
   * is a consequence of the connection, not an independent data error. Named
   * for what is derived (this Station is not currently available to this app)
   * rather than "offline", which asserted a device network state nothing here
   * observes (station#3711). `reason` is the connection layer's own typed
   * verdict, when it has one.
   */
  | { status: 'host-unavailable'; reason: ConnectionFailureReason | null }
  | { status: 'error'; source: 'projects' | 'first-project-layouts' };

/**
 * Pure resolver for Home readiness and its best safe project continuation,
 * together both loading flags (`projectsLoading`,
 * `firstProjectLayoutsLoading`) and the three-priority restore contract
 * (CLAUDE.md "Navigation"): (1) a persisted `lastProject` +
 * `lastProjectLayout` pair that still exists in the loaded `projects` list,
 * (2) the first project's first layout — or the first project itself, if it
 * has no layouts yet, (3) the new-project prompt, once it is confirmed there
 * are zero projects.
 *
 * Returns `pending` whenever the data needed to derive the continuation
 * applicable* priority hasn't loaded yet. The caller (`App.tsx`) must never
 * render `project-new` content (or any other guess) while this reports
 * `pending` — that gap between two independently-gated loading checks is the
 * root-route restore flash this module fixes (#223): a stale/deleted
 * `lastProject`, or a restore that depends on priority 2, used to resolve to
 * `project-new` before `firstProjectLayoutsLoading` was known, transiently
 * mounting `NewProjectModal`.
 *
 * This preserves the old effect's fall-through order, but the caller now
 * renders Home at `/` and treats `target` as an action destination. A stale/deleted `lastProject` with no
 * matching entry in `projects` falls straight through to the first-project
 * flow, never to a distinct "restore lastProject without its layout"
 * resolution (that shape was never in the effect this replaces). No new
 * decision is introduced here; the explicit readiness result is what's new.
 */
export function resolveHomeSurface(
  input: ResolveHomeSurfaceInput,
): HomeSurfaceResult {
  const {
    connectionStatus,
    connectionFailureReason,
    projectsLoading,
    projectsError,
    projects,
    lastProject,
    lastProjectLayout,
    firstProjectSlug,
    firstProjectLayoutsLoading,
    firstProjectLayoutsError,
    firstProjectLayouts,
  } = input;

  // Projects haven't loaded yet — we can't know whether `lastProject` is
  // still valid, whether any projects exist, or what the first project is.
  // Nothing below can be decided yet.
  if (projectsLoading) {
    return { status: 'pending' };
  }

  if (projectsError) {
    if (connectionStatus !== 'connected')
      return { status: 'host-unavailable', reason: connectionFailureReason };
    return { status: 'error', source: 'projects' };
  }

  // Priority 1: a persisted project+layout pair that still exists.
  if (
    lastProject &&
    lastProjectLayout &&
    projects.some((project) => project.slug === lastProject)
  ) {
    return {
      status: 'resolved',
      target: {
        type: 'layout',
        projectSlug: lastProject,
        layoutSlug: lastProjectLayout,
      },
    };
  }

  // No restorable `lastProject` (never set, or stale/deleted — the
  // `.some(...)` check above already ruled that out) — fall through to
  // priority 2. If there are no projects at all, `firstProjectSlug` is the
  // empty string and every branch below is skipped, landing on `empty`.
  if (firstProjectSlug) {
    // The first project's layouts are still loading — can't yet tell
    // whether it has any layouts or none.
    if (firstProjectLayoutsLoading) {
      return { status: 'pending' };
    }

    if (firstProjectLayoutsError) {
      if (connectionStatus !== 'connected')
        return { status: 'host-unavailable', reason: connectionFailureReason };
      return { status: 'error', source: 'first-project-layouts' };
    }

    if (firstProjectLayouts.length > 0) {
      return {
        status: 'resolved',
        target: {
          type: 'layout',
          projectSlug: firstProjectSlug,
          layoutSlug: firstProjectLayouts[0].slug,
        },
      };
    }

    return {
      status: 'resolved',
      target: { type: 'project', slug: firstProjectSlug },
    };
  }

  // Priority 3: confirmed zero projects (`projectsLoading` is false and
  // there is no first project slug).
  return { status: 'empty' };
}
