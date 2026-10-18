import type { AgentEngineValidationFinding } from '@kontourai/station-contracts/agent-validation';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { InfoTip } from '../../components/InfoTip';
import { PlusGlyph, SettingsGlyph } from '../../components/icons/Glyph';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { Toggle } from '../../components/Toggle';
import { AgentEditorWorkflows } from './AgentEditorWorkflows';
import { AgentToolPicker } from './AgentToolPicker';
import type { AgentEditorFormProps } from './types';
import { removeIntegration } from './utils';
export function AgentEditorToolsTab({
  form,
  setForm,
  locked,
  availableTools,
  integrationTools,
  onNavigate,
  finding,
  engineDefaultToolsHint,
  engineId = 'station',
}: Pick<
  AgentEditorFormProps,
  | 'form'
  | 'setForm'
  | 'locked'
  | 'availableTools'
  | 'integrationTools'
  | 'onNavigate'
  | 'onOpenAddModal'
> & {
  expandedIntegrations: Record<string, boolean>;
  setExpandedIntegrations: Dispatch<SetStateAction<Record<string, boolean>>>;
  finding?: AgentEngineValidationFinding;
  engineDefaultToolsHint?: number;
  engineId?: string;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [initialSourceId, setInitialSourceId] = useState<string>();
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [discardConnection, setDiscardConnection] = useState(false);
  const disabled = locked || !!finding;
  const closeBrowser = () => {
    if (connectionDirty) setDiscardConnection(true);
    else setBrowsing(false);
  };
  return (
    <div className="agent-editor__section">
      {finding && <p role="status">{finding.message}</p>}
      <div className="editor-field agent-tools__shell">
        <div className="agent-tools__heading">
          <span className="editor-label">Tools</span>
          <div className="agent-tools__actions">
            <Button
              disabled={disabled}
              onClick={() => {
                setInitialSourceId(undefined);
                setBrowsing(true);
              }}
            >
              <PlusGlyph />
              Add tools
            </Button>
            <details className="agent-tools__preferences">
              <summary aria-label="Tool settings" title="Tool settings">
                <SettingsGlyph />
              </summary>
              <div className="agent-tools__settings">
                {['claude', 'codex'].includes(engineId) && (
                  <>
                    <div className="agent-tools__setting">
                      <span>Keep harness tools</span>
                      <Toggle
                        label="Keep harness tools"
                        checked={
                          form.tools.mcpMode === 'add' ||
                          (form.tools.mcpMode === undefined &&
                            (engineId === 'codex' ||
                              form.toolsOriginal?.mcpServers === undefined))
                        }
                        disabled={disabled}
                        onChange={(keep) =>
                          setForm((current) => ({
                            ...current,
                            tools: {
                              ...current.tools,
                              mcpMode: keep ? 'add' : 'replace',
                            },
                          }))
                        }
                      />
                    </div>
                    {engineId === 'claude' && (
                      <label className="agent-tools__loading">
                        Discovery
                        <select
                          className="editor-select"
                          disabled={disabled}
                          value={form.tools.mcpLoading ?? ''}
                          onChange={(event) => {
                            const value = event.target.value;
                            setForm((current) => ({
                              ...current,
                              tools: {
                                ...current.tools,
                                mcpLoading:
                                  value === 'always' || value === 'on-demand'
                                    ? value
                                    : undefined,
                              },
                            }));
                          }}
                        >
                          <option value="">Harness default</option>
                          <option value="on-demand">On demand</option>
                          <option value="always">Always available</option>
                        </select>
                      </label>
                    )}
                  </>
                )}
                {!finding &&
                  !!engineDefaultToolsHint &&
                  form.tools.mcpServers.length === 0 && (
                    <span className="editor-hint">
                      {engineDefaultToolsHint} harness integration(s).
                    </span>
                  )}
                <Button
                  variant="ghost"
                  onClick={() => onNavigate({ type: 'connections-tools' })}
                >
                  Manage integrations
                </Button>
              </div>
            </details>
          </div>
        </div>
        {form.tools.mcpServers.map((id) => {
          const source = availableTools.find((tool) => tool.id === id);
          return (
            <div className="agent-tool-library__row" key={id}>
              <button
                type="button"
                className="agent-tool-library__source"
                disabled={disabled}
                onClick={() => {
                  setInitialSourceId(id);
                  setBrowsing(true);
                }}
              >
                <strong>{source?.displayName || source?.name || id}</strong>
                <small>
                  {source?.origin?.kind === 'station'
                    ? 'Station'
                    : source?.origin?.pluginName ||
                      source?.origin?.registryName ||
                      ''}
                </small>
              </button>
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={`Remove ${source?.displayName || source?.name || id}`}
                onClick={() =>
                  setForm((current) => removeIntegration(current, id))
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>
      {browsing && !disabled && (
        <Dialog
          title="Add tools"
          closeLabel="Close tools"
          onClose={closeBrowser}
          size="lg"
          footer={
            <Button variant="primary" onClick={closeBrowser}>
              Done
            </Button>
          }
        >
          <AgentToolPicker
            form={form}
            setForm={setForm}
            availableTools={availableTools}
            integrationTools={integrationTools}
            engineId={engineId}
            initialSourceId={initialSourceId}
            onConnectionDirtyChange={setConnectionDirty}
          />
        </Dialog>
      )}
      <ConfirmModal
        isOpen={discardConnection}
        title="Discard connection changes?"
        message="The agent draft will be kept."
        confirmLabel="Discard"
        onConfirm={() => {
          setDiscardConnection(false);
          setConnectionDirty(false);
          setBrowsing(false);
        }}
        onCancel={() => setDiscardConnection(false)}
      />
      <div className="editor-field">
        <div className="editor-label-row">
          <span className="editor-label">
            Browser access
            <InfoTip label="Browser access">
              Let this agent view and interact with the Project browser.
            </InfoTip>
          </span>
          {engineId === 'claude' && (
            <Toggle
              checked={form.tools.browser !== false}
              disabled={disabled}
              label="Browser access"
              onChange={(browser) =>
                setForm((current) => ({
                  ...current,
                  tools: { ...current.tools, browser },
                }))
              }
            />
          )}
        </div>
        <p className="editor-hint">
          {engineId === 'claude'
            ? 'Uses this Project’s Station browser.'
            : 'Station browser access is currently available with Claude Code.'}
        </p>
      </div>
      <details className="agent-tools__advanced">
        <summary>Workflow files</summary>
        <AgentEditorWorkflows slug={form.slug} locked={locked} />
      </details>
    </div>
  );
}
