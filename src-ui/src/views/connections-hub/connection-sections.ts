/**
 * The Customize items that host today's connection screens: their routes,
 * frame copy and the addresses they replaced. Routes, the Customize list and
 * the section frame read this one table.
 */
export const CONNECTION_SECTIONS = [
  {
    id: 'engines',
    title: 'Engines',
    subtitle: 'Claude Code, Codex and other engines that run agents',
    path: '/customize/engines',
    legacyPaths: [
      '/connections/engines',
      '/connections/acp',
      '/connections/agents',
      '/connections/agent-apps',
    ],
    addLabel: 'Add engine',
  },
  {
    // The item is Providers; the screen it hosts is still the model
    // connection list until the Providers redesign replaces it.
    id: 'providers',
    title: 'Providers',
    subtitle: "Model APIs that Station's engine uses",
    path: '/customize/providers',
    legacyPaths: ['/connections/models', '/connections/providers'],
    addLabel: 'Add model connection',
  },
  {
    id: 'tools',
    title: 'Tools',
    subtitle: 'Connect tool servers and choose which agents use them',
    path: '/customize/tools',
    legacyPaths: ['/connections/tools'],
    addLabel: 'Add tool server',
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    subtitle: 'What agents can look up',
    path: '/customize/knowledge',
    legacyPaths: ['/connections/knowledge'],
    addLabel: 'Add knowledge source',
  },
] as const;

export type ConnectionSectionId = (typeof CONNECTION_SECTIONS)[number]['id'];

/**
 * Computers is not a Customize item: devices and other Stations belong to the
 * Station page. Until that page exists, this address keeps working for the
 * links that name it (relay invites, the project page).
 */
export const COMPUTERS_PATH = '/connections/computers';

const LEGACY_COMPUTERS_PATHS = ['/connections/environments'];

/** The current address for a retired Connections address, or null. */
export function canonicalConnectionPath(path: string): string | null {
  for (const legacy of LEGACY_COMPUTERS_PATHS) {
    if (path === legacy || path.startsWith(`${legacy}/`)) {
      return `${COMPUTERS_PATH}${path.slice(legacy.length)}`;
    }
  }
  for (const section of CONNECTION_SECTIONS) {
    for (const legacy of section.legacyPaths) {
      if (path === legacy || path.startsWith(`${legacy}/`)) {
        return `${section.path}${path.slice(legacy.length)}`;
      }
    }
  }
  return null;
}

/**
 * The engine detail's route tabs (`/customize/engines/<id>/<tab>`). Any
 * other segment there is not found. The detail page does not render tabs
 * yet; the route accepts them so links can be written against it.
 */
export const ENGINE_DETAIL_TABS = [
  'overview',
  'usage',
  'models',
  'accounts',
  'settings',
] as const;

export type EngineDetailTab = (typeof ENGINE_DETAIL_TABS)[number];
