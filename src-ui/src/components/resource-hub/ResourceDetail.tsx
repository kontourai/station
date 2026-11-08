import { type ReactNode, useState } from 'react';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
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
 * it is not ready, at most one fix and what that fix reported, an unsaved
 * changes bar while the editor is dirty, then route tabs over one panel. The
 * feature owns the verdict, the fix and the edits; this owns where they sit,
 * so every tab shows them the same way.
 *
 * Tabs use manual activation because selecting one changes the route.
 */
export function ResourceDetail<Tab extends string>({
  id,
  title,
  icon,
  status,
  fix,
  fixNotice,
  unsaved,
  tabs,
  activeTab,
  onSelectTab,
  tabsLabel,
  renderPanel,
  keepMounted = [],
}: {
  /** Prefix for the tab and panel element ids. */
  id: string;
  title: string;
  icon?: ReactNode;
  status: ResourceStatus;
  /** The one action that addresses `status`; absent when there is none. */
  fix?: ReactNode;
  /** What the fix (or a check) reported, and what it costs. */
  fixNotice?: ReactNode;
  /** Present while the editor holds unsaved edits. */
  unsaved?: { saving: boolean; onSave: () => void; onDiscard: () => void };
  tabs: ReadonlyArray<ResourceDetailTab<Tab>>;
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  tabsLabel: string;
  renderPanel: (tab: Tab) => ReactNode;
  /**
   * Tabs whose panel stays mounted (hidden) once opened, so state their
   * fields hold outside the editor (a half-typed entry, a checkbox that
   * shapes an import) survives a tab switch.
   */
  keepMounted?: readonly Tab[];
}) {
  const [visited, setVisited] = useState<readonly Tab[]>([]);
  if (keepMounted.includes(activeTab) && !visited.includes(activeTab))
    setVisited([...visited, activeTab]);
  const panels = tabs.filter(
    (tab) =>
      tab.key === activeTab ||
      (keepMounted.includes(tab.key) && visited.includes(tab.key)),
  );
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
      {/* Always mounted: a live region that mounts with its content is often
          not announced. */}
      <div className="resource-detail__notice" aria-live="polite">
        {fixNotice}
      </div>
      {unsaved && (
        <div
          className="resource-detail__unsaved"
          role="region"
          aria-label="Unsaved changes"
        >
          <p>Unsaved changes</p>
          <ActionRow
            overflowLabel="More unsaved-change actions"
            primary={
              <Button
                variant="primary"
                onClick={unsaved.onSave}
                disabled={unsaved.saving}
              >
                {unsaved.saving ? 'Saving…' : 'Save'}
              </Button>
            }
            secondary={
              <Button onClick={unsaved.onDiscard} disabled={unsaved.saving}>
                Discard
              </Button>
            }
          />
        </div>
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
      {panels.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={tabPanelElementId(id, tab.key)}
          aria-labelledby={tabElementId(id, tab.key)}
          hidden={tab.key !== activeTab}
          className="resource-detail__panel content-stack"
        >
          {renderPanel(tab.key)}
        </div>
      ))}
    </div>
  );
}
