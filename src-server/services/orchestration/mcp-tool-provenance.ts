/**
 * Server-only authority for an MCP tool identity observed by a reviewed
 * loader.  A tool name is model-visible presentation, never this authority.
 */

const loaderProvenanceBrand = Symbol('mcp-tool-loader-provenance');
const issuedProvenance = new WeakMap<object, MCPToolProvenanceGeneration>();

export type MCPToolLoaderProvenance = Readonly<{
  serverId: string;
  originalToolName: string;
  runtimeName: string;
  integrationId: string;
  readonly [loaderProvenanceBrand]: true;
}>;

/** One published runtime configuration generation's issuer. */
export class MCPToolProvenanceGeneration {
  private current = true;

  mint(input: {
    serverId: string;
    originalToolName: string;
    runtimeName: string;
    integrationId: string;
  }): MCPToolLoaderProvenance {
    if (!this.current) {
      throw new Error('Cannot mint provenance for a revoked MCP generation.');
    }
    const provenance = Object.freeze({
      ...input,
      [loaderProvenanceBrand]: true as const,
    });
    issuedProvenance.set(provenance, this);
    return provenance;
  }

  revoke(): void {
    this.current = false;
  }

  isCurrent(provenance: unknown): provenance is MCPToolLoaderProvenance {
    return (
      !!provenance &&
      typeof provenance === 'object' &&
      issuedProvenance.get(provenance) === this &&
      this.current
    );
  }
}

/** A new generation is deliberately explicit at runtime composition. */
export function createMCPToolProvenanceGeneration(): MCPToolProvenanceGeneration {
  return new MCPToolProvenanceGeneration();
}

/**
 * Accept only an issued, still-current loader record.  This prevents callers
 * from converting model-supplied server/tool strings into authority.
 */
export function isCurrentMCPToolLoaderProvenance(
  provenance: unknown,
): provenance is MCPToolLoaderProvenance {
  if (!provenance || typeof provenance !== 'object') return false;
  const generation = issuedProvenance.get(provenance);
  return generation?.isCurrent(provenance) === true;
}
