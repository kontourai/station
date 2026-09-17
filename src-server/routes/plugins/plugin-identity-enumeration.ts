/**
 * The routes that return PLUGIN IDENTITY, and the one guard they share
 * (#2067).
 *
 * The acceptance criterion this serves is about ENUMERATION, not about one
 * route: a collaborator's first-member journey must not be able to learn what
 * is installed on this instance
 * (`docs/design/project-membership.md`). `GET /api/plugins` was the obvious
 * enumerator and the first one projected; an independent review then found
 * four more on the same read tier, each returning plugin names to anybody
 * holding an ordinary paired-device credential. A second reader of an
 * authorized store eventually gets the authorization wrong, and this family
 * proved it four times in one slice.
 *
 * So the family is written down here, each member carries its disposition,
 * and `plugin-identity-enumeration.test.ts` asserts that every route in the
 * inventory actually behaves the way its disposition claims. A new route that
 * returns plugin identity and is neither projected nor operator-only cannot
 * pass that test without somebody deleting a row, which is a visible act in a
 * diff rather than an omission nobody sees.
 */
import { RESERVED_EVENT_SENTINEL_PLUGIN_NAMES } from '@kontourai/station-contracts/plugin-visibility';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import type { Context } from 'hono';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
} from '../../services/identity/principal-resolver.js';
import { errorMessage } from '../schemas/schemas.js';

/**
 * How one route in the family keeps plugin identity away from a caller who
 * may not see it.
 *
 * - `projected` — the route still answers, but only about the plugins in the
 *   caller's projection. The right disposition for a surface a collaborator
 *   legitimately uses (a picker, their own plugin list).
 * - `operator-only` — the route refuses a non-operator outright. The right
 *   disposition for a maintenance surface: there is no useful projected
 *   answer, because the actions it feeds are operator actions anyway, and a
 *   half-answer would be a worse lie than a refusal.
 * - `projected-with-residual` — the route withholds every plugin fact the
 *   SERVER derives, but its response can still carry plugin-authored strings
 *   that come from the caller's own project record and cannot be removed
 *   without deleting the record's meaning. Added for the two layout READ
 *   routes (#2090/#2103), which project `config.plugin`, the live
 *   `plugins/<name>` read and the catalog backfill, yet still answer with a
 *   layout whose component ids are plugin-namespaced by convention, whose
 *   `name` the catalog parser falls back to the plugin manifest's (and
 *   finally to the plugin name), and whose `slug` is plugin-authored and IS
 *   the route address.
 *
 *   It exists because the alternative was worse in both directions: calling
 *   them `projected` would have them asserted against this family's
 *   whole-body "names no ungranted plugin" check, which they cannot satisfy
 *   and which a fixture can be chosen to dodge; excusing them in the scan
 *   would drop them out of the enumerated list AND out of any executable
 *   coverage, leaving a prose citation, which is the defect the citation
 *   guard was built twice to fix. Their test asserts the withheld FIELDS
 *   with an operator control instead.
 */
export type PluginIdentityDisposition =
  | 'projected'
  | 'projected-with-residual'
  | 'operator-only';

export interface PluginIdentityRoute {
  method: 'GET' | 'POST';
  path: string;
  disposition: PluginIdentityDisposition;
  /** Why this disposition and not the other one. */
  rationale: string;
}

export const PLUGIN_IDENTITY_ROUTES: readonly PluginIdentityRoute[] = [
  {
    method: 'GET',
    path: '/api/plugins',
    disposition: 'projected',
    rationale:
      'A person’s own plugin list. The projection IS this route: a plugin outside it is absent from the array.',
  },
  {
    method: 'GET',
    path: '/api/projects/:slug/panes',
    disposition: 'projected',
    rationale:
      'The Pane catalogue a person composes a layout from. Contributions and descriptors for plugins outside the projection are dropped at the source.',
  },
  {
    method: 'GET',
    path: '/api/projects/:slug/layouts',
    disposition: 'projected-with-residual',
    rationale:
      'Each row carries the stored `config.plugin`, which is dropped for a caller who cannot see that plugin. Withholding that name on the detail read while handing it over here in one request would make the detail route’s withholding theatre, so the same predicate answers both. The residual is the rest of a row: `name`, `description` and `slug` come from the layout the plugin shipped.',
  },
  {
    method: 'GET',
    path: '/api/projects/:slug/layouts/:layoutSlug',
    disposition: 'projected-with-residual',
    rationale:
      'It merged the plugin’s LIVE layout from disk and backfilled catalog attribution, and `config` is a free record a member can write, so `{plugin: "a-guess"}` read back whether that plugin exists, with its tabs, version and `plugins/<name>` source (#2103). All four are withheld now, and a hidden plugin answers identically to a name nobody installed. The residual is the project’s own stored record: plugin-namespaced component ids, and a layout name and slug the plugin authored.',
  },
  {
    method: 'GET',
    path: '/api/plugins/home-role/candidates',
    disposition: 'projected',
    rationale:
      'A user-facing picker: a collaborator legitimately chooses a Home pane, and must choose from what they can see rather than from the instance inventory.',
  },
  {
    method: 'GET',
    path: '/api/plugins/check-updates',
    disposition: 'operator-only',
    rationale:
      'A maintenance surface. It runs git fetch against every installed plugin directory and reports what is behind; acting on that is operator work, so a projected half-list would answer a question a collaborator cannot act on while still enumerating.',
  },
  {
    method: 'GET',
    path: '/api/registry/plugins',
    disposition: 'operator-only',
    rationale:
      'An install surface whose rows carry an `installed` flag. Installing is operator work, and the flag is exactly the instance inventory restated against a catalog.',
  },
  {
    method: 'GET',
    path: '/api/registry/plugins/installed',
    disposition: 'operator-only',
    rationale:
      'The same surface filtered to `installed`, which is the instance plugin inventory with no catalog around it.',
  },
  {
    method: 'GET',
    path: '/api/registry/layouts',
    disposition: 'projected',
    rationale:
      'A plugin-contributed layout carries the plugin name, its `plugins/<name>` source and its contribution provenance. Layouts are something a collaborator legitimately browses and applies, so the list is narrowed rather than refused.',
  },
  {
    method: 'GET',
    path: '/api/registry/layouts/installed',
    disposition: 'projected',
    rationale:
      'The same catalog filtered to installed; same reason, same projection.',
  },
  {
    method: 'GET',
    path: '/api/projects/layouts/available',
    disposition: 'projected',
    rationale:
      'The picker a project applies a layout from. It returned `listLayouts()` raw with no principal resolved at all; it is a composition surface, so it is narrowed rather than refused.',
  },
  {
    method: 'GET',
    path: '/api/registry/agents/installed',
    disposition: 'operator-only',
    rationale:
      'Rows carry `installedPluginName`, which is the installed plugin inventory keyed by agent. An install/maintenance surface, refused for the same reason as the plugin twin beside it.',
  },
  {
    method: 'GET',
    path: '/api/registry/integrations/installed',
    disposition: 'operator-only',
    rationale:
      'Same shape as the agent twin: installed rows whose provenance is an installed plugin. Refused rather than projected for the same reason.',
  },
  {
    method: 'POST',
    path: '/api/plugins/reload',
    disposition: 'operator-only',
    rationale:
      'Reports the loaded count and the pending plugin ids after reconciling the whole install directory. Reloading is a maintenance action a collaborator cannot take, and the pending list is the inventory.',
  },
  {
    method: 'GET',
    path: '/api/plugins/command-effects/withdrawals',
    disposition: 'operator-only',
    rationale:
      'Lists every open command effect withdrawal and recent closed ones, each naming the `pluginId` whose lifecycle change caused it. Only the operator can act on a withdrawal, so a collaborator is refused rather than projected.',
  },
  {
    method: 'GET',
    path: '/api/plugins/command-effects/uncaptured',
    disposition: 'operator-only',
    rationale:
      'Lists outstanding command effects no withdrawal captured, with their `pluginId` and principal. Abandoning one is an operator action, so the list is refused to a collaborator rather than projected.',
  },
  {
    method: 'GET',
    path: '/api/plugins/command-effects/withdrawals/:id',
    disposition: 'operator-only',
    rationale:
      'Reports a command effect withdrawal, including the `pluginId` whose lifecycle change caused it. Withdrawals follow operator lifecycle actions and only the operator may resolve one, so a collaborator is refused rather than projected.',
  },
  {
    method: 'GET',
    path: '/api/plugins/home-role',
    disposition: 'projected',
    rationale:
      'Reports the Home holder, including its `pluginId`. A collaborator legitimately asks what holds Home, so the status is answered with the holder withheld when its plugin is outside their projection, rather than the whole route refused.',
  },
];

/**
 * Narrows a layout catalog listing to the plugins the caller may see.
 *
 * Built-in layouts are never touched: their provenance names no plugin, and
 * hiding Station's own layouts from a collaborator would be a different and
 * wrong change. A plugin-contributed layout is kept only when the caller can
 * see the contributing plugin, which is the same predicate and the same
 * derivation `GET /api/plugins` applies to the list itself.
 *
 * `canSeePlugin` absent means this composition has no caller to project onto
 * and nothing is narrowed — the same convention the Pane catalogue uses.
 */
export function projectLayoutCatalogItems<
  T extends {
    contribution?: { provenance?: { origin?: string; pluginId?: string } };
  },
>(
  items: readonly T[],
  canSeePlugin: ((pluginId: string) => boolean) | undefined,
): T[] {
  if (!canSeePlugin) return [...items];
  return items.filter((item) => {
    const provenance = item.contribution?.provenance;
    if (provenance?.origin !== 'plugin') return true;
    // A plugin-origin contribution naming no plugin is dropped rather than
    // kept (#2090 review MEDIUM-D). It used to be kept, which made this the
    // one place in the family that failed OPEN on a shape every other
    // reader — the layout read routes' `layoutPluginBindingWithheld` and the
    // apply guard that calls it — fails CLOSED on. Unreachable from the real
    // `DistributionProfileService`, which always sets `pluginId`; the cost
    // if it ever happens is an operator not seeing a malformed item in a
    // picker, against a collaborator seeing a plugin layout nobody could
    // attribute.
    return (
      provenance.pluginId !== undefined && canSeePlugin(provenance.pluginId)
    );
  });
}

/**
 * Resolves the request's own principal. Never a body, never a header the
 * caller wrote — the same memoized, fail-closed resolver every other
 * identity-bearing route reads.
 */
export interface PluginPrincipalResolution {
  resolvePrincipal(c: {
    env: unknown;
    req: { raw: Request; header(name: string): string | undefined };
  }): PrincipalRef;
}

class PluginOperatorOnlyError extends Error {
  constructor(what: string) {
    super(`Only the Station operator can ${what}.`);
    this.name = 'PluginOperatorOnlyError';
  }
}

/**
 * Wraps a handler so it runs only for the instance operator.
 *
 * `resolution` is REQUIRED and has no permissive default. A composition that
 * did not supply it is not serving authenticated HTTP callers, and the honest
 * answer for an operator-only route in that situation is a refusal, not the
 * whole inventory — the same choice `createPluginRoutes` makes for the plugin
 * list, and for the same reason.
 */
export function operatorOnly(
  resolution: PluginPrincipalResolution | undefined,
  what: string,
) {
  return (handle: (c: Context) => Response | Promise<Response>) =>
    (c: Context): Response | Promise<Response> => {
      try {
        if (!resolution) {
          throw new PrincipalUnresolvedError(
            'plugin visibility was not composed for this route',
          );
        }
        const caller = resolution.resolvePrincipal(c);
        if (caller.id !== LOCAL_OPERATOR_PRINCIPAL_ID) {
          throw new PluginOperatorOnlyError(what);
        }
      } catch (error) {
        if (error instanceof PrincipalUnresolvedError) {
          return c.json(
            { success: false, error: errorMessage(error), code: error.code },
            400,
          );
        }
        if (error instanceof PluginOperatorOnlyError) {
          return c.json({ success: false, error: error.message }, 403);
        }
        throw error;
      }
      return handle(c);
    };
}

/**
 * The payload `name` the Home-role routes emit on `plugins:grants-changed`.
 *
 * It is a SENTINEL, not a plugin: the Home role is one instance-level slot,
 * and the frame says "that slot changed". Exported so the emitters and the
 * relay gate below share one string rather than two copies of a literal that
 * can drift apart — which is how the gate silently stopped relaying it.
 */
export const WORKSPACE_HOME_ROLE_EVENT_NAME = 'workspace-home-role';
// The sentinel must BE reserved; a rename that forgot the contract set would
// otherwise leave the name installable again.
if (!RESERVED_EVENT_SENTINEL_PLUGIN_NAMES.has(WORKSPACE_HOME_ROLE_EVENT_NAME)) {
  throw new Error(
    'The Home-role event sentinel is not in RESERVED_EVENT_SENTINEL_PLUGIN_NAMES',
  );
}

/**
 * The field the Home-role emitters set and no plugin lifecycle frame does.
 *
 * Read as an OWN property: the stated property is a field the emitters SET,
 * and a prototype-chain read would also accept one merely inherited through
 * `Object.create`. No emitter produces that and JSON parsing cannot, but the
 * check should mean what it says.
 *
 * The name alone is not a safe discriminator, and reserving the name is not
 * either — not because reservation fails, but because a single axis that
 * silently stops holding (a reservation dropped in a refactor, an installed
 * plugin predating the rule) turns the exemption back into a hole that
 * carries plugin setting VALUES to subscribers who may not see them. The
 * relay requires the channel AND this field; a `plugins:settings-changed`
 * frame for a plugin somehow named like the sentinel matches neither.
 */
export const WORKSPACE_HOME_ROLE_EVENT_MARKER = 'homeRoleSlot' as const;

/**
 * The ONE constructor for a Home-role `plugins:grants-changed` payload.
 *
 * Both emitters call it rather than writing the two fields out, because a
 * hand-copied literal at two sites is exactly the drift that silently
 * unhooked this frame from the relay once already — and a frame that loses
 * the marker is not dropped loudly, it is just quietly withheld from every
 * collaborator.
 */
export function workspaceHomeRoleEventFrame(): {
  name: typeof WORKSPACE_HOME_ROLE_EVENT_NAME;
  [WORKSPACE_HOME_ROLE_EVENT_MARKER]: true;
} {
  return {
    name: WORKSPACE_HOME_ROLE_EVENT_NAME,
    [WORKSPACE_HOME_ROLE_EVENT_MARKER]: true,
  };
}

/**
 * The channel whose payload is a LIST of updates rather than one plugin.
 * Read from the shared constant rather than hand-copied — a literal here is
 * the same drift that silently unhooked the Home-role sentinel.
 */
const PLUGIN_UPDATES_AVAILABLE_EVENT = SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE;

/**
 * Whether one plugin lifecycle frame may reach one subscriber (#2067).
 *
 * Extracted and exported deliberately. This lived as an inline lambda inside
 * a 4,000-line composition, which made it untestable by construction:
 * injecting `return true` as its first statement left every gate green while
 * every plugin channel relayed to every listener. That is the same hole the
 * scan closes one layer up — the label is checked and the thing the label
 * points at is not — so the predicate is a named function with its own
 * tests.
 *
 * Three answers, and each failure direction is a denial:
 *
 *   - the Home-role SENTINEL is relayed to everyone. It names no plugin, so
 *     there is nothing for the projection to evaluate and nothing to
 *     enumerate; withholding it only broke a collaborator's cache
 *     invalidation after a Home revoke. Making it carry a plugin name to
 *     satisfy the gate would ADD plugin identity to a frame that has none.
 *   - `plugins:updates-available` carries a list, not a name, and its route
 *     is operator-only; so is the frame.
 *   - everything else must name a plugin the subscriber may see. A payload
 *     that names none is denied, because an unattributable frame cannot be
 *     shown to be safe.
 */
export function canRelayPluginIdentityEvent(input: {
  event: string;
  data: unknown;
  /** The subscriber, or null when this request cannot be attributed. */
  principal: PrincipalRef | null;
  canSee: (principal: PrincipalRef, pluginName: string) => boolean;
}): boolean {
  const { event, data, principal, canSee } = input;
  const payload = data as
    | { name?: unknown; [WORKSPACE_HOME_ROLE_EVENT_MARKER]?: unknown }
    | undefined;
  const name = payload?.name;
  // Attribution FIRST, for everything including the sentinel. The inline
  // original this was extracted from resolved the principal as its first
  // statement, so an unattributable subscriber received nothing at all; the
  // extraction moved the sentinel check ahead of it and quietly widened the
  // gate. A subscriber this runtime cannot place gets no frames.
  if (principal === null) return false;
  // The sentinel: the grants-changed channel, the reserved name, AND the
  // marker only the Home-role emitters set. All three, because the name is
  // plugin-shaped — it satisfies `isCanonicalPluginId` — so a frame Station
  // emits FOR a plugin of that name would otherwise be indistinguishable
  // from one it emits ABOUT the Home slot, and the settings channel carries
  // a plugin's non-secret setting VALUES.
  if (
    event === SERVER_EVENTS.PLUGINS_GRANTS_CHANGED &&
    name === WORKSPACE_HOME_ROLE_EVENT_NAME &&
    payload !== undefined &&
    payload !== null &&
    Object.hasOwn(payload, WORKSPACE_HOME_ROLE_EVENT_MARKER) &&
    payload[WORKSPACE_HOME_ROLE_EVENT_MARKER] === true
  ) {
    return true;
  }
  if (event === PLUGIN_UPDATES_AVAILABLE_EVENT) {
    return principal.id === LOCAL_OPERATOR_PRINCIPAL_ID;
  }
  if (typeof name !== 'string' || name.length === 0) return false;
  return canSee(principal, name);
}
