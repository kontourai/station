import type {
  AvailableProjectLayout,
  LayoutCatalogContribution,
  LayoutContributionSourceIdentity,
  LayoutDefinition,
} from './layout.js';
import type { PluginInstallationReadiness } from './plugin.js';
import type { RegistryLifecycleRecord } from './registry-lifecycle.js';

/** Current catalog identity grammar, including Agent Plugins 1.0 names. */
export const LAYOUT_CATALOG_ITEM_ID_PATTERN =
  /^(?:builtin:[a-z0-9][a-z0-9-]{0,62}(?::[a-z0-9][a-z0-9-]{0,62})?|plugin:(?![^:]*--)(?![^:]*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?(?::[a-z0-9][a-z0-9-]{0,62})?)$/;

/** A profile is a presentation/default policy, never evidence that code is installed. */
export interface DistributionProfile {
  /** Stable, path-safe identifier. `standard` and `minimal` are reserved. */
  id: string;
  registrySources: DistributionRegistrySource[];
  /** Defaults keyed by canonical catalog item id (for example `builtin:coding`). */
  itemPolicies?: Record<string, DistributionItemPolicy>;
}

/** Select a built-in profile or provide an organization-owned inline profile. */
export type DistributionProfileSelection =
  | 'standard'
  | 'minimal'
  | DistributionProfile;

/**
 * Sources are intentionally declarative. In particular, a remote source being
 * present in a profile does not authorize fetching, installing, or executing it.
 */
export interface DistributionRegistrySource {
  id: string;
  kind: 'builtin' | 'local' | 'remote';
  /** Relative local path, or an explicit http(s) URL for a future registry adapter. */
  source?: string;
}

/** Desired first-run defaults. They must be joined with lifecycle state at read time. */
export interface DistributionItemPolicy {
  visible?: boolean;
  preinstalled?: boolean;
  enabled?: boolean;
}

/** Explicit user lifecycle choice; omitted fields retain profile-derived defaults. */
export interface DistributionLifecycleOverride {
  installed?: boolean;
  enabled?: boolean;
}

export interface DistributionLifecycleOverrides {
  version: 1;
  items: Record<string, DistributionLifecycleOverride>;
}

export type LayoutCatalogSourceIdentity = LayoutContributionSourceIdentity;

/**
 * The sole catalog shape shared by built-ins and plugin layouts. `lifecycle`
 * reports observed/derived state; `policy` remains the independently visible
 * distribution default that produced that state.
 */
export interface LayoutCatalogItem extends AvailableProjectLayout {
  installationReadiness?: PluginInstallationReadiness;
  id: string;
  sourceIdentity: LayoutCatalogSourceIdentity;
  /** Exact contributor snapshot, retained when a Project applies this item. */
  contribution: LayoutCatalogContribution;
  lifecycle: RegistryLifecycleRecord;
  visible: boolean;
  installable: boolean;
  enabled: boolean;
  policy: DistributionItemPolicy;
  tabCount?: number;
}

export interface ResolvedCatalogLayout {
  item: LayoutCatalogItem;
  definition: Pick<
    LayoutDefinition,
    | 'name'
    | 'slug'
    | 'icon'
    | 'description'
    | 'tabs'
    | 'globalSkills'
    | 'defaultAgent'
    | 'availableAgents'
    | 'requiredProviders'
  > & { type: string };
  pluginName?: string;
}

export const STANDARD_DISTRIBUTION_PROFILE: Readonly<DistributionProfile> =
  Object.freeze<DistributionProfile>({
    id: 'standard',
    registrySources: [
      { id: 'builtin', kind: 'builtin' },
      { id: 'installed-plugins', kind: 'local', source: 'plugins' },
    ],
    itemPolicies: {
      'builtin:coding': { visible: true, preinstalled: true, enabled: true },
      'builtin:tasks': { visible: true, preinstalled: true, enabled: true },
      'builtin:session-board': {
        visible: true,
        preinstalled: true,
        enabled: true,
      },
    },
  });

export const MINIMAL_DISTRIBUTION_PROFILE: Readonly<DistributionProfile> =
  Object.freeze<DistributionProfile>({
    id: 'minimal',
    registrySources: [],
    itemPolicies: {},
  });
