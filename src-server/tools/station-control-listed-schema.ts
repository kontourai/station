import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

/**
 * Arguments Station's own runtime writes onto a station-control call after
 * the model has written it (`wrapDelegationAwareTools` in `mcp-manager.ts`):
 * the caller's user, the attested delegation context and the provenance of
 * a skill or plugin-proposal edit. A model has nothing true to put in them,
 * so `tools/list` does not offer them. The tools still accept them, because
 * the runtime's injected call is validated against the tool's own schema.
 *
 * Hiding them grants and removes nothing: a value a model writes anyway is
 * judged exactly as before. The routes derive the user from the verified
 * caller, keep a delegation context only with Station's HMAC attestation
 * (`delegation-attestation.ts`), and the plugin-proposal stamp carries its
 * own attestation (`plugin-proposal-provenance.ts`). The exception is
 * `update_skill`'s `_sourceContext`: it is unattested, and where no wrapper
 * runs (Claude in-process, Codex) a model-written one still sets the skill's
 * `provenance.updatedFrom` label, as the route's public `provenance` field
 * already lets any caller do. It is a label, not authority.
 */
export const STATION_INJECTED_TOOL_ARGUMENTS: ReadonlySet<string> = new Set([
  '_userId',
  '_delegation',
  '_delegationAttestation',
  '_sourceContext',
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keywords whose value is instance data, never a schema to walk. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

/**
 * One schema node as a model needs it. Each removal leaves the set of calls
 * a model would make unchanged:
 *
 * - `minimum`/`maximum` of ±2^53-1 on an integer: zod's safe-integer bound
 *   on every `.int()`. No argument a model writes comes near it.
 * - `propertyNames: { type: 'string' }`: every JSON object key is a string.
 * - `additionalProperties: {}`: the empty schema allows any value, exactly
 *   as an absent keyword does.
 *
 * Everything that tells a model what to send stays: types, `required`,
 * `const`/`enum`, lengths, real bounds, `additionalProperties: false` and
 * descriptions.
 */
function listedNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(listedNode);
  if (!isObject(node)) return node;
  const listed: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isObject(value)) {
      listed[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          listedNode(schema),
        ]),
      );
    } else {
      listed[key] = DATA_KEYWORDS.has(key) ? value : listedNode(value);
    }
  }
  if (listed.type === 'integer') {
    if (listed.maximum === Number.MAX_SAFE_INTEGER) delete listed.maximum;
    if (listed.minimum === Number.MIN_SAFE_INTEGER) delete listed.minimum;
  }
  if (
    isObject(listed.propertyNames) &&
    Object.keys(listed.propertyNames).length === 1 &&
    listed.propertyNames.type === 'string'
  )
    delete listed.propertyNames;
  if (
    isObject(listed.additionalProperties) &&
    Object.keys(listed.additionalProperties).length === 0
  )
    delete listed.additionalProperties;
  return listed;
}

/**
 * A tool's input schema as `tools/list` carries it. Besides `listedNode`'s
 * removals, it drops the `$schema` dialect URL the SDK stamps on every
 * converted schema (a schema that names no dialect is read as JSON Schema
 * 2020-12, the dialect that URL names) and the top-level arguments only
 * Station's runtime writes (`STATION_INJECTED_TOOL_ARGUMENTS`).
 */
function listedJsonSchema(schema: JsonObject): JsonObject {
  const { $schema: _dialect, ...rest } = schema;
  const listed = listedNode(rest) as JsonObject;
  if (isObject(listed.properties)) {
    listed.properties = Object.fromEntries(
      Object.entries(listed.properties).filter(
        ([name]) => !STATION_INJECTED_TOOL_ARGUMENTS.has(name),
      ),
    );
  }
  if (Array.isArray(listed.required)) {
    listed.required = listed.required.filter(
      (name) =>
        typeof name !== 'string' || !STATION_INJECTED_TOOL_ARGUMENTS.has(name),
    );
  }
  return listed;
}

/**
 * `schema` with its listing (`~standard.jsonSchema`) passed through
 * `listedJsonSchema`, so every engine session's context carries less
 * (`agent-context-budget.json`). Validation is unchanged: calls are still
 * checked by the wrapped schema's own `validate`.
 */
export function listedForModels<Schema extends StandardSchemaWithJSON>(
  schema: Schema,
): Schema {
  const standard = schema['~standard'];
  type Convert = typeof standard.jsonSchema.input;
  const list =
    (convert: Convert): Convert =>
    (options) =>
      listedJsonSchema(convert(options));
  const listed = {
    ...standard,
    jsonSchema: {
      input: list(standard.jsonSchema.input),
      output: list(standard.jsonSchema.output),
    },
  };
  return new Proxy(schema, {
    get: (target, key, receiver) =>
      key === '~standard' ? listed : Reflect.get(target, key, receiver),
  });
}
