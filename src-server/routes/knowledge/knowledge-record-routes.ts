/**
 * K5 knowledge-record routes — thin delegations onto the K2 `KnowledgeStoreProvider`
 * seam's per-root adapter (`docs/design/knowledge-foundation.md`'s K2 section;
 * `packages/contracts/src/knowledge-store.ts`'s `KnowledgeStoreAdapter`). This closes
 * one of the two flagged primitive gaps `s203-knowledge-meeting-notes--plan.md`'s
 * Wave 1 Task 2 names: `KnowledgeStoreProvider.adapterFor(rootId)` had NO HTTP route
 * before this file — only root-registry (`knowledge-store-routes.ts`) and
 * index-rebuild/migrate (`knowledge-index-routes.ts`) routes existed.
 *
 * Scope (Q4 "genuine primitive gap, not scope creep"): this file exposes ONLY the
 * record operations K5's capture+recall flow needs — create, get, listByType, link,
 * and a bulk graph read for the wikilink pane. It deliberately does NOT expose the
 * rest of the adapter's §8 surface over HTTP (`update`/`propose`/`apply`/`reject`/
 * `supersede`/`retire` stay unexposed — nothing in this plan needs them).
 *
 * Path-safety (SEC-1, mirroring `knowledge-store-routes.ts`'s `projectSlug` guard and
 * `knowledge-index-routes.ts`'s `isPlausibleRootId` guard): `rootId` never reaches a
 * filesystem path directly (the store resolves roots by registry id), so it only gets
 * the same defensive shape/length check `knowledge-index-routes.ts` already applies.
 * A Kit record `id`, by contrast, DOES reach a filesystem path directly in
 * `kit-default-store` (verified by reading `default-store.ts`): `recordPath(id)`
 * joins the raw id straight into `records/<id>.md` with no validation of its own —
 * `create`'s optional `input.id`, `link`'s `l.target_id` (via `readRecord` inside the
 * adapter's own existence check), and `get`'s `idOrHandle` (via `resolveRecordId` ->
 * `idExists`) all reach that join unguarded. A caller-supplied id containing `..`/`/`
 * is therefore a real traversal vector at the adapter layer this route sits in front
 * of. Every id-shaped value this file accepts — the create body's optional `id`, the
 * `:id` path param, and each `links[].target_id` — is validated with the same
 * `isSafePathSegment` check `knowledge-store-routes.ts` already uses for
 * `projectSlug`, rejecting with 400 before the value ever reaches the adapter.
 *
 * This is a deliberate narrowing versus the full store contract: Addendum H's
 * slug-alias/id-prefix resolution (which legitimately allows `/` in a slug) is out of
 * scope for this HTTP surface — K5's capture+recall never needs alias resolution,
 * only lookup by a record's own generated id, so `GET .../records/:id` only ever
 * resolves a full id here, not a handle. Nothing about this narrowing changes the
 * adapter's own contract; a caller that genuinely needs alias resolution is not
 * served by this route today, named here rather than silently unsupported.
 *
 * The graph route (`GET /roots/:rootId/graph`) builds nodes+edges directly from
 * `listByType`'s own `KitRecord.links` field (already the same forward-edge data
 * `getLinks(id).forward` would return for that same record) rather than an
 * additional `getLinks` call per record — same data, one read per record instead of
 * two. A Neo4j-connected root's graph read (Wave 1 Task 1's `readGraph`) is
 * deliberately NOT wired in here: that module lives under `src-server/knowledge-store/
 * neo4j-graph-provider.ts`, owned by a different, file-disjoint Wave 1 task — every
 * root this route serves goes through its registered `KnowledgeStoreAdapter` only.
 * Wiring a Neo4j-backed root's graph read through this route is follow-up scope for
 * whichever task lands `runtime-routes.ts`'s final wiring decision, not this file.
 *
 * Error-code honesty: adapter mutation methods throw one of the five
 * `KnowledgeStoreErrorCode`s (`src-server/knowledge-store/errors.ts`) rather than a
 * plain `Error` — this file maps them to distinct HTTP statuses (404/400/409/405)
 * instead of collapsing every adapter failure into a generic 500, the same honesty bar
 * `knowledge-index-routes.ts`'s `RebuildInProgressError` -> 409 mapping already sets.
 */

import type {
  CreateInput,
  KitLink,
  KitRecordType,
  KnowledgeStoreProvider,
} from '@kontourai/station-contracts/knowledge-store';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { isSafePathSegment } from '../../knowledge-index/path-safety.js';
import {
  AmbiguousIdError,
  KnowledgeRecordNotFoundError,
  MissingEvidenceError,
  ReadOnlyStoreError,
  SlugConflictError,
} from '../../knowledge-store/errors.js';
import { errorMessage } from '../schemas/schemas.js';
import { projectKnowledgePersistenceError } from './knowledge-persistence-errors.js';

export interface KnowledgeRecordRouteDeps {
  store: KnowledgeStoreProvider;
}

/** All `KitRecordType`s — mirrors `sqlite-vec-index-provider.ts`'s own
 * `ALL_KIT_RECORD_TYPES` constant (not exported there, so kept in sync by hand). */
const ALL_KIT_RECORD_TYPES: KitRecordType[] = [
  'raw',
  'compiled',
  'concept',
  'snapshot',
  'person',
];

function isKnownRecordType(value: unknown): value is KitRecordType {
  return (
    typeof value === 'string' &&
    (ALL_KIT_RECORD_TYPES as string[]).includes(value)
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control characters to reject them from rootId (mirrors knowledge-index-routes.ts)
const ROOT_ID_CONTROL_CHAR_PATTERN = /[\x00-\x1f]/;

/** A `rootId` never reaches a filesystem path (see module doc), but still must be a
 * plausible, non-empty identifier — same guard as `knowledge-index-routes.ts`'s
 * `isPlausibleRootId`. */
function isPlausibleRootId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    !ROOT_ID_CONTROL_CHAR_PATTERN.test(value)
  );
}

function isKitLinkArray(value: unknown): value is KitLink[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (l) =>
      l !== null &&
      typeof l === 'object' &&
      typeof (l as { target_id?: unknown }).target_id === 'string' &&
      typeof (l as { kind?: unknown }).kind === 'string',
  );
}

/** Every `id`-shaped value a `KitLink[]` carries must itself be a safe path segment
 * (see module doc's `link`/`readRecord` traversal note). */
function hasUnsafeTargetId(links: KitLink[]): boolean {
  return links.some((l) => !isSafePathSegment(l.target_id));
}

/**
 * Maps the four `KnowledgeStoreErrorCode`s to distinct HTTP statuses instead of a
 * generic 500 — same honesty bar `knowledge-index-routes.ts`'s
 * `RebuildInProgressError` -> 409 mapping already sets (module doc).
 */
function knowledgeStoreErrorResponse(c: Context, e: unknown) {
  const persistence = projectKnowledgePersistenceError(e);
  if (persistence) {
    return c.json(
      { success: false, error: persistence.error },
      persistence.status,
    );
  }
  if (e instanceof KnowledgeRecordNotFoundError) {
    return c.json({ success: false, error: errorMessage(e) }, 404);
  }
  if (e instanceof MissingEvidenceError) {
    return c.json({ success: false, error: errorMessage(e) }, 400);
  }
  if (e instanceof AmbiguousIdError || e instanceof SlugConflictError) {
    return c.json({ success: false, error: errorMessage(e) }, 409);
  }
  // station#1879: a read-only projection adapter (e.g. the conversation-history
  // root) rejects every mutation verb — 405, not a generic 500, mirroring the
  // honesty bar this function already sets for the other three codes.
  if (e instanceof ReadOnlyStoreError) {
    return c.json({ success: false, error: errorMessage(e) }, 405);
  }
  return c.json(
    { success: false, error: 'Knowledge store operation failed.' },
    500,
  );
}

interface CreateRecordBody {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  body?: unknown;
  category?: unknown;
  tags?: unknown;
  aliases?: unknown;
  links?: unknown;
  provenance?: unknown;
  expires_at?: unknown;
  ttl_seconds?: unknown;
}

interface LinkRecordBody {
  links?: unknown;
  evidence?: unknown;
}

export function createKnowledgeRecordRoutes(deps: KnowledgeRecordRouteDeps) {
  const app = new Hono();

  // POST /roots/:rootId/records — body: CreateInput (store-contract.md §6.1).
  app.post('/roots/:rootId/records', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }

      const body = (await c.req.json().catch(() => ({}))) as CreateRecordBody;

      if (body.id !== undefined && !isSafePathSegment(body.id)) {
        return c.json({ success: false, error: 'Invalid id' }, 400);
      }
      if (!isKnownRecordType(body.type)) {
        return c.json({ success: false, error: 'Invalid type' }, 400);
      }
      if (typeof body.title !== 'string' || body.title.length === 0) {
        return c.json({ success: false, error: 'Invalid title' }, 400);
      }
      if (typeof body.body !== 'string') {
        return c.json({ success: false, error: 'Invalid body' }, 400);
      }
      if (typeof body.category !== 'string' || body.category.length === 0) {
        return c.json({ success: false, error: 'Invalid category' }, 400);
      }
      if (body.links !== undefined) {
        if (!isKitLinkArray(body.links)) {
          return c.json({ success: false, error: 'Invalid links' }, 400);
        }
        if (hasUnsafeTargetId(body.links)) {
          return c.json(
            { success: false, error: 'Invalid links[].target_id' },
            400,
          );
        }
      }
      const provenance = body.provenance as { agent?: unknown } | undefined;
      if (
        !provenance ||
        typeof provenance.agent !== 'string' ||
        provenance.agent.length === 0
      ) {
        return c.json(
          { success: false, error: 'Invalid provenance.agent' },
          400,
        );
      }

      const createInput: CreateInput = {
        id: body.id as string | undefined,
        type: body.type as KitRecordType,
        title: body.title,
        body: body.body,
        category: body.category,
        tags: body.tags as string[] | undefined,
        aliases: body.aliases as string[] | undefined,
        links: body.links as KitLink[] | undefined,
        provenance: provenance as CreateInput['provenance'],
        expires_at: body.expires_at as string | undefined,
        ttl_seconds: body.ttl_seconds as number | undefined,
      };

      const adapter = await deps.store.adapterFor(rootId);
      const id = await adapter.create(createInput);
      const record = await adapter.get(id);
      return c.json({ success: true, data: record }, 201);
    } catch (e: unknown) {
      return knowledgeStoreErrorResponse(c, e);
    }
  });

  // GET /roots/:rootId/records/:id — full-id lookup only (see module doc).
  app.get('/roots/:rootId/records/:id', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      const id = c.req.param('id');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }
      if (!isSafePathSegment(id)) {
        return c.json({ success: false, error: 'Invalid id' }, 400);
      }

      const adapter = await deps.store.adapterFor(rootId);
      const record = await adapter.get(id);
      if (!record) {
        return c.json({ success: false, error: 'Record not found' }, 404);
      }
      return c.json({ success: true, data: record });
    } catch (e: unknown) {
      return knowledgeStoreErrorResponse(c, e);
    }
  });

  // GET /roots/:rootId/records?type=raw[&includeRetired=true] — listByType.
  app.get('/roots/:rootId/records', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }
      const type = c.req.query('type');
      if (!isKnownRecordType(type)) {
        return c.json(
          { success: false, error: 'Invalid or missing type query param' },
          400,
        );
      }
      const includeRetired = c.req.query('includeRetired') === 'true';

      const adapter = await deps.store.adapterFor(rootId);
      const records = await adapter.listByType(type, { includeRetired });
      return c.json({ success: true, data: records });
    } catch (e: unknown) {
      return knowledgeStoreErrorResponse(c, e);
    }
  });

  // POST /roots/:rootId/records/:id/links — body: { links: KitLink[], evidence: { agent, note? } }.
  app.post('/roots/:rootId/records/:id/links', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      const id = c.req.param('id');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }
      if (!isSafePathSegment(id)) {
        return c.json({ success: false, error: 'Invalid id' }, 400);
      }

      const body = (await c.req.json().catch(() => ({}))) as LinkRecordBody;
      if (!isKitLinkArray(body.links) || body.links.length === 0) {
        return c.json({ success: false, error: 'Invalid links' }, 400);
      }
      if (hasUnsafeTargetId(body.links)) {
        return c.json(
          { success: false, error: 'Invalid links[].target_id' },
          400,
        );
      }
      const evidence = body.evidence as
        | { agent?: unknown; note?: unknown }
        | undefined;
      if (
        !evidence ||
        typeof evidence.agent !== 'string' ||
        evidence.agent.length === 0
      ) {
        return c.json({ success: false, error: 'Invalid evidence.agent' }, 400);
      }

      const adapter = await deps.store.adapterFor(rootId);
      await adapter.link(id, body.links, {
        agent: evidence.agent,
        note: typeof evidence.note === 'string' ? evidence.note : undefined,
      });
      const record = await adapter.get(id);
      return c.json({ success: true, data: record });
    } catch (e: unknown) {
      return knowledgeStoreErrorResponse(c, e);
    }
  });

  // GET /roots/:rootId/graph — bulk nodes/edges across every record type, for the
  // wikilink pane (see module doc for the file-based-adapter-only scope decision).
  app.get('/roots/:rootId/graph', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }

      const adapter = await deps.store.adapterFor(rootId);
      const records = [];
      for (const type of ALL_KIT_RECORD_TYPES) {
        records.push(...(await adapter.listByType(type)));
      }

      const nodes = records.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        category: r.category,
      }));
      const edges = records.flatMap((r) =>
        (r.links ?? []).map((l) => ({
          source: r.id,
          target: l.target_id,
          kind: l.kind,
          label: l.label,
        })),
      );

      return c.json({ success: true, data: { nodes, edges } });
    } catch (e: unknown) {
      return knowledgeStoreErrorResponse(c, e);
    }
  });

  return app;
}
