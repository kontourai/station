import {
  useIntegrationsQuery,
  useInvalidateQuery,
  useReconnectIntegrationMutation,
} from '@kontourai/station-sdk';
import { originalMcpToolName } from '@kontourai/station-shared/mcp-tool-selection';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ArrowDownGlyph } from '../../components/icons/Glyph';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import type { Tool } from '../../types';
import { AgentToolApproval } from './AgentToolApproval';
import { AgentToolDetails } from './AgentToolDetails';
import { AgentToolConnection, AgentToolDiscovery } from './AgentToolDiscovery';
import type { AgentEditorFormProps } from './types';
import {
  applyNewToolApprovalDefaults,
  canonicalAgentToolPatterns,
  getIntegrationToolKey,
  removeIntegration,
  selectIntegrationTools,
  toggleIntegrationToolEnabled,
} from './utils';
import './AgentToolPicker.css';

export function AgentToolPicker({
  form,
  setForm,
  availableTools,
  integrationTools,
  engineId,
  onConnectionDirtyChange,
}: Pick<
  AgentEditorFormProps,
  'form' | 'setForm' | 'availableTools' | 'integrationTools'
> & { engineId: string; onConnectionDirtyChange?: (dirty: boolean) => void }) {
  const [search, setSearch] = useState('');
  const [section, setSection] = useState<'installed' | 'discover'>('installed');
  const [setup, setSetup] = useState<string | null>(null);
  const invalidate = useInvalidateQuery();
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [discoveries, setDiscoveries] = useState<
    Record<string, { listing: string; probe: Tool['probe'] }>
  >({});
  const sourcesWithDiscovery = availableTools.map((integration): Tool => {
    const discovery = discoveries[integration.id];
    if (!discovery || discovery.listing !== JSON.stringify(integration))
      return integration;
    const probe = discovery.probe;
    return {
      ...integration,
      probe,
      ...(probe?.ok
        ? {
            tools: (
              probe.tools ??
              probe.toolNames?.map((name) => ({
                name: originalMcpToolName(integration.id, name),
              })) ??
              []
            ).map((tool) => ({
              ...integration.tools?.find(
                (current) => (current.toolName || current.name) === tool.name,
              ),
              ...tool,
              disabled: integration.tools?.find(
                (current) => (current.toolName || current.name) === tool.name,
              )?.disabled,
            })),
          }
        : {}),
    };
  });
  const refresh = useReconnectIntegrationMutation();
  const catalogQuery = useIntegrationsQuery({ enabled: false });
  const supportsSelection = ['station', 'claude', 'codex'].includes(engineId);
  const catalogs = Object.fromEntries(
    sourcesWithDiscovery.map((integration) => [
      integration.id,
      integration.tools !== undefined
        ? integration.tools.map((tool) => ({
            id: getIntegrationToolKey(integration.id, tool),
            name: tool.toolName || tool.name,
            toolName: tool.toolName || tool.name,
            title: tool.title,
            description: tool.description,
            group: tool.group,
            readOnly: tool.readOnly,
            classificationSource: tool.classificationSource,
            enabled: !tool.disabled,
          }))
        : (integrationTools[integration.id] ?? []),
    ]),
  );
  const patterns = canonicalAgentToolPatterns(form, catalogs);
  const attached = (id: string) => form.tools.mcpServers.includes(id);
  const selected = (id: string, tool: Tool, current = form) => {
    const currentPatterns =
      current === form
        ? patterns
        : canonicalAgentToolPatterns(current, catalogs);
    return (
      current.tools.mcpServers.includes(id) &&
      (currentPatterns.includes('*') ||
        currentPatterns.includes(`${id}_*`) ||
        currentPatterns.includes(getIntegrationToolKey(id, tool)))
    );
  };
  const title = (tool: Tool) =>
    (tool.title || tool.toolName || tool.name)
      .replaceAll('_', ' ')
      .replace(/^./, (letter) => letter.toUpperCase());
  const query = search.trim().toLowerCase();
  const categories = [
    ...new Set(
      Object.values(catalogs).flatMap((tools) =>
        tools.map((tool) => tool.group || 'Other'),
      ),
    ),
  ].sort();
  const sources = sourcesWithDiscovery.filter(
    (integration) =>
      !source ||
      (source === 'station'
        ? ['station-control', 'station-knowledge', 'station-docs'].includes(
            integration.id,
          )
        : integration.id === source),
  );
  const visibleSources = sources.flatMap((integration) => {
    const sourceMatches =
      `${integration.displayName || integration.name || integration.id} ${integration.description || ''}`
        .toLowerCase()
        .includes(query);
    const tools = catalogs[integration.id].filter(
      (tool) =>
        (!category || (tool.group || 'Other') === category) &&
        (!query ||
          sourceMatches ||
          `${title(tool)} ${tool.name} ${tool.description || ''} ${tool.group || ''}`
            .toLowerCase()
            .includes(query)),
    );
    return tools.length || (!category && (!query || sourceMatches))
      ? [{ integration, tools }]
      : [];
  });

  const updateSelection = (
    current: typeof form,
    id: string,
    next: typeof form,
  ) => applyNewToolApprovalDefaults(next, current, id, catalogs[id], engineId);
  if (setup)
    return (
      <AgentToolConnection
        id={setup}
        onBack={() => {
          setSetup(null);
          onConnectionDirtyChange?.(false);
        }}
        onDirtyChange={onConnectionDirtyChange ?? (() => {})}
      />
    );
  return (
    <div className="agent-tool-picker">
      <fieldset
        className="agent-tool-picker__navigation"
        aria-label="Tool library"
      >
        <Button
          variant="secondary"
          aria-pressed={section === 'installed'}
          onClick={() => setSection('installed')}
        >
          Installed tools
        </Button>
        <Button
          variant="secondary"
          aria-pressed={section === 'discover'}
          onClick={() => setSection('discover')}
        >
          Find more
        </Button>
        <Button variant="ghost" onClick={() => setSetup('new')}>
          Connect server
        </Button>
      </fieldset>
      {section === 'discover' ? (
        <AgentToolDiscovery
          onInstalled={() => {
            void invalidate(['integrations']);
          }}
        />
      ) : (
        <>
          {catalogQuery.isError && (
            <div role="alert" className="editor-hint">
              Could not load the latest tools.{' '}
              <Button
                variant="secondary"
                onClick={() => void catalogQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {catalogQuery.isFetching && (
            <p className="editor-hint" role="status">
              Updating tools…
            </p>
          )}
          <input
            type="search"
            className="editor-input"
            aria-label="Search tools"
            placeholder="Search tools by name or what they do"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setExpanded({});
            }}
          />
          <div className="agent-tool-picker__filters">
            <select
              className="editor-select"
              aria-label="Tool source"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setExpanded({});
              }}
            >
              <option value="">All sources</option>
              <option value="station">Station tools</option>
              {availableTools
                .filter(
                  (integration) =>
                    ![
                      'station-control',
                      'station-knowledge',
                      'station-docs',
                    ].includes(integration.id),
                )
                .map((integration) => (
                  <option key={integration.id} value={integration.id}>
                    {integration.displayName ||
                      integration.name ||
                      integration.id}
                  </option>
                ))}
            </select>
            <select
              className="editor-select"
              aria-label="Tool category"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setExpanded({});
              }}
            >
              <option value="">All categories</option>
              {categories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          {!supportsSelection && (
            <p className="editor-hint" role="status">
              This engine accepts whole tool sources. Individual tool selection
              is unavailable.
            </p>
          )}
          {!['station', 'claude'].includes(engineId) &&
            !!form.tools.askBeforeUse?.length && (
              <p role="alert" className="editor-hint">
                This engine cannot enforce saved Ask me rules. Choose a
                supported engine or clear those rules before starting.
              </p>
            )}
          {visibleSources.length === 0 ? (
            <p className="editor-hint" role="status">
              {availableTools.length
                ? 'No matching tools.'
                : 'No sources yet. Find more or connect a server.'}
            </p>
          ) : (
            visibleSources.map(({ integration, tools }) => {
              const id = integration.id;
              const allTools = catalogs[id];
              const disabled = integration.enabled === false;
              const added = attached(id);
              const selectedCount = allTools.filter((tool) =>
                selected(id, tool),
              ).length;
              const following =
                added &&
                (patterns.includes('*') || patterns.includes(`${id}_*`));
              const missingSelections = patterns.filter(
                (key) =>
                  key.startsWith(`${id}_`) &&
                  !key.includes('*') &&
                  !allTools.some(
                    (tool) => getIntegrationToolKey(id, tool) === key,
                  ),
              );
              const label = integration.displayName || integration.name || id;
              const open = expanded[id] ?? (!!query || !!category || !!source);
              return (
                <section
                  className="agent-tool-picker__source"
                  key={id}
                  aria-label={label}
                >
                  <div className="agent-tool-picker__source-heading">
                    <IntegrationGlyph
                      id={id}
                      displayName={label}
                      icon={integration.icon}
                      iconUrl={integration.iconUrl}
                      size={20}
                    />
                    <Button
                      variant="ghost"
                      aria-expanded={!!open}
                      onClick={() =>
                        setExpanded((current) => ({ ...current, [id]: !open }))
                      }
                    >
                      {label}
                      <span
                        className={`agent-tools__chevron${open ? ' is-open' : ''}`}
                      >
                        <ArrowDownGlyph />
                      </span>
                    </Button>
                    <span className="editor-hint">
                      {added
                        ? allTools.length
                          ? `${selectedCount} selected`
                          : 'Source added'
                        : 'Not added'}
                    </span>
                  </div>
                  <AgentToolDetails
                    integration={integration}
                    projectSlug={form.project || undefined}
                  />
                  {added && missingSelections.length > 0 && (
                    <p className="editor-hint">
                      {missingSelections.length} saved selection(s) are not in
                      this catalog. Refresh tools to check them.
                    </p>
                  )}
                  {disabled && (
                    <p className="editor-hint" role="status">
                      Disabled. Connect and enable to use these tools.
                    </p>
                  )}
                  {integration.probe?.ok === false && (
                    <p className="editor-hint" role="alert">
                      Could not discover tools.{' '}
                      {integration.probe.error ||
                        'Check this source in Connections, then refresh.'}
                    </p>
                  )}
                  {integration.probe &&
                    integration.probe.toolCount > allTools.length && (
                      <p className="editor-hint">
                        Showing {allTools.length} of{' '}
                        {integration.probe.toolCount} discovered tools.
                      </p>
                    )}
                  {open && (
                    <>
                      <div className="agent-tool-picker__actions">
                        <Button variant="ghost" onClick={() => setSetup(id)}>
                          {disabled ? 'Set up' : 'Connection'}
                        </Button>
                        {supportsSelection && tools.length > 0 ? (
                          <Button
                            variant="secondary"
                            disabled={disabled}
                            onClick={() =>
                              setForm((current) => {
                                const retained = allTools
                                  .filter(
                                    (tool) =>
                                      !tools.includes(tool) &&
                                      selected(id, tool, current),
                                  )
                                  .map((tool) =>
                                    getIntegrationToolKey(id, tool),
                                  );
                                const unknown = canonicalAgentToolPatterns(
                                  current,
                                  catalogs,
                                ).filter(
                                  (key) =>
                                    key.startsWith(`${id}_`) &&
                                    !key.includes('*') &&
                                    !allTools.some(
                                      (tool) =>
                                        getIntegrationToolKey(id, tool) === key,
                                    ),
                                );
                                return updateSelection(
                                  current,
                                  id,
                                  selectIntegrationTools(
                                    current,
                                    id,
                                    [
                                      ...new Set([
                                        ...retained,
                                        ...unknown,
                                        ...tools
                                          .filter(
                                            (tool) => tool.enabled !== false,
                                          )
                                          .map((tool) =>
                                            getIntegrationToolKey(id, tool),
                                          ),
                                      ]),
                                    ],
                                    catalogs,
                                  ),
                                );
                              })
                            }
                          >
                            Select shown
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            disabled={disabled || added}
                            onClick={() =>
                              setForm((current) =>
                                updateSelection(
                                  current,
                                  id,
                                  selectIntegrationTools(
                                    current,
                                    id,
                                    'all',
                                    catalogs,
                                  ),
                                ),
                              )
                            }
                          >
                            {added ? 'Added' : 'Add source'}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          disabled={disabled || refresh.isPending}
                          pending={
                            refresh.isPending && refresh.variables === id
                          }
                          pendingLabel="Refreshing…"
                          onClick={() =>
                            refresh.mutate(id, {
                              onSuccess: (result) =>
                                setDiscoveries((current) => ({
                                  ...current,
                                  [id]: {
                                    listing: JSON.stringify(
                                      availableTools.find(
                                        (entry) => entry.id === id,
                                      ),
                                    ),
                                    probe: result.probe,
                                  },
                                })),
                            })
                          }
                        >
                          Refresh tools
                        </Button>
                        {added && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setForm((current) =>
                                removeIntegration(current, id),
                              )
                            }
                          >
                            Remove source
                          </Button>
                        )}
                      </div>
                      {refresh.isError && refresh.variables === id && (
                        <p className="editor-hint" role="alert">
                          Could not refresh tools. Check this integration in
                          Connections.
                        </p>
                      )}
                      {allTools.length === 0 && (
                        <p className="editor-hint">
                          Tool names have not been discovered. Refresh to list
                          them, or add the whole source, including future tools.
                        </p>
                      )}
                      {supportsSelection && added && allTools.length > 0 && (
                        <Checkbox
                          checked={following}
                          disabled={disabled}
                          onChange={(include) =>
                            setForm((current) =>
                              updateSelection(
                                current,
                                id,
                                selectIntegrationTools(
                                  current,
                                  id,
                                  include
                                    ? 'all'
                                    : allTools
                                        .filter(
                                          (tool) => tool.enabled !== false,
                                        )
                                        .map((tool) =>
                                          getIntegrationToolKey(id, tool),
                                        ),
                                  catalogs,
                                ),
                              ),
                            )
                          }
                        >
                          Include all current and future tools
                        </Checkbox>
                      )}
                      {tools.map((tool) => {
                        const key = getIntegrationToolKey(id, tool);
                        return (
                          <div className="agent-tool-picker__tool" key={key}>
                            <div className="agent-tool-picker__tool-heading">
                              <Checkbox
                                checked={
                                  selected(id, tool) && tool.enabled !== false
                                }
                                disabled={
                                  disabled ||
                                  tool.enabled === false ||
                                  !supportsSelection
                                }
                                onChange={() =>
                                  setForm((current) =>
                                    updateSelection(
                                      current,
                                      id,
                                      toggleIntegrationToolEnabled(
                                        current,
                                        id,
                                        key,
                                        allTools,
                                        catalogs,
                                      ),
                                    ),
                                  )
                                }
                              >
                                {title(tool)}
                              </Checkbox>
                              <span
                                className="agent-tool-picker__category"
                                title={
                                  tool.classificationSource === 'station'
                                    ? 'Classified by Station'
                                    : 'Reported by the source; not independently verified'
                                }
                              >
                                {tool.readOnly === true
                                  ? 'Read'
                                  : tool.readOnly === false
                                    ? 'Changes'
                                    : 'Unknown'}
                              </span>
                              {selected(id, tool) && (
                                <AgentToolApproval
                                  form={form}
                                  setForm={setForm}
                                  integrationId={id}
                                  tool={tool}
                                  tools={allTools}
                                  engineId={engineId}
                                  disabled={disabled || tool.enabled === false}
                                />
                              )}
                              <details className="agent-tool-picker__details">
                                <summary>Details</summary>
                                <p>
                                  {tool.description ||
                                    'No description supplied.'}
                                </p>
                                <code>{tool.toolName || tool.name}</code>
                                <p>
                                  {tool.group || 'Other'}
                                  {tool.enabled === false ? ' · Disabled' : ''}
                                </p>
                              </details>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </section>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
