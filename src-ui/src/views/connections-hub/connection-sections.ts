/**
 * The Customize items that host today's connection screens: their routes and
 * the addresses they replaced. Routes, the Customize list and the section
 * frame read this one table; the frame's words live with the frame, which
 * loads on demand.
 */
export const CONNECTION_SECTIONS = [
  {
    id: 'engines',
    path: '/customize/engines',
    legacyPaths: [
      '/connections/engines',
      '/connections/acp',
      '/connections/agents',
      '/connections/agent-apps',
    ],
  },
  {
    id: 'providers',
    path: '/customize/providers',
    legacyPaths: ['/connections/models', '/connections/providers'],
  },
  {
    id: 'tools',
    path: '/customize/tools',
    legacyPaths: ['/connections/tools'],
  },
  {
    id: 'knowledge',
    path: '/customize/knowledge',
    legacyPaths: ['/connections/knowledge'],
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
