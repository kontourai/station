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
  // Each tab used to render its own unstyled top-level heading (browser-
  // default 32px, flush at x=248). The tab strip names the section; the
  // frame renders it.
  //
  // station#4463 slice 1: the eyebrow is 'Developer' — a real parent (the
  // title is the active tab's name, never 'Developer' itself), so it stays
  // and is linked back to `/developer` rather than left as inert text.
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
        // Manual activation (station#4463 slice 2 review HIGH-2): each
        // tab's onSelect pushes a ROUTE (`navigate`), so automatic
        // activation was pushing one history entry per arrow-key press and
        // yanking focus out of the strip. Arrows move focus only here;
        // Enter/Space navigates.
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
