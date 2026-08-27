import { MonitoringViewWithBoundary } from '../MonitoringView';

// #1989: the Monitoring page MOVES into the telemetry tab rather than being
// reconstructed here. DeveloperView lazy-loads this tab, so the full
// monitoring subtree (time controls, sidebar, filters/search, event stream,
// metrics, fleet receipts) and its `MonitoringWidgets.css` land in this async
// chunk — off the entry graph — while `/developer/telemetry` renders the real
// `.monitoring-page` surface with full behavior.
export default function TelemetryTab() {
  return (
    <section
      className="developer-tab developer-tab--telemetry"
      aria-label="Telemetry"
    >
      <MonitoringViewWithBoundary />
    </section>
  );
}
