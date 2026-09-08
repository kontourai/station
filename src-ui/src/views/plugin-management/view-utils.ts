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

/**
 * A path-safe identifier as a person would read it: `getting-started` ->
 * "Getting Started" (#1536 review M4). Reached only when the payload carries
 * no display name of its own — a manifest slug is what the reader is stuck
 * with otherwise, and it is the thing they were shown before.
 *
 * Deliberately conservative: an identifier carrying a separator that is not a
 * word break (a dotted or slashed id) is returned unchanged rather than
 * mangled into a fabricated name, the same rule `prettifyModelId` follows.
 */
export function humanizeContributionSlug(slug: string): string {
  const id = slug.trim();
  if (!id || /[./:]/.test(id)) return id;
  return (
    id
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(' ') || id
  );
}

/**
 * What an installed plugin CONTRIBUTES, in the reader's words.
 *
 * The detail page listed `ui` and `layout:getting-started` capability chips
 * and nothing else, so after installing a starter there was no way to see
 * what had arrived or to reach it (#1536 G2). This is the same manifest data
 * the chips render, and it carries the `layoutSlug` the Add Layout flow needs.
 *
 * Review M4: each entry is NAMED — its own display name when the payload
 * carries one (panes always do; a layout will once the route sends it), and a
 * humanized identifier otherwise. It used to pass the raw slug through under
 * the field called `name`, so the section promised things and rendered
 * `getting-started`.
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
    const declared =
      plugin.layout.name || plugin.layout.displayName || plugin.layout.title;
    contributions.push({
      kind: 'layout',
      kindLabel: 'Layout',
      id: `layout:${plugin.layout.slug}`,
      name: declared || humanizeContributionSlug(plugin.layout.slug),
      layoutSlug: plugin.layout.slug,
    });
  }
  for (const pane of plugin.workspacePanes ?? []) {
    contributions.push({
      kind: 'pane',
      kindLabel: 'Pane',
      id: `pane:${pane.id}`,
      name: pane.name || humanizeContributionSlug(pane.id),
    });
  }
  for (const agent of plugin.agents ?? []) {
    contributions.push({
      kind: 'agent',
      kindLabel: 'Agent',
      id: `agent:${agent.slug}`,
      name: humanizeContributionSlug(agent.slug),
    });
  }
  for (const provider of plugin.providers ?? []) {
    contributions.push({
      kind: 'provider',
      kindLabel: 'Connection type',
      id: `provider:${provider.type}`,
      // A provider TYPE is an identifier the operator matches against
      // configuration, not a product name — shown as declared.
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
