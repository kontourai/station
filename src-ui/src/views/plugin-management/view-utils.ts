import type { Plugin } from './types';

export function filterPlugins(plugins: Plugin[], search: string) {
  const query = search.toLowerCase();
  return plugins.filter((plugin) => {
    if (!query) return true;
    return (
      (plugin.displayName || plugin.name).toLowerCase().includes(query) ||
      plugin.description?.toLowerCase().includes(query)
    );
  });
}

export function buildPluginListItems(plugins: Plugin[]) {
  return plugins.map((plugin) => ({
    id: plugin.name,
    name: plugin.displayName || plugin.name,
    subtitle: `v${plugin.version}${plugin.description ? ` · ${plugin.description}` : ''}`,
  }));
}

export function slugifyProjectName(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'default'
  );
}

export function toggleSetValue(
  current: ReadonlySet<string>,
  value: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}
