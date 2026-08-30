import type { IntegrationViewModel } from '@kontourai/station-sdk';
import { DetailHeader } from '../../components/DetailHeader';
import { LockGlyph } from '../../components/icons/Glyph';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import { LazyBoundary } from '../../components/LazyBoundary';

const loadSecretBindingPicker = () =>
  import('./SecretBindingPicker').then((module) => ({
    default: module.SecretBindingPicker,
  }));

type Message = {
  type: 'success' | 'warning' | 'error';
  text: string;
} | null;

export function IntegrationEditorPanel({
  editForm,
  isNew,
  locked,
  message,
  viewMode,
  rawJson,
  rawError,
  secretBindingRequireSave = false,
  savePending,
  reconnectPending,
  lifecyclePending,
  toolsApplyPending,
  pendingDisabledTools,
  onToggleEnabled,
  onToggleTool,
  onApplyTools,
  renderAllowed = true,
  renderPermPending = false,
  onToggleRender,
  onReconnect,
  onDelete,
  onSave,
  onSwitchToForm,
  onSwitchToRaw,
  onRawJsonChange,
  onUpdate,
  onUnlock,
}: {
  editForm: IntegrationViewModel;
  isNew: boolean;
  locked: boolean;
  message: Message;
  viewMode: 'form' | 'raw';
  rawJson: string;
  rawError: string | null;
  /** The parent owns the saved integration baseline, so it owns this guard. */
  secretBindingRequireSave?: boolean;
  savePending: boolean;
  reconnectPending: boolean;
  lifecyclePending?: boolean;
  toolsApplyPending?: boolean;
  pendingDisabledTools?: string[];
  onToggleEnabled?: () => void;
  onToggleTool?: (name: string) => void;
  onApplyTools?: () => void;
  renderAllowed?: boolean;
  renderPermPending?: boolean;
  onToggleRender?: (allow: boolean) => void;
  onReconnect: () => void;
  onDelete: () => void;
  onSave: () => void;
  onSwitchToForm: () => void;
  onSwitchToRaw: () => void;
  onRawJsonChange: (value: string) => void;
  onUpdate: (
    updater: (form: IntegrationViewModel) => IntegrationViewModel,
  ) => void;
  onUnlock: () => void;
}) {
  const isBuiltin = editForm.kind === 'builtin';
  /**
   * CI-R7: server-derived (`GET /integrations`), not inferred from `kind` —
   * Station's own tool servers persist as `kind: 'mcp'`, so the `isBuiltin`
   * test above (which means "Strands vended tool") was false for them and
   * this panel offered a Delete the runtime silently undid on next start.
   */
  const isRuntimeManaged = editForm.builtin === true;
  /**
   * CI-R15: the live catalogue only carries names once an agent session has
   * opened a client, so fall back to the names the last probe recorded. Never
   * a count without a way to see what it counted.
   */
  const probedToolNames = editForm.probe?.toolNames ?? [];

  return (
    <div className="detail-panel integration-editor-panel">
      <DetailHeader
        title={editForm.displayName || editForm.id || 'New Tool Server'}
        icon={
          !isNew ? (
            <IntegrationGlyph
              id={editForm.id}
              displayName={editForm.displayName}
              icon={editForm.icon}
              iconUrl={editForm.iconUrl}
              size={32}
              className="editor-icon-preview"
            />
          ) : undefined
        }
        badge={
          isBuiltin || isRuntimeManaged
            ? { label: 'Built in', variant: 'muted' as const }
            : editForm.transport
              ? { label: editForm.transport, variant: 'muted' as const }
              : undefined
        }
        statusDot={
          !isNew
            ? editForm.enabled === false
              ? 'disconnected'
              : editForm.probe?.ok
                ? 'connected'
                : 'disconnected'
            : undefined
        }
      >
        {!isNew && (
          <button
            type="button"
            className="editor-btn"
            onClick={onReconnect}
            disabled={reconnectPending}
          >
            {reconnectPending ? 'Reconnecting…' : 'Reconnect'}
          </button>
        )}
        {!isNew && onToggleEnabled && (
          <button
            type="button"
            className="editor-btn"
            onClick={onToggleEnabled}
            disabled={lifecyclePending}
          >
            {editForm.enabled === false ? 'Enable' : 'Disable'}
          </button>
        )}
        {!isNew && !isRuntimeManaged && (
          <button
            type="button"
            className="editor-btn editor-btn--danger"
            onClick={onDelete}
          >
            Delete
          </button>
        )}
        <button
          type="button"
          className="editor-btn editor-btn--primary"
          onClick={onSave}
          disabled={savePending || !editForm.id || locked}
        >
          {savePending ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </button>
      </DetailHeader>

      <div
        className="agent-editor__section integration-health"
        role="status"
        aria-label="Tool server health"
      >
        <strong>
          {isNew
            ? 'Disabled until you explicitly enable it'
            : editForm.enabled === false
              ? 'Disabled'
              : editForm.probe?.ok
                ? 'Connected'
                : editForm.probe
                  ? 'Needs attention'
                  : 'Not checked yet'}
        </strong>
        {editForm.probe && (
          <span>
            {editForm.probe.toolCount}{' '}
            {editForm.probe.toolCount === 1 ? 'tool' : 'tools'} · observed{' '}
            {new Date(editForm.probe.checkedAt).toLocaleString()}
          </span>
        )}
        {editForm.probe && !editForm.probe.ok && editForm.probe.error && (
          <pre className="integration-health__error">
            {editForm.probe.error}
          </pre>
        )}
        {isRuntimeManaged && (
          <span>
            Built into Station and re-created every time it starts, so it cannot
            be removed. Disable it to stop delivering its tools.
          </span>
        )}
      </div>

      <div className="agent-editor__section">
        <div className="agent-editor__section-header">
          <h3 className="agent-editor__section-title">Editor Mode</h3>
          <p className="agent-editor__section-desc">
            {isBuiltin
              ? 'Built-in compatibility tools use a shared implementation across both runtimes.'
              : 'Switch between guided fields and raw mcp.json editing.'}
          </p>
        </div>
        {message && (
          <div className={`plugins__message plugins__message--${message.type}`}>
            {message.text}
          </div>
        )}
        {!isBuiltin && (
          <div className="integration__mode-tabs">
            <button
              type="button"
              className={`integration__mode-tab ${viewMode === 'form' ? 'integration__mode-tab--active' : ''}`}
              onClick={onSwitchToForm}
            >
              Form
            </button>
            <button
              type="button"
              className={`integration__mode-tab ${viewMode === 'raw' ? 'integration__mode-tab--active' : ''}`}
              onClick={onSwitchToRaw}
            >
              Raw JSON
            </button>
          </div>
        )}
      </div>
      {!isNew && !isRuntimeManaged && (
        <LazyBoundary
          load={loadSecretBindingPicker}
          componentProps={{
            integrationId: editForm.id,
            envNames: editForm.secretEnvKeys ?? Object.keys(editForm.env ?? {}),
            requireSave:
              secretBindingRequireSave ||
              (editForm.transport ??
                (editForm.command ? 'stdio' : undefined)) !== 'stdio',
          }}
          pending={null}
        />
      )}

      {!isBuiltin && viewMode === 'raw' ? (
        <div className="agent-editor__section">
          <div className="agent-editor__section-header">
            <h3 className="agent-editor__section-title">Raw Configuration</h3>
            <p className="agent-editor__section-desc">
              Paste a standard <code>mcp.json</code> config compatible with
              Claude Desktop, Cursor, Windsurf, and similar tools.
            </p>
          </div>
          <div className="integration__raw-section">
            <textarea
              className="integration__raw-editor"
              value={rawJson}
              onChange={(event) => onRawJsonChange(event.target.value)}
              placeholder={
                '{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "my-mcp-server"]\n    }\n  }\n}'
              }
              spellCheck={false}
              disabled={locked}
            />
            {rawError && (
              <div className="integration__raw-error">{rawError}</div>
            )}
          </div>
        </div>
      ) : (
        <>
          {editForm.plugin && locked && !isNew && (
            <div className="agent-editor__section">
              <div className="editor__lock-banner">
                <span>
                  <LockGlyph /> Managed by plugin &ldquo;{editForm.plugin}
                  &rdquo;. Edits will be overwritten on plugin updates.
                </span>
                <button
                  type="button"
                  className="editor__lock-btn"
                  onClick={onUnlock}
                >
                  Unlock
                </button>
              </div>
            </div>
          )}

          <div className="agent-editor__section">
            <div className="agent-editor__section-header">
              <h3 className="agent-editor__section-title">Basics</h3>
              <p className="agent-editor__section-desc">
                Configure the identity and display details for this tool server.
              </p>
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="int-id">
                ID
              </label>
              <input
                id="int-id"
                className="editor-input"
                value={editForm.id}
                onChange={(event) =>
                  onUpdate((form) => ({ ...form, id: event.target.value }))
                }
                placeholder="my-tool-server"
                disabled={!isNew || locked}
              />
              {!isNew && (
                <span className="editor-hint">
                  ID cannot be changed after creation
                </span>
              )}
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="int-name">
                Display Name
              </label>
              <input
                id="int-name"
                className="editor-input"
                value={editForm.displayName || ''}
                onChange={(event) =>
                  onUpdate((form) => ({
                    ...form,
                    displayName: event.target.value,
                  }))
                }
                placeholder="My Integration"
                disabled={locked}
              />
            </div>
            <div className="editor-field">
              <label className="editor-label" htmlFor="int-desc">
                Description
              </label>
              <input
                id="int-desc"
                className="editor-input"
                value={editForm.description || ''}
                onChange={(event) =>
                  onUpdate((form) => ({
                    ...form,
                    description: event.target.value,
                  }))
                }
                placeholder="What this tool server does"
                disabled={locked}
              />
            </div>
          </div>

          {!isNew && onToggleRender && (
            <div className="agent-editor__section">
              <div className="agent-editor__section-header">
                <h3 className="agent-editor__section-title">
                  Layout Rendering
                </h3>
                <p className="agent-editor__section-desc">
                  MCP-UI panels from this server render in Station layouts by
                  default, inside a hardened sandbox. Disable to revoke
                  rendering for this server.
                </p>
              </div>
              <label className="editor-toggle-field">
                <input
                  type="checkbox"
                  checked={renderAllowed}
                  disabled={renderPermPending}
                  onChange={(event) => onToggleRender(event.target.checked)}
                />
                <span>Allow this server to render UI in layouts</span>
              </label>
            </div>
          )}

          {!isNew &&
            !(editForm.tools && editForm.tools.length > 0) &&
            probedToolNames.length > 0 && (
              <div className="agent-editor__section">
                <div className="agent-editor__section-header">
                  <h3 className="agent-editor__section-title">Tools</h3>
                  <p className="agent-editor__section-desc">
                    Seen when this server was last probed. Per-tool controls
                    appear once a session has opened a connection to it.
                  </p>
                </div>
                <div className="integration-tools">
                  {probedToolNames.map((name) => (
                    <span className="integration-tool-name" key={name}>
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            )}

          {!isNew &&
            editForm.tools &&
            editForm.tools.length > 0 &&
            onToggleTool &&
            onApplyTools && (
              <div className="agent-editor__section">
                <div className="agent-editor__section-header">
                  <h3 className="agent-editor__section-title">
                    Delivered Tools
                  </h3>
                  <p className="agent-editor__section-desc">
                    Stage any number of changes, then apply them atomically.
                  </p>
                </div>
                <div className="integration-tools">
                  {editForm.tools.map((tool) => {
                    const pendingDisabled =
                      pendingDisabledTools?.includes(tool.name) ?? false;
                    const savedDisabled =
                      editForm.disabledTools?.includes(tool.name) ?? false;
                    return (
                      <button
                        type="button"
                        key={tool.name}
                        className={`integration-tool-toggle ${pendingDisabled !== savedDisabled ? 'integration-tool-toggle--pending' : ''}`}
                        onClick={() => onToggleTool(tool.name)}
                        aria-pressed={!pendingDisabled}
                      >
                        {tool.name}
                        <span>
                          {pendingDisabled ? 'Disabled' : 'Enabled'}
                          {pendingDisabled !== savedDisabled
                            ? ' · pending'
                            : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="editor-btn editor-btn--primary"
                  disabled={
                    toolsApplyPending ||
                    JSON.stringify(pendingDisabledTools ?? []) ===
                      JSON.stringify(editForm.disabledTools ?? [])
                  }
                  onClick={onApplyTools}
                >
                  Apply tool changes
                </button>
              </div>
            )}

          {isBuiltin ? (
            <div className="agent-editor__section">
              <div className="agent-editor__section-header">
                <h3 className="agent-editor__section-title">Implementation</h3>
                <p className="agent-editor__section-desc">
                  This integration is backed by Station&apos;s shared Strands
                  compatibility layer rather than an external MCP transport.
                </p>
              </div>
              <div className="editor-field">
                <label className="editor-label" htmlFor="int-tool-type">
                  Tool Type
                </label>
                <input
                  id="int-tool-type"
                  className="editor-input"
                  value="Built-in compatibility tool"
                  disabled
                />
              </div>
            </div>
          ) : (
            <>
              <div className="agent-editor__section">
                <div className="agent-editor__section-header">
                  <h3 className="agent-editor__section-title">Connection</h3>
                </div>
                <div className="editor-field">
                  <label className="editor-label" htmlFor="int-transport">
                    Type
                  </label>
                  <select
                    id="int-transport"
                    className="editor-select"
                    aria-label="Connection type"
                    value={editForm.transport || 'stdio'}
                    disabled={locked}
                    onChange={(event) =>
                      onUpdate((form) => ({
                        ...form,
                        transport: event.target
                          .value as IntegrationViewModel['transport'],
                      }))
                    }
                  >
                    <option value="stdio">Local command</option>
                    <option value="sse">SSE</option>
                    <option value="streamable-http">HTTP</option>
                  </select>
                </div>

                {(!editForm.transport || editForm.transport === 'stdio') && (
                  <>
                    <div className="editor-field">
                      <label className="editor-label" htmlFor="int-cmd">
                        Command
                      </label>
                      <input
                        id="int-cmd"
                        className="editor-input"
                        value={editForm.command || ''}
                        onChange={(event) =>
                          onUpdate((form) => ({
                            ...form,
                            command: event.target.value,
                          }))
                        }
                        placeholder="npx, uvx, node, etc."
                        disabled={locked}
                      />
                    </div>
                    <div className="editor-field">
                      <label className="editor-label" htmlFor="int-args">
                        Arguments
                      </label>
                      <input
                        id="int-args"
                        className="editor-input"
                        value={(editForm.args || []).join(' ')}
                        onChange={(event) =>
                          onUpdate((form) => ({
                            ...form,
                            args: event.target.value
                              .split(/\s+/)
                              .filter(Boolean),
                          }))
                        }
                        placeholder="Space-separated arguments"
                        disabled={locked}
                      />
                    </div>
                  </>
                )}

                {editForm.transport && editForm.transport !== 'stdio' && (
                  <div className="editor-field">
                    <label className="editor-label" htmlFor="int-endpoint">
                      Endpoint URL
                    </label>
                    <input
                      id="int-endpoint"
                      className="editor-input"
                      value={editForm.endpoint || ''}
                      onChange={(event) =>
                        onUpdate((form) => ({
                          ...form,
                          endpoint: event.target.value,
                        }))
                      }
                      placeholder="http://localhost:3001/mcp"
                      disabled={locked}
                    />
                  </div>
                )}
              </div>

              <div className="agent-editor__section">
                <div className="agent-editor__section-header">
                  <h3 className="agent-editor__section-title">
                    Environment Variables
                  </h3>
                  <p className="agent-editor__section-desc">
                    Define secrets and configuration passed to the server
                    process at startup.
                  </p>
                </div>
                {Object.entries({
                  ...Object.fromEntries(
                    (editForm.secretEnvKeys || []).map((key) => [key, '']),
                  ),
                  ...(editForm.env || {}),
                  ...(editForm.secretEnv || {}),
                }).map(([key, value], index) => (
                  <div key={index} className="editor-kv-row">
                    <input
                      className="editor-input editor-input--half"
                      value={key}
                      placeholder="KEY"
                      disabled={
                        locked || Boolean(editForm.secretEnvKeys?.includes(key))
                      }
                      onChange={(event) =>
                        onUpdate((form) => {
                          const { [key]: _oldSecret, ...secretEnv } =
                            form.secretEnv || {};
                          return {
                            ...form,
                            secretEnv: {
                              ...secretEnv,
                              [event.target.value]: value,
                            },
                          };
                        })
                      }
                    />
                    <input
                      className="editor-input editor-input--half"
                      type="password"
                      autoComplete="new-password"
                      value={value}
                      placeholder={
                        editForm.secretEnvKeys?.includes(key)
                          ? 'Set — enter to replace'
                          : 'Secret value'
                      }
                      aria-label={`${key || 'New variable'} secret value`}
                      disabled={locked}
                      onChange={(event) =>
                        onUpdate((form) => ({
                          ...form,
                          secretEnv: {
                            ...(form.secretEnv || {}),
                            [key]: event.target.value,
                          },
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="editor-btn--icon"
                      disabled={locked}
                      onClick={() =>
                        onUpdate((form) => {
                          const { [key]: _, ...rest } = form.secretEnv || {};
                          const { [key]: _env, ...env } = form.env || {};
                          return {
                            ...form,
                            env,
                            secretEnv: rest,
                            removeSecretEnvKeys: [
                              ...new Set([
                                ...(form.removeSecretEnvKeys || []),
                                ...(form.secretEnvKeys?.includes(key)
                                  ? [key]
                                  : []),
                              ]),
                            ],
                            secretEnvKeys: (form.secretEnvKeys || []).filter(
                              (name) => name !== key,
                            ),
                          };
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="editor-btn--ghost"
                  disabled={locked}
                  onClick={() =>
                    onUpdate((form) => ({
                      ...form,
                      secretEnv: { ...(form.secretEnv || {}), '': '' },
                    }))
                  }
                >
                  + Add Variable
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
