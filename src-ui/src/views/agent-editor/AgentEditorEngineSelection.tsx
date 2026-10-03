import { isStationAgentIdentity } from '@kontourai/station-contracts/agent-identity';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { EngineCapabilitySummary } from '../../components/acp-connections/EngineCapabilitySummary';
import { EngineChip } from '../../components/badges/EngineChip';
import { InfoTip } from '../../components/InfoTip';
import { navigationStore } from '../../contexts/navigation-store';
import {
  connectionStatusLabel,
  isAgentConnectionSelectable,
} from '../../utils/execution';
import { settingsDeepLinkUrl } from '../settings/settings-deep-link';
import type { AgentEditorFormProps, AgentFormData } from './types';

/** Creation-only branch state: Station, or an external engine not named yet. */
export type EngineKind = 'model' | 'cli';

/** The enabled engine connections a person may actually wrap. */
export function externalEngineOptions(
  agentConnections: ConnectionConfig[],
): ConnectionConfig[] {
  return agentConnections.filter((connection) => {
    if (connection.kind !== 'agent' || !connection.enabled) return false;
    if (!connection.capabilities.includes('agent-runtime')) return false;
    return (
      resolveEngineCapabilityMatrix(connection.id, connection).engineId !==
      'station'
    );
  });
}

/**
 * DESIGN.md §3.2 — the engine question, asked first, as peer engine rows.
 *
 * `engineKind` is a PROP, not a derivation, for one case the derivation
 * cannot express: during creation an external engine row is chosen
 * BEFORE any CLI is, and an absent `agentConnectionId` reads as Station
 * everywhere else in the codebase (`docs/design/agent-engine-unification.md`
 * §7.1) — so a derived answer would silently bounce the user back to the
 * model card the moment they picked the CLI branch. On a persisted agent the
 * caller passes the derived value and nothing changes.
 */
export function AgentEditorEngineSelection({
  form,
  setForm,
  locked,
  agentConnections,
  engineKind,
  onEngineKindChange,
  stationConnectionId,
}: Pick<AgentEditorFormProps, 'form' | 'setForm' | 'locked'> & {
  agentConnections: ConnectionConfig[];
  engineKind: EngineKind;
  onEngineKindChange: (kind: EngineKind) => void;
  /**
   * The selectable Station-engine connection to bind when "Use a model
   * connection" is chosen, or `''` when none is ready. Passing the id keeps
   * the model catalogue reachable (`runtimeCatalogVisibleModels`); `''` is
   * the persisted Station shape when there is nothing ready to name.
   */
  stationConnectionId: string;
}) {
  const boundConnectionId = form.execution.agentConnectionId;
  const boundConnection = agentConnections.find(
    (connection) => connection.id === boundConnectionId,
  );
  const isStationBound =
    resolveEngineCapabilityMatrix(boundConnectionId, boundConnection)
      .engineId === 'station';
  const cliOptions = externalEngineOptions(agentConnections);
  const engineDescriptor = (connection: ConnectionConfig) => {
    const engineId = resolveEngineCapabilityMatrix(
      connection.id,
      connection,
    ).engineId;
    return {
      name:
        engineId === 'acp'
          ? connection.name
          : (engineDisplayLabel(engineId) ?? connection.name),
    };
  };

  const bindEngine = (value: string) => {
    setForm((current: AgentFormData) => {
      if (!value) {
        // Station is represented by the ABSENCE of a connection, never by a
        // managed-runtime connection id: that id is one Station-engine
        // connection among several, while the record's meaning is simply
        // "Station's own engine runs this".
        return {
          ...current,
          execution: { ...current.execution, agentConnectionId: '' },
        };
      }
      const changed = value !== current.execution.agentConnectionId;
      return {
        ...current,
        execution: {
          ...current.execution,
          agentConnectionId: value,
          modelConnectionId: '',
          // §3.2: engine-owned values reset to the new engine's defaults.
          runtimeOptions: changed ? {} : current.execution.runtimeOptions,
          modelOptions: changed ? {} : current.execution.modelOptions,
        },
      };
    });
  };

  /**
   * The built-in Station Agent's engine is NOT an Agent field.
   * `AppConfig.builtinAgentEngineConnectionId` owns it, resolved per boot
   * against live readiness, and the record deliberately never carries the
   * result (`docs/design/agent-engine-unification.md` §7.1.1, archive#3662
   * delta). A picker here would have written a value no reader consults
   * and the write boundary drops — an engine choice that silently does
   * nothing. So this states where the setting lives instead of offering one.
   */
  if (isStationAgentIdentity(form.slug)) {
    return (
      <div className="editor-field">
        <div className="editor-label-row">
          <h3 id="agent-engine" className="agent-editor__section-title">
            Engine
          </h3>
          <InfoTip label="Engine capabilities">
            <p>The built-in Agent uses the engine chosen in Settings.</p>
            <EngineCapabilitySummary
              matrix={resolveEngineCapabilityMatrix(
                boundConnectionId,
                boundConnection,
              )}
              connectionName={
                isStationBound
                  ? 'Station'
                  : (boundConnection?.name ??
                    engineDisplayLabel(
                      resolveEngineCapabilityMatrix(
                        boundConnectionId,
                        boundConnection,
                      ).engineId,
                    ) ??
                    boundConnectionId)
              }
            />
          </InfoTip>
        </div>
        <output className="editor-readonly" aria-labelledby="agent-engine">
          {isStationBound
            ? 'Station'
            : (boundConnection?.name ??
              engineDisplayLabel(
                resolveEngineCapabilityMatrix(
                  boundConnectionId,
                  boundConnection,
                ).engineId,
              ) ??
              boundConnectionId)}
        </output>
        <span className="editor-hint">
          <button
            type="button"
            className="agent-editor__capability-banner-action"
            onClick={() =>
              navigationStore.navigate(
                settingsDeepLinkUrl({
                  // #2182: the row moved to Agent runs. The highlight is what
                  // makes this link self-healing, but the view is stated
                  // correctly anyway — a bare stale view is NOT healed.
                  view: 'agent-runs',
                  highlight: 'builtin-agent-engine',
                }),
              )
            }
          >
            Change it in Settings
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="editor-field">
      <div className="editor-label-row">
        <h3 id="agent-engine" className="agent-editor__section-title">
          Engine
        </h3>
        {(engineKind === 'model' || boundConnectionId) && (
          <InfoTip label="Engine capabilities">
            {engineKind === 'model' ? (
              <EngineCapabilitySummary
                matrix={ENGINE_CAPABILITY_MATRICES.station}
                connectionName="Station"
              />
            ) : boundConnectionId ? (
              <EngineCapabilitySummary
                matrix={resolveEngineCapabilityMatrix(
                  boundConnectionId,
                  boundConnection,
                )}
                connectionName={boundConnection?.name ?? 'this engine'}
              />
            ) : null}
          </InfoTip>
        )}
      </div>
      <div
        className="agent-engine-choices"
        role="radiogroup"
        aria-label="Engine choice"
      >
        <label className="agent-engine-choice">
          <input
            type="radio"
            name="ae-engine"
            checked={engineKind === 'model'}
            disabled={locked}
            onChange={() => {
              onEngineKindChange('model');
              bindEngine(stationConnectionId);
            }}
          />
          <span>
            <EngineChip engine={{ name: 'Station' }} />
          </span>
        </label>
        {cliOptions.length === 0
          ? engineKind === 'cli' && (
              <p className="editor-hint">
                No external engine is enabled on this machine yet.{' '}
                <button
                  type="button"
                  className="agent-editor__capability-banner-action"
                  onClick={() =>
                    navigationStore.navigate('/connections?section=engines')
                  }
                >
                  Set one up
                </button>
              </p>
            )
          : cliOptions.map((connection) => (
              <label className="agent-engine-choice" key={connection.id}>
                <input
                  type="radio"
                  name="ae-engine"
                  checked={
                    engineKind === 'cli' && boundConnectionId === connection.id
                  }
                  disabled={locked || !isAgentConnectionSelectable(connection)}
                  onChange={() => {
                    onEngineKindChange('cli');
                    bindEngine(connection.id);
                  }}
                />
                <span>
                  <EngineChip engine={engineDescriptor(connection)} />
                  {/* The SERVER's readiness sentence (archive#3649 evidence), not
                      the evidence KIND — "Catalog: Live" is internal
                      vocabulary (Y5). */}
                  {!isAgentConnectionSelectable(connection) && (
                    <small>
                      {connection.readinessEvidence?.summary ??
                        connectionStatusLabel(connection.status)}
                    </small>
                  )}
                  {!isAgentConnectionSelectable(connection) && (
                    <button
                      type="button"
                      className="agent-editor__capability-banner-action"
                      onClick={() =>
                        navigationStore.navigate(
                          `/connections/engines/${encodeURIComponent(connection.id)}`,
                        )
                      }
                    >
                      Set up {connection.name}
                    </button>
                  )}
                </span>
              </label>
            ))}
      </div>
    </div>
  );
}
