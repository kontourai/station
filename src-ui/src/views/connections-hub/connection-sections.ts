/** The one connections IA: routes, frame copy, and the rail must agree. */
export const CONNECTION_SECTIONS = [
  {
    id: 'models',
    title: 'Models',
    subtitle: "API and local model services for agents using Station's engine.",
    path: '/connections/models',
    legacyPaths: ['/connections/providers'],
    addLabel: 'Add model connection',
  },
  {
    id: 'engines',
    title: 'Engines',
    subtitle: 'AI apps and other engines that run your agents.',
    path: '/connections/engines',
    legacyPaths: [
      '/connections/acp',
      '/connections/agents',
      '/connections/agent-apps',
    ],
    addLabel: 'Add engine',
  },
  {
    id: 'tools',
    title: 'Tools',
    subtitle: 'Connect tool servers and choose which agents use them.',
    path: '/connections/tools',
    legacyPaths: [],
    addLabel: 'Add tool server',
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    subtitle: 'The knowledge store and its attached namespaces.',
    path: '/connections/knowledge',
    legacyPaths: [],
    addLabel: 'Add knowledge source',
  },
  {
    id: 'computers',
    title: 'Computers',
    subtitle: 'Devices and computers Station can reach or run work on.',
    path: '/connections/computers',
    legacyPaths: ['/connections/environments'],
    addLabel: 'Add computer',
  },
] as const;

export type ConnectionSectionId = (typeof CONNECTION_SECTIONS)[number]['id'];

export function connectionSectionForPath(path: string) {
  return CONNECTION_SECTIONS.find(
    (section) =>
      path === section.path ||
      section.legacyPaths.some((legacy) => path === legacy),
  );
}

export function canonicalConnectionPath(path: string): string | null {
  for (const section of CONNECTION_SECTIONS) {
    for (const legacy of section.legacyPaths) {
      if (path === legacy || path.startsWith(`${legacy}/`)) {
        return `${section.path}${path.slice(legacy.length)}`;
      }
    }
  }
  return null;
}
