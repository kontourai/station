import { isRejectedPlugin, type Plugin } from './types';

export function pluginSelectionId(plugin: Plugin) {
  return isRejectedPlugin(plugin) ? `rejected:${plugin.name}` : plugin.name;
}

export function filterPlugins(plugins: Plugin[], search: string) {
  const query = search.toLowerCase();
  return plugins.filter((plugin) => {
    if (!query) return true;
    if (isRejectedPlugin(plugin)) {
      return (
        plugin.displayName.toLowerCase().includes(query) ||
        plugin.rejection.reason.toLowerCase().includes(query) ||
        plugin.rejection.recovery.instruction.toLowerCase().includes(query)
      );
    }
    return (
      (plugin.displayName || plugin.name).toLowerCase().includes(query) ||
      plugin.description?.toLowerCase().includes(query)
    );
  });
}

export function buildPluginListItems(plugins: Plugin[]) {
  return plugins.map((plugin) =>
    isRejectedPlugin(plugin)
      ? {
          id: pluginSelectionId(plugin),
          name: plugin.displayName,
          subtitle: `Rejected · ${plugin.rejection.reason}`,
        }
      : {
          id: pluginSelectionId(plugin),
          name: plugin.displayName || plugin.name,
          subtitle: `${plugin.installationReadiness?.state === 'pending' ? 'Activation pending · ' : plugin.installationReadiness?.state === 'unavailable' ? 'Unavailable · ' : ''}v${plugin.version}${plugin.description ? ` · ${plugin.description}` : ''}`,
        },
  );
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
