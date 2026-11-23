import type { RegistryItem as CatalogRegistryItem } from '@kontourai/station-contracts/catalog';
import type { RegistryCatalogTab } from '@kontourai/station-sdk';

export interface RegistryItem
  extends Pick<
    CatalogRegistryItem,
    | 'catalog'
    | 'catalogSourceName'
    | 'catalogFreshness'
    | 'installedPluginName'
    | 'toolOrigin'
    | 'mcpServer'
    | 'app'
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

/** Where a catalogue page is entered from; its eyebrow links back there. */
interface RegistryPageOwner {
  label: string;
  path: string;
}

/**
 * Each catalogue is its own page, entered from where its kind is used: there
 * is no page that holds them all. `noun` names the entries in search and
 * empty states; `owner` is the place the page's eyebrow climbs back to.
 */
export function getRegistryTabCopy(tab: RegistryCatalogTab): {
  title: string;
  noun: string;
  description: string;
  empty: string;
  owner?: RegistryPageOwner;
} {
  switch (tab) {
    // No page shows the agent catalogue any more; the SDK's tab type still
    // names it, so the switch must too.
    case 'agents':
      return {
        title: 'Browse agents',
        noun: 'agents',
        description: 'Agent definitions your sources supply.',
        empty: 'No agents in your sources yet.',
        owner: { label: 'Agents', path: '/agents' },
      };
    case 'skills':
      return {
        title: 'Browse skills',
        noun: 'skills',
        description: 'Find skills to install. Edit installed skills in Skills.',
        empty: 'No skills in your sources yet.',
        owner: { label: 'Skills', path: '/guidance?tab=skills' },
      };
    case 'integrations':
      return {
        title: 'Browse tool servers',
        noun: 'tool servers',
        description: 'Tool servers you can add. Each is added turned off.',
        empty: 'No tool servers in your sources yet.',
        owner: { label: 'Tools', path: '/customize/tools' },
      };
    case 'plugins':
      return {
        title: 'Discover',
        noun: 'apps',
        description: 'Find apps to add. Manage added apps in Apps › Library.',
        empty: 'No apps in your sources yet.',
      };
    case 'layouts':
      return {
        title: 'Browse layouts',
        noun: 'layouts',
        description:
          'Browse ready layouts, then add an enabled layout to a project.',
        empty: 'No layouts are available for this workspace yet.',
        // Opened from a project's Add Layout; a direct load climbs to Apps,
        // where an app's screen is found.
        owner: { label: 'Apps', path: '/apps/discover' },
      };
    case 'kits':
      return {
        title: 'Browse kits',
        noun: 'kits',
        description:
          'Browse installed Kits and add their read-only views to a Project.',
        empty: 'No portable Kits are installed for this workspace yet.',
        owner: { label: 'Apps', path: '/apps/discover' },
      };
  }
}

export function getRegistrySkillInstallRefusal(
  tab: RegistryCatalogTab,
  item: RegistryItem,
): string | null {
  if (item.catalogFreshness === 'stale')
    return 'This source is offline. Refresh it and inspect the item again before installing.';
  // The server decides and enforces these; the page only repeats them.
  if (tab === 'integrations' && item.mcpServer?.unavailable.length)
    return item.mcpServer.unavailable.join(' ');
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
  item?: RegistryItem,
) {
  // An MCP server is added turned off; nothing is installed or run.
  if (tab === 'integrations' && item?.mcpServer)
    return installed ? 'Remove' : 'Add';
  if (tab === 'layouts') return installed ? 'Use' : 'Install';
  if (tab === 'kits') return 'View';
  if (tab === 'skills')
    return installed ? 'Remove from workspace' : 'Install to workspace';
  return installed ? 'Remove' : 'Install';
}

type McpServerListing = NonNullable<RegistryItem['mcpServer']>;

export const MCP_AUTH_MODE_LABELS: Record<
  McpServerListing['authMode'],
  string
> = {
  dcr: 'OAuth sign-in',
  'pre-registered-required': 'OAuth with your own client',
  token: 'Secret token header',
  none: 'No sign-in',
  unknown: 'Sign-in not stated',
};

export const MCP_QUALIFICATION_LABELS: Record<
  McpServerListing['qualification']['state'],
  string
> = {
  qualified: 'Station qualified',
  'setup-required': 'Checked, needs your OAuth client',
  blocked: 'Checked, not available yet',
  unqualified: 'Unqualified',
};
