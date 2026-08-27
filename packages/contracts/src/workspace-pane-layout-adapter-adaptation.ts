import type { LayoutTab } from './layout.js';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from './workspace-pane.js';
import {
  cloneLayoutTab,
  contributorSegment,
  DESCRIPTOR_ID_PREFIX,
  deriveModeContextRequirement,
  deriveProvenance,
  extractIdentityScope,
  INSTANCE_ID_PREFIX,
  identitySegment,
  isPlainObject,
  mintIdentities,
  normalizeContext,
  RENDERER_ID_PREFIX,
  rendererRefFromComponent,
  STATE_KEY_PREFIX,
  structurallyEqual,
} from './workspace-pane-layout-adapter-helpers.js';
import type {
  WorkspacePaneLayoutAdapterContext,
  WorkspacePaneLayoutTabAdaptation,
  WorkspacePaneLayoutTabAdapterOptions,
} from './workspace-pane-layout-adapter-types.js';

/**
 * Adapts one baseline `LayoutTab` into an adaptation record, or returns `null`
 * when a tab, context, identity, or contract candidate is malformed.
 */
export function paneAdaptationFromLayoutTab(
  tab: unknown,
  context: WorkspacePaneLayoutAdapterContext,
  options: WorkspacePaneLayoutTabAdapterOptions = {},
): WorkspacePaneLayoutTabAdaptation | null {
  const normalizedContext = normalizeContext(context);
  if (!normalizedContext) return null;
  const retainedLayoutTab = cloneLayoutTab(tab);
  if (!retainedLayoutTab) return null;
  const renderer = rendererRefFromComponent(retainedLayoutTab.component);
  if (!renderer) return null;
  const provenance = deriveProvenance(renderer, normalizedContext);
  if (!provenance) return null;
  if (
    normalizedContext.contribution !== undefined &&
    !contributionMatchesDescriptorProvenance(
      normalizedContext.contribution,
      provenance,
    )
  ) {
    return null;
  }
  const identities = mintIdentities(
    normalizedContext,
    retainedLayoutTab.id,
    renderer,
    provenance,
  );
  if (!identities) return null;

  const placement: Record<string, unknown> = {
    supportedRegions: normalizedContext.supportedRegions,
    preferredRegion: normalizedContext.preferredRegion,
  };
  if (options.order !== undefined) placement.order = options.order;
  const candidate: Record<string, unknown> = {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: identities.descriptorId,
    name: retainedLayoutTab.label,
    rendererId: identities.rendererId,
    renderer,
    placement,
    provenance,
    lifecycle: normalizedContext.lifecycle,
  };
  if (retainedLayoutTab.requiredRendererCapabilities !== undefined) {
    candidate.requiredRendererCapabilities =
      retainedLayoutTab.requiredRendererCapabilities;
  }
  if (retainedLayoutTab.alternativeRenderer !== undefined) {
    const alternativeRenderer = rendererRefFromComponent(
      retainedLayoutTab.alternativeRenderer.component,
    );
    if (!alternativeRenderer) return null;
    candidate.alternativeRenderer = {
      renderer: alternativeRenderer,
      ...(retainedLayoutTab.alternativeRenderer.rendererId === undefined
        ? {}
        : { rendererId: retainedLayoutTab.alternativeRenderer.rendererId }),
      ...(retainedLayoutTab.alternativeRenderer.provenance === undefined
        ? {}
        : { provenance: retainedLayoutTab.alternativeRenderer.provenance }),
      ...(retainedLayoutTab.alternativeRenderer.requiredCapabilities ===
      undefined
        ? {}
        : {
            requiredCapabilities:
              retainedLayoutTab.alternativeRenderer.requiredCapabilities,
          }),
      ...(retainedLayoutTab.alternativeRenderer.reason === undefined
        ? {}
        : { reason: retainedLayoutTab.alternativeRenderer.reason }),
    };
  }
  if (
    retainedLayoutTab.description !== undefined &&
    retainedLayoutTab.description !== ''
  )
    candidate.description = retainedLayoutTab.description;
  if (retainedLayoutTab.icon !== undefined && retainedLayoutTab.icon !== '')
    candidate.icon = retainedLayoutTab.icon;
  const contextRequirement = deriveModeContextRequirement(
    options.requiredProviders,
    normalizedContext,
  );
  candidate.modes = [
    {
      id: 'default',
      ...(contextRequirement === undefined ? {} : { contextRequirement }),
    },
  ];
  if (retainedLayoutTab.actions !== undefined)
    candidate.actions = retainedLayoutTab.actions;

  const descriptor = parseWorkspacePaneDescriptor(candidate);
  if (!descriptor) return null;
  const boundContext = {
    ...(normalizedContext.boundContext ?? {}),
    ...(normalizedContext.contribution === undefined
      ? {}
      : { contribution: normalizedContext.contribution }),
  };
  const instance = parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: descriptor.id,
    instanceId: identities.instanceId,
    stateKey: identities.stateKey,
    ...(Object.keys(boundContext).length === 0 ? {} : { boundContext }),
  });
  return instance ? { descriptor, instance, retainedLayoutTab } : null;
}

function contributionMatchesDescriptorProvenance(
  contribution: import('./layout.js').LayoutCatalogContribution,
  provenance: import('./workspace-pane.js').WorkspacePaneProvenance,
): boolean {
  if (contribution.provenance.origin !== provenance.origin) return false;
  if (provenance.origin === 'plugin') {
    // MCP server attribution belongs to the renderer. A plugin can declare
    // several sandboxed Apps while remaining one catalog contributor.
    return contribution.provenance.pluginId === provenance.pluginId;
  }
  return contribution.provenance.mcpServerId === provenance.mcpServerId;
}

/** Restores an independent, lossless clone of the retained layout tab. */
export function layoutTabFromWorkspacePaneAdaptation(
  adaptation: WorkspacePaneLayoutTabAdaptation,
): LayoutTab {
  const retainedLayoutTab = cloneLayoutTab(adaptation.retainedLayoutTab);
  if (!retainedLayoutTab) {
    throw new TypeError(
      'Workspace Pane adaptation carries an invalid retained layout tab',
    );
  }
  return retainedLayoutTab;
}

function hasOwnDataField(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return Object.getOwnPropertyDescriptor(record, key) !== undefined;
}

function parseAdaptationParts(
  input: unknown,
): WorkspacePaneLayoutTabAdaptation | null {
  if (!isPlainObject(input)) return null;
  const record = input;
  // Persisted adaptations are untrusted. The safe-data guard recursively
  // rejects accessors, non-plain values, and Proxies before the contract
  // parsers read a field; retain the original depth for the parser's own
  // `initialArguments` boundary instead of consuming it in a wrapper clone.
  if (!isPlainObject(record.descriptor) || !isPlainObject(record.instance))
    return null;
  const descriptor = parseWorkspacePaneDescriptor(record.descriptor);
  const instance = parseWorkspacePaneInstance(record.instance);
  if (hasOwnDataField(record, 'legacyTab')) return null;
  const retainedLayoutTab = cloneLayoutTab(record.retainedLayoutTab);
  if (
    !descriptor ||
    !instance ||
    !retainedLayoutTab ||
    instance.descriptorId !== descriptor.id
  )
    return null;
  return { descriptor, instance, retainedLayoutTab };
}

function hasMatchingDescriptorContent(
  adaptation: WorkspacePaneLayoutTabAdaptation,
): boolean {
  const { descriptor, retainedLayoutTab } = adaptation;
  const renderer = rendererRefFromComponent(retainedLayoutTab.component);
  if (!renderer || !structurallyEqual(renderer, descriptor.renderer))
    return false;
  const projectedIcon =
    retainedLayoutTab.icon === '' ? undefined : retainedLayoutTab.icon;
  const projectedDescription =
    retainedLayoutTab.description === ''
      ? undefined
      : retainedLayoutTab.description;
  return !(
    descriptor.name !== retainedLayoutTab.label ||
    !structurallyEqual(descriptor.icon, projectedIcon) ||
    !structurallyEqual(descriptor.description, projectedDescription) ||
    !structurallyEqual(descriptor.actions, retainedLayoutTab.actions) ||
    !structurallyEqual(
      descriptor.requiredRendererCapabilities,
      retainedLayoutTab.requiredRendererCapabilities,
    ) ||
    !structurallyEqual(
      descriptor.alternativeRenderer?.renderer,
      retainedLayoutTab.alternativeRenderer
        ? rendererRefFromComponent(
            retainedLayoutTab.alternativeRenderer.component,
          )
        : undefined,
    ) ||
    !structurallyEqual(
      descriptor.alternativeRenderer?.requiredCapabilities,
      retainedLayoutTab.alternativeRenderer?.requiredCapabilities,
    ) ||
    descriptor.alternativeRenderer?.rendererId !==
      retainedLayoutTab.alternativeRenderer?.rendererId ||
    !structurallyEqual(
      descriptor.alternativeRenderer?.provenance,
      retainedLayoutTab.alternativeRenderer?.provenance,
    ) ||
    descriptor.alternativeRenderer?.reason !==
      retainedLayoutTab.alternativeRenderer?.reason
  );
}

function hasMatchingMintedIdentities(
  adaptation: WorkspacePaneLayoutTabAdaptation,
): boolean {
  const { descriptor, instance, retainedLayoutTab } = adaptation;
  const renderer = rendererRefFromComponent(retainedLayoutTab.component);
  if (!renderer) return false;
  const contributor = contributorSegment(descriptor.provenance);
  if (renderer.kind === 'standard-data') return false;
  const rendererSegment = identitySegment(
    renderer.kind === 'mcp-tool-ui' ? renderer.ref : renderer.name,
  );
  if (
    contributor === null ||
    rendererSegment === null ||
    descriptor.rendererId !==
      `${RENDERER_ID_PREFIX}:${contributor}:${renderer.kind}:${rendererSegment}`
  )
    return false;
  const descriptorPrefix = `${DESCRIPTOR_ID_PREFIX}:${contributor}:`;
  if (!descriptor.id.startsWith(descriptorPrefix)) return false;
  const descriptorSegments = descriptor.id
    .slice(descriptorPrefix.length)
    .split(':');
  if (descriptorSegments.length !== 2) return false;
  const [encodedLayoutSegment, encodedTabSegment] = descriptorSegments;
  let decodedLayoutSegment: string;
  try {
    decodedLayoutSegment = decodeURIComponent(encodedLayoutSegment);
  } catch {
    return false;
  }
  if (identitySegment(decodedLayoutSegment) !== encodedLayoutSegment)
    return false;
  const expectedTabSegment = identitySegment(retainedLayoutTab.id);
  if (expectedTabSegment === null || encodedTabSegment !== expectedTabSegment)
    return false;

  const instanceScope = extractIdentityScope(
    instance.instanceId,
    INSTANCE_ID_PREFIX,
    descriptor.id,
  );
  const stateScope = extractIdentityScope(
    instance.stateKey,
    STATE_KEY_PREFIX,
    descriptor.id,
  );
  if (
    instanceScope === null ||
    stateScope === null ||
    instanceScope !== stateScope
  )
    return false;
  return true;
}

/**
 * Parses persisted adaptation data as untrusted input and requires its retained
 * tab, contract objects, provenance, and all minted identities to agree.
 */
export function parseWorkspacePaneLayoutTabAdaptation(
  input: unknown,
): WorkspacePaneLayoutTabAdaptation | null {
  const adaptation = parseAdaptationParts(input);
  if (!adaptation || !hasMatchingDescriptorContent(adaptation)) return null;
  const contribution = adaptation.instance.boundContext?.contribution;
  if (
    contribution !== undefined &&
    !contributionMatchesDescriptorProvenance(
      contribution,
      adaptation.descriptor.provenance,
    )
  ) {
    return null;
  }
  return hasMatchingMintedIdentities(adaptation) ? adaptation : null;
}
