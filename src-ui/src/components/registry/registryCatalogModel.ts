import type { RegistryItem as CatalogRegistryItem } from '@kontourai/station-contracts/catalog';
import type { RegistryCatalogTab } from '@kontourai/station-sdk';

export interface RegistryItem
  extends Pick<
    CatalogRegistryItem,
    'catalog' | 'catalogSourceName' | 'catalogFreshness' | 'installedPluginName'
  > {
  id: string;
  displayName?: string;
  description?: string;
  installed?: boolean;
  status?: string;
  source?: string;
  version?: string;
  name?: string;
  enabled?: boolean;
  installable?: boolean;
  lifecycle?: { state?: 'installed' | 'installable' | 'disabled' };
  /** Manifest-declared glyph for integration entries (issue #691); see
   * `ToolDef.icon`. Only populated when the provider read the full
   * manifest — absent entries fall back to initials in the UI. */
  icon?: string;
  /** Same-origin output URL for validated installed integration artwork. */
  iconUrl?: string;
}

export function getRegistryItemId(item: RegistryItem) {
  return (
    item.id ||
    (item as { name?: string }).name ||
    (item as { slug?: string }).slug ||
    ''
  );
}

export function getRegistrySourceLabel(item: RegistryItem) {
  if (item.catalogSourceName) return item.catalogSourceName;
  if (!item.source) return null;
  if (item.source === 'GitHub') return 'GitHub';
  if (
    item.source.includes('/examples/') ||
    item.source.includes('\\examples\\')
  ) {
    return 'Bundled example';
  }
  if (
    item.source.startsWith('/') ||
    item.source.startsWith('.') ||
    /^[A-Za-z]:/.test(item.source)
  ) {
    return 'Configured registry';
  }
  if (
    item.source.startsWith('http://') ||
    item.source.startsWith('https://') ||
    item.source.startsWith('git@')
  ) {
    return 'Remote registry';
  }
  return item.source;
}

export function getRegistryTabCopy(tab: RegistryCatalogTab) {
  switch (tab) {
    case 'agents':
      return {
        description:
          'Discover agent definitions that can be added to this workspace.',
        empty:
          'No agents are available from the configured registry sources yet.',
      };
    case 'skills':
      return {
        description:
          'Discover skills to install, then author and edit installed skills separately.',
        empty:
          'No skills are available from the configured registry sources yet.',
      };
    case 'integrations':
      return {
        description: 'Discover integrations to connect to this workspace.',
        empty:
          'No integrations are available from the configured registry sources yet.',
      };
    case 'plugins':
      return {
        description:
          'Discover plugins to install. Manage installed plugin settings in Plugins.',
        empty:
          'No plugins are available from the configured registry sources yet.',
      };
    case 'layouts':
      return {
        description:
          'Browse ready layouts, then add an enabled layout to a project.',
        empty: 'No layouts are available for this workspace yet.',
      };
    case 'kits':
      return {
        description:
          'Browse host-discovered portable Kits and add their read-only projections to a project.',
        empty: 'No portable Kits are installed for this workspace yet.',
      };
  }
}

export function getRegistrySkillInstallRefusal(
  tab: RegistryCatalogTab,
  item: RegistryItem,
): string | null {
  if (item.catalogFreshness === 'stale')
    return 'This marketplace is offline. Refresh its source and inspect the item again before installing.';
  if (tab !== 'skills') return null;
  if (item.status === 'installed-name-conflict')
    return 'A skill with this name is already in your Library from another source. Manage that copy before adding this one.';
  if (item.status === 'unsupported-skill-name')
    return 'This skill uses a name reserved by Station. Ask its publisher for a supported name before installing.';
  if (item.status === 'unsupported-skill-format')
    return 'This skill uses metadata that Station cannot install. Its original Markdown is available for inspection; ask its publisher for a supported format.';
  return null;
}

export function getRegistryActionLabel(
  tab: RegistryCatalogTab,
  installed: boolean,
) {
  if (tab === 'layouts') return installed ? 'Use' : 'Install';
  if (tab === 'kits') return 'View';
  if (tab === 'skills')
    return installed ? 'Remove from workspace' : 'Install to workspace';
  return installed ? 'Remove' : 'Install';
}
