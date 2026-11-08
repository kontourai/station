import type { ReactNode } from 'react';
import { DetailHeader } from '../DetailHeader';
import { Tabs, tabElementId, tabPanelElementId } from '../Tabs';
import { ResourceStatusBadge } from './ResourceStatusBadge';
import type { ResourceStatus } from './resource-status';
import './resource-hub.css';

export interface ResourceDetailTab<Tab extends string> {
  key: Tab;
  label: string;
}

/**
 * A resource's detail page: its name with the status badge, the reason when
 * it is not ready, at most one fix, then route tabs over one panel. The
 * feature owns the verdict and the fix; this owns where they sit.
 *
 * Tabs use manual activation because selecting one changes the route.
 */
export function ResourceDetail<Tab extends string>({
  id,
  title,
  icon,
  status,
  fix,
  tabs,
  activeTab,
  onSelectTab,
  tabsLabel,
  children,
}: {
  /** Prefix for the tab and panel element ids. */
  id: string;
  title: string;
  icon?: ReactNode;
  status: ResourceStatus;
  /** The one action that addresses `status`; absent when there is none. */
  fix?: ReactNode;
  tabs: ReadonlyArray<ResourceDetailTab<Tab>>;
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  tabsLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="resource-detail">
      <DetailHeader
        title={title}
        icon={icon}
        // The reason is read once, from the line below.
        titleAccessory={
          <ResourceStatusBadge status={{ ...status, reason: undefined }} />
        }
      >
        {fix}
      </DetailHeader>
      {status.reason && (
        <p className="resource-detail__reason">{status.reason}</p>
      )}
      <Tabs
        id={id}
        items={tabs}
        activeKey={activeTab}
        onSelect={(key) => {
          const tab = tabs.find((candidate) => candidate.key === key);
          if (tab) onSelectTab(tab.key);
        }}
        aria-label={tabsLabel}
        activation="manual"
        className="resource-detail__tabs"
      />
      <div
        role="tabpanel"
        id={tabPanelElementId(id, activeTab)}
        aria-labelledby={tabElementId(id, activeTab)}
        className="resource-detail__panel content-stack"
      >
        {children}
      </div>
    </div>
  );
}
