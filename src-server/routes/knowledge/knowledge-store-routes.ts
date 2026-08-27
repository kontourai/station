/**
 * K4 onboarding routes — thin delegations onto the K2 `KnowledgeStoreProvider`
 * seam (`docs/design/knowledge-foundation.md`'s K4 section): list/create/validate
 * roots and list registered adapters. No route here touches `src-server/
 * knowledge-index/*` (K3 internals) — this file only ever calls through
 * `KnowledgeStoreProvider`'s own public methods.
 *
 * Input validation (SEC-1, mirroring `knowledge-index-routes.ts`'s exact
 * convention): a `project`-scope `projectSlug` reaches a filesystem join (the
 * server-defaulted project store path, `{dataDir}/projects/<slug>/knowledge-store`)
 * so it is validated via `../knowledge-index/path-safety.ts`'s `isSafePathSegment`
 * BEFORE that join happens, returning 400 rather than letting a traversal-shaped
 * slug (e.g. `../../evil`) reach `node:path.join`. `adapterId` is validated against
 * `store.listAdapters()` before `createRoot` is called (400 on unknown adapter) —
 * the same honesty bar `knowledge-index-routes.ts` already sets for `rootId`/
 * `projectSlug`.
 *
 * Dishonest-validation stop-short risk (binding): `POST /roots/validate` returns
 * `store.validateRootForAdapter(...)`'s `{ ok, reason? }` verbatim — this route
 * never rewrites, summarizes, or replaces the adapter's own `reason` string with a
 * generic message. `POST /roots` closes the same gap for every caller (K4 code-review
 * MEDIUM finding, not just the one UI flow that already re-validated on its own before
 * connecting): it calls `validateRootForAdapter` itself before `createRoot` and
 * returns 400 with the adapter's own `reason` on `ok:false` — an adapter with no
 * `validateRoot` hook (e.g. kit-default-store) always reports `{ ok: true }`, so this
 * never rejects a not-yet-existing default personal/project path for that adapter; only
 * an adapter that actually declares a validation hook (e.g. kit-obsidian-store, which
 * rejects a missing/empty target directory) can ever produce a 400 here.
 *
 * SEC-K4-1 (LOW, accepted): an explicit `storeRoot` override is deliberately
 * scope-agnostic — a `project`-scope create may target any absolute path the caller
 * supplies, not just a path under that project. This is intentional, matching Station's
 * existing local-first model (the same trust boundary as the filesystem-browse routes
 * and a project's own `workingDirectory`, both of which already accept an arbitrary
 * local path): once a caller can reach these routes at all, no server-side sandboxing
 * happens to already exist for local filesystem targets, so per-scope path confinement
 * would be a new invariant, not a restoration of one that exists elsewhere in this
 * codebase.
 */

import { join } from 'node:path';
import type {
  KnowledgeRootScope,
  KnowledgeStoreProvider,
} from '@kontourai/station-contracts/knowledge-store';
import { Hono } from 'hono';
import { isSafePathSegment } from '../../knowledge-index/path-safety.js';
import { expandTilde } from '../../utils/paths.js';
import { errorMessage } from '../schemas/schemas.js';

export interface KnowledgeStoreRouteDeps {
  store: KnowledgeStoreProvider;
  /** Station home dir — same accessor `knowledge-index-routes.ts` already uses
   * (`context.configLoader.getProjectHomeDir()`). */
  dataDir: string;
}

interface CreateRootBody {
  scope?: unknown;
  adapterId?: unknown;
  storeRoot?: unknown;
  displayName?: unknown;
}

interface ValidateRootBody {
  adapterId?: unknown;
  storeRoot?: unknown;
}

function isKnownScope(value: unknown): value is KnowledgeRootScope {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'personal') return true;
  if (kind === 'project') {
    return typeof (value as { projectSlug?: unknown }).projectSlug === 'string';
  }
  return false;
}

function defaultDisplayName(scope: KnowledgeRootScope): string {
  return scope.kind === 'personal'
    ? 'Personal knowledge store'
    : `${scope.projectSlug} knowledge store`;
}

export function createKnowledgeStoreRoutes(deps: KnowledgeStoreRouteDeps) {
  const app = new Hono();

  // GET /roots — every registered root (personal + project), all scopes.
  app.get('/roots', async (c) => {
    try {
      const roots = await deps.store.listRoots();
      return c.json({ success: true, data: roots });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // GET /adapters — id/displayName only; never leak adapter internals
  // (`create`/`validateRoot` function references are dropped by this mapping).
  app.get('/adapters', async (c) => {
    try {
      const adapters = deps.store
        .listAdapters()
        .map((a) => ({ id: a.id, displayName: a.displayName }));
      return c.json({ success: true, data: adapters });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // POST /roots — body: { scope, adapterId, storeRoot?, displayName? }.
  // `storeRoot` omitted => server-defaulted so "create" is a single click with
  // no path to type: personal defaults to `{dataDir}/knowledge/personal`;
  // project defaults to `{dataDir}/projects/<slug>/knowledge-store`.
  app.post('/roots', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as CreateRootBody;

      if (!isKnownScope(body.scope)) {
        return c.json({ success: false, error: 'Invalid scope' }, 400);
      }
      const scope = body.scope;

      if (scope.kind === 'project' && !isSafePathSegment(scope.projectSlug)) {
        return c.json({ success: false, error: 'Invalid projectSlug' }, 400);
      }

      if (typeof body.adapterId !== 'string' || body.adapterId.length === 0) {
        return c.json({ success: false, error: 'Invalid adapterId' }, 400);
      }
      const adapterId = body.adapterId;
      const knownAdapterIds = deps.store.listAdapters().map((a) => a.id);
      if (!knownAdapterIds.includes(adapterId)) {
        return c.json(
          { success: false, error: `Unknown adapterId: ${adapterId}` },
          400,
        );
      }

      if (
        body.storeRoot !== undefined &&
        (typeof body.storeRoot !== 'string' || body.storeRoot.length === 0)
      ) {
        return c.json({ success: false, error: 'Invalid storeRoot' }, 400);
      }
      if (
        body.displayName !== undefined &&
        typeof body.displayName !== 'string'
      ) {
        return c.json({ success: false, error: 'Invalid displayName' }, 400);
      }

      const storeRoot =
        typeof body.storeRoot === 'string' && body.storeRoot.length > 0
          ? expandTilde(body.storeRoot)
          : defaultStoreRoot(deps.dataDir, scope);

      const displayName =
        typeof body.displayName === 'string' && body.displayName.length > 0
          ? body.displayName
          : defaultDisplayName(scope);

      // Honest-validation guarantee at the API layer (not just the UI flow — K4
      // code-review MEDIUM finding): reject a create for a target the adapter
      // itself would flag before ever calling createRoot. Verbatim passthrough of
      // the adapter's own `reason`, same convention as `POST /roots/validate`.
      // For an adapter with no `validateRoot` hook (e.g. kit-default-store),
      // `validateRootForAdapter` always returns `{ ok: true }`, so this never
      // rejects a not-yet-existing default path for that adapter.
      const validation = await deps.store.validateRootForAdapter(
        adapterId,
        storeRoot,
      );
      if (!validation.ok) {
        return c.json({ success: false, error: validation.reason }, 400);
      }

      const root = await deps.store.createRoot({
        scope,
        adapterId,
        storeRoot,
        displayName,
      });
      return c.json({ success: true, data: root }, 201);
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // POST /roots/validate — body: { adapterId, storeRoot }. Verbatim passthrough
  // of the adapter's own `{ ok, reason? }` — see module doc.
  app.post('/roots/validate', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as ValidateRootBody;

      if (typeof body.adapterId !== 'string' || body.adapterId.length === 0) {
        return c.json({ success: false, error: 'Invalid adapterId' }, 400);
      }
      if (typeof body.storeRoot !== 'string' || body.storeRoot.length === 0) {
        return c.json({ success: false, error: 'Invalid storeRoot' }, 400);
      }

      const expanded = expandTilde(body.storeRoot);
      const result = await deps.store.validateRootForAdapter(
        body.adapterId,
        expanded,
      );
      return c.json({ success: true, data: result });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // DELETE /roots/:id — deregister only (K2's `removeRoot` never deletes store
  // files; see its own doc comment).
  app.delete('/roots/:id', async (c) => {
    try {
      const id = c.req.param('id');
      await deps.store.removeRoot(id);
      return c.json({ success: true, data: { id } });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  return app;
}

/** `scope.projectSlug` is validated via `isSafePathSegment` by the caller
 * (`POST /roots`) before this is ever invoked. */
function defaultStoreRoot(dataDir: string, scope: KnowledgeRootScope): string {
  if (scope.kind === 'personal') {
    return join(dataDir, 'knowledge', 'personal');
  }
  return join(dataDir, 'projects', scope.projectSlug, 'knowledge-store');
}
