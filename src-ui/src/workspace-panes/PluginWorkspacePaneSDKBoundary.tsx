import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import { LayoutNavigationProvider } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { SDKAdapter } from '../core/SDKAdapter';

/** One canonical SDK composition shared by direct and placed trusted panes. */
export function PluginWorkspacePaneSDKBoundary({
  children,
  layout,
  pluginName,
  projectSlug,
}: {
  children: ReactNode;
  layout: LayoutDefinition;
  /**
   * The installed plugin this pane belongs to. Absent for a plugin DRAFT
   * preview (epic #2323 S3): a draft is not installed, so it must not carry
   * an installed plugin's request identity (and whatever grants that name
   * holds); its requests go out as the viewer's own, which is what the
   * preview's disclosure tells the viewer before they run it.
   */
  pluginName?: string;
  projectSlug: string;
}) {
  const activeTabId = layout.tabs[0]?.id;
  return (
    <SDKAdapter
      layout={layout}
      boundProjectSlug={projectSlug}
      boundPluginName={pluginName}
    >
      <LayoutNavigationProvider
        activeTabId={activeTabId}
        layoutSlug={layout.slug}
      >
        {children}
      </LayoutNavigationProvider>
    </SDKAdapter>
  );
}
