import { isStationAgentIdentity } from '@kontourai/station-contracts/agent-identity';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { EngineCapabilitySummary } from '../../components/acp-connections/EngineCapabilitySummary';
import { navigationStore } from '../../contexts/navigation-store';
import {
  agentConnectionLabel,
  connectionStatusLabel,
  isAgentConnectionSelectable,
} from '../../utils/execution';
import type { AgentEditorFormProps, AgentFormData } from './types';

/** "Use a model connection" (Station's own engine) or "Use an installed agent CLI". */
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
 * DESIGN.md §3.2 — the engine question, asked first, as two radio cards.
 *
 * `engineKind` is a PROP, not a derivation, for one case the derivation
 * cannot express: during creation "Wrap an installed agent CLI" is chosen
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
        <span className="editor-label" id="ae-engine-builtin-label">
          Engine
        </span>
        <output
          className="editor-readonly"
          aria-labelledby="ae-engine-builtin-label"
        >
          {isStationBound
            ? 'Station'
            : (boundConnection?.name ??
              agentConnectionLabel(boundConnectionId))}
        </output>
        <span className="editor-hint">
          The built-in Agent runs on whichever engine this Station is set up to
          use, and that choice is a Settings one — it is resolved fresh each
          time Station starts, so it is not stored on this Agent.{' '}
          <button
            type="button"
            className="agent-editor__capability-banner-action"
            onClick={() =>
              navigationStore.navigate(
                '/settings?view=station-config&highlight=builtin-agent-engine',
              )
            }
          >
            Change it in Settings
          </button>
        </span>
{/* archive#3728: omitting the PICKER here is the
            documented decision; omitting the capability summary was not —
            this was the one editor case that named an engine without
            explaining it. Read-only, from the runtime-resolved binding. */}
        <EngineCapabilitySummary
          matrix={resolveEngineCapabilityMatrix(
            boundConnectionId,
            boundConnection,
          )}
          connectionName={
            isStationBound
              ? 'Station'
              : (boundConnection?.name ??
                agentConnectionLabel(boundConnectionId))
          }
        />
      </div>
    );
  }

  return (
    <div className="editor-field">
      <span className="editor-label">Which engine runs this agent?</span>
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
            <strong>Use a model connection</strong>
            <small>
              Station’s own engine runs the agent on a Model connection you
              choose (Bedrock, OpenAI, Ollama…).
            </small>
          </span>
        </label>
        <label className="agent-engine-choice">
          <input
            type="radio"
            name="ae-engine"
            checked={engineKind === 'cli'}
            disabled={locked}
            onChange={() => {
              onEngineKindChange('cli');
 // Do NOT auto-bind the first CLI: DESIGN.md §4 makes choosing
// one an explicit step, and Create stays disabled until it is
// made. Binding here would let a person create an agent on an
// engine they never named.
              bindEngine('');
            }}
          />
          <span>
            <strong>Use an installed agent CLI</strong>
            <small>
              An agent CLI on this machine runs itself. Station sets only what
              the CLI lets it set.
            </small>
          </span>
        </label>
      </div>

      {engineKind === 'cli' && (
        <div
          className="agent-engine-choices agent-engine-choices--nested"
          role="radiogroup"
          aria-label="Installed agent CLI"
        >
          {cliOptions.length === 0 ? (
            <p className="editor-hint">
              No agent CLI is enabled on this machine yet.{' '}
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
          ) : (
            cliOptions.map((connection) => (
              <label className="agent-engine-choice" key={connection.id}>
                <input
                  type="radio"
                  name="ae-cli-engine"
                  checked={boundConnectionId === connection.id}
                  disabled={locked || !isAgentConnectionSelectable(connection)}
                  onChange={() => bindEngine(connection.id)}
                />
                <span>
                  <strong>{connection.name}</strong>
 {/* The SERVER's readiness sentence (archive#3649 evidence), not
                      the evidence KIND — "Catalog: Live" is internal
                      vocabulary (Y5). */}
                  <small>
                    {connection.readinessEvidence?.summary ??
                      connectionStatusLabel(connection.status)}
                  </small>
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
            ))
          )}
        </div>
      )}

{/* archive#3722: the two-row capability summary for the engine
          this agent is actually bound to. The MODEL branch resolves to the
          Station matrix EXPLICITLY (#3728 review, LOW): "Use a model
          connection" means Station's own engine, and during the transient
          window where the model radio is selected while a CLI binding has
          not been rewritten yet, resolving from the stale binding would
          describe an engine the user is not choosing. The CLI branch shows
          the summary only once a concrete CLI is bound. */}
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
    </div>
  );
}
