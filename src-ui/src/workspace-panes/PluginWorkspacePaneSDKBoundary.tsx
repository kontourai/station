import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import type { PaneRelatedPanesHost } from '@kontourai/station-contracts/workspace-pane-host-contract';
import { LayoutNavigationProvider } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { SDKAdapter } from '../core/SDKAdapter';
import {
  type RelatedPaneCaller,
  useRelatedPanesHost,
} from './relatedPanesHost';

interface BoundaryProps {
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
}

function Boundary({
  children,
  layout,
  pluginName,
  projectSlug,
  relatedPanes,
}: BoundaryProps & { relatedPanes: PaneRelatedPanesHost | undefined }) {
  const activeTabId = layout.tabs[0]?.id;
  return (
    <SDKAdapter
      layout={layout}
      boundProjectSlug={projectSlug}
      boundPluginName={pluginName}
      relatedPanes={relatedPanes}
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

function RelatedBoundary({
  related,
  ...props
}: BoundaryProps & { related: RelatedPaneCaller | null }) {
  return <Boundary {...props} relatedPanes={useRelatedPanesHost(related)} />;
}

/**
 * One canonical SDK composition shared by direct and placed trusted panes.
 * `related` is the installed plugin occurrence this boundary wraps, from a
 * placement that can offer related panes (`useRelatedPanes`); a placement
 * that passes none (a draft) offers none. Whether it passes one is fixed per
 * placement, so the plugin below never remounts over it.
 */
export function PluginWorkspacePaneSDKBoundary(
  props: BoundaryProps & { related?: RelatedPaneCaller | null },
) {
  const { related, ...rest } = props;
  return related === undefined ? (
    <Boundary {...rest} relatedPanes={undefined} />
  ) : (
    <RelatedBoundary {...rest} related={related} />
  );
}
