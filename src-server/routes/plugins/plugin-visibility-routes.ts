/**
 * `/api/plugins/visibility` — the operator's grant surface for per-principal
 * plugin visibility (#2067; design decision D2 in
 * `docs/design/shell-ownership-and-boards.md`).
 *
 * Two callers appear in every handler and they are never the same one:
 *
 * - the **caller**, resolved from the request's own authentication through
 *   the same fail-closed resolver every identity-bearing route reads
 *   (`services/identity/principal-resolver.ts`). It decides whether this
 *   request may grant anything at all, and it can never be supplied;
 * - the **target**, a principal id in the body. It decides WHOSE projection
 *   changes, and it is only ever read after the caller has been proved to be
 *   the operator.
 *
 * Conflating the two is the whole vulnerability this file exists to avoid: a
 * body-supplied principal that also authorized the request would let anybody
 * grant themselves sight of every installed plugin. `asOperator` runs before
 * any body is read, and the body's `principalId` is never consulted as
 * authority — only as a destination.
 */
import type {
  PluginVisibilityDirectory,
  PluginVisibilityPrincipal,
} from '@kontourai/station-contracts/plugin-visibility';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { Context, Hono } from 'hono';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
} from '../../services/identity/principal-resolver.js';
import {
  isInstanceOperator,
  PluginVisibilityInputError,
  type PluginVisibilityService,
} from '../../services/plugins/plugin-visibility-service.js';
import {
  errorMessage,
  getBody,
  pluginVisibilityGrantSchema,
  validate,
} from '../schemas/schemas.js';

/**
 * The minimal per-request shape principal resolution needs — the same
 * duck-typed subset `createOrchestrationRoutes` and the personal-layout routes
 * accept, so this module stays decoupled from Hono internals and production
 * passes the one memoized resolver it already builds.
 */
export interface PluginVisibilityPrincipalContext {
  env: unknown;
  req: {
    raw: Request;
    header(name: string): string | undefined;
  };
}

/**
 * One row of the operator's principal picker as the DIRECTORY supplies it —
 * the contract row minus the two columns this route derives (`plugins` from
 * the grant record, `operator` from the resolver's one id). Expressed as a
 * subset of {@link PluginVisibilityPrincipal} rather than a parallel
 * interface so a column added to the wire cannot silently stop being filled.
 */
export type PluginVisibilityDirectoryEntry = Omit<
  PluginVisibilityPrincipal,
  'plugins' | 'operator'
>;

export interface PluginVisibilityRouteDeps {
  service: PluginVisibilityService;
  /**
   * Resolves the CALLING request's principal, fail-closed. REQUIRED, with no
   * test-only fallback: a route family whose entire authorization is "is the
   * caller the operator" must never have a second branch that answers when
   * the resolver does not.
   */
  resolvePrincipal(c: PluginVisibilityPrincipalContext): PrincipalRef;
  /**
   * Every principal this instance has a record of, for the operator's picker.
   * Injected rather than derived here: the durable list is the trusted device
   * registry (`DevicePairingService.listKnownPrincipals`), and a route that
   * re-derived it would become a second reader of an authorized store — the
   * shape that eventually disagrees with the first.
   */
  listKnownPrincipals(): readonly PluginVisibilityDirectoryEntry[];
}

class NotOperatorError extends Error {
  constructor() {
    super('Only the Station operator can change plugin visibility.');
    this.name = 'NotOperatorError';
  }
}

export function registerPluginVisibilityRoutes(
  app: Hono,
  deps: PluginVisibilityRouteDeps,
): void {
  /**
   * The ONE place a request becomes an authorized operator action. Every
   * handler below runs inside it, so no handler can acquire authority without
   * passing through both refusals.
   */
  const asOperator =
    (handle: (c: Context) => Response | Promise<Response>) =>
    (c: Context): Response | Promise<Response> => {
      try {
        const caller = deps.resolvePrincipal(c);
        if (!isInstanceOperator(caller)) throw new NotOperatorError();
      } catch (error) {
        if (error instanceof PrincipalUnresolvedError) {
          return c.json(
            { success: false, error: errorMessage(error), code: error.code },
            400,
          );
        }
        if (error instanceof NotOperatorError) {
          return c.json({ success: false, error: error.message }, 403);
        }
        throw error;
      }
      return handle(c);
    };

  const grantsFor = (principalId: string): string[] =>
    deps.service.read().grants[principalId] ?? [];

  app.get(
    '/visibility',
    asOperator((c) => {
      // The operator's row is added here, from the ONE id
      // `principal-resolver` owns, rather than by the pairing registry: the
      // operator has no pairing record, and an operator row invented by a
      // device store would be a second answer to "who is the operator".
      const directory: readonly PluginVisibilityDirectoryEntry[] = [
        {
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          display: 'Operator',
          revoked: false,
        },
        ...deps
          .listKnownPrincipals()
          .filter((entry) => entry.id !== LOCAL_OPERATOR_PRINCIPAL_ID),
      ];
      const data: PluginVisibilityDirectory = {
        principals: directory.map((entry) => ({
          ...entry,
          // The operator's row reports its grants AS RECORDED — an empty
          // list. It is deliberately not filled in with the installed set:
          // the operator sees everything because `visiblePlugins` derives
          // that, and writing it into the grant column would make the UI
          // display a record that does not exist.
          plugins: grantsFor(entry.id),
          operator: entry.id === LOCAL_OPERATOR_PRINCIPAL_ID,
        })),
      };
      return c.json({ success: true, data });
    }),
  );

  const mutate = (
    apply: (principalId: string, plugin: string) => Promise<string[]>,
  ) =>
    asOperator(async (c) => {
      const body = getBody(c) as { principalId: string; plugin: string };
      try {
        return c.json({
          success: true,
          data: {
            principalId: body.principalId,
            plugins: await apply(body.principalId, body.plugin),
          },
        });
      } catch (error) {
        if (error instanceof PluginVisibilityInputError) {
          return c.json(
            { success: false, error: error.message, code: error.code },
            400,
          );
        }
        throw error;
      }
    });

  app.post(
    '/visibility/grants',
    validate(pluginVisibilityGrantSchema),
    mutate((principalId, plugin) => deps.service.grant(principalId, plugin)),
  );

  app.delete(
    '/visibility/grants',
    validate(pluginVisibilityGrantSchema),
    mutate((principalId, plugin) => deps.service.revoke(principalId, plugin)),
  );
}
