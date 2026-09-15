/**
 * `/api/me/layouts` — the authenticated caller's own Boards (#2061).
 *
 * "Me" is the whole authorization model of this family. There is no owner
 * segment in any path and no owner field in any body: the principal comes
 * from the request's own authentication, through the same resolver every
 * other identity-bearing route reads
 * (`src-server/services/identity/principal-resolver.ts`, wired in
 * `runtime-routes.ts`). A caller therefore cannot address another principal's
 * Boards — not because a filter refuses, but because there is nothing to
 * write the other principal into.
 *
 * The mirror of `/api/projects/:slug/layouts`, which issues ownership from
 * its path segment for the same reason (#2060).
 */
import { randomUUID } from 'node:crypto';
import type {
  LayoutOwner,
  LayoutReadView,
} from '@kontourai/station-contracts/layout';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { AgentOwnershipRef } from '@kontourai/station-contracts/project-reference-integrity';
import { type Context, Hono } from 'hono';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import { InvalidPathSegmentError } from '../../knowledge-index/path-safety.js';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';
import { resolveLayoutPaneReferences } from '../../services/layouts/layout-pane-reference.js';
import {
  type OwnedLayoutStore,
  PersonalLayoutConflictError,
  PersonalLayoutService,
  ProjectLayoutRefusedError,
  personalLayoutOwner,
} from '../../services/layouts/personal-layout-service.js';
import {
  errorMessage,
  getBody,
  param,
  personalLayoutCreateSchema,
  personalLayoutPromoteSchema,
  personalLayoutUpdateSchema,
  validate,
} from '../schemas/schemas.js';

/**
 * The minimal per-request shape principal resolution needs — the same
 * duck-typed subset `createOrchestrationRoutes` accepts, so this route module
 * stays decoupled from Hono internals and production can pass the one
 * memoized resolver it already builds.
 */
export interface PersonalLayoutPrincipalContext {
  env: unknown;
  req: {
    raw: Request;
    header(name: string): string | undefined;
  };
}

export interface PersonalLayoutRouteDeps {
  /**
   * Resolves the calling request's principal, fail-closed. REQUIRED, with no
   * test-only fallback: a route family whose entire authorization is "who is
   * calling" must never have a second branch that answers when the resolver
   * does not. An unresolvable caller throws `PrincipalUnresolvedError`, which
   * {@link principalUnresolved} answers as a typed refusal rather than this
   * file inventing an owner.
   */
  resolvePrincipal(c: PersonalLayoutPrincipalContext): PrincipalRef;
  /** Overridable so tests pin timestamps and ids; production takes the defaults. */
  now?: () => string;
  newId?: () => string;
  /**
   * The agents a promoted Board's references are checked against (#2062
   * review BLOCKING-2).
   *
   * REQUIRED, like `resolvePrincipal` and for the same reason: promote
   * publishes into a project, and the project's own create route refuses a
   * layout naming an agent it cannot reach. A composition that forgets to
   * supply this would promote past a check the destination applies, so the
   * omission is a type error rather than a silent skip. Resolving to
   * `undefined` still means "skip", matching `projects.ts`'s own
   * `readKnownAgents()`.
   */
  listAgents: () => Promise<readonly AgentOwnershipRef[] | undefined>;
  /** Resolves a coding layout's repo-scoped directory, as the project routes do. */
  resolveWorkspacePath?: (
    projectSlug: string,
    resourceId: string,
  ) => Promise<string | undefined>;
  /**
   * Whether the request's own caller may see a named plugin (#2067), bound
   * per request — the same projection the project layout routes read.
   *
   * A Board reaches `LayoutRenderer` through the same
   * `layoutWorkspaceShape` derivation a project Layout does, so a Board tab
   * naming a component from a plugin this person cannot see hits the same
   * false sentence ("…is not installed or registered"). This is what lets
   * the Board answer it with the causeless placeholder instead (#2090).
   *
   * Optional, and absent means NOTHING is withheld — the layout-only route
   * tests compose without it and must render exactly as before.
   *
   * Unlike the project route, this one withholds nothing else. There is no
   * live plugin read and no catalog backfill on this path: a Board's
   * `config.plugin` is the CALLER'S OWN input into their OWN record, so
   * stripping it would disclose nothing while destroying their binding on
   * the next read-modify-write.
   */
  canSeePlugin?: (
    c: PersonalLayoutPrincipalContext,
    pluginId: string,
  ) => boolean;
}

/**
 * The one not-found answer this family gives.
 *
 * A slug the caller does not own and a slug nobody owns MUST be
 * indistinguishable — same status, same body — or the response becomes an
 * oracle for whether another person has a Board by that name. Routing both
 * through one helper is what keeps them identical as this file changes; the
 * storage layout (one directory per principal) is what makes them identical
 * in the first place.
 */
function noSuchBoard(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ success: false, error: 'Board not found' }, 404);
}

/**
 * The refusal an unresolvable caller gets.
 *
 * Mirrors what the orchestration routes already answer for the SAME error
 * (`src-server/routes/orchestration/orchestration.ts`, whose route catch
 * forwards `errorCode(error)` onto a 400 `{ success, error, code }`
 * envelope): status 400, `error` sanitized through the shared
 * `errorMessage`, and `code` carrying the wire-stable
 * `PRINCIPAL_UNRESOLVED_CODE` the client-side translator keys on
 * (`src-ui/src/utils/chatErrorTranslation.ts`) so the rendered copy never
 * offers a retry for a failure retrying cannot fix.
 *
 * Without this, the error is neither a route error nor an auth error, so
 * `runtime-http.ts`'s unhandled-error boundary answers 500 "unexpected
 * runtime error" with a correlation id — an infrastructure fault for what is
 * a deterministic authz refusal. Production reaches it: a paired device whose
 * person binding conflicts with the current identity or deployment
 * (`runtime-routes.ts`'s `resolveOrchestrationRequestPrincipal`), or a caller
 * carrying no identity and no authority fact at all.
 */
function principalUnresolved(
  c: { json: (body: unknown, status: 400) => Response },
  error: PrincipalUnresolvedError,
): Response {
  return c.json(
    { success: false, error: errorMessage(error), code: error.code },
    400,
  );
}

export function createPersonalLayoutRoutes(
  store: OwnedLayoutStore,
  deps: PersonalLayoutRouteDeps,
): Hono {
  const app = new Hono();
  const service = new PersonalLayoutService(store, {
    now: deps.now,
    newId: deps.newId ?? randomUUID,
    listAgents: deps.listAgents,
    resolveWorkspacePath: deps.resolveWorkspacePath,
  });
  /**
   * Resolves the caller once, ahead of the handler, and is the ONE place an
   * unresolvable caller is turned into a response. Every handler below reads
   * its owner from here, so no route can acquire an owner without passing
   * through this refusal — the same reason `noSuchBoard` is a single helper.
   */
  const withOwner =
    (
      handle: (c: Context, owner: LayoutOwner) => Response | Promise<Response>,
    ) =>
    (c: Context): Response | Promise<Response> => {
      let owner: LayoutOwner;
      try {
        owner = personalLayoutOwner(deps.resolvePrincipal(c));
      } catch (error) {
        if (error instanceof PrincipalUnresolvedError) {
          return principalUnresolved(c, error);
        }
        throw error;
      }
      return handle(c, owner);
    };

  app.get(
    '/layouts',
    withOwner((c, owner) => {
      return c.json({ success: true, data: service.list(owner) });
    }),
  );

  app.post(
    '/layouts',
    validate(personalLayoutCreateSchema),
    withOwner(async (c, owner) => {
      const body = getBody(c);
      try {
        assertSafeLayoutPathSegment('layout slug', body.slug);
      } catch (error) {
        if (error instanceof InvalidPathSegmentError) {
          return c.json({ success: false, error: 'Invalid Board name' }, 400);
        }
        throw error;
      }
      try {
        const created = await service.create(owner, body);
        return c.json({ success: true, data: created }, 201);
      } catch (error) {
        if (error instanceof PersonalLayoutConflictError) {
          return c.json({ success: false, error: error.message }, 409);
        }
        throw error;
      }
    }),
  );

  /** This request's own plugin projection (#2067), or `undefined`. */
  const viewerPluginSight = (
    c: Context,
  ): ((pluginId: string) => boolean) | undefined => {
    const canSeePlugin = deps.canSeePlugin;
    return canSeePlugin ? (pluginId) => canSeePlugin(c, pluginId) : undefined;
  };

  app.get(
    '/layouts/:layoutSlug',
    withOwner((c, owner) => {
      const layoutSlug = addressableSlug(c);
      if (layoutSlug === undefined) return noSuchBoard(c);
      const board = service.get(owner, layoutSlug);
      if (board === undefined) return noSuchBoard(c);
      // #2090 — the Board twin of the project layout read. Emitted only when
      // a tab really cannot be shown, so absence stays absence and a
      // composition with no projection renders exactly as it always did.
      const paneReferences = resolveLayoutPaneReferences(board, {
        canSeePlugin: viewerPluginSight(c),
      });
      // Assigned to a typed binding rather than spread into a literal: a
      // misspelling in a spread is not excess-property-checked (#2090
      // review), so the field would silently vanish from the response.
      const data: LayoutReadView = { ...board };
      if (paneReferences) data.paneReferences = paneReferences;
      return c.json({ success: true, data });
    }),
  );

  app.put(
    '/layouts/:layoutSlug',
    validate(personalLayoutUpdateSchema),
    withOwner(async (c, owner) => {
      const layoutSlug = addressableSlug(c);
      if (layoutSlug === undefined) return noSuchBoard(c);
      // #2090 — `paneReferences` is a READ verdict about the caller, and the
      // storage schema is `.strict()`. A client that read a Board and PUT it
      // back would otherwise be refused by the store; the update schema
      // tolerates the key for that reason alone and it is dropped here,
      // rather than spread into the record by `service.update`.
      const { paneReferences: _paneReferences, ...patch } = getBody(c);
      const updated = await service.update(owner, layoutSlug, patch);
      if (updated === undefined) return noSuchBoard(c);
      // The write answers with the same verdict the read does. Without it a
      // client rendering from this response falls back to the false "not
      // installed or registered" sentence until its next refetch.
      const verdict = resolveLayoutPaneReferences(updated, {
        canSeePlugin: viewerPluginSight(c),
      });
      const data: LayoutReadView = { ...updated };
      if (verdict) data.paneReferences = verdict;
      return c.json({ success: true, data });
    }),
  );

  /**
   * Move a Board into a project (#2062).
   *
   * Routed through `withOwner` like every other handler here, so an
   * unresolvable caller gets this family's one typed refusal rather than a
   * catch written for the DESTINATION reading it as a missing project.
   *
   * ## Why this is not a membership check
   *
   * The brief this slice was written from expected promote to reuse "the
   * membership check the project routes use". There is none to reuse:
   * `src-server/routes/projects/projects.ts` applies no per-project predicate
   * to any layout handler (its `POST /:slug/layouts` validates the slug,
   * reads `projectRevision(slug)`, and writes), the only membership
   * middleware in `runtime-routes.ts` covers `/api/projects/:slug/access*`
   * and merely stashes a principal, and `ProjectMembershipService` is
   * constructed only when `projectSharingEnabled` and only knows projects
   * that were explicitly shared — so requiring it here would make promote
   * fail on every ordinary single-operator Station.
   * `docs/design/project-membership.md` says so itself: "This document
   * specifies the contract; it does not claim implemented API or membership
   * capability."
   *
   * So promote does not INVENT an authorization tier the operation it
   * performs does not have. It publishes through the project transaction
   * (`createOwnedLayout` -> `createLayout` -> `projectRevision(slug)`), which
   * is the same and only writer `POST /api/projects/:slug/layouts` uses, and
   * both leaves carry the same `orchestration:operate` pairing scope — so
   * promote hands a caller nothing it could not already do by posting the
   * same layout to the project directly. `pairing-route-scopes.test.ts` pins
   * that equivalence rather than this comment asserting it.
   *
   * What it does enforce is that the destination EXISTS, with the project
   * routes' own answer: `projectRevision` raises `FileStorageNotFoundError`
   * and this returns 404 `Project not found`, byte-identical to
   * `projectMutationMessage`/`projectMutationStatus` (`projects.ts`) — and it
   * enforces it BEFORE the personal record is deleted, so a promote into a
   * name nobody owns cannot destroy the Board.
   */
  app.post(
    '/layouts/:layoutSlug/promote',
    validate(personalLayoutPromoteSchema),
    withOwner(async (c, owner) => {
      const layoutSlug = addressableSlug(c);
      if (layoutSlug === undefined) return noSuchBoard(c);
      const { projectSlug } = getBody(c);
      try {
        assertSafeLayoutPathSegment('project slug', projectSlug);
      } catch (error) {
        if (error instanceof InvalidPathSegmentError) {
          return c.json({ success: false, error: 'Project not found' }, 404);
        }
        throw error;
      }
      try {
        const promoted = await service.promote(owner, layoutSlug, projectSlug);
        return promoted === undefined
          ? noSuchBoard(c)
          : c.json({ success: true, data: promoted });
      } catch (error) {
        // The destination's own admission refused this body. Forwarded
        // verbatim — same status, same message, same diagnostics the project
        // route would have answered — because it IS that route's refusal,
        // produced by the function both call (#2062 review BLOCKING-2).
        if (error instanceof ProjectLayoutRefusedError) {
          return c.json(error.body, 400);
        }
        if (error instanceof FileStorageNotFoundError) {
          return c.json({ success: false, error: 'Project not found' }, 404);
        }
        if (error instanceof FileStorageConflictError) {
          return c.json(
            {
              success: false,
              error: `Project '${projectSlug}' already has a layout named '${layoutSlug}'.`,
            },
            409,
          );
        }
        throw error;
      }
    }),
  );

  app.delete(
    '/layouts/:layoutSlug',
    withOwner(async (c, owner) => {
      const layoutSlug = addressableSlug(c);
      if (layoutSlug === undefined) return noSuchBoard(c);
      return (await service.remove(owner, layoutSlug))
        ? c.json({ success: true })
        : noSuchBoard(c);
    }),
  );

  return app;
}

/**
 * The slug a read/update/delete addresses, or `undefined` when it could never
 * name a stored record.
 *
 * A malformed slug answers exactly like an unused one. Letting the path-safety
 * refusal surface its own status would sort slugs into "merely unused" and
 * "malformed" for a caller who is guessing — a distinction that helps nobody
 * except somebody probing the store. A create is different and does answer
 * 400: it is the caller naming a new Board, not asking whether one exists.
 */
function addressableSlug(c: Context): string | undefined {
  const layoutSlug = param(c, 'layoutSlug');
  try {
    assertSafeLayoutPathSegment('layout slug', layoutSlug);
    return layoutSlug;
  } catch (error) {
    if (error instanceof InvalidPathSegmentError) return undefined;
    throw error;
  }
}
