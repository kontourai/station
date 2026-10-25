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
  LayoutConfig,
  LayoutOwner,
  LayoutReadView,
} from '@kontourai/station-contracts/layout';
import { layoutSubject } from '@kontourai/station-contracts/layout';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { AgentOwnershipRef } from '@kontourai/station-contracts/project-reference-integrity';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import {
  InvalidPathSegmentError,
  isSafePathSegment,
} from '../../knowledge-index/path-safety.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';
import { resolveLayoutPaneReferences } from '../../services/layouts/layout-pane-reference.js';
import {
  BoardRevisionConflict,
  PersonalBoardAuthoring,
} from '../../services/layouts/personal-board-authoring.js';
import { personalLayoutConforms } from '../../services/layouts/personal-layout-policy.js';
import {
  type OwnedLayoutStore,
  PersonalBoardAuthoringRequired,
  PersonalBoardMoveConflict,
  PersonalLayoutConflictError,
  PersonalLayoutService,
  ProjectLayoutRefusedError,
  personalLayoutOwner,
} from '../../services/layouts/personal-layout-service.js';
import {
  personalBoardDismissSchema,
  personalBoardProposalSchema,
  personalBoardSaveSchema,
} from '../schemas/schema-definitions/personal-board.js';
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
  /** Required for subject-bearing layouts; absent composition fails closed. */
  canUseProject?: (
    c: PersonalLayoutPrincipalContext,
    projectSlug: string,
    action: 'view' | 'manage-layouts',
  ) => Promise<boolean>;
  componentPlugins?: (name: string) => readonly string[];
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
  const authoring = new PersonalBoardAuthoring(store);
  const eligible = async (
    c: Context,
    layout: Pick<
      LayoutConfig,
      'owner' | 'projectSlug' | 'subject' | 'config' | 'catalogContribution'
    >,
  ): Promise<boolean> => {
    const subject = layoutSubject(layout);
    if (!subject) return true;
    if (!(await deps.canUseProject?.(c, subject.projectSlug, 'view')))
      return false;
    try {
      const project = store.getProject(subject.projectSlug);
      const projectOwner: LayoutOwner = {
        kind: 'project',
        projectSlug: subject.projectSlug,
      };
      return personalLayoutConforms({
        layout,
        project,
        projectLayouts: store
          .listOwnedLayouts(projectOwner)
          .map((item) => store.getOwnedLayout(projectOwner, item.slug)),
        canSeePlugin: (id) => deps.canSeePlugin?.(c, id) === true,
        componentPlugins: (name) => deps.componentPlugins?.(name) ?? [],
      });
    } catch (error) {
      if (error instanceof FileStorageNotFoundError) return false;
      throw error;
    }
  };
  const readView = (layout: LayoutConfig): LayoutReadView =>
    layout.subject ? { ...layout, presentation: 'tabs' } : { ...layout };
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
    async (c: Context): Promise<Response> => {
      let owner: LayoutOwner;
      try {
        owner = personalLayoutOwner(deps.resolvePrincipal(c));
      } catch (error) {
        if (error instanceof PrincipalUnresolvedError) {
          return principalUnresolved(c, error);
        }
        throw error;
      }
      const slug = c.req.param('layoutSlug') ? addressableSlug(c) : undefined;
      const saved = slug ? service.get(owner, slug) : undefined;
      if (saved && !(await eligible(c, saved))) return noSuchBoard(c);
      return handle(c, owner);
    };

  const boardAction = async (
    c: Context,
    operation: () => unknown | Promise<unknown>,
  ) => {
    try {
      return c.json({ success: true, data: await operation() });
    } catch (error) {
      if (error instanceof BoardRevisionConflict)
        return c.json({ success: false, error: errorMessage(error) }, 409);
      if (error instanceof FileStorageNotFoundError) return noSuchBoard(c);
      throw error;
    }
  };
  app.get(
    '/boards/:layoutSlug',
    withOwner((c, owner) => {
      const slug = addressableSlug(c);
      return slug === undefined
        ? noSuchBoard(c)
        : boardAction(c, () => authoring.get(owner, slug));
    }),
  );
  app.post(
    '/boards/:layoutSlug/proposal',
    validate(personalBoardProposalSchema),
    withOwner((c, owner) => {
      const slug = addressableSlug(c);
      return slug === undefined
        ? noSuchBoard(c)
        : boardAction(c, () => authoring.propose(owner, slug, getBody(c)));
    }),
  );
  app.put(
    '/boards/:layoutSlug',
    validate(personalBoardSaveSchema),
    withOwner((c, owner) => {
      if (requestMayBeAnAgent(c.req.raw))
        return c.json(
          { success: false, error: 'Review and save this Board in Station.' },
          403,
        );
      const slug = addressableSlug(c);
      return slug === undefined
        ? noSuchBoard(c)
        : boardAction(c, () => authoring.save(owner, slug, getBody(c)));
    }),
  );
  app.delete(
    '/boards/:layoutSlug/proposal',
    validate(personalBoardDismissSchema),
    withOwner((c, owner) => {
      if (requestMayBeAnAgent(c.req.raw))
        return c.json(
          { success: false, error: 'Dismiss this proposal in Station.' },
          403,
        );
      const slug = addressableSlug(c);
      return slug === undefined
        ? noSuchBoard(c)
        : boardAction(c, () =>
            authoring.dismiss(owner, slug, getBody(c).revision),
          );
    }),
  );

  app.get(
    '/layouts',
    withOwner(async (c, owner) => {
      const visible = [];
      for (const item of service.list(owner)) {
        const record = service.get(owner, item.slug);
        if (record && (await eligible(c, record)))
          visible.push(
            layoutSubject(record) ? { ...item, presentation: 'tabs' } : item,
          );
      }
      return c.json({ success: true, data: visible });
    }),
  );

  app.post(
    '/layouts',
    validate(personalLayoutCreateSchema),
    withOwner(async (c, owner) => {
      const body = getBody(c);
      if (
        body.config &&
        ('dashboard' in body.config || 'dashboardProposal' in body.config)
      )
        return c.json(
          {
            success: false,
            error:
              'Use the Board editor or proposal API to author a dashboard.',
          },
          400,
        );
      try {
        assertSafeLayoutPathSegment('layout slug', body.slug);
      } catch (error) {
        if (error instanceof InvalidPathSegmentError) {
          return c.json({ success: false, error: 'Invalid Board name' }, 400);
        }
        throw error;
      }
      try {
        const candidate = { ...body, owner, config: body.config ?? {} };
        if (!(await eligible(c, candidate)))
          return c.json(
            {
              success: false,
              error: 'Personal layout is unavailable on this Project',
            },
            400,
          );
        const created = await service.create(owner, body);
        return c.json({ success: true, data: readView(created) }, 201);
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

  const layoutSegmentSchema = z
    .string()
    .refine(isSafePathSegment, 'Invalid layout path segment');
  const cloneSchema = z
    .object({
      slug: layoutSegmentSchema,
      name: z.string().min(1).optional(),
      asTemplate: z.boolean().optional(),
    })
    .strict();
  const projectCloneSchema = cloneSchema
    .extend({
      projectSlug: layoutSegmentSchema,
      layoutSlug: layoutSegmentSchema,
    })
    .strict();
  const clone = async (
    c: Context,
    owner: LayoutOwner,
    source: LayoutConfig,
    input: z.infer<typeof cloneSchema>,
    projectSlug?: string,
  ) => {
    const subject = input.asTemplate
      ? undefined
      : projectSlug
        ? { kind: 'project' as const, projectSlug }
        : source.subject;
    const candidate = { ...source, owner, projectSlug: undefined, subject };
    if (!(await eligible(c, candidate))) return noSuchBoard(c);
    try {
      const created = await service.clone(owner, source, {
        slug: input.slug,
        name: input.name,
        subject,
      });
      return c.json({ success: true, data: readView(created) }, 201);
    } catch (error) {
      if (error instanceof PersonalLayoutConflictError)
        return c.json({ success: false, error: errorMessage(error) }, 409);
      throw error;
    }
  };
  app.post(
    '/layouts/clone-project',
    validate(projectCloneSchema),
    withOwner(async (c, owner) => {
      const input = getBody(c);
      if (!(await deps.canUseProject?.(c, input.projectSlug, 'view')))
        return noSuchBoard(c);
      try {
        const source = store.getOwnedLayout(
          { kind: 'project', projectSlug: input.projectSlug },
          input.layoutSlug,
        );
        // Even saving a template cannot use a hidden plugin as an existence oracle.
        if (
          !(await eligible(c, {
            ...source,
            projectSlug: undefined,
            owner,
            subject: { kind: 'project', projectSlug: input.projectSlug },
          }))
        )
          return noSuchBoard(c);
        return clone(c, owner, source, input, input.projectSlug);
      } catch (error) {
        if (error instanceof FileStorageNotFoundError) return noSuchBoard(c);
        throw error;
      }
    }),
  );
  app.post(
    '/layouts/:layoutSlug/clone',
    validate(cloneSchema),
    withOwner(async (c, owner) => {
      const slug = addressableSlug(c);
      const source = slug ? service.get(owner, slug) : undefined;
      return source ? clone(c, owner, source, getBody(c)) : noSuchBoard(c);
    }),
  );
  app.get(
    '/layouts/:layoutSlug/open',
    withOwner(async (c, owner) => {
      const projectSlug = c.req.query('projectSlug');
      if (!isSafePathSegment(projectSlug)) return noSuchBoard(c);
      const slug = addressableSlug(c);
      const source = slug ? service.get(owner, slug) : undefined;
      if (!source) return noSuchBoard(c);
      const bound = {
        ...source,
        subject: { kind: 'project' as const, projectSlug },
      };
      if (!(await eligible(c, bound))) return noSuchBoard(c);
      return c.json({ success: true, data: readView(bound) });
    }),
  );

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
      const data = readView(board);
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
      const saved = service.get(owner, layoutSlug);
      if (
        patch.config &&
        (saved?.config.dashboard ||
          saved?.config.dashboardProposal ||
          'dashboard' in patch.config ||
          'dashboardProposal' in patch.config)
      )
        return c.json(
          {
            success: false,
            error:
              'Use the Board editor or proposal API to author a dashboard.',
          },
          400,
        );
      if (saved && !(await eligible(c, { ...saved, ...patch })))
        return c.json(
          {
            success: false,
            error: 'Personal layout is unavailable on this Project',
          },
          400,
        );
      let updated: LayoutConfig | undefined;
      try {
        updated = await service.update(owner, layoutSlug, patch);
      } catch (error) {
        if (error instanceof PersonalBoardAuthoringRequired)
          return c.json({ success: false, error: errorMessage(error) }, 400);
        throw error;
      }
      if (updated === undefined) return noSuchBoard(c);
      // The write answers with the same verdict the read does. Without it a
      // client rendering from this response falls back to the false "not
      // installed or registered" sentence until its next refetch.
      const verdict = resolveLayoutPaneReferences(updated, {
        canSeePlugin: viewerPluginSight(c),
      });
      const data = readView(updated);
      if (verdict) data.paneReferences = verdict;
      return c.json({ success: true, data });
    }),
  );

  /** Promotion remains a move and requires the destination's layout-management authority. */
  app.post(
    '/layouts/:layoutSlug/promote',
    validate(personalLayoutPromoteSchema),
    withOwner(async (c, owner) => {
      const layoutSlug = addressableSlug(c);
      if (layoutSlug === undefined) return noSuchBoard(c);
      const { projectSlug } = getBody(c);
      if (
        deps.canUseProject &&
        !(await deps.canUseProject(c, projectSlug, 'manage-layouts'))
      )
        return c.json(
          { success: false, error: 'Project mutation is forbidden' },
          403,
        );
      if (
        service.get(owner, layoutSlug)?.config.dashboardProposal !== undefined
      )
        return c.json(
          {
            success: false,
            error:
              'Apply or dismiss the Board proposal before moving it to a Project.',
          },
          409,
        );
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
        if (error instanceof PersonalLayoutConflictError)
          return c.json(
            {
              success: false,
              error:
                'Apply or dismiss the Board proposal before moving it to a Project.',
            },
            409,
          );
        if (error instanceof PersonalBoardMoveConflict)
          return c.json({ success: false, error: errorMessage(error) }, 409);
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
