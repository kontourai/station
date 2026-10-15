import type { ToolLibrarySource } from '@kontourai/station-contracts/tool-library';
import {
  useOwnToolAccess,
  useToolLibrary,
  useToolLibraryChange,
} from '@kontourai/station-sdk/tool-library';
import { lazy, Suspense, useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { PageHeaderScope } from '../../components/page-frame';
import { SkeletonList } from '../../components/state';
import type { Tool } from '../../types';
import { AgentToolApproval } from './AgentToolApproval';
import { AgentToolConnection } from './AgentToolDiscovery';
import { ToolAccountPanel } from './ToolAccountPanel';
import { useToolLibraryClient } from './ToolLibraryContext';
import type { AgentEditorFormProps } from './types';
import {
  applyNewToolApprovalDefaults,
  canonicalAgentToolPatterns,
  getIntegrationToolKey,
  selectIntegrationTools,
  toggleIntegrationToolEnabled,
} from './utils';
import './AgentToolPicker.css';

const Registry = lazy(() =>
  import('../RegistryView').then((module) => ({
    default: module.RegistryView,
  })),
);

function sourceCatalog(source: ToolLibrarySource) {
  if (source.origin?.registryId)
    return {
      id: `registry:${source.origin.registryId}`,
      name: source.origin.registryName || source.from,
    };
  if (source.origin?.kind === 'station')
    return { id: 'station', name: 'Station tools' };
  return undefined;
}

export function AgentToolLibrary({
  form,
  setForm,
  engineId,
  onConnectionDirtyChange,
}: Pick<AgentEditorFormProps, 'form' | 'setForm'> & {
  engineId: string;
  onConnectionDirtyChange?: (dirty: boolean) => void;
}) {
  const client = useToolLibraryClient();
  const access = useOwnToolAccess(client);
  const library = useToolLibrary(client, form.project || undefined);
  const change = useToolLibraryChange(client);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string>();
  const [catalog, setCatalog] = useState<{ id: string; name: string }>();
  const [setup, setSetup] = useState<string>();
  const [plugin, setPlugin] = useState<ToolLibrarySource>();
  const [notice, setNotice] = useState<string>();
  const [discovery, setDiscovery] = useState<{
    id: string;
    snapshot: string;
    source: ToolLibrarySource;
  }>();
  if (setup)
    return (
      <AgentToolConnection
        id={setup}
        onBack={() => {
          setSetup(undefined);
          onConnectionDirtyChange?.(false);
          void library.refetch();
        }}
        onDirtyChange={onConnectionDirtyChange ?? (() => {})}
      />
    );
  if (plugin)
    return (
      <PageHeaderScope>
        <Button variant="ghost" onClick={() => setPlugin(undefined)}>
          Back
        </Button>
        <Suspense fallback={<SkeletonList count={2} />}>
          <Registry
            initialTab="plugins"
            toolPicker
            installTarget={plugin.id}
            onInstalled={() => {
              setPlugin(undefined);
              void library.refetch();
            }}
          />
        </Suspense>
      </PageHeaderScope>
    );
  if (library.isPending || access.isPending)
    return <SkeletonList count={3} label="Loading tools" />;
  if (library.isError || access.isError || !library.data || !access.data)
    return (
      <p role="alert">
        Tools unavailable.{' '}
        <Button
          variant="link"
          onClick={() => {
            void library.refetch();
            void access.refetch();
          }}
        >
          Try again
        </Button>
      </p>
    );
  const view = library.data;
  const actor = access.data.principalId;
  const sources = view.sources
    .map((source) =>
      discovery?.id === source.id &&
      discovery.snapshot === JSON.stringify(source)
        ? discovery.source
        : source,
    )
    .filter(
      (source) =>
        source.kind === 'integration' ||
        (!source.installed && source.providesTools === true),
    );
  const catalogs = Object.fromEntries(
    sources.map((source) => [
      source.id,
      source.tools.map((tool) => ({
        id: `${source.id}_${tool.name}`,
        toolName: tool.name,
        ...tool,
      })),
    ]),
  );
  const patterns = canonicalAgentToolPatterns(form, catalogs);
  const selectedSource = sources.find(
    (source) => `${source.kind}:${source.id}` === selected,
  );
  const query = search.toLowerCase().trim();
  const matching = sources.filter(
    (source) =>
      (!catalog || sourceCatalog(source)?.id === catalog.id) &&
      `${source.name} ${source.from} ${source.description ?? ''} ${source.tools.map((tool) => `${tool.name} ${tool.description ?? ''}`).join(' ')}`
        .toLowerCase()
        .includes(query),
  );
  function origin(source: ToolLibrarySource) {
    const target = sourceCatalog(source);
    return target ? (
      <button
        type="button"
        className="agent-tool-library__origin"
        aria-label={`Browse ${target.name}`}
        onClick={() => {
          setCatalog(target);
          setSelected(undefined);
          setSearch('');
        }}
      >
        {source.from}
      </button>
    ) : (
      <small className="agent-tool-library__origin">{source.from}</small>
    );
  }
  function attach(source: ToolLibrarySource) {
    if (source.personalAccount && engineId !== 'station') return;
    const tools = source.tools.map((tool) => ({
      id: `${source.id}_${tool.name}`,
      toolName: tool.name,
      ...tool,
    }));
    const currentCatalogs = { ...catalogs, [source.id]: tools };
    const names = tools
      .filter((tool) => !tool.disabled)
      .map((tool) => getIntegrationToolKey(source.id, tool));
    setForm((current) =>
      applyNewToolApprovalDefaults(
        selectIntegrationTools(
          current,
          source.id,
          tools.length && ['station', 'claude', 'codex'].includes(engineId)
            ? names
            : 'all',
          currentCatalogs,
        ),
        current,
        source.id,
        tools,
        engineId,
      ),
    );
    setSelected(`${source.kind}:${source.id}`);
  }
  async function refresh(source: ToolLibrarySource) {
    const result = await change.mutateAsync({
      path: `/sources/${encodeURIComponent(source.id)}/discover`,
      body: {
        expectedActor: actor,
        project: form.project || undefined,
        projectId: view.project?.id,
      },
    });
    if (result && typeof result === 'object' && 'tools' in result) {
      const updated = await library.refetch();
      const base = updated.data?.sources.find(
        (row) => row.id === source.id && row.kind === 'integration',
      );
      if (base)
        setDiscovery({
          id: source.id,
          snapshot: JSON.stringify(base),
          source: result as ToolLibrarySource,
        });
    }
  }
  async function add(source: ToolLibrarySource) {
    setNotice(undefined);
    if (!view.operator) {
      await change.mutateAsync({
        path: '/requests',
        body: {
          project: form.project,
          projectId: view.project?.id,
          expectedActor: actor,
          sourceId: source.id,
          kind: source.kind,
        },
      });
      return;
    }
    if (source.kind === 'plugin') {
      setPlugin(source);
      return;
    }
    await change.mutateAsync({
      path: '/add',
      body: { id: source.id, kind: source.kind, expectedActor: actor },
    });
    const updated = await library.refetch();
    const installed = updated.data?.sources.find(
      (row) => row.id === source.id && row.kind === 'integration',
    );
    if (installed?.enabled) {
      attach(installed);
      setNotice(`${source.name} added.`);
    } else setSetup(source.id);
  }
  if (selectedSource) {
    const source = selectedSource;
    const tools = catalogs[source.id];
    const attached = form.tools.mcpServers.includes(source.id);
    return (
      <div className="agent-tool-library">
        <Button variant="ghost" onClick={() => setSelected(undefined)}>
          Back
        </Button>
        <div className="agent-tool-library__identity">
          <strong>{source.name}</strong>
          {origin(source)}
        </div>
        {source.description && (
          <p className="editor-hint">{source.description}</p>
        )}
        <div className="agent-tool-library__actions">
          {source.installed && source.enabled && source.permitted ? (
            <Button
              variant="secondary"
              disabled={
                !view.canManageAgents ||
                (!!source.personalAccount && engineId !== 'station')
              }
              onClick={() => attach(source)}
            >
              {source.personalAccount && engineId !== 'station'
                ? 'Station engine required'
                : attached
                  ? 'Select all'
                  : 'Add to agent'}
            </Button>
          ) : (
            <Button
              disabled={
                change.isPending ||
                !source.permitted ||
                ['pending', 'setting-up'].includes(source.request?.status ?? '')
              }
              onClick={() => void add(source).catch(() => {})}
            >
              {!source.permitted
                ? 'Not allowed'
                : source.request?.status === 'pending'
                  ? 'Pending'
                  : source.request?.status === 'setting-up'
                    ? 'Setting up'
                    : view.operator
                      ? 'Add'
                      : 'Request'}
            </Button>
          )}
        </div>
        {form.tools.mcpServers.includes(source.id) && (
          <small>
            {['station', 'claude'].includes(engineId)
              ? 'Approval choices are in each action’s details'
              : 'Approvals controlled by the engine'}
          </small>
        )}
        {tools.map((tool) => {
          const key = getIntegrationToolKey(source.id, tool);
          const checked =
            attached &&
            (patterns.includes('*') ||
              patterns.includes(`${source.id}_*`) ||
              patterns.includes(key));
          return (
            <div className="agent-tool-library__tool" key={key}>
              <Checkbox
                checked={checked}
                disabled={
                  !view.canManageAgents ||
                  !source.enabled ||
                  !source.permitted ||
                  tool.disabled ||
                  !['station', 'claude', 'codex'].includes(engineId)
                }
                onChange={() =>
                  setForm((current) =>
                    applyNewToolApprovalDefaults(
                      toggleIntegrationToolEnabled(
                        current,
                        source.id,
                        key,
                        tools,
                        catalogs,
                      ),
                      current,
                      source.id,
                      tools,
                      engineId,
                    ),
                  )
                }
              >
                {tool.title || tool.name.replaceAll('_', ' ')}
              </Checkbox>
              <span
                className="agent-tool-library__classification"
                title={
                  tool.classificationSource === 'publisher'
                    ? 'Reported by the source; approval still defaults to Ask me.'
                    : undefined
                }
              >
                {tool.readOnly === true
                  ? 'Read'
                  : tool.readOnly === false
                    ? 'Write'
                    : 'Unclassified'}
              </span>
              <details>
                <summary aria-label={`Details for ${tool.name}`}>
                  Details
                </summary>
                <p>{tool.description}</p>
                {checked && (
                  <AgentToolApproval
                    form={form}
                    setForm={setForm}
                    integrationId={source.id}
                    tool={tool as Tool}
                    tools={tools}
                    engineId={engineId}
                    disabled={!view.canManageAgents || !source.permitted}
                  />
                )}
              </details>
            </div>
          );
        })}
        {attached && ['station', 'claude', 'codex'].includes(engineId) && (
          <details className="agent-tool-picker__details">
            <summary>Advanced</summary>
            <Checkbox
              checked={patterns.includes(`${source.id}_*`)}
              disabled={!view.canManageAgents || !source.permitted}
              onChange={(include) =>
                setForm((current) =>
                  applyNewToolApprovalDefaults(
                    selectIntegrationTools(
                      current,
                      source.id,
                      include
                        ? 'all'
                        : tools.map((tool) =>
                            getIntegrationToolKey(source.id, tool),
                          ),
                      catalogs,
                    ),
                    current,
                    source.id,
                    tools,
                    engineId,
                  ),
                )
              }
            >
              Include future tools
            </Checkbox>
          </details>
        )}
        <details className="agent-tool-picker__details">
          <summary>About this source</summary>
          <dl>
            <dt>From</dt>
            <dd>{source.from}</dd>
            {source.origin?.version && (
              <>
                <dt>Version</dt>
                <dd>{source.origin.version}</dd>
              </>
            )}
            {source.origin?.location && (
              <>
                <dt>Location</dt>
                <dd>{source.origin.location}</dd>
              </>
            )}
          </dl>
          {(!source.origin || source.origin.kind === 'unavailable') && (
            <p>
              Origin metadata is missing, invalid, or no longer matches this
              connection.
            </p>
          )}
          {source.installed && source.kind === 'integration' && (
            <Button
              variant="ghost"
              pending={change.isPending}
              onClick={() => void refresh(source).catch(() => {})}
            >
              Refresh actions
            </Button>
          )}
          {source.personalAccount && view.project && (
            <ToolAccountPanel
              sourceId={source.id}
              project={view.project}
              actorId={actor}
            />
          )}
          {view.operator && !source.operatorOnly && (
            <Checkbox
              checked={source.sharedWithProjects !== false}
              onChange={(shared) =>
                void change
                  .mutateAsync({
                    path: `/sources/${encodeURIComponent(source.id)}/sharing`,
                    method: 'PUT',
                    body: { expectedActor: actor, shared },
                  })
                  .catch(() => {})
              }
            >
              Available to Projects
            </Checkbox>
          )}
          {view.operator && source.kind === 'integration' && (
            <Button variant="ghost" onClick={() => setSetup(source.id)}>
              Connection settings
            </Button>
          )}
        </details>
        {change.isError && <p role="alert">{change.error.message}</p>}
      </div>
    );
  }
  return (
    <div className="agent-tool-library">
      {catalog && (
        <div className="agent-tool-library__catalog-heading">
          <Button variant="ghost" onClick={() => setCatalog(undefined)}>
            All sources
          </Button>
          <strong>{catalog.name}</strong>
        </div>
      )}
      <input
        type="search"
        className="editor-input"
        aria-label="Search tools"
        placeholder="Search tools"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {notice && <p role="status">{notice}</p>}
      {matching.map((source) => {
        const added = form.tools.mcpServers.includes(source.id);
        const pending = ['pending', 'setting-up'].includes(
          source.request?.status ?? '',
        );
        const ready = source.installed && source.enabled && source.permitted;
        return (
          <div
            className="agent-tool-library__row"
            key={`${source.kind}:${source.id}`}
          >
            <div className="agent-tool-library__entry">
              <button
                type="button"
                className="agent-tool-library__source"
                aria-label={`View ${source.name} tools`}
                onClick={() => setSelected(`${source.kind}:${source.id}`)}
              >
                <strong>{source.name}</strong>
              </button>
              {origin(source)}
            </div>
            {!source.permitted ? (
              <span className="editor-hint">
                {source.operatorOnly ? 'Operator only' : 'Not allowed'}
              </span>
            ) : source.personalAccount && engineId !== 'station' ? (
              <span className="editor-hint">Station engine required</span>
            ) : added ? (
              <span className="editor-hint">Added</span>
            ) : (
              <Button
                variant="ghost"
                disabled={!view.canManageAgents || change.isPending || pending}
                onClick={() =>
                  ready ? attach(source) : void add(source).catch(() => {})
                }
              >
                {pending
                  ? source.request?.status === 'setting-up'
                    ? 'Setting up'
                    : 'Pending'
                  : ready
                    ? 'Add'
                    : view.operator
                      ? 'Add'
                      : 'Request'}
              </Button>
            )}
          </div>
        );
      })}
      {matching.length === 0 && (
        <p className="editor-hint">No matching tools.</p>
      )}
      {change.isError && <p role="alert">{change.error.message}</p>}
      {view.operator && (
        <details className="agent-tool-picker__details">
          <summary>Connect your own source</summary>
          <Button variant="ghost" onClick={() => setSetup('new')}>
            Connect a tool source
          </Button>
        </details>
      )}
    </div>
  );
}
