/**
 * The object-key hazard shared by every store whose keys are EXTERNAL
 * identifiers (plugin names, MCP server ids, manifest-declared setting keys).
 *
 * This is decision 5 of `services/plugins/grants-file-store.ts`, lifted out of
 * that file so the two stores keyed by plugin identity derive the policy from
 * one place instead of two (station#4307). The grants store remains the
 * reference implementation and its docblock carries the full rationale; this
 * module is only the shared vocabulary and the two helpers it needs.
 *
 * On a plain-prototype object:
 *
 * - `store['__proto__']` reads `Object.prototype` (truthy — so a
 *   `if (!store[key]) store[key] = {}` initializer is SKIPPED), and
 *   `store['__proto__'] = value` hits the prototype setter, which persists
 *   nothing while the caller is told the write succeeded. Silent write loss on
 *   top of pollution of every object in the process.
 * - `store['constructor']` and `store['prototype']` answer inherited
 *   `Object.prototype` members instead of `undefined`, so a lookup that should
 *   miss reads as a hit. Note `constructor` and `prototype` both SATISFY
 *   `CANONICAL_PLUGIN_ID_PATTERN`, so a canonical-id check alone does not
 *   close them — the reserved-key refusal is a second, independent axis.
 *
 * Null-prototype objects close the read side for keys nobody thought about;
 * refusing the reserved names closes the write side explicitly, so a caller
 * that reaches one gets an error rather than a plausible-looking success.
 */

export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** True when `key` names an `Object.prototype` member a store must refuse. */
export function isReservedObjectKey(key: string): boolean {
  return RESERVED_OBJECT_KEYS.has(key);
}

/** Shallow null-prototype copy: key lookups never consult Object.prototype. */
export function nullPrototypeCopy<T extends Record<string, unknown>>(
  value: T,
): T {
  return Object.assign(Object.create(null), value) as T;
}

type JsonContainer = Record<string, unknown> | unknown[];

function isJsonContainer(value: unknown): value is JsonContainer {
  return typeof value === 'object' && value !== null;
}

/** An empty container of the same kind: `[]` for an array, else `Object.create(null)`. */
function emptyLike(source: JsonContainer): JsonContainer {
  return Array.isArray(source)
    ? []
    : (Object.create(null) as Record<string, unknown>);
}

/**
 * Deep null-prototype copy of JSON-shaped data. Arrays keep their `Array`
 * prototype (they are indexed, not keyed by external identifiers); every plain
 * object on the way down loses its prototype, so a nested map keyed by an
 * external identifier — a plugin's `settings`, keyed by manifest-declared
 * field names — is as safe as the top level.
 *
 * `JSON.stringify` serializes null-prototype objects identically, and
 * `JSON.parse` creates a literal `"__proto__"` member as an OWN data property
 * rather than invoking the setter, so a store round-trips byte-for-byte.
 *
 * ITERATIVE, deliberately (station#4307 review). The recursive form consumed
 * one call frame per level and died with a `RangeError` at ~3.5k, but the
 * producer and the consumer on either side of it both survive far deeper:
 * `JSON.parse` is iterative in V8 (~200k levels) and `JSON.stringify` reaches
 * ~6.2k. A `PUT /api/plugins/:name/settings` body nested between those two
 * limits therefore PERSISTED successfully and then made every subsequent read
 * of the store throw — the four settings/overrides routes, every HTTP request
 * to any plugin server module, and `loadPluginOverrides` on the server BOOT
 * path (`runtime/plugins/runtime-plugin-loader.ts`), which is awaited
 * unguarded, so plugin provider loading aborted at every start and survived
 * restart. An explicit stack removes the call-depth bound entirely: this
 * helper can now consume anything `JSON.parse` produced. The depth a caller
 * may WRITE is bounded separately, at the request boundary, by
 * `pluginSettingsSchema`/`pluginOverridesSchema`.
 *
 * Only `JSON.parse` output (and object literals) reach here, so the copy needs
 * no cycle check, and an array's own keys are always indices — a plain
 * `target[key] = …` can never hit `Array.prototype`'s `__proto__` setter.
 */
export function nullPrototypeDeep<T>(value: T): T {
  if (!isJsonContainer(value)) return value;
  const root = emptyLike(value);
  const pending: Array<[JsonContainer, JsonContainer]> = [[value, root]];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) break;
    const [source, target] = frame;
    const sink = target as Record<string, unknown>;
    for (const [key, entry] of Object.entries(source)) {
      if (isJsonContainer(entry)) {
        const copy = emptyLike(entry);
        sink[key] = copy;
        pending.push([entry, copy]);
      } else {
        sink[key] = entry;
      }
    }
  }
  return root as T;
}
