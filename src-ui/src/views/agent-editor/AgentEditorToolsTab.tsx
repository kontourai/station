import type { AgentEngineValidationFinding } from '@kontourai/station-contracts/agent-validation';
import { useReconnectIntegrationMutation } from '@kontourai/station-sdk';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ArrowDownGlyph } from '../../components/icons/Glyph';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import { Toggle } from '../../components/Toggle';
import type { Tool } from '../../types';
import { AgentEditorWorkflows } from './AgentEditorWorkflows';
import type { AgentEditorFormProps } from './types';
import {
  addIntegration,
  canonicalAgentToolPatterns,
  getIntegrationToolKey,
  removeIntegration,
  selectIntegrationTools,
  toggleIntegrationAutoApprove,
  toggleIntegrationToolAutoApprove,
  toggleIntegrationToolEnabled,
} from './utils';

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
  const [search, setSearch] = useState('');
  const [groups, setGroups] = useState<Record<string, string>>({});
  const [showApprovals, setShowApprovals] = useState(false);
  const checkTools = useReconnectIntegrationMutation();
  const disabled = locked || !!finding;
  const selected: Tool[] = form.tools.mcpServers.map(
    (id) =>
      availableTools.find((tool) => tool.id === id) ?? {
        id,
        name: id,
        displayName: id,
      },
  );
  const station = availableTools.find((tool) => tool.id === 'station-control');
  const supportsSelection = ['station', 'claude', 'codex'].includes(engineId);
  const query = search.trim().toLowerCase();

  const catalogFor = (integration: Tool): Tool[] =>
    integration.tools?.length
      ? integration.tools.map((tool) => ({
          id: `${integration.id}_${tool.toolName || tool.name}`,
          name: tool.toolName || tool.name,
          toolName: tool.toolName || tool.name,
          description: tool.description,
          group: tool.group,
          title: tool.title,
          enabled: !tool.disabled,
        }))
      : (integrationTools[integration.id] ?? []);
  const catalogs = Object.fromEntries(
    selected.map((integration) => [integration.id, catalogFor(integration)]),
  );
  const patterns = canonicalAgentToolPatterns(form, catalogs);
  const toolEnabled = (id: string, key: string) =>
    patterns.includes('*') ||
    patterns.includes(`${id}_*`) ||
    patterns.includes(key);

  return (
    <div className="agent-editor__section">
      {finding && (
        <div className="agent-editor__capability-banner" role="status">
          {finding.message}
        </div>
      )}
      <div className="editor-field">
        <div className="editor-label-row">
          <span className="editor-label">Tools</span>
          <div className="agent-tools__actions">
            {station && !form.tools.mcpServers.includes(station.id) && (
              <Button
                variant="secondary"
                disabled={disabled || station.enabled === false}
                onClick={() => {
                  const readOnly = station.tools
                    ?.filter((tool) => tool.readOnly && !tool.disabled)
                    .map(
                      (tool) => `station-control_${tool.toolName || tool.name}`,
                    );
                  setForm((current) =>
                    supportsSelection && readOnly?.length
                      ? selectIntegrationTools(current, station.id, readOnly)
                      : addIntegration(current, station.id),
                  );
                  setExpandedIntegrations((current) => ({
                    ...current,
                    [station.id]: true,
                  }));
                }}
              >
                Add Station tools
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => onOpenAddModal('integrations')}
            >
              Add tools
            </Button>
          </div>
        </div>
        <span className="editor-hint">Applies to new chats.</span>
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
        {selected.length === 0 ? (
          <span className="editor-hint">Choose tools.</span>
        ) : (
          <>
            <input
              className="editor-input"
              aria-label="Search added tools"
              placeholder="Search tools…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="editor__tools-grouped">
              {selected.map((integration) => {
                const tools = catalogFor(integration);
                const groupNames = tools.some((tool) => tool.group)
                  ? [
                      ...new Set(tools.map((tool) => tool.group || 'Other')),
                    ].sort()
                  : [];
                const selectedGroup = groups[integration.id] || '';
                const group = groupNames.includes(selectedGroup)
                  ? selectedGroup
                  : '';
                const scoped = group
                  ? tools.filter((tool) => (tool.group || 'Other') === group)
                  : tools;
                const choose = (current: typeof form, keys: string[]) => {
                  const currentPatterns = canonicalAgentToolPatterns(
                    current,
                    catalogs,
                  );
                  const retained = group
                    ? tools
                        .filter(
                          (tool) =>
                            (tool.group || 'Other') !== group &&
                            (currentPatterns.includes('*') ||
                              currentPatterns.includes(`${integration.id}_*`) ||
                              currentPatterns.includes(
                                getIntegrationToolKey(integration.id, tool),
                              )),
                        )
                        .map((tool) =>
                          getIntegrationToolKey(integration.id, tool),
                        )
                    : [];
                  const known = new Set(
                    tools.map((tool) =>
                      getIntegrationToolKey(integration.id, tool),
                    ),
                  );
                  const undiscovered = group
                    ? currentPatterns.filter(
                        (key) =>
                          key.startsWith(`${integration.id}_`) &&
                          !key.includes('*') &&
                          !known.has(key),
                      )
                    : [];
                  return selectIntegrationTools(
                    current,
                    integration.id,
                    [...retained, ...undiscovered, ...keys],
                    catalogs,
                  );
                };
                const visible = scoped.filter(
                  (tool) =>
                    !query ||
                    `${tool.toolName || tool.name} ${(tool.toolName || tool.name).replaceAll('_', ' ')} ${tool.description || ''} ${tool.title || ''} ${tool.group || ''}`
                      .toLowerCase()
                      .includes(query),
                );
                if (
                  query &&
                  visible.length === 0 &&
                  !(integration.displayName || integration.id)
                    .toLowerCase()
                    .includes(query)
                )
                  return null;
                const expanded =
                  !!query || expandedIntegrations[integration.id];
                const enabledCount = tools.filter(
                  (tool) =>
                    tool.enabled !== false &&
                    toolEnabled(
                      integration.id,
                      getIntegrationToolKey(integration.id, tool),
                    ),
                ).length;
                const readOnly = integration.tools?.filter(
                  (tool) =>
                    tool.readOnly === true &&
                    !tool.disabled &&
                    (!group || (tool.group || 'Other') === group),
                );
                const prefix = `${integration.id}_`;
                const allScopeKeys = scoped
                  .filter((tool) => tool.enabled !== false)
                  .map((tool) => getIntegrationToolKey(integration.id, tool));
                const readOnlyKeys =
                  readOnly?.map(
                    (tool) => `${prefix}${tool.toolName || tool.name}`,
                  ) ?? [];
                const selectedScopeKeys = allScopeKeys.filter((key) =>
                  toolEnabled(integration.id, key),
                );

                return (
                  <div className="editor__tools-server" key={integration.id}>
                    <div className="agent-tools__server-row">
                      <Button
                        variant="ghost"
                        className="agent-tools__server-toggle"
                        aria-expanded={!!expanded}
                        onClick={() =>
                          setExpandedIntegrations((current) => ({
                            ...current,
                            [integration.id]: !expanded,
                          }))
                        }
                      >
                        <IntegrationGlyph
                          id={integration.id}
                          displayName={integration.displayName}
                          icon={integration.icon}
                          iconUrl={integration.iconUrl}
                          size={20}
                        />
                        <span>{integration.displayName || integration.id}</span>
                        <span className="editor-hint">
                          {tools.length
                            ? `${enabledCount}/${tools.length}`
                            : 'All tools'}
                        </span>
                        <span
                          aria-hidden="true"
                          className={`agent-editor__chevron${expanded ? ' agent-editor__chevron--open' : ''}`}
                        >
                          <ArrowDownGlyph />
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        aria-label={`Remove ${integration.displayName || integration.id}`}
                        onClick={() =>
                          setForm((current) =>
                            removeIntegration(current, integration.id),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                    {expanded && (
                      <div className="agent-tools__detail">
                        {groupNames.length > 0 && (
                          <select
                            className="editor-select agent-tools__group"
                            aria-label={`Tool group for ${integration.displayName || integration.id}`}
                            value={group}
                            onChange={(event) =>
                              setGroups((current) => ({
                                ...current,
                                [integration.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">All tools</option>
                            {groupNames.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        )}
                        {supportsSelection && tools.length > 0 && (
                          <div className="agent-tools__actions">
                            {readOnly?.length ? (
                              <Button
                                variant="secondary"
                                aria-pressed={
                                  readOnlyKeys.length > 0 &&
                                  allScopeKeys.every(
                                    (key) =>
                                      toolEnabled(integration.id, key) ===
                                      readOnlyKeys.includes(key),
                                  )
                                }
                                disabled={disabled}
                                onClick={() =>
                                  setForm((current) =>
                                    choose(
                                      current,
                                      readOnly.map(
                                        (tool) =>
                                          `${prefix}${tool.toolName || tool.name}`,
                                      ),
                                    ),
                                  )
                                }
                              >
                                Read only
                              </Button>
                            ) : null}
                            <Button
                              variant="secondary"
                              aria-pressed={
                                allScopeKeys.length > 0 &&
                                selectedScopeKeys.length === allScopeKeys.length
                              }
                              disabled={disabled}
                              onClick={() =>
                                setForm((current) =>
                                  choose(
                                    current,
                                    scoped
                                      .filter((tool) => tool.enabled !== false)
                                      .map((tool) =>
                                        getIntegrationToolKey(
                                          integration.id,
                                          tool,
                                        ),
                                      ),
                                  ),
                                )
                              }
                            >
                              All
                            </Button>
                            <Button
                              variant="ghost"
                              aria-pressed={selectedScopeKeys.length === 0}
                              disabled={disabled}
                              onClick={() =>
                                setForm((current) => choose(current, []))
                              }
                            >
                              None
                            </Button>
                            <Button
                              variant="ghost"
                              aria-pressed={showApprovals}
                              onClick={() =>
                                setShowApprovals((current) => !current)
                              }
                            >
                              Approvals
                            </Button>
                          </div>
                        )}
                        {!supportsSelection && (
                          <span className="editor-hint">
                            This harness selects its own tools.
                          </span>
                        )}
                        {showApprovals && (
                          <div className="agent-tools__setting">
                            <span>Auto-approve all</span>
                            <Toggle
                              label={`Auto-approve ${integration.displayName || integration.id}`}
                              checked={form.tools.autoApprove.includes(
                                `${prefix}*`,
                              )}
                              disabled={disabled}
                              onChange={() =>
                                setForm((current) =>
                                  toggleIntegrationAutoApprove(
                                    current,
                                    integration.id,
                                  ),
                                )
                              }
                            />
                          </div>
                        )}
                        {tools.length === 0 && (
                          <div className="agent-tools__actions">
                            <Button
                              variant="secondary"
                              disabled={
                                disabled || integration.enabled === false
                              }
                              pending={
                                checkTools.isPending &&
                                checkTools.variables === integration.id
                              }
                              pendingLabel="Check tools"
                              onClick={() => checkTools.mutate(integration.id)}
                            >
                              Check tools
                            </Button>
                            {checkTools.isError &&
                              checkTools.variables === integration.id && (
                                <span className="editor-hint" role="status">
                                  Could not check tools. Open Manage
                                  integrations.
                                </span>
                              )}
                          </div>
                        )}
                        <div className="agent-tools__checklist">
                          {visible.map((tool) => {
                            const key = getIntegrationToolKey(
                              integration.id,
                              tool,
                            );
                            const enabled =
                              tool.enabled !== false &&
                              toolEnabled(integration.id, key);
                            return (
                              <div className="agent-tools__tool-row" key={key}>
                                <Checkbox
                                  checked={enabled}
                                  disabled={
                                    disabled ||
                                    !supportsSelection ||
                                    tool.enabled === false
                                  }
                                  onChange={() =>
                                    setForm((current) =>
                                      toggleIntegrationToolEnabled(
                                        current,
                                        integration.id,
                                        key,
                                        tools,
                                        catalogs,
                                      ),
                                    )
                                  }
                                >
                                  <span title={tool.description}>
                                    {(tool.title || tool.toolName || tool.name)
                                      .replaceAll('_', ' ')
                                      .replace(/^./, (letter) =>
                                        letter.toUpperCase(),
                                      )}
                                  </span>
                                </Checkbox>
                                {showApprovals && (
                                  <Toggle
                                    label={`Auto-approve ${tool.toolName || tool.name}`}
                                    checked={
                                      enabled &&
                                      (form.tools.autoApprove.includes(
                                        `${prefix}*`,
                                      ) ||
                                        form.tools.autoApprove.includes(key))
                                    }
                                    disabled={disabled || !enabled}
                                    onChange={() =>
                                      setForm((current) =>
                                        toggleIntegrationToolAutoApprove(
                                          current,
                                          integration.id,
                                          key,
                                          tools,
                                        ),
                                      )
                                    }
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <div className="editor-field">
        <div className="editor-label-row">
          <span className="editor-label">Browser tools</span>
          <Toggle
            checked={form.tools.browser !== false}
            disabled={disabled}
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
          Drive the Project browser. Available to Claude agents.
        </span>
      </div>
      <AgentEditorWorkflows slug={form.slug} locked={locked} />
    </div>
  );
}
