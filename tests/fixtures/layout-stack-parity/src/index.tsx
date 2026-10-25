import type { LayoutComponent } from '@kontourai/station-sdk';

/** Two plain drill-ins: each names itself, so a test can see which is shown. */
function ParityNotes() {
  return (
    <section aria-label="Parity notes pane">
      <h2>Parity notes drill-in</h2>
    </section>
  );
}

function ParityChecks() {
  return (
    <section aria-label="Parity checks pane">
      <h2>Parity checks drill-in</h2>
    </section>
  );
}

export const components = {
  'stack-fx-notes': ParityNotes,
  'stack-fx-checks': ParityChecks,
} satisfies Record<string, LayoutComponent>;

export default ParityNotes;
