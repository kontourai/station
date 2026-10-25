import type { LayoutConfig } from '@kontourai/station-contracts/layout';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { layoutReferencedPluginIds } from './layout-pane-reference.js';

/** Every renderer, including an alternative, must pass the same admission. */
function components(config: Record<string, unknown>): unknown[] {
  if (!Array.isArray(config.tabs)) return [];
  return config.tabs.flatMap((tab: unknown) => {
    if (!tab || typeof tab !== 'object') return [undefined];
    const entry = tab as Record<string, unknown>;
    const alternative = entry.alternativeRenderer;
    return [
      entry.component,
      ...(alternative && typeof alternative === 'object'
        ? [(alternative as Record<string, unknown>).component]
        : []),
    ];
  });
}

function componentKey(component: unknown): string | undefined {
  if (typeof component === 'string') return `plugin-component:${component}`;
  if (!component || typeof component !== 'object') return undefined;
  const value = component as Record<string, unknown>;
  if (
    (value.kind === 'plugin-component' || value.kind === 'builtin-component') &&
    typeof value.name === 'string'
  )
    return `${value.kind}:${value.name}`;
  if (value.kind === 'mcp-tool-ui' && typeof value.ref === 'string')
    return `mcp-tool-ui:${value.ref}:${String(value.resourceUri ?? '')}`;
  return undefined;
}

/** Request-local admission; an unavailable/unknown pane and a hidden one both fail closed. */
export function personalLayoutConforms(input: {
  layout: Pick<LayoutConfig, 'config' | 'catalogContribution'>;
  project: ProjectConfig;
  projectLayouts: readonly LayoutConfig[];
  canSeePlugin: (id: string) => boolean;
  componentPlugins: (name: string) => readonly string[];
}): boolean {
  const { layout, project, projectLayouts, canSeePlugin, componentPlugins } =
    input;
  const policy = project.personalLayouts ?? 'project-panes';
  if (policy === 'off') return false;
  const references = layoutReferencedPluginIds(layout);
  if (
    references.unattributed ||
    references.pluginIds.some((id) => !canSeePlugin(id))
  )
    return false;
  const projectComponents = new Set(
    projectLayouts.flatMap((record) =>
      components(record.config).map(componentKey),
    ),
  );
  const projectPlugins = new Set(
    projectLayouts.flatMap(
      (record) => layoutReferencedPluginIds(record).pluginIds,
    ),
  );
  const allowed = new Set(project.personalLayoutAllowedPlugins ?? []);
  if (
    references.pluginIds.some((id) =>
      policy === 'project-panes'
        ? !projectPlugins.has(id)
        : !allowed.has(id) && !projectPlugins.has(id),
    )
  )
    return false;
  return components(layout.config).every((component) => {
    const key = componentKey(component);
    if (!key) return false;
    if (key.startsWith('plugin-component:')) {
      const ids = componentPlugins(key.slice('plugin-component:'.length));
      if (ids.length !== 1 || !canSeePlugin(ids[0])) return false;
      if (policy === 'allowed-plugins' && allowed.has(ids[0])) return true;
    }
    return projectComponents.has(key);
  });
}
