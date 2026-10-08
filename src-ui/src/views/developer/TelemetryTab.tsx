import { MonitoringViewWithBoundary } from '../MonitoringView';

// #1989: keep the existing monitoring subtree behind DeveloperView's lazy tab.
export default function TelemetryTab() {
  return (
    <section
      className="developer-tab developer-tab--telemetry"
      aria-label="Monitoring"
    >
      <MonitoringViewWithBoundary />
    </section>
  );
}
