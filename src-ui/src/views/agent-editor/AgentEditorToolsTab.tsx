import type { AgentEngineValidationFinding } from '@kontourai/station-contracts/agent-validation';
import type { Dispatch, SetStateAction } from 'react';
import { Checkbox } from '../../components/Checkbox';
import { CheckGlyph } from '../../components/icons/Glyph';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import { Toggle } from '../../components/Toggle';
import { AgentEditorWorkflows } from './AgentEditorWorkflows';
import type { AgentEditorFormProps } from './types';
import {
  getIntegrationToolKey,
  removeIntegration,
  toggleIntegrationAutoApprove,
  toggleIntegrationToolAutoApprove,
  toggleIntegrationToolEnabled,
} from './utils';

const READONLY_TRAILER =
  "This content is saved with the agent and stays portable, but this engine won't deliver it.";

export function AgentEditorToolsTab({
  form,
  setForm,
  locked,
  availableTools,
  integrationTools,
  expandedIntegrations,
  setExpandedIntegrations,
  onNavigate,
  onOpenAddModal,
  finding,
  engineDefaultToolsHint,
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
  /**
   * archive#975 D-1 §4.2 engine-default hint: the bound connection's own
   * `config.provideToolServers` count, shown only when the surface is
   * deliverable and the agent hasn't authored its own tool servers.
   */
  engineDefaultToolsHint?: number;
}) {
  const readOnly = !!finding;
  const effectiveLocked = locked || readOnly;
  const enabledServers = new Set(form.tools.mcpServers);
  const enabledIntegrations = availableTools.filter((tool) =>
    enabledServers.has(tool.id),
  );

  return (
    <div className="agent-editor__section">
      {finding && (
        <div className="agent-editor__capability-banner" role="status">
          {finding.message}. {READONLY_TRAILER}
        </div>
      )}
      <div className="editor-field">
        <div className="editor-label-row">
          <span className="editor-label">Integrations</span>
          <span className="editor-label-row__actions">
            <button
              type="button"
              className="editor-enrich-btn"
              onClick={() => onNavigate({ type: 'connections-tools' })}
            >
              Manage →
            </button>
            {!effectiveLocked && (
              <button
                type="button"
                className="editor-enrich-btn"
                onClick={() => onOpenAddModal('integrations')}
              >
                + Add
              </button>
            )}
          </span>
        </div>
        {!readOnly &&
          !!engineDefaultToolsHint &&
          form.tools.mcpServers.length === 0 && (
            <span className="editor-hint">
              {`This engine connection's default provides ${engineDefaultToolsHint} tool server(s) when the agent doesn't set its own.`}
            </span>
          )}
        {enabledIntegrations.length === 0 ? (
          <div className="editor__tools-empty">
            No integrations enabled.{' '}
            {!effectiveLocked && (
              <button
                type="button"
                className="editor__tools-link"
                onClick={() => onOpenAddModal('integrations')}
              >
                Add integrations
              </button>
            )}
          </div>
        ) : (
          <div className="editor__tools-grouped">
            {enabledIntegrations.map((integration) => {
              const isExpanded = expandedIntegrations[integration.id] || false;
              const tools = integrationTools[integration.id] || [];
              const prefix = `${integration.id}_`;
              const hasAutoApprove = form.tools.autoApprove.includes(
                `${prefix}*`,
              );
              const hasExplicitAvailable = form.tools.available.some((entry) =>
                entry.startsWith(prefix),
              );
              const allToolsActive =
                !hasExplicitAvailable ||
                form.tools.available.includes(`${prefix}*`);

              return (
                <div key={integration.id} className="editor__tools-server">
                  {/* biome-ignore lint/a11y/useSemanticElements: composite header contains independent checkbox and auto-approve buttons, so it cannot itself be a native button. */}
                  <div
                    className={`editor__tools-server-header${tools.length > 0 ? ' editor__tools-server-header--clickable' : ''}`}
                    onClick={() =>
                      tools.length > 0 &&
                      setExpandedIntegrations((current) => ({
                        ...current,
                        [integration.id]: !current[integration.id],
                      }))
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.currentTarget.click();
                      }
                    }}
                  >
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: event shield with no action of its own — it only keeps a checkbox click from toggling the header. */}
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: nothing to activate; the checkbox inside carries the action. */}
                    <span
                      onClick={(event) => event.stopPropagation()}
                      style={{ display: 'contents' }}
                    >
                      <Checkbox
                        checked={true}
                        onChange={() => {
                          if (effectiveLocked) {
                            return;
                          }
                          setForm((current) =>
                            removeIntegration(current, integration.id),
                          );
                        }}
                        disabled={effectiveLocked}
                      />
                    </span>
                    <span className="editor__tools-server-name">
                      <IntegrationGlyph
                        id={integration.id}
                        displayName={integration.displayName}
                        icon={integration.icon}
                        iconUrl={integration.iconUrl}
                        size={20}
                      />
                      {integration.displayName || integration.id}
                    </span>
                    <button
                      type="button"
                      className={`editor__tool-badge editor__tool-badge--btn${hasAutoApprove ? ' editor__tool-badge--auto' : ' editor__tool-badge--add'}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (effectiveLocked) {
                          return;
                        }
                        setForm((current) =>
                          toggleIntegrationAutoApprove(current, integration.id),
                        );
                      }}
                    >
                      {hasAutoApprove ? (
                        <>
                          <CheckGlyph /> auto-approve
                        </>
                      ) : (
                        '+ auto-approve'
                      )}
                    </button>
                    {tools.length > 0 && (
                      <span
                        className={`agent-editor__chevron${isExpanded ? ' agent-editor__chevron--open' : ''}`}
                      >
                        ›
                      </span>
                    )}
                  </div>
                  {isExpanded && tools.length > 0 && (
                    <div className="editor__tools-list">
                      {tools.map((tool) => {
                        const toolKey = getIntegrationToolKey(
                          integration.id,
                          tool,
                        );
                        const toolEnabled =
                          allToolsActive ||
                          form.tools.available.includes(toolKey);
                        const toolAutoApprove =
                          toolEnabled &&
                          (form.tools.autoApprove.includes(`${prefix}*`) ||
                            form.tools.autoApprove.includes(toolKey));

                        return (
                          <div
                            key={tool.id}
                            className={`editor__tool-item${toolEnabled ? ' editor__tool-item--active' : ''}`}
                          >
                            <Checkbox
                              checked={toolEnabled}
                              disabled={effectiveLocked}
                              onChange={() => {
                                if (effectiveLocked) {
                                  return;
                                }
                                setForm((current) =>
                                  toggleIntegrationToolEnabled(
                                    current,
                                    integration.id,
                                    toolKey,
                                    tools,
                                  ),
                                );
                              }}
                            />
                            <div className="editor__tool-info">
                              <div className="editor__tool-name">
                                {tool.toolName || tool.name}
                              </div>
                              {tool.description && (
                                <div className="editor__tool-desc">
                                  {tool.description}
                                </div>
                              )}
                            </div>
                            {toolEnabled ? (
                              <button
                                type="button"
                                className={`editor__tool-badge editor__tool-badge--btn${toolAutoApprove ? ' editor__tool-badge--auto' : ' editor__tool-badge--add'}`}
                                onClick={() => {
                                  if (effectiveLocked) {
                                    return;
                                  }
                                  setForm((current) =>
                                    toggleIntegrationToolAutoApprove(
                                      current,
                                      integration.id,
                                      toolKey,
                                      tools,
                                    ),
                                  );
                                }}
                              >
                                {toolAutoApprove ? (
                                  <>
                                    <CheckGlyph /> auto
                                  </>
                                ) : (
                                  '+ auto'
                                )}
                              </button>
                            ) : (
                              <span className="editor__tool-badge editor__tool-badge--disabled">
                                auto
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="editor-field">
        <div className="editor-label-row">
          <span className="editor-label" id="agent-browser-tools-label">
            Browser tools
          </span>
          <Toggle
            checked={form.tools.browser !== false}
            disabled={effectiveLocked}
            describedBy="agent-browser-tools-hint"
            label="Browser tools"
            onChange={(browser) =>
              setForm((current) => ({
                ...current,
                tools: { ...current.tools, browser },
              }))
            }
          />
        </div>
        <span className="editor-hint" id="agent-browser-tools-hint">
          Lets this agent open and drive its Project's Browser pane, the same
          browser you can watch and take over. Delivered to Claude agents;
          browser actions ask for approval like other sensitive tools.
        </span>
      </div>
      {/*
        station#2693: workflow files were CLI-only between the #2677
        dead-surface sweep (nothing navigated to the old view) and the #1563
        editor redesign it waited for. The section below is the UI for the
        live `/agents/:slug/workflows/*` routes; see AgentEditorWorkflows.
      */}
      <AgentEditorWorkflows slug={form.slug} locked={locked} />
    </div>
  );
}
