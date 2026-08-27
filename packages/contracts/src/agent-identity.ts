/** Clean, persisted identities used by the post-synthetic Agent schema. */

declare const agentIdBrand: unique symbol;
declare const engineConnectionIdBrand: unique symbol;
declare const engineIdBrand: unique symbol;
declare const engineRuntimeIdBrand: unique symbol;

export type AgentId = string & { readonly [agentIdBrand]: 'AgentId' };
export type EngineConnectionId = string & {
  readonly [engineConnectionIdBrand]: 'EngineConnectionId';
};
/** Capability-matrix identity for the engine implementation itself. */
export type EngineId = string & { readonly [engineIdBrand]: 'EngineId' };
/** Adapter-private selector used to address one engine runtime implementation. */
export type EngineRuntimeId = string & {
  readonly [engineRuntimeIdBrand]: 'EngineRuntimeId';
};

export type AgentIdentity =
  | { kind: 'agent'; id: AgentId }
  | { kind: 'engine-connection'; id: EngineConnectionId };

/**
 * Plugin contributions must provide globally unique clean IDs. IDs are stable
 * names, never synthetic prefixes or opaque UUID replacements.
 */
export const CLEAN_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The reserved identity of Station's own default Agent. It is an AGENT id and
 * never an engine-connection id — `ReservedStationIdentityError` below is
 * thrown for any attempt to register an engine connection called this.
 *
 * Exported (station#3662) so the places that have to know "this is Station's
 * own Agent" spell it the same way instead of re-typing the literal: the
 * registry seed, the Station-engine instance registry, and the authored-prompt
 * requirement all key off this one identity.
 */
export const STATION_AGENT_ID = 'station';

export function isStationAgentIdentity(slug?: string | null): boolean {
  return slug === STATION_AGENT_ID;
}

export class ReservedStationIdentityError extends Error {
  readonly code = 'STATION_ID_RESERVED';

  constructor() {
    super(
      "STATION_ID_RESERVED: 'station' is reserved for Station's default Agent.",
    );
  }
}

export function assertCleanIdentity(value: string): void {
  if (!CLEAN_ID_PATTERN.test(value) || UUID_PATTERN.test(value)) {
    throw new Error(
      `Invalid clean identity '${value}'. Use lowercase letters, digits, and hyphens; start with a letter and keep it to 64 characters.`,
    );
  }
}

export function agentId(value: string): AgentId {
  assertCleanIdentity(value);
  return value as AgentId;
}

export function engineConnectionId(value: string): EngineConnectionId {
  assertCleanIdentity(value);
  return value as EngineConnectionId;
}

export function engineId(value: string): EngineId {
  assertCleanIdentity(value);
  return value as EngineId;
}

export function engineRuntimeId(value: string): EngineRuntimeId {
  assertCleanIdentity(value);
  return value as EngineRuntimeId;
}

export function parseEngineId(value: unknown): EngineId | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return engineId(value);
  } catch {
    return undefined;
  }
}

export function parseEngineConnectionId(
  value: unknown,
): EngineConnectionId | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return engineConnectionId(value);
  } catch {
    return undefined;
  }
}

export function parseEngineRuntimeId(
  value: unknown,
): EngineRuntimeId | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return engineRuntimeId(value);
  } catch {
    return undefined;
  }
}
