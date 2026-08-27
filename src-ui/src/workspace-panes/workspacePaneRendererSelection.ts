import {
  selectWorkspacePaneRenderer,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
  type WorkspacePaneRendererCandidate,
  type WorkspacePaneRendererSelection,
} from '@kontourai/station-contracts';
import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';
import type { LayoutComponent } from '@kontourai/station-sdk';
import { pluginRegistry } from '../core/PluginRegistry';
import { builtinWorkspacePaneRendererPresence } from './builtinWorkspacePaneCanonical';

function sameContribution(
  left: LayoutCatalogContribution,
  right: LayoutCatalogContribution,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface ClientWorkspacePaneRendererSupport {
  mcpAppsEnabled: boolean;
  pluginFramesEnabled?: boolean;
  /**
   * Exact MCP tool refs whose asynchronous resolver has reported a terminal
   * missing/revoked result for this host occurrence. This remains local
   * presentation state; it never changes contributor lifecycle or policy.
   */
  unavailableMcpToolRefs?: readonly string[];
  /** The exact persisted occurrence whose contribution authorizes React code. */
  instance?: WorkspacePaneInstance;
  hasTrustedPluginLayout?: (
    name: string,
    instance: WorkspacePaneInstance | undefined,
  ) => boolean;
}

function isBoundTrustedPluginCandidate(
  candidate: WorkspacePaneRendererCandidate,
  instance: WorkspacePaneInstance | undefined,
): boolean {
  const contribution = instance?.boundContext?.contribution;
  const declaredProvenance =
    candidate.rendererProvenance ?? candidate.contributorProvenance;
  // A presence check must answer false for an incomplete candidate, never
  // throw: this runs over every candidate during catalog resolution, and an
  // eager deref of a missing provenance escaped as an unhandled exception that
  // blanked the whole app (no boundary above the catalog).
  return (
    contribution?.provenance?.origin === 'plugin' &&
    declaredProvenance?.origin === 'plugin' &&
    contribution.provenance?.pluginId === declaredProvenance?.pluginId
  );
}

function isDeclaredPluginCandidate(
  descriptor: WorkspacePaneDescriptor,
  candidate: WorkspacePaneRendererCandidate,
): boolean {
  const renderer = candidate.renderer;
  if (renderer.kind !== 'plugin-component') return false;
  if (candidate.source === 'primary') {
    return (
      descriptor.renderer.kind === 'plugin-component' &&
      descriptor.renderer.name === renderer.name &&
      descriptor.rendererId === candidate.rendererId
    );
  }
  const alternative = descriptor.alternativeRenderer;
  if (alternative?.renderer.kind !== 'plugin-component') {
    return false;
  }
  return (
    alternative.renderer.name === renderer.name &&
    alternative.rendererId === candidate.rendererId
  );
}

/**
 * Adapts current UI-host facts into the public data-only selector. Trusted
 * plugin React and sandboxed MCP App paths remain distinct at this boundary.
 */
export function selectClientWorkspacePaneRenderer(
  descriptor: WorkspacePaneDescriptor,
  support: ClientWorkspacePaneRendererSupport,
): WorkspacePaneRendererSelection {
  return selectWorkspacePaneRenderer(descriptor, {
    capabilities: [
      ...(support.mcpAppsEnabled ? (['sandboxed-mcp-app'] as const) : []),
      ...(support.pluginFramesEnabled
        ? (['sandboxed-plugin-frame'] as const)
        : []),
      'trusted-plugin-react' as const,
    ],
    isRendererPresent: (candidate: WorkspacePaneRendererCandidate) => {
      switch (candidate.renderer.kind) {
        case 'builtin-component':
          // Direct built-ins remain governed by their exact canonical registry.
          return (
            candidate.source === 'primary' &&
            builtinWorkspacePaneRendererPresence(descriptor) === 'present'
          );
        case 'plugin-component':
          if (!isBoundTrustedPluginCandidate(candidate, support.instance))
            return false;
          return (
            support.hasTrustedPluginLayout?.(
              candidate.renderer.name,
              support.instance,
            ) ??
            pluginRegistry.getTrustedLayout(
              candidate.renderer.name,
              support.instance?.boundContext?.contribution,
            ) !== null
          );
        case 'mcp-tool-ui':
          // Presence admits only the hardened host path; MCP resolution and
          // per-tool approval remain MCPToolUIFrame responsibilities.
          return (
            support.mcpAppsEnabled &&
            !support.unavailableMcpToolRefs?.includes(candidate.renderer.ref)
          );
        case 'standard-data':
          return (
            support.instance?.boundContext?.contribution !== undefined &&
            sameContribution(
              support.instance.boundContext.contribution,
              candidate.renderer.view.contribution,
            )
          );
      }
    },
  });
}

/**
 * Rechecks the exact occurrence binding at dispatch time so an intervening
 * registry reload or colliding registration cannot turn a selected name into
 * authority to mount different trusted React code.
 */
export function resolveClientTrustedPluginLayout(
  descriptor: WorkspacePaneDescriptor,
  candidate: WorkspacePaneRendererCandidate,
  instance: WorkspacePaneInstance,
): LayoutComponent | null {
  const renderer = candidate.renderer;
  if (
    renderer.kind !== 'plugin-component' ||
    !isDeclaredPluginCandidate(descriptor, candidate) ||
    !isBoundTrustedPluginCandidate(candidate, instance)
  ) {
    return null;
  }
  return pluginRegistry.getTrustedLayout(
    renderer.name,
    instance.boundContext?.contribution,
  );
}
