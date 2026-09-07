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
  pluginName: string;
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
