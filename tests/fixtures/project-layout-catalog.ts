import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';

export const STARTER_CATALOG = [
  {
    id: 'builtin:coding',
    source: 'builtin',
    name: 'Coding',
    slug: 'coding',
    type: 'coding',
    description: 'Code, terminal, and work receipt tabs.',
    tabCount: 3,
    sourceIdentity: { id: 'builtin', kind: 'builtin' },
    contribution: {
      id: 'builtin:coding',
      version: '1.0.0',
      sourceIdentity: { id: 'builtin', kind: 'builtin' },
      provenance: { origin: 'builtin' },
    },
    lifecycle: {
      itemId: 'builtin:coding',
      state: 'installed',
      source: 'builtin',
    },
    visible: true,
    installable: false,
    enabled: true,
    policy: { visible: true, preinstalled: true, enabled: true },
  },
  {
    id: 'plugin:planning-board',
    source: 'plugin',
    name: 'Planning board',
    slug: 'planning-board',
    type: 'board',
    description: 'Plan work alongside the project.',
    tabCount: 2,
    plugin: 'planning',
    sourceIdentity: { id: 'planning', kind: 'local', source: 'plugins' },
    contribution: {
      id: 'plugin:planning-board',
      version: '1.0.0',
      sourceIdentity: { id: 'planning', kind: 'local', source: 'plugins' },
      provenance: { origin: 'plugin', pluginId: 'planning' },
    },
    lifecycle: {
      itemId: 'plugin:planning-board',
      state: 'installed',
      source: 'planning',
    },
    visible: true,
    installable: false,
    enabled: true,
    policy: { visible: true, preinstalled: false, enabled: true },
  },
] satisfies LayoutCatalogItem[];

export const CODING_STARTER_CATALOG = [
  STARTER_CATALOG[0],
] satisfies LayoutCatalogItem[];

/** A remotely sourced plugin preserves organization policy using valid catalog fields. */
export const ORGANIZATION_LAYOUT_CATALOG = [
  STARTER_CATALOG[0],
  {
    id: 'plugin:organization-layouts:delivery',
    source: 'plugin',
    plugin: 'organization-layouts',
    name: 'Delivery workspace',
    slug: 'delivery',
    type: 'workflow',
    description: 'Organization delivery receipt layout.',
    tabCount: 4,
    sourceIdentity: {
      id: 'organization-layouts',
      kind: 'remote',
      source: 'https://registry.example.test/organization-layouts',
    },
    contribution: {
      id: 'plugin:organization-layouts:delivery',
      version: '1.0.0',
      sourceIdentity: {
        id: 'organization-layouts',
        kind: 'remote',
        source: 'https://registry.example.test/organization-layouts',
      },
      provenance: {
        origin: 'plugin',
        pluginId: 'organization-layouts',
      },
    },
    lifecycle: {
      itemId: 'plugin:organization-layouts:delivery',
      state: 'installed',
      source: 'organization-layouts',
    },
    visible: true,
    installable: false,
    enabled: true,
    policy: { visible: true, preinstalled: false, enabled: true },
  },
] satisfies LayoutCatalogItem[];
