import { useSystemStatusForApiBaseQuery } from '@kontourai/station-sdk';
import { type ReactNode, useState } from 'react';
import {
  CheckGlyph,
  CloseGlyph,
  WarningGlyph,
} from '../../components/icons/Glyph';
import { SkeletonBlock } from '../../components/state';
import { activatable } from '../../utils/activatable';
import { SettingsSection } from './SettingsSection';
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

export function EnvironmentStatus({
  apiBase,
  children,
}: {
  apiBase: string;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <SettingsSection id="section-host-runtime" icon="" title="Host options">
      {children}
      <details
        {...settingsRow('host-runtime')}
        tabIndex={-1}
        className="settings__subsection host-runtime__disclosure"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>Host diagnostics</summary>
        <p className="settings__field-hint">
          Detected agent apps and model prerequisites on the computer running
          Station. Use this when troubleshooting a connection.
        </p>
        {expanded && <HostDiagnostics apiBase={apiBase} />}
      </details>
    </SettingsSection>
  );
}

function HostDiagnostics({ apiBase }: { apiBase: string }) {
  const [guideOpen, setGuideOpen] = useState<Set<string>>(new Set());
  const {
    data: systemStatus,
    isLoading: loading,
    isError,
  } = useSystemStatusForApiBaseQuery(apiBase);
  const hideImplicitProviderPrereq =
    systemStatus?.recommendation?.code === 'runtime-only';
  const prerequisites = Array.isArray(systemStatus?.prerequisites)
    ? (systemStatus.prerequisites as Prerequisite[]).filter((prerequisite) =>
        hideImplicitProviderPrereq
          ? prerequisite.id !== 'bedrock-credentials'
          : true,
      )
    : [];

  if (loading)
    return <SkeletonBlock count={2} label="Checking the Station host" />;
  if (isError || !Array.isArray(systemStatus?.prerequisites)) {
    return (
      <p role="status">
        Host diagnostics are unavailable. Your saved settings remain available.
      </p>
    );
  }

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
    <div className="host-runtime__panel settings__env-panel">
      {[...grouped.entries()].map(([source, items]) => (
        <div key={source}>
          <div className="settings__env-source">{source}</div>
          {items.map(renderItem)}
        </div>
      ))}
    </div>
  );
}
