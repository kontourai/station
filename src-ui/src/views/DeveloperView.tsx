import { lazy, Suspense, useMemo } from 'react';
import { PageEyebrowTrail, usePageHeader } from '../components/page-frame';
import { Tabs, tabElementId, tabPanelElementId } from '../components/Tabs';
import { useNavigation } from '../contexts/NavigationContext';
import type { DeveloperTab } from '../types';
import './DeveloperView.css';

const LogsTab = lazy(() => import('./developer/LogsTab'));
const SystemTab = lazy(() => import('./developer/SystemTab'));
const MemoryTab = lazy(() => import('./developer/MemoryTab'));
const ArchiveTab = lazy(() => import('./developer/ArchiveTab'));

// These bodies own substantial optional dependency subtrees. Keeping their
// imports here makes DeveloperView the only route-level owner of monitoring.
const TelemetryTab = lazy(() => import('./developer/TelemetryTab'));

/** Groups this view's generated tab/panel ids — see `components/Tabs.tsx`. */
const TABS_ID = 'developer-tabs';

const tabs: Array<{ id: DeveloperTab; label: string }> = [
  { id: 'logs', label: 'Logs' },
  { id: 'system', label: 'System' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'memory', label: 'Memory' },
  { id: 'archive', label: 'Archive' },
];

export function DeveloperView({
  tab = 'logs',
  apiBase,
}: {
  tab?: DeveloperTab;
  apiBase: string;
}) {
  const { navigate } = useNavigation();
  const active = tab;
  // archive#4463: the frame owns the tab title; Developer links to its parent.
  const eyebrow = useMemo(
    () => (
      <PageEyebrowTrail
        segments={[
          { label: 'Developer', onClick: () => navigate('/developer') },
        ]}
      />
    ),
    [navigate],
  );
  usePageHeader({
    eyebrow,
    title: tabs.find((item) => item.id === active)?.label ?? 'Developer',
  });
  const body =
    active === 'logs' ? (
      <LogsTab />
    ) : active === 'system' ? (
      <SystemTab apiBase={apiBase} />
    ) : active === 'telemetry' ? (
      <TelemetryTab />
    ) : active === 'memory' ? (
      <MemoryTab />
    ) : (
      <ArchiveTab apiBase={apiBase} />
    );
  return (
    <div className="pane-host developer-view">
      <Tabs
        id={TABS_ID}
        className="developer-view__tabs"
        aria-label="Developer"
        // archive#4463: arrow keys must not push routes or steal tab focus.
        activation="manual"
        items={tabs.map(({ id, label }) => ({ key: id, label }))}
        activeKey={active}
        onSelect={(key) => navigate(`/developer/${key}`)}
      />
      <div
        role="tabpanel"
        id={tabPanelElementId(TABS_ID, active)}
        aria-labelledby={tabElementId(TABS_ID, active)}
        className="tab-panel"
      >
        <Suspense
          fallback={
            <div className="developer-view__loading">
              Loading {tabs.find((item) => item.id === active)?.label}…
            </div>
          }
        >
          {body}
        </Suspense>
      </div>
    </div>
  );
}
