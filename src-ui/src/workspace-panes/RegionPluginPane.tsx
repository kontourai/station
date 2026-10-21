import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { useMemo } from 'react';
import { isDistinctFrameOrigin } from '../components/mcp-ui/frameOrigin';
import { SkeletonBlock } from '../components/Skeleton';
import { Empty } from '../components/state';
import { useConfig } from '../contexts/ConfigContext';
import { LayoutRenderer } from '../layouts';
import { PluginWorkspacePaneSDKBoundary } from './PluginWorkspacePaneSDKBoundary';
import {
  type PluginPaneState,
  readPluginPaneState,
} from './pluginPaneOccurrence';
import { FencedRelatedPane, RelatedPaneStrip } from './RelatedPaneStrip';
import {
  ownedPluginDescriptor,
  pluginInstallGeneration,
  relatedPaneCaller,
  relatedPluginPaneInstance,
} from './relatedPanesHost';
import { useResolvedWorkspacePaneCatalog } from './resolvedWorkspacePaneCatalog';
import {
  resolveClientTrustedPluginLayout,
  selectClientWorkspacePaneRenderer,
} from './workspacePaneRendererSelection';

function Placeholder({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <div className="dock-slot__body">
      <Empty variant="compact" label={label} description={description} />
    </div>
  );
}

/**
 * A plugin's own pane opened as a related pane (`PaneRelatedPanesHost.open`),
 * in a dock region. Its Station fence gates it before anything reads its
 * record (`FencedRelatedPane`).
 */
export function RegionPluginPane({
  instance,
}: {
  instance: WorkspacePaneInstance;
}) {
  const id = String(instance.instanceId);
  return (
    <FencedRelatedPane instanceId={id}>
      <PluginOccurrenceRecord id={id} />
    </FencedRelatedPane>
  );
}

function PluginOccurrenceRecord({ id }: { id: string }) {
  const state = useMemo(
    () => readPluginPaneState(window.localStorage, id),
    [id],
  );
  if (!state)
    return (
      <Placeholder
        label="This pane is no longer available"
        description="Station no longer remembers what this plugin pane showed. Close the tab, then open it again from the pane that opened it."
      />
    );
  return <PluginOccurrence id={id} state={state} />;
}

/**
 * The stored record only NAMES the plugin, descriptor, mode and target.
 * Every render re-derives the descriptor and its server-issued contribution
 * from the Project's catalog and admits the renderer against the live plugin
 * registry; a plugin that is disabled, removed or no longer the installed
 * generation the pane was opened under renders unavailable, with its tab
 * kept and no plugin code run.
 */
function PluginOccurrence({
  id,
  state,
}: {
  id: string;
  state: PluginPaneState;
}) {
  const catalog = useResolvedWorkspacePaneCatalog(state.projectSlug);
  const config = useConfig();
  const sameProject =
    catalog.projectSlug === state.projectSlug &&
    catalog.projectId === state.projectId;
  const entry = sameProject
    ? ownedPluginDescriptor(catalog.entries, state.pluginId, state.descriptorId)
    : undefined;
  const contribution = entry?.instance?.boundContext?.contribution;
  const current =
    contribution !== undefined &&
    pluginInstallGeneration(contribution) === state.generation;
  const renderInstance = useMemo(
    () =>
      current && contribution
        ? relatedPluginPaneInstance(id, state, contribution)
        : null,
    [contribution, current, id, state],
  );
  const selection =
    entry && renderInstance
      ? selectClientWorkspacePaneRenderer(entry.descriptor, {
          mcpAppsEnabled: config?.mcpUiHost !== false,
          pluginFramesEnabled: isDistinctFrameOrigin(config?.pluginFrameOrigin),
          instance: renderInstance,
        })
      : undefined;
  const trustedLayout =
    entry &&
    renderInstance &&
    selection?.state === 'selected' &&
    selection.candidate.renderer.kind === 'plugin-component'
      ? resolveClientTrustedPluginLayout(
          entry.descriptor,
          selection.candidate,
          renderInstance,
        )
      : null;
  const label = state.title ?? entry?.descriptor.name ?? 'Plugin pane';
  const caller = useMemo(
    () =>
      renderInstance
        ? relatedPaneCaller({
            occurrenceId: id,
            instance: renderInstance,
            projectId: state.projectId,
            projectSlug: state.projectSlug,
            layoutSlug: null,
            label,
            target: {
              descriptorId: state.descriptorId,
              modeId: state.modeId,
              key: state.key,
            },
          })
        : null,
    [id, label, renderInstance, state],
  );

  if (catalog.isPending || (entry && entry.rendererResolution === 'pending'))
    return (
      <div className="dock-slot__body">
        <SkeletonBlock count={3} label="Loading plugin pane" />
      </div>
    );
  if (catalog.isError && catalog.data === undefined)
    return (
      <Placeholder
        label="Station could not load this Project’s panes"
        description="The plugin pane stays here and loads when Station answers again."
      />
    );
  if (
    !entry ||
    !renderInstance ||
    !trustedLayout ||
    !caller ||
    entry.descriptor.renderer.kind !== 'plugin-component'
  )
    return (
      <div className="related-pane">
        <RelatedPaneStrip instanceId={id} />
        <Placeholder
          label="This plugin pane is unavailable"
          description="Its plugin is disabled, was removed or updated, or no longer offers this pane in this Project. The tab stays until you close it."
        />
      </div>
    );
  const component = entry.descriptor.renderer;
  const selectedTab = {
    id,
    label,
    description: entry.descriptor.description,
    component,
    actions: entry.descriptor.actions,
  };
  const paneLayout = { name: label, slug: id, tabs: [selectedTab] };
  return (
    <div className="related-pane">
      <RelatedPaneStrip instanceId={id} />
      <div className="dock-slot__body">
        <PluginWorkspacePaneSDKBoundary
          layout={paneLayout}
          projectSlug={state.projectSlug}
          pluginName={state.pluginId}
          related={caller}
        >
          <LayoutRenderer
            componentId={component}
            trustedPluginLayout={trustedLayout}
            layout={paneLayout}
            activeTab={selectedTab}
            activeTabId={selectedTab.id}
          />
        </PluginWorkspacePaneSDKBoundary>
      </div>
    </div>
  );
}
