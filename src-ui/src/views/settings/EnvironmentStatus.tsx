import { useSystemStatusForApiBaseQuery } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import {
  CheckGlyph,
  CloseGlyph,
  WarningGlyph,
} from '../../components/icons/Glyph';
import { PageSection } from '../../components/PageSection';
import { activatable } from '../../utils/activatable';
import { settingsRow } from './settings-catalog';

interface Prerequisite {
  id: string;
  name: string;
  description: string;
  status: 'installed' | 'error' | 'missing';
  category: 'required' | 'optional';
  source?: string;
  installGuide?: { steps: string[]; commands?: string[] };
}

// The host's detected engines and Model connections (Bedrock/Claude
// CLI/Codex/Ollama/Kiro/…). This reflects the connected Station HOST's own
// machine — on a remote client it is host runtime diagnostics, not the user's
// device or their own Settings — so it is framed as "Host runtime" and lives
// low in Settings behind a disclosure, surfacing only genuinely-unmet REQUIRED
// items inline (glossary: "Engine", "Model connections", "host").
export function EnvironmentStatus({ apiBase }: { apiBase: string }) {
  const [expanded, setExpanded] = useState(false);
  const [guideOpen, setGuideOpen] = useState<Set<string>>(new Set());

  const { data: systemStatus, isLoading: loading } =
    useSystemStatusForApiBaseQuery(apiBase);
  const hideImplicitProviderPrereq =
    systemStatus?.recommendation?.code === 'runtime-only';
  const prerequisites = Array.isArray(systemStatus?.prerequisites)
    ? (systemStatus.prerequisites as Prerequisite[]).filter((prerequisite) =>
        hideImplicitProviderPrereq
          ? prerequisite.id !== 'bedrock-credentials'
          : true,
      )
    : [];

  const requiredUnmet = prerequisites.filter(
    (prerequisite) =>
      prerequisite.category === 'required' &&
      prerequisite.status !== 'installed',
  );
  const hasRequiredUnmet = requiredUnmet.length > 0;

  useEffect(() => {
    // Auto-open the full checklist only when the host is missing a REQUIRED
    // prerequisite; otherwise it stays collapsed so the green wall of detected
    // CLIs never dominates Settings.
    if (hasRequiredUnmet) {
      setExpanded(true);
    }
  }, [hasRequiredUnmet]);

  // A missing host report is an observation boundary, not evidence that the
  // host is healthy. Keep the catalog target mounted so deep links and screen
  // readers receive an honest pending/unavailable state.
  if (loading || !Array.isArray(systemStatus?.prerequisites)) {
    return (
      <PageSection
        id="section-host-runtime"
        className="settings__section host-runtime"
        title="Station host"
      >
        <div {...settingsRow('host-runtime')} tabIndex={-1} role="status">
          {loading
            ? 'Checking provider software on the Station host…'
            : 'Host runtime status is unavailable. Try again when the Station host is reachable.'}
        </div>
      </PageSection>
    );
  }

  const allRequiredMet = !hasRequiredUnmet;

  const toggleGuide = (id: string) =>
    setGuideOpen((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const icon = (status: string) =>
    status === 'installed' ? (
      <CheckGlyph />
    ) : status === 'error' ? (
      <WarningGlyph />
    ) : (
      <CloseGlyph />
    );

  const grouped = new Map<string, Prerequisite[]>();
  for (const prerequisite of prerequisites) {
    const source = prerequisite.source || 'Core';
    if (!grouped.has(source)) grouped.set(source, []);
    grouped.get(source)!.push(prerequisite);
  }

  const renderItem = (prerequisite: Prerequisite) => {
    const isClickable =
      prerequisite.status !== 'installed' && !!prerequisite.installGuide;
    return (
      <div key={prerequisite.id}>
        <div
          className={`settings__env-item${isClickable ? ' settings__env-item--clickable' : ''}`}
          {...activatable(
            isClickable ? () => toggleGuide(prerequisite.id) : null,
          )}
        >
          <span
            className={`settings__env-status settings__env-status--${prerequisite.status}`}
          >
            {icon(prerequisite.status)}
          </span>
          <span>
            <span className="settings__env-name">{prerequisite.name}</span>
            <span className="settings__env-desc">
              {' '}
              — {prerequisite.description}
            </span>
            {prerequisite.category === 'optional' && (
              <span className="settings__env-optional"> (optional)</span>
            )}
          </span>
        </div>
        {guideOpen.has(prerequisite.id) && prerequisite.installGuide && (
          <div className="settings__env-guide">
            <ol>
              {prerequisite.installGuide.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            {(prerequisite.installGuide.commands?.length ?? 0) > 0 && (
              <div className="settings__env-guide-cmds">
                {prerequisite.installGuide.commands?.map((command, index) => (
                  <div key={index}>$ {command}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <PageSection
      id="section-host-runtime"
      className="settings__section host-runtime"
      title={
        <>
          <span className="settings__section-icon" aria-hidden="true">
            ◇
          </span>{' '}
          Station host
        </>
      }
      description="Provider software detected on the computer running this Station. On a remote client, this describes the Station host—not your device."
    >
      <div {...settingsRow('host-runtime')} tabIndex={-1}>
        {hasRequiredUnmet && (
          <div className="host-runtime__alert" role="alert">
            <div className="host-runtime__alert-title">
              {requiredUnmet.length} required item
              {requiredUnmet.length !== 1 ? 's' : ''} to resolve on this host
            </div>
            {requiredUnmet.map(renderItem)}
          </div>
        )}

        <details
          className="host-runtime__disclosure"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="host-runtime__summary">
            <span
              className={`host-runtime__summary-status host-runtime__summary-status--${allRequiredMet ? 'ok' : 'warn'}`}
              aria-hidden="true"
            >
              {allRequiredMet ? '●' : '○'}
            </span>
            <span className="host-runtime__summary-label">
              Detected provider software
            </span>
          </summary>
          <div className="host-runtime__panel settings__env-panel">
            {[...grouped.entries()].map(([source, items]) => (
              <div key={source}>
                <div className="settings__env-source">{source}</div>
                {items.map(renderItem)}
              </div>
            ))}
          </div>
        </details>
      </div>
    </PageSection>
  );
}
