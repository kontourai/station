import type { PaneNavigationTarget } from '@kontourai/station-contracts/workspace-pane-host-contract';
import {
  isPaneRouteSlug,
  paneAppSurfaceIdForRoute,
  resolvePaneNavigationRoute,
} from '../../workspace-panes/paneHostShellBindings';

/**
 * Decode a frame's navigation request into the pane-host contract's typed
 * target vocabulary, or refuse it (archive#3323, archive#4201 step 3).
 *
 * There is no plugin-specific target type any more. `PluginNavigationTarget`
 * used to be this file's own union, carrying the resolved `path` for the call
 * site to navigate to; it is now `PaneNavigationTarget` — the SAME value an
 * in-process pane passes to `host.navigate(...)` — and the path grammar lives
 * once, in `resolvePaneNavigationRoute`. That convergence is the whole point
 * of the frame adapter: one interface, two transports.
 *
 * Two encodings arrive here, and both decode to one union:
 *
 *  - the **contract shape** (`{ kind,... }`), which is what a pane written
 *    against `WorkspacePaneHostContract` sends when it runs in the frame;
 *  - the **documented path string** (`docs/guides/plugins.md`:
 *    `postMessage({ method: 'navigate', params: { target: '/agents' } })`),
 *    which is a published plugin API and therefore cannot simply stop
 *    working. It is validated exactly as before and then named in the
 *    contract's vocabulary.
 *
 * The PATH-STRING encoding permits exactly what it did before: a project
 * layout, and a route the app's own surface registry resolves to a view. The
 * contract-shape encoding adds one destination the path form never accepted —
 * `project-workspace`, i.e. `/projects/<slug>[?task=<slug>]`, which
 * `resolveExactRoute` did not resolve and `PROJECT_LAYOUT_PATH` did not match.
 * Refusing it in tier 3 would have forked the contract, so it is admitted
 * deliberately: it is a route the user reaches from the sidebar, its slugs are
 * validated, and it is bounded by the same navigation budget and the same
 * `navigation.dock` grant as every other target.
 *
 * Everything else —
 * an absolute URL, a protocol-relative `//host` path, a traversal, a query or
 * fragment, an unregistered path, an unknown surface id — is refused, so a
 * frame cannot steer the shell somewhere the product does not itself navigate
 * to, and cannot leave Station at all.
 *
 * Note what the typed vocabulary buys over the string form: for a decoded
 * `app-surface` target the DESTINATION is looked up in the registry rather
 * than taken from the message, so a path can no longer be smuggled through at
 * all — there is nowhere to put one.
 */
export function resolvePluginNavigationTarget(
  target: unknown,
): PaneNavigationTarget | null {
  const decoded =
    typeof target === 'string'
      ? decodeLegacyPathTarget(target)
      : decodeContractTarget(target);
  // Whatever the encoding, a target the shell cannot resolve to a destination
  // is refused here rather than at the call site — one refusal rule, and the
  // caller never sees a target it would have to re-validate.
  if (!decoded || !resolvePaneNavigationRoute(decoded)) return null;
  return decoded;
}

const PROJECT_LAYOUT_PATH = /^\/projects\/([^/]+)\/layouts\/([^/]+)$/;
const MAX_TARGET_LENGTH = 256;

/** The contract shape, from an untrusted sender: every field re-checked. */
function decodeContractTarget(target: unknown): PaneNavigationTarget | null {
  if (typeof target !== 'object' || target === null) return null;
  const candidate = target as Record<string, unknown>;
  switch (candidate.kind) {
    case 'project-workspace': {
      if (!isPaneRouteSlug(candidate.projectSlug)) return null;
      if (
        candidate.taskSlug !== undefined &&
        !isPaneRouteSlug(candidate.taskSlug)
      )
        return null;
      return {
        kind: 'project-workspace',
        projectSlug: candidate.projectSlug,
        ...(candidate.taskSlug === undefined
          ? {}
          : { taskSlug: candidate.taskSlug }),
      };
    }
    case 'project-layout': {
      if (
        !isPaneRouteSlug(candidate.projectSlug) ||
        !isPaneRouteSlug(candidate.layoutSlug)
      )
        return null;
      return {
        kind: 'project-layout',
        projectSlug: candidate.projectSlug,
        layoutSlug: candidate.layoutSlug,
      };
    }
    case 'app-surface': {
      if (typeof candidate.surfaceId !== 'string') return null;
      // The registry decides whether this id exists; `resolvePluginNavigation
      // Target` refuses the target if it does not resolve to a destination.
      return { kind: 'app-surface', surfaceId: candidate.surfaceId };
    }
    default:
      return null;
  }
}

/** The documented `target: '/some/path'` form, unchanged in what it admits. */
function decodeLegacyPathTarget(target: string): PaneNavigationTarget | null {
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) return null;
  // One leading slash, then only path characters. This rejects `https://…`,
  // `//evil.example`, `javascript:…`, backslashes, whitespace, control
  // characters, `?query`, `#fragment`, and percent-encoding games in one pass.
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(target)) return null;
  if (target.includes('//') || target.includes('..')) return null;

  const layoutMatch = target.match(PROJECT_LAYOUT_PATH);
  if (layoutMatch) {
    const [, projectSlug, layoutSlug] = layoutMatch;
    if (!isPaneRouteSlug(projectSlug) || !isPaneRouteSlug(layoutSlug))
      return null;
    return { kind: 'project-layout', projectSlug, layoutSlug };
  }

  const surfaceId = paneAppSurfaceIdForRoute(target);
  return surfaceId ? { kind: 'app-surface', surfaceId } : null;
}
