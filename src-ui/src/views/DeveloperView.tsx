import { lazy, Suspense, useMemo } from 'react';
import { PageEyebrowTrail, usePageHeader } from '../components/page-frame';
import { SectionNavigation } from '../components/SectionNavigation';
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

const tabs: Array<{ id: DeveloperTab; label: string; description: string }> = [
  {
    id: 'logs',
    label: 'Logs',
    description: 'Search server output and inspect structured records.',
  },
  {
    id: 'system',
    label: 'System',
    description: 'Inspect this Station, host resources, and runtime readiness.',
  },
  {
    id: 'telemetry',
    label: 'Monitoring',
    description:
      'Investigate activity, tool latency, usage, and inference routing.',
  },
  {
    id: 'memory',
    label: 'Memory',
    description:
      'Inspect recall and canonical records in configured knowledge stores.',
  },
  {
    id: 'archive',
    label: 'Archive',
    description: 'Browse session history and download diagnostics.',
  },
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
    subtitle: tabs.find((item) => item.id === active)?.description,
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
    <div className="pane-host developer-view section-nav-rail">
      <SectionNavigation
        label="Developer sections"
        pickerLabel="Developer section"
        items={tabs.map(({ id, label }) => ({
          key: id,
          label,
          href: `/developer/${id}`,
        }))}
        activeKey={active}
        onNavigate={(key) => navigate(`/developer/${key}`)}
      />
      <div className="section-nav-rail__body developer-view__body">
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
