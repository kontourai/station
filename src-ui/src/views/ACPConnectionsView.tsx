import { ACPConnectionsSection } from '../components/acp-connections/ACPConnectionsSection';
import { PageEyebrowTrail, usePageHeader } from '../components/page-frame';
import type { AgentSummary } from '../types';
import './page-layout.css';
import './editor-layout.css';
import '../components/acp-connections/ACPConnections.css';

interface ACPConnectionsViewProps {
  agents: AgentSummary[];
  initialProviderId?: string | null;
}

/**
 * The eyebrow this view publishes when it owns the page header directly
 * (its live route always wraps it in `ConnectionsSectionFrame`'s
 * `PageHeaderScope`, so in practice `ConnectionsSectionFrame`'s own eyebrow
 * wins — this is the contract this component's own tests pin).
 *
* archive#4463: 'Connections' only, unlinked — `/connections`
 * is a redirect-only resolver (`ConnectionsHub` jumps straight to whichever
 * section needs attention, or Models), so a click here would be a no-op or a
 * sibling jump dressed up as "go up", matching the same call made for the
 * five `ConnectionsSectionFrame` sections.
 */
const CONNECTIONS_EYEBROW = (
  <PageEyebrowTrail segments={[{ label: 'Connections' }]} />
);

export function ACPConnectionsView({
  agents,
  initialProviderId,
}: ACPConnectionsViewProps) {
  usePageHeader({ eyebrow: CONNECTIONS_EYEBROW });

  return (
    <div className="acp-connections-view">
      <ACPConnectionsSection
        acpAgents={agents}
        initialProviderId={initialProviderId}
      />
    </div>
  );
}
