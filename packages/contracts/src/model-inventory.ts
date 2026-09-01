export interface ModelInventoryComponentIdentity {
  id: string;
  version: string | null;
}

export interface ModelInventoryModelIdentity {
  id: string;
  revision: string | null;
  quantization: string | null;
}

export type ModelInventoryConnectionKind = 'model' | 'agent';
export type ModelInventoryLocality = 'local' | 'remote' | 'unknown';
export type ModelInventoryAvailability = 'available' | 'stale';
export type ModelInventoryFreshness =
  | 'live'
  | 'cached'
  | 'configured'
  | 'built-in'
  | 'stale-snapshot';

export interface ModelInventoryExecutionIdentity {
  runtime: ModelInventoryComponentIdentity;
  adapter: ModelInventoryComponentIdentity | null;
  locality: ModelInventoryLocality;
}

export interface LaunchableModelRecord {
  /** Stable within a Station connection and provider-native model id. */
  id: string;
  connectionId: string;
  connectionKind: ModelInventoryConnectionKind;
  /** Station's configured launch binding, not an inferred upstream vendor. */
  providerId: string;
  runtime: ModelInventoryComponentIdentity | null;
  adapter: ModelInventoryComponentIdentity | null;
  model: ModelInventoryModelIdentity;
  /** Exact provider-native model id used at invocation time. */
  providerModel: string;
  /** Exact-match identity from the reviewed cross-connection map, when known. */
  canonicalModelIdentity?: CanonicalModelIdentityReference;
  /** Explicit selectors reported for the same provider-native model id. */
  aliases: string[];
  displayName: string;
  locality: ModelInventoryLocality;
  availability: ModelInventoryAvailability;
  freshness: ModelInventoryFreshness;
  observedAt: string | null;
  effectiveContextTokens: number | null;
  /** null is unknown; an empty array is known-empty. */
  toolSurface: string[] | null;
  supportsVision: boolean | null;
}

export interface CanonicalModelIdentityReference {
  canonicalId: string;
  /** Human-readable review anchor; this is not a live discovery timestamp. */
  verifiedAgainst: string;
}

export interface CuratedModelIdentity {
  canonicalId: string;
  displayName: string;
  verifiedAgainst: string;
  /** Provider-native IDs are compared as opaque, exact strings. */
  providerModels: readonly string[];
}

/**
 * Reviewed data only. Do not derive entries from names, prefixes, or model
 * metadata. An omitted provider-native ID is intentionally unrecognised.
 */
export const CURATED_MODEL_IDENTITIES: readonly CuratedModelIdentity[] = [
  {
    canonicalId: 'anthropic:claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    verifiedAgainst: 'Anthropic model documentation, reviewed 2026-08-31',
    providerModels: [
      'sonnet',
      'anthropic.claude-sonnet-4-5-v1:0',
      'anthropic/claude-sonnet-4.5',
      'claude-sonnet-4-5',
    ],
  },
];

export function curatedModelIdentityFor(
  providerModel: string,
): CanonicalModelIdentityReference | undefined {
  const identity = CURATED_MODEL_IDENTITIES.find((candidate) =>
    candidate.providerModels.some((knownId) => knownId === providerModel),
  );
  return identity
    ? {
        canonicalId: identity.canonicalId,
        verifiedAgainst: identity.verifiedAgainst,
      }
    : undefined;
}

/**
 * The reviewed entry behind a canonical id, for surfaces that group routes and
 * need a name for the group. The name is reviewed data, never derived from a
 * route's own label -- two routes for one model often disagree about what to
 * call it, and picking one route's name silently privileges that provider.
 */
export function curatedModelIdentityByCanonicalId(
  canonicalId: string,
): CuratedModelIdentity | undefined {
  return CURATED_MODEL_IDENTITIES.find(
    (candidate) => candidate.canonicalId === canonicalId,
  );
}

export type ModelInventoryDiagnosticCode =
  | 'disabled'
  | 'not-ready'
  | 'catalog-unavailable'
  | 'stale-catalog'
  | 'refresh-unavailable'
  | 'discovery-limited';

export interface ModelInventoryDiagnostic {
  connectionId: string;
  code: ModelInventoryDiagnosticCode;
  message: string;
}

export interface LaunchableModelInventory {
  schemaVersion: 'station.model-inventory/v2';
  observedAt: string;
  models: LaunchableModelRecord[];
  diagnostics: ModelInventoryDiagnostic[];
}

/**
 * The ONE derivation of "is this connection part of the model inventory?"
 *
 * station#3747: `/api/connections/models` used to return every provider
 * connection Station has — including the built-in LanceDB vector store, which
 * is a model connection by `kind` and nothing else. Every consumer then
 * re-derived the real question with its own `capabilities.includes('llm')`,
 * so the route's name and the route's contents disagreed and each caller was
 * free to disagree differently. The inventory now means what it says, and
 * this predicate is the single place that says it. Vector stores are read
 * through the full `/api/connections` projection that the Knowledge section
 * already uses.
 */
export interface ModelInventoryCapabilityRef {
  capabilities: readonly string[];
}

export function isLlmModelConnection(
  connection: ModelInventoryCapabilityRef,
): boolean {
  return connection.capabilities.includes('llm');
}

/**
 * A connection the inventory could not read AT ALL (station#3748).
 *
 * The inventory used to be all-or-nothing: one malformed or throwing row
 * abandoned the whole map, and `/api/connections/models` and
 * `/api/connections/agents` both answered with an empty list — which renders
 * identically to "you have no connections" and disables Create with nothing
 * anywhere saying why. An error is not an empty list. The good rows are
 * returned, and each row that could not be read costs exactly itself and says
 * so by name.
 */
export interface ConnectionInventoryFailure {
  connectionId: string;
  /** The connection's own name when it had one, else its id. */
  name: string;
  /** Why this row could not be read, in the failure's own words. */
  reason: string;
}

/**
 * The sentence a consumer renders instead of an empty list. Kept here so the
 * server, the SDK and any other reader describe a partial inventory the same
 * way rather than each inventing its own phrasing.
 */
export function describeConnectionInventoryFailures(
  kind: string,
  failures: readonly ConnectionInventoryFailure[],
): string {
  const detail = failures
    .map((failure) => `${failure.name}: ${failure.reason}`)
    .join('; ');
  return failures.length === 1
    ? `A ${kind} connection could not be read — ${detail}`
    : `${failures.length} ${kind} connections could not be read — ${detail}`;
}
