/**
 * Whether an `opencode serve` speaks the API Station's native OpenCode
 * transport was checked against.
 *
 * The server publishes its OpenAPI document at `/openapi.json` (authenticated).
 * Station projects it to the operations the native transport calls, the
 * component schemas they reach (transitively, through `$ref`) and the event
 * type list (`event.subscribe`'s `types` parameter, which the projection
 * carries), hashes that projection as canonical JSON, and compares the hash
 * with an exact allowlist keyed by the version the binary reported. Anything
 * else (an unlisted version, a changed shape, a missing operation) is
 * unverified, and the session runs over ACP instead (Muse's pattern:
 * `MUSE_SERVE_VERIFIED_SCHEMA_FINGERPRINTS`).
 *
 * Only the projection is hashed, so an operation Station never calls can
 * change without unverifying a server; every shape Station reads or sends
 * cannot.
 */
import { createHash } from 'node:crypto';

/**
 * The operations the native transport calls, by `operationId`. Adding one
 * changes the projection, so the allowlist entry is recomputed from the
 * captured document (opencode-serve-fingerprint.test.ts).
 */
export const OPENCODE_NATIVE_OPERATIONS: readonly string[] = [
  'server.info',
  'event.subscribe',
  'agent.list',
  'agent.get',
  'command.list',
  'model.list',
  'mcp.list',
  'permission.saved.list',
  'permission.request.list',
  'session.create',
  'session.get',
  'session.update',
  'session.active',
  'session.message.list',
  'session.prompt',
  'session.interrupt',
  'session.command',
  'session.compact',
  'session.switchModel',
  'session.switchAgent',
  'session.inbox.list',
  'session.inbox.cancel',
  'session.permission.list',
  'session.permission.reply',
  'session.form.list',
  'session.form.reply',
  'session.form.cancel',
  'session.revert.stage',
  'session.revert.commit',
  'session.revert.clear',
];

/**
 * Projection hashes of the servers the native transport was verified
 * against, keyed by the version `--version` reported. Recomputed from the
 * scrubbed capture `fixtures/opencode-serve-2.3.0-openapi.json`; the
 * unscrubbed document a separate 2.3.0 run served hashed the same.
 */
export const OPENCODE_SERVE_VERIFIED_FINGERPRINTS: Readonly<
  Record<string, string>
> = {
  '2.3.0':
    'sha256:9a91cd5d1ef1217ccfb9797f1848038987cb88503309d557124dd7a8c127c17c',
};

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
] as const;
const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON with every object's keys sorted, so equal documents hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string') {
      const name = SCHEMA_REF.exec(child)?.[1];
      if (name) into.add(name);
    } else collectRefs(child, into);
  }
}

export type OpenCodeServeProjection =
  | { ok: true; projection: Json }
  | { ok: false; reason: string };

/** The part of the document the native transport depends on. */
export function projectOpenCodeServeSchema(
  doc: unknown,
  operations: readonly string[] = OPENCODE_NATIVE_OPERATIONS,
): OpenCodeServeProjection {
  if (!isRecord(doc) || !isRecord(doc.paths))
    return { ok: false, reason: 'the document has no paths' };
  const wanted = new Set(operations);
  const found: Record<string, Json> = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation: unknown = item[method];
      if (!isRecord(operation)) continue;
      const id = operation.operationId;
      if (typeof id !== 'string' || !wanted.has(id)) continue;
      if (found[id] !== undefined)
        return { ok: false, reason: `operation ${id} is declared twice` };
      found[id] = { method, path, operation: operation as Json };
    }
  }
  const missing = operations.filter((id) => found[id] === undefined);
  if (missing.length > 0)
    return { ok: false, reason: `missing operations: ${missing.join(', ')}` };

  const schemas = isRecord(doc.components) ? doc.components.schemas : undefined;
  const reached: Record<string, Json> = {};
  const pending = new Set<string>();
  collectRefs(found, pending);
  while (pending.size > 0) {
    const [name] = pending;
    pending.delete(name as string);
    if (name === undefined || reached[name] !== undefined) continue;
    const schema = isRecord(schemas) ? schemas[name] : undefined;
    if (schema === undefined)
      return { ok: false, reason: `unresolved schema reference ${name}` };
    reached[name] = schema as Json;
    const next = new Set<string>();
    collectRefs(schema, next);
    for (const ref of next) if (reached[ref] === undefined) pending.add(ref);
  }
  return { ok: true, projection: { operations: found, schemas: reached } };
}

export function openCodeServeFingerprint(projection: Json): string {
  return `sha256:${createHash('sha256').update(canonical(projection)).digest('hex')}`;
}

export type OpenCodeServeVerdict =
  | { verified: true; fingerprint: string }
  | { verified: false; reason: string; fingerprint?: string };

/**
 * Whether the served document is the one verified for `version`. Exact
 * match only: a server whose projection differs in any byte is unverified.
 */
export function verifyOpenCodeServeSchema(
  version: string,
  doc: unknown,
  allowlist: Readonly<
    Record<string, string>
  > = OPENCODE_SERVE_VERIFIED_FINGERPRINTS,
): OpenCodeServeVerdict {
  const projected = projectOpenCodeServeSchema(doc);
  if (!projected.ok) return { verified: false, reason: projected.reason };
  const fingerprint = openCodeServeFingerprint(projected.projection);
  const expected = Object.hasOwn(allowlist, version)
    ? allowlist[version]
    : undefined;
  if (!expected)
    return {
      verified: false,
      fingerprint,
      reason: `OpenCode ${version} was not verified for the native transport`,
    };
  if (fingerprint !== expected)
    return {
      verified: false,
      fingerprint,
      reason: `OpenCode ${version} serves an API that differs from the one verified (${fingerprint})`,
    };
  return { verified: true, fingerprint };
}
