/**
 * Engine-held secrets Station stores for an engine it launched, through a
 * reviewed binding (docs/decisions/engine-credential-provider.md).
 *
 * Some engines keep state they treat as secret (an MCP server's OAuth client
 * registration and tokens) in a store the client provides. Station serves
 * that store only through a reviewed binding: its exact methods, the client
 * capability flag that announces it, and a key policy that restricts it to
 * the engine's own namespace. Station is never a general key-value store for
 * an engine.
 *
 * Shapes and pure helpers only. The reviewed bindings are the server's
 * (`REVIEWED_ENGINE_SECRET_BINDINGS`), and so is the store.
 */

export type EngineSecretStorageBindingId = 'kiro.mcp-grant-storage';

/** The kind suffix of a key; only `persistedKinds` outlive the engine process. */
export type EngineSecretKeyKind =
  | 'client'
  | 'tokens'
  | 'verifier'
  | 'discovery';

export interface EngineSecretStorageBinding {
  readonly id: EngineSecretStorageBindingId;
  /** Exact wire methods. Each names no session: scope is the connection. */
  readonly methods: {
    readonly get: string;
    readonly store: string;
    readonly delete: string;
  };
  /** The client capability flag announced only while the store is wired. */
  readonly announce: { readonly metaNamespace: string; readonly flag: string };
  /** The whole key, anchored. A key that does not match is refused. */
  readonly keyPattern: RegExp;
  /** Kinds persisted across engine processes; the rest stay in memory. */
  readonly persistedKinds: readonly EngineSecretKeyKind[];
  /** Longest value accepted, in UTF-16 code units (JavaScript `length`). */
  readonly maxValueChars: number;
  readonly scope: 'connection-profile';
  readonly evidence: string;
}

/** A request the binding's methods carry, read from the wire. */
export type EngineSecretRequest =
  | { readonly op: 'get'; readonly key: string }
  | { readonly op: 'store'; readonly key: string; readonly value: string }
  | { readonly op: 'delete'; readonly key: string };

/**
 * The answers. `get` of an absent key is `{}`; a refusal is a JSON-RPC
 * `-32602` whose message never echoes the value.
 */
export type EngineSecretAnswer =
  | { readonly value: string }
  | Record<string, never>;

export type EngineSecretRefusal =
  | 'unknown-method'
  | 'malformed'
  | 'key-refused'
  | 'value-too-long';

/**
 * Read one request against a binding. Returns the refusal reason rather than
 * throwing, and never includes the value in it.
 */
export function readEngineSecretRequest(
  binding: EngineSecretStorageBinding,
  method: string,
  params: unknown,
): EngineSecretRequest | { readonly refused: EngineSecretRefusal } {
  const op =
    method === binding.methods.get
      ? 'get'
      : method === binding.methods.store
        ? 'store'
        : method === binding.methods.delete
          ? 'delete'
          : undefined;
  if (!op) return { refused: 'unknown-method' };
  if (params === null || typeof params !== 'object' || Array.isArray(params))
    return { refused: 'malformed' };
  const record = params as Record<string, unknown>;
  const key = record.key;
  if (typeof key !== 'string') return { refused: 'malformed' };
  if (!binding.keyPattern.test(key)) return { refused: 'key-refused' };
  if (op !== 'store') return { op, key };
  const value = record.value;
  if (typeof value !== 'string') return { refused: 'malformed' };
  if (value.length > binding.maxValueChars)
    return { refused: 'value-too-long' };
  return { op, key, value };
}

/** The kind suffix of a key the binding's pattern accepted. */
export function engineSecretKeyKind(
  key: string,
): EngineSecretKeyKind | undefined {
  const kind = key.slice(key.lastIndexOf('.') + 1);
  return kind === 'client' ||
    kind === 'tokens' ||
    kind === 'verifier' ||
    kind === 'discovery'
    ? kind
    : undefined;
}

/** Whether a key outlives the engine process under this binding. */
export function isPersistedEngineSecretKey(
  binding: EngineSecretStorageBinding,
  key: string,
): boolean {
  const kind = engineSecretKeyKind(key);
  return kind !== undefined && binding.persistedKinds.includes(kind);
}
