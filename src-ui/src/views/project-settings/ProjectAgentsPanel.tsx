import {
  useOwnToolAccess,
  useProjectAuthoredAgents,
  useToolLibrary,
  useToolLibraryChange,
} from '@kontourai/station-sdk/tool-library';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Dialog } from '../../components/Dialog';
import { Empty, SkeletonList } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { AgentToolLibrary } from '../agent-editor/AgentToolLibrary';
import {
  createEmptyAgentForm,
  formFromAgent,
} from '../agent-editor/agentsViewUtils';
import { useToolLibraryClient } from '../agent-editor/ToolLibraryContext';
import type { AgentFormData } from '../agent-editor/types';
import { removeIntegration } from '../agent-editor/utils';

export function ProjectAgentsPanel({
  project,
}: {
  project: { id: string; slug: string; name?: string };
}) {
  const client = useToolLibraryClient();
  const access = useOwnToolAccess(client);
  const library = useToolLibrary(client, project.slug);
  const agents = useProjectAuthoredAgents(
    client,
    project.slug,
    library.data?.canManageAgents === true,
  );
  const change = useToolLibraryChange(client);
  const [editing, setEditing] = useState<string>();
  const [form, setForm] = useState<AgentFormData>();
  const [tools, setTools] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const { guard, DiscardModal } = useUnsavedGuard(
    !!form && JSON.stringify(form) !== saved,
  );
  const view = library.data;
  const selectedEngine = view?.engines?.find(
    (engine) => engine.id === form?.execution.agentConnectionId,
  );
  const unsupportedAsk =
    !!form?.tools.askBeforeUse?.length &&
    !['station', 'claude'].includes(
      selectedEngine?.engineId ?? form?.execution.agentConnectionId ?? '',
    );
  if (library.isPending)
    return <SkeletonList count={2} label="Loading Project tools" />;
  if (library.isError || !view)
    return <p role="status">Project tools unavailable.</p>;
  const role = access.data?.projects.find((row) => row.id === project.id)?.role;
  if (!view.canManageAgents)
    return (
      <p>
        {role ? `${role.charAt(0).toUpperCase()}${role.slice(1)} · ` : ''}
        Project agents are managed by this Project’s admins.
      </p>
    );
  function create() {
    const next = createEmptyAgentForm(view?.engines?.[0]?.id ?? '');
    next.project = project.slug;
    next.tools.mcpMode = 'replace';
    setForm(next);
    setSaved(JSON.stringify(next));
    setEditing('new');
    setError(undefined);
  }
  async function save() {
    if (!form || !access.data || unsupportedAsk) return;
    setError(undefined);
    try {
      await change.mutateAsync({
        path: `/projects/${encodeURIComponent(project.slug)}/agents${editing === 'new' ? '' : `/${encodeURIComponent(editing!)}`}`,
        method: editing === 'new' ? 'POST' : 'PUT',
        body: {
          projectId: project.id,
          expectedActor: access.data.principalId,
          draft: {
            name: form.name,
            description: form.description,
            prompt: form.prompt,
            engineId: form.execution.agentConnectionId,
            tools: {
              mcpServers: form.tools.mcpServers,
              available: form.tools.available,
              autoApprove: form.tools.autoApprove,
              askBeforeUse: form.tools.askBeforeUse,
            },
          },
        },
      });
      setForm(undefined);
      setEditing(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Agent could not be saved.',
      );
    }
  }
  async function policy(mode: 'all' | 'selected', sources: string[]) {
    if (!access.data || !view) return;
    await change.mutateAsync({
      path: `/projects/${encodeURIComponent(project.slug)}/policy`,
      method: 'PUT',
      body: {
        projectId: project.id,
        expectedActor: access.data.principalId,
        mode,
        sources,
        revision: view.policy.revision,
      },
    });
  }
  return (
    <section
      aria-label="Project agents and tools"
      className="agent-tool-library"
    >
      <small>
        {role
          ? `${role.charAt(0).toUpperCase()}${role.slice(1)} in this Project`
          : 'Project access unavailable'}
      </small>
      <div className="agent-tool-library__row">
        <h3>Agents</h3>
        <Button onClick={create}>New agent</Button>
      </div>
      {agents.isError && <p role="alert">Agents unavailable.</p>}
      {agents.data?.map((agent) => (
        <div className="agent-tool-library__row" key={agent.slug}>
          <strong>{agent.spec.name}</strong>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(agent.slug);
              const next = formFromAgent({
                ...agent.spec,
                slug: agent.slug,
                toolsConfig: agent.spec.tools,
              });
              next.execution.agentConnectionId ||= 'station';
              setForm(next);
              setSaved(JSON.stringify(next));
            }}
          >
            Edit
          </Button>
        </div>
      ))}
      {agents.data?.length === 0 && (
        <Empty variant="compact" label="Nothing here yet." />
      )}
      <small>
        Running work also requires an available computer contribution.
      </small>
      {view.canManagePolicy && (
        <details>
          <summary>Tool permissions</summary>
          <Checkbox
            checked={view.policy.mode === 'all'}
            disabled={change.isPending}
            onChange={(all) =>
              void policy(
                all ? 'all' : 'selected',
                all
                  ? []
                  : view.sources
                      .filter(
                        (source) =>
                          source.permitted && source.kind === 'integration',
                      )
                      .map((source) => source.id),
              ).catch(() => {})
            }
          >
            Allow all sources shared by the operator
          </Checkbox>
          {view.policy.mode === 'selected' &&
            view.sources
              .filter(
                (source) =>
                  !source.operatorOnly &&
                  (source.kind === 'integration' ||
                    source.providesTools === true),
              )
              .map((source) => (
                <Checkbox
                  key={source.id}
                  checked={view.policy.sources.includes(source.id)}
                  disabled={change.isPending}
                  onChange={(allow) =>
                    void policy(
                      'selected',
                      allow
                        ? [...view.policy.sources, source.id]
                        : view.policy.sources.filter((id) => id !== source.id),
                    ).catch(() => {})
                  }
                >
                  {source.name}
                </Checkbox>
              ))}
        </details>
      )}
      {change.isError && <p role="alert">{change.error.message}</p>}
      {form && (
        <Dialog
          title={editing === 'new' ? 'New Project agent' : form.name}
          closeLabel="Close Project agent"
          dismissible={!connectionDirty}
          onClose={() => {
            if (connectionDirty) return;
            guard(() => {
              setEditing(undefined);
              setForm(undefined);
            });
          }}
          size="lg"
          footer={
            <Button
              pending={change.isPending}
              disabled={
                unsupportedAsk ||
                connectionDirty ||
                !form.name.trim() ||
                !form.execution.agentConnectionId
              }
              onClick={() => void save()}
            >
              Save agent
            </Button>
          }
        >
          <div className="agent-tool-library">
            <label>
              Name
              <input
                className="editor-input"
                value={form.name}
                onChange={(event) =>
                  setForm((current) =>
                    current
                      ? { ...current, name: event.target.value }
                      : current,
                  )
                }
              />
            </label>
            <label>
              Engine
              <select
                className="editor-select"
                value={form.execution.agentConnectionId}
                onChange={(event) =>
                  setForm((current) =>
                    current
                      ? {
                          ...current,
                          execution: {
                            ...current.execution,
                            agentConnectionId: event.target.value,
                          },
                        }
                      : current,
                  )
                }
              >
                {view.engines?.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.name}
                  </option>
                ))}
              </select>
            </label>
            {unsupportedAsk && (
              <p role="alert">
                This engine cannot enforce Ask me rules. Choose Station or
                Claude, or review and remove those rules before switching.
              </p>
            )}
            <label>
              Instructions
              <textarea
                className="editor-textarea"
                value={form.prompt}
                onChange={(event) =>
                  setForm((current) =>
                    current
                      ? { ...current, prompt: event.target.value }
                      : current,
                  )
                }
              />
            </label>
            <Button variant="secondary" onClick={() => setTools(true)}>
              Add tools
            </Button>
            {form.tools.mcpServers.map((id) => (
              <div key={id} className="agent-tool-library__row">
                <strong>
                  {view.sources.find(
                    (source) =>
                      source.id === id && source.kind === 'integration',
                  )?.name ?? id}
                </strong>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setForm((current) =>
                      current ? removeIntegration(current, id) : current,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {error && <p role="alert">{error}</p>}
          </div>
          {tools && (
            <Dialog
              title="Add tools"
              closeLabel="Close tools"
              dismissible={!connectionDirty}
              onClose={() => {
                if (!connectionDirty) setTools(false);
              }}
              footer={
                <Button
                  disabled={connectionDirty}
                  onClick={() => setTools(false)}
                >
                  Done
                </Button>
              }
            >
              <AgentToolLibrary
                onConnectionDirtyChange={setConnectionDirty}
                form={form}
                setForm={(update) =>
                  setForm((current) =>
                    current
                      ? typeof update === 'function'
                        ? update(current)
                        : update
                      : current,
                  )
                }
                engineId={
                  view.engines?.find(
                    (engine) => engine.id === form.execution.agentConnectionId,
                  )?.engineId ?? form.execution.agentConnectionId
                }
              />
            </Dialog>
          )}
        </Dialog>
      )}
      <DiscardModal />
    </section>
  );
}
