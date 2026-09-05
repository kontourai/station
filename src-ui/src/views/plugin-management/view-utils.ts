import { isRejectedPlugin, type Plugin, type ReadyPlugin } from './types';

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
          subtitle: `v${plugin.version}${plugin.description ? ` · ${plugin.description}` : ''}`,
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

/**
 * What an installed plugin CONTRIBUTES, in the reader's words.
 *
 * The detail page listed `ui` and `layout:getting-started` capability chips
 * and nothing else, so after installing a starter there was no way to see
 * what had arrived or to reach it (#1536 G2). This is the same manifest data
 * the chips render, named as things rather than as slugs, and it carries the
 * `layoutSlug` the Add Layout flow needs.
 */
export interface PluginContribution {
  kind: 'layout' | 'pane' | 'agent' | 'provider';
  kindLabel: string;
  /** Stable within a plugin; the render key. */
  id: string;
  name: string;
  /** Present only on a layout, and only then can it be added to a project. */
  layoutSlug?: string;
}

export function pluginContributions(plugin: ReadyPlugin): PluginContribution[] {
  const contributions: PluginContribution[] = [];
  if (plugin.layout) {
    contributions.push({
      kind: 'layout',
      kindLabel: 'Layout',
      id: `layout:${plugin.layout.slug}`,
      name: plugin.layout.slug,
      layoutSlug: plugin.layout.slug,
    });
  }
  for (const pane of plugin.workspacePanes ?? []) {
    contributions.push({
      kind: 'pane',
      kindLabel: 'Pane',
      id: `pane:${pane.id}`,
      name: pane.name || pane.id,
    });
  }
  for (const agent of plugin.agents ?? []) {
    contributions.push({
      kind: 'agent',
      kindLabel: 'Agent',
      id: `agent:${agent.slug}`,
      name: agent.slug,
    });
  }
  for (const provider of plugin.providers ?? []) {
    contributions.push({
      kind: 'provider',
      kindLabel: 'Connection type',
      id: `provider:${provider.type}`,
      name: provider.type,
    });
  }
  return contributions;
}

/**
 * The project an "Add to project" action would target without asking. Only
 * when there is exactly one: with none there is nothing to add to, and with
 * several the destination is a real question the Add Layout picker asks.
 */
export function soleLayoutTargetProject<
  T extends { slug: string; name: string },
>(projects: readonly T[]): T | null {
  return projects.length === 1 ? projects[0] : null;
}
