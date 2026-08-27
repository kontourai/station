import type { ToolDef } from '@kontourai/station-contracts/tool';
import type {
  IntegrationSecretResolution,
  IntegrationSecretResolver,
} from './secret-binding-administration.js';

/** A stable failure at the child-establishment boundary. It intentionally
 * carries no Datum/provider detail, binding id, AuthRef, or secret material. */
export class McpSecretChildEstablishmentError extends Error {
  constructor() {
    super('The integration secret binding cannot be established.');
    this.name = 'McpSecretChildEstablishmentError';
  }
}

export function hasSecretEnvRefs(def: ToolDef): boolean {
  return Boolean(def.secretEnvRefs && Object.keys(def.secretEnvRefs).length);
}

/**
 * Resolve authored secret bindings only for a new stdio MCP child. The caller
 * owns construction and combines this result into a fresh child-only env.
 */
export async function resolveMcpSecretChildEnv(input: {
  integrationId: string;
  def: ToolDef;
  resolver?: IntegrationSecretResolver;
  isBuiltinStationControl?: boolean;
}): Promise<IntegrationSecretResolution | undefined> {
  const { def } = input;
  if (!hasSecretEnvRefs(def)) return undefined;

  // Authored bindings are exclusively for stdio MCP children. Refuse an
  // unsupported record without looking up Datum rather than silently opening
  // a child whose configuration says it needs a binding.
  const transport = def.transport ?? (def.command ? 'stdio' : undefined);
  if (def.kind !== 'mcp' || transport !== 'stdio') {
    throw new McpSecretChildEstablishmentError();
  }

  // The Station-owned control child receives only its reviewed runtime token;
  // authored binding injection would create a second, unreviewed authority.
  if (input.isBuiltinStationControl) {
    throw new McpSecretChildEstablishmentError();
  }
  if (!input.resolver) throw new McpSecretChildEstablishmentError();

  try {
    return await input.resolver.resolveForIntegration({
      integrationId: input.integrationId,
      secretEnvRefs: def.secretEnvRefs!,
    });
  } catch {
    // Datum/provider errors may contain operation URIs or stderr. Never let
    // those escape this runtime seam (or reach structured logs downstream).
    throw new McpSecretChildEstablishmentError();
  }
}

/**
 * The one first-child seam for binding-backed MCP establishment. It settles a
 * resolver-owned metadata snapshot only after the caller's full connection /
 * handshake action succeeds; a later tool-use failure is outside this scope.
 */
export async function establishMcpSecretChild<T>(
  input: {
    integrationId: string;
    def: ToolDef;
    resolver?: IntegrationSecretResolver;
    isBuiltinStationControl?: boolean;
  },
  establish: (environment: Record<string, string> | undefined) => Promise<T>,
): Promise<T> {
  const resolution = await resolveMcpSecretChildEnv(input);
  try {
    const child = await establish(resolution?.environment);
    resolution?.settlement.settle({ outcome: 'success' });
    return child;
  } catch (error) {
    resolution?.settlement.settle({
      outcome: 'failure',
      reason: 'child_establishment_failed',
    });
    throw error;
  }
}
