import {
  useIntegrationsQuery,
  useReconnectIntegrationMutation,
} from '@kontourai/station-sdk';
import { originalMcpToolName } from '@kontourai/station-shared/mcp-tool-selection';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ArrowDownGlyph } from '../../components/icons/Glyph';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import type { Tool } from '../../types';
import type { AgentEditorFormProps } from './types';
import {
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
}: Pick<
  AgentEditorFormProps,
  'form' | 'setForm' | 'availableTools' | 'integrationTools'
> & { engineId: string }) {
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const discoveriesKey = ['integration-tool-discoveries'];
  const { data: discoveries = {} } = useQuery<
    Record<string, { source?: string; probe: Tool['probe'] }>
  >({ queryKey: discoveriesKey, queryFn: skipToken });
  const sourcesWithDiscovery = availableTools.map((integration): Tool => {
    const discovery = discoveries[integration.id];
    if (!discovery || discovery.source !== integration.source)
      return integration;
    const probe = discovery.probe;
    if (
      integration.probe &&
      probe &&
      integration.probe.checkedAt > probe.checkedAt
    )
      return integration;
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

  return (
    <div className="agent-tool-picker">
      <p className="editor-hint">
        Choose what this agent can do. Save the agent to use these tools in new
        chats.
      </p>
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
                {integration.displayName || integration.name || integration.id}
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
          This engine accepts whole tool sources. Individual tool selection is
          unavailable.
        </p>
      )}
      {visibleSources.length === 0 ? (
        <p className="editor-hint" role="status">
          {availableTools.length
            ? 'No tools match. Try another search or category.'
            : 'No tool sources installed. Add an integration in Connections to make its tools available here.'}
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
            added && (patterns.includes('*') || patterns.includes(`${id}_*`));
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
              {integration.description && (
                <p className="editor-hint">{integration.description}</p>
              )}
              {disabled && (
                <p className="editor-hint" role="status">
                  Disabled in Connections. Enable this source there to use its
                  tools.
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
                    Showing {allTools.length} of {integration.probe.toolCount}{' '}
                    discovered tools.
                  </p>
                )}
              {open && (
                <>
                  <div className="agent-tool-picker__actions">
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
                              .map((tool) => getIntegrationToolKey(id, tool));
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
                            return selectIntegrationTools(
                              current,
                              id,
                              [
                                ...new Set([
                                  ...retained,
                                  ...unknown,
                                  ...tools
                                    .filter((tool) => tool.enabled !== false)
                                    .map((tool) =>
                                      getIntegrationToolKey(id, tool),
                                    ),
                                ]),
                              ],
                              catalogs,
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
                            selectIntegrationTools(
                              current,
                              id,
                              'all',
                              catalogs,
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
                      pending={refresh.isPending && refresh.variables === id}
                      pendingLabel="Refreshing…"
                      onClick={() =>
                        refresh.mutate(id, {
                          onSuccess: (result) =>
                            queryClient.setQueryData<typeof discoveries>(
                              discoveriesKey,
                              (current) => ({
                                ...current,
                                [id]: {
                                  source: integration.source,
                                  probe: result.probe,
                                },
                              }),
                            ),
                        })
                      }
                    >
                      Refresh tools
                    </Button>
                    {added && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setForm((current) => removeIntegration(current, id))
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
                      Tool names have not been discovered. Refresh to list them,
                      or add the whole source, including future tools.
                    </p>
                  )}
                  {supportsSelection && added && allTools.length > 0 && (
                    <Checkbox
                      checked={following}
                      disabled={disabled}
                      onChange={(include) =>
                        setForm((current) =>
                          selectIntegrationTools(
                            current,
                            id,
                            include
                              ? 'all'
                              : allTools
                                  .filter((tool) => tool.enabled !== false)
                                  .map((tool) =>
                                    getIntegrationToolKey(id, tool),
                                  ),
                            catalogs,
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
                        <Checkbox
                          checked={selected(id, tool) && tool.enabled !== false}
                          disabled={
                            disabled ||
                            tool.enabled === false ||
                            !supportsSelection
                          }
                          onChange={() =>
                            setForm((current) =>
                              toggleIntegrationToolEnabled(
                                current,
                                id,
                                key,
                                allTools,
                                catalogs,
                              ),
                            )
                          }
                        >
                          {title(tool)}
                        </Checkbox>
                        {tool.description && (
                          <p className="editor-hint">{tool.description}</p>
                        )}
                        <span className="agent-tool-picker__category">
                          {tool.group || 'Other'}
                          {tool.enabled === false
                            ? ' · Disabled in Connections'
                            : ''}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
