import { useState } from 'react';
import { Tabs, tabElementId, tabPanelElementId } from '../../components/Tabs';
import { MonitoringViewWithBoundary } from '../MonitoringView';
import { TelemetryCompanion } from './TelemetryCompanion';

// #1989: keep the existing monitoring subtree behind DeveloperView's lazy tab.
export default function TelemetryTab() {
  const [view, setView] = useState('activity');
  return (
    <section
      className="pane-host developer-tab developer-tab--telemetry section-nav-rail__contained"
      aria-label="Monitoring"
    >
      <Tabs
        id="telemetry-surfaces"
        aria-label="Telemetry views"
        activation="manual"
        items={[
          { key: 'activity', label: 'Activity' },
          { key: 'companion', label: 'Companion' },
        ]}
        activeKey={view}
        onSelect={setView}
      />
      <div
        className="tab-panel"
        role="tabpanel"
        id={tabPanelElementId('telemetry-surfaces', view)}
        aria-labelledby={tabElementId('telemetry-surfaces', view)}
      >
        {view === 'activity' ? (
          <MonitoringViewWithBoundary />
        ) : (
          <TelemetryCompanion />
        )}
      </div>
    </section>
  );
}
