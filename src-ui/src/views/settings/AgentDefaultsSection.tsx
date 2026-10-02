import type { SettingProvenanceEntry } from '@kontourai/station-contracts/settings-registry';
import type {
  AgentConnectionView,
  ModelConnectionConfig,
} from '@kontourai/station-contracts/tool';
import {
  useEngineConnectionsQuery,
  useModelConnectionsQuery,
} from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { CloseGlyph } from '../../components/icons/Glyph';
import { ModelSelector } from '../../components/ModelSelector';
import { ProvenanceBadge } from '../../components/ProvenanceBadge';
import { useNavigation } from '../../contexts/NavigationContext';
import type { AppConfig } from '../../types';
import {
  preferredChatRuntime,
  runtimeCatalogVisibleModels,
} from '../../utils/execution';
import { SettingsSection } from './SettingsSection';
import type { StationConfigProjectOverride } from './StationConfigSection';
import { settingsRow } from './settings-catalog';

function ProjectModelDefaults({
  config,
  projectOverride,
  readReady,
}: {
  config: AppConfig;
  projectOverride: StationConfigProjectOverride;
  readReady: boolean;
}) {
  const connections = useModelConnectionsQuery();
  const available = (connections.data ?? []).filter(
    (connection) =>
      connection.kind === 'model' &&
      connection.enabled &&
      connection.status === 'ready',
  );
  const provider = projectOverride.values.defaultLLMProvider;
  const providerId = typeof provider === 'string' ? provider : '';
  const selected = available.find((connection) => connection.id === providerId);
  const models = runtimeCatalogVisibleModels(selected);
  const model = projectOverride.values.defaultModel;
  const modelId =
    typeof model === 'string' ? model : (config.defaultModel ?? '');

  return (
    <>
      <label
        className="settings__field-label"
        htmlFor="project-model-connection"
      >
        Model connection
      </label>
      <select
        id="project-model-connection"
        className="editor-select"
        value={providerId}
        disabled={!readReady || connections.isLoading || connections.isError}
        onChange={(event) => {
          const id = event.target.value;
          if (!id) {
            projectOverride.onReset('defaultModel');
            projectOverride.onReset('defaultLLMProvider');
            return;
          }
          const connection = available.find((candidate) => candidate.id === id);
          const declared = connection?.config.defaultModel;
          projectOverride.onChange('defaultLLMProvider', id);
          projectOverride.onChange(
            'defaultModel',
            typeof declared === 'string' && declared
              ? declared
              : (runtimeCatalogVisibleModels(connection)[0]?.id ?? ''),
          );
        }}
      >
        <option value="">Station default</option>
        {providerId && !selected && (
          <option value={providerId}>
            Unavailable connection: {providerId}
          </option>
        )}
        {available.map((connection: ModelConnectionConfig) => (
          <option key={connection.id} value={connection.id}>
            {connection.name}
          </option>
        ))}
      </select>
      <ModelSelector
        id="defaultModel"
        value={modelId}
        models={models}
        disabled={!readReady || !selected}
        onChange={(id) => projectOverride.onChange('defaultModel', id)}
        placeholder="Select a model…"
      />
      <span className="settings__field-hint">
        {connections.isError
          ? 'Model connections could not be loaded.'
          : !readReady
            ? 'Loading this project’s defaults…'
            : providerId
              ? `Connection and model for ${projectOverride.name}. Choose Station default to inherit both.`
              : `${projectOverride.name} follows the Station default. Choose a connection to set its own model.`}
      </span>
      {providerId && !modelId.trim() && (
        <span className="settings__field-error">
          Choose a model before saving this project’s default.
        </span>
      )}
    </>
  );
}

// archive#settings-revamp: promoted from a de-emphasized disclosure
// to its own top-level "Defaults" scope (docs/design/settings-architecture.md
// §3) — still default values only used when a chat, project, or agent
// has no override of its own, now with a persistence-tier caption
// (`SettingsView.tsx`) instead of "de-emphasized" framing. The internal
// progressive disclosure is gone: these fields sat behind a closed
// <details> labelled "Show default model, instructions, region, and
// variables", so the scope that was promoted to top level still opened
// closed. The `agent-defaults__panel` wrapper is kept — it carries the
// section's layout.
export function AgentDefaultsSection({
  config,
  validationErrors,
  validationWarnings,
  onChange,
  region,
  regionError,
  regionProvenance,
  showRegion,
  onRegionChange,
  projectOverride,
  projectReadReady = true,
  children,
}: {
  config: AppConfig;
  validationErrors: Record<string, string>;
  validationWarnings: Record<string, string>;
  onChange: (config: AppConfig) => void;
  region: string;
  regionError?: string;
  /** docs/design/settings-architecture.md §4's named example: `region`/`AWS_REGION`. */
  regionProvenance?: SettingProvenanceEntry;
  showRegion: boolean;
  onRegionChange: (value: string) => void;
  projectOverride?: StationConfigProjectOverride;
  projectReadReady?: boolean;
  /**
   * Rows that belong to this section but are registry-driven (#2182: the five
   * Station settings that bound or equip a run). They render at the end of
   * this card, after the four fields with bespoke controls.
   */
  children?: ReactNode;
}) {
  const { navigate } = useNavigation();
  const { data: agentConnections = [] } = useEngineConnectionsQuery() as {
    data?: AgentConnectionView[];
  };
  const preferredRuntime = preferredChatRuntime(agentConnections);
  const runtimeModels = runtimeCatalogVisibleModels(preferredRuntime);
  const useRuntimeModelOptions =
    !config.defaultLLMProvider && runtimeModels.length > 0;

  return (
    <SettingsSection icon="▾" title="Agent runs" id="section-agent-runs">
      <div className="agent-defaults__panel">
        <div
          className="settings__field"
          {...settingsRow('default-model')}
          tabIndex={-1}
        >
          <label className="settings__field-label" htmlFor="defaultModel">
            {settingsRow('default-model').title}
          </label>
          {projectOverride ? (
            <ProjectModelDefaults
              config={config}
              projectOverride={projectOverride}
              readReady={projectReadReady}
            />
          ) : (
            <ModelSelector
              id="defaultModel"
              value={config.defaultModel ?? ''}
              models={
                useRuntimeModelOptions
                  ? runtimeModels.map((model) => ({
                      id: model.id,
                      name: model.name,
                      originalId: model.originalId,
                    }))
                  : undefined
              }
              onChange={(modelId) =>
                onChange({ ...config, defaultModel: modelId })
              }
              placeholder="Select a model…"
            />
          )}
          {!projectOverride && (
            <>
              <span className="settings__field-hint">
                {useRuntimeModelOptions
                  ? `Default model for new chats and agents that don't specify one. Options currently come from ${preferredRuntime?.name}.`
                  : "Default model for new chats and agents that don't specify one."}
              </span>
              <span className="settings__field-hint">
                Projects and agents can choose their own model.{' '}
                <button
                  type="button"
                  className="button button--link"
                  onClick={() => navigate('/agents')}
                >
                  Open Agents
                </button>
              </span>
            </>
          )}
        </div>

        {showRegion ? (
          <div
            className="settings__field"
            {...settingsRow('default-region')}
            tabIndex={-1}
          >
            <label className="settings__field-label" htmlFor="region">
              {settingsRow('default-region').title}
            </label>
            <ProvenanceBadge provenance={regionProvenance} />
            <input
              id="region"
              type="text"
              className={regionError ? 'settings__field--invalid' : ''}
              value={region}
              onChange={(event) => onRegionChange(event.target.value)}
              placeholder="us-east-1"
            />
            {regionError && (
              <span className="settings__field-error">{regionError}</span>
            )}
            <span className="settings__field-hint">
              Region for connections that use regional routing.
            </span>
            <span className="settings__field-hint">
              Agents can choose their own region.{' '}
              <button
                type="button"
                className="button button--link"
                onClick={() => navigate('/agents')}
              >
                Open Agents
              </button>
            </span>
          </div>
        ) : null}

        <div
          className="settings__field"
          {...settingsRow('default-agent-instructions')}
          tabIndex={-1}
        >
          <label className="settings__field-label" htmlFor="systemPrompt">
            {settingsRow('default-agent-instructions').title}
          </label>
          <textarea
            id="systemPrompt"
            value={config.systemPrompt || ''}
            onChange={(event) =>
              onChange({ ...config, systemPrompt: event.target.value })
            }
            placeholder="Default instructions used when an agent or chat doesn't define its own…"
            rows={6}
          />
          <div
            className="settings__char-count"
            aria-live="polite"
            aria-atomic="true"
          >
            {(config.systemPrompt || '').length.toLocaleString()} / 10,000
          </div>
          {validationErrors.systemPrompt && (
            <span className="settings__field-error">
              {validationErrors.systemPrompt}
            </span>
          )}
          <span className="settings__field-hint">
            Added before Station agents’ instructions. Used for chats with no
            instructions of their own. Supports {'{{date}}'}, {'{{time}}'}, or
            custom variables below.
          </span>
        </div>

        <div
          className="settings__field"
          {...settingsRow('template-variables')}
          tabIndex={-1}
        >
          <div className="settings__field-label">
            {settingsRow('template-variables').title}
          </div>
          <div className="settings__vars">
            {(config.templateVariables || []).map((variable, index) => (
              <div key={index} className="settings__var-row">
                <input
                  type="text"
                  value={variable.key}
                  onChange={(event) => {
                    const updated = [...(config.templateVariables || [])];
                    updated[index] = {
                      ...variable,
                      key: event.target.value,
                    };
                    onChange({ ...config, templateVariables: updated });
                  }}
                  placeholder="variable_name"
                />
                <select
                  value={variable.type}
                  onChange={(event) => {
                    const updated = [...(config.templateVariables || [])];
                    updated[index] = {
                      ...variable,
                      type: event.target.value as
                        | 'static'
                        | 'date'
                        | 'time'
                        | 'datetime'
                        | 'custom',
                    };
                    onChange({ ...config, templateVariables: updated });
                  }}
                >
                  <option value="static">Static</option>
                  <option value="date">Date</option>
                  <option value="time">Time</option>
                  <option value="datetime">DateTime</option>
                  <option value="custom">Custom</option>
                </select>
                {variable.type === 'static' || variable.type === 'custom' ? (
                  <input
                    type="text"
                    value={variable.value || ''}
                    onChange={(event) => {
                      const updated = [...(config.templateVariables || [])];
                      updated[index] = {
                        ...variable,
                        value: event.target.value,
                      };
                      onChange({ ...config, templateVariables: updated });
                    }}
                    placeholder="Value"
                  />
                ) : (
                  <input
                    type="text"
                    value={variable.format || ''}
                    onChange={(event) => {
                      const updated = [...(config.templateVariables || [])];
                      updated[index] = {
                        ...variable,
                        format: event.target.value,
                      };
                      onChange({ ...config, templateVariables: updated });
                    }}
                    placeholder="Format (optional)"
                    aria-label={`Date/time format for ${variable.key || 'unnamed variable'}`}
                    title='JSON date/time options, e.g. {"year":"numeric","month":"short","day":"numeric"}. Leave empty for the default.'
                  />
                )}
                <button
                  type="button"
                  className="settings__var-remove"
                  aria-label={`Remove template variable ${index + 1}: ${variable.key || 'unnamed'}`}
                  onClick={() => {
                    const updated = (config.templateVariables || []).filter(
                      (_, candidateIndex) => candidateIndex !== index,
                    );
                    onChange({ ...config, templateVariables: updated });
                  }}
                >
                  <CloseGlyph />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="settings__var-add"
              onClick={() =>
                onChange({
                  ...config,
                  templateVariables: [
                    ...(config.templateVariables || []),
                    { key: '', type: 'static' as const, value: '' },
                  ],
                })
              }
            >
              + Add Variable
            </button>
            {validationErrors.templateVars && (
              <span className="settings__field-error">
                {validationErrors.templateVars}
              </span>
            )}
            {validationWarnings.templateVarValues && (
              <span className="settings__field-warning">
                {validationWarnings.templateVarValues}
              </span>
            )}
            {config.templateVariables?.some(
              (variable) =>
                variable.type === 'date' ||
                variable.type === 'time' ||
                variable.type === 'datetime',
            ) && (
              <span className="settings__field-hint">
                Date/time format uses JSON options, such as{' '}
                <code>{'{"year":"numeric"}'}</code>. Leave empty for the
                default.
              </span>
            )}
          </div>
          <div className="settings__var-ref">
            <strong>Built-in (always available):</strong>
            <ul>
              <li>
                <code>{'{{date}}'}</code> Full date · <code>{'{{time}}'}</code>{' '}
                Current time · <code>{'{{datetime}}'}</code> Combined
              </li>
              <li>
                <code>{'{{iso_date}}'}</code> ISO · <code>{'{{year}}'}</code>{' '}
                <code>{'{{month}}'}</code> <code>{'{{day}}'}</code>{' '}
                <code>{'{{weekday}}'}</code>
              </li>
            </ul>
          </div>
        </div>
        {children}
      </div>
    </SettingsSection>
  );
}
