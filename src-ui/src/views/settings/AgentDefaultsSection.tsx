import type { SettingProvenanceEntry } from '@kontourai/station-contracts/settings-registry';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useAgentConnectionsQuery } from '@kontourai/station-sdk';
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
import { settingsRow } from './settings-catalog';

// archive#settings-revamp: promoted from a de-emphasized disclosure
// to its own top-level "Defaults" scope (docs/design/settings-architecture.md
// §3) — still default values only used when a chat, project, or agent
// has no override of its own, now with a persistence-tier caption
// (`SettingsView.tsx`) instead of "de-emphasized" framing. The internal
// progressive disclosure below is kept (a long form, not the scope's
// significance) rather than reworked this slice.
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
  guard,
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
/**
 * `SettingsView.tsx`'s own `useUnsavedGuard` guard — 
 * ( 1): every navigation trigger from a page with dirty state
* must route through it (CLAUDE.md's unsaved-guard standard), including
* this section's own "Open Agents" cross-links.
*/
  guard: (callback: () => void) => void;
}) {
  const { navigate } = useNavigation();
  const { data: agentConnections = [] } = useAgentConnectionsQuery() as {
    data?: AgentConnectionView[];
  };
  const preferredRuntime = preferredChatRuntime(agentConnections);
  const runtimeModels = runtimeCatalogVisibleModels(preferredRuntime);
  const useRuntimeModelOptions =
    !config.defaultLLMProvider && runtimeModels.length > 0;

  return (
    <SettingsSection icon="▾" title="Defaults" id="section-agent-defaults">
      <p className="settings__field-hint agent-defaults__intro">
        Default values used only when a chat or agent doesn't specify its own
        model, instructions, or region. Most agents and connections override
        these — nothing here is injected into every conversation
        unconditionally.
      </p>

      <details className="agent-defaults__disclosure">
        <summary className="agent-defaults__summary">
          <span className="agent-defaults__summary-label">
            Show default model, instructions, region, and variables
          </span>
        </summary>
        <div className="agent-defaults__panel">
          <div
            className="settings__field"
            {...settingsRow('default-model')}
            tabIndex={-1}
          >
            <label className="settings__field-label" htmlFor="defaultModel">
              {settingsRow('default-model').title}
            </label>
            <ModelSelector
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
            <span className="settings__field-hint">
              {useRuntimeModelOptions
                ? `Default model for new chats and agents that don't specify one. Options currently come from ${preferredRuntime?.name}.`
                : "Default model for new chats and agents that don't specify one."}
            </span>
            <span className="settings__field-hint">
              Projects and agents can override this — a project's own Settings
              holds its override; agents override theirs in the agent editor.{' '}
              <button
                type="button"
                className="button button--link"
                onClick={() => guard(() => navigate('/agents'))}
              >
                Open Agents
              </button>
            </span>
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
                Used when a configured connection requires regional routing,
                such as built-in cloud services.
              </span>
              <span className="settings__field-hint">
                Agents can override this per-agent in the agent editor.{' '}
                <button
                  type="button"
                  className="button button--link"
                  onClick={() => guard(() => navigate('/agents'))}
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
              Prepended ahead of a Station agent's own instructions, and used as
              the whole instruction set for chats and agents that define none of
              their own. Supports template variables like {'{{date}}'},{' '}
              {'{{time}}'}, or custom variables below.
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
            </div>
            <div className="settings__var-ref">
              <strong>Built-in (always available):</strong>
              <ul>
                <li>
                  <code>{'{{date}}'}</code> Full date ·{' '}
                  <code>{'{{time}}'}</code> Current time ·{' '}
                  <code>{'{{datetime}}'}</code> Combined
                </li>
                <li>
                  <code>{'{{iso_date}}'}</code> ISO · <code>{'{{year}}'}</code>{' '}
                  <code>{'{{month}}'}</code> <code>{'{{day}}'}</code>{' '}
                  <code>{'{{weekday}}'}</code>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </details>
    </SettingsSection>
  );
}
