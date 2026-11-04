import type { ToolLibrarySource } from '@kontourai/station-contracts/tool-library';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import {
  type ToolLibraryClient,
  useOwnToolAccess,
  useToolLibrary,
} from '@kontourai/station-sdk/tool-library';
import { Badge } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import {
  Empty,
  ErrorState,
  FilteredEmpty,
  SkeletonList,
} from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import './TaskCapabilityPath.css';

interface TaskCapabilityPathProps {
  taskId: string;
  taskCreatedAt: string;
  projectId: string;
  projectSlug: string;
  onView: (view: 'Plan' | 'Work chats' | 'Details') => void;
}

export function TaskCapabilityPath(props: TaskCapabilityPathProps) {
  const flags = useSurfaceVisibilityFlags();
  const authority = useHostRequestAuthorityScope();
  if (!flags.has('task-capabilities')) return null;
  return (
    <CapabilityPath
      key={JSON.stringify([
        authority?.apiBase,
        authority?.authorityKey,
        props.taskId,
        props.taskCreatedAt,
        props.projectId,
      ])}
      {...props}
      authority={authority ?? undefined}
    />
  );
}

function CapabilityPath({
  projectId,
  projectSlug,
  authority,
  onView,
}: TaskCapabilityPathProps & { authority?: ApiRequestScope }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section
      className="task-capability-path"
      aria-label="Capabilities and evidence"
    >
      <h3>Capabilities and evidence</h3>
      <ol className="task-capability-path__steps">
        <li>
          <Button onClick={() => onView('Plan')}>Plan</Button>
          <span>Define the outcome and completion criteria.</span>
        </li>
        <li>
          <Button onClick={() => onView('Work chats')}>Work chats</Button>
          <span>Follow the linked Agent conversations.</span>
        </li>
        <li>
          <Button onClick={() => onView('Details')}>
            Artifacts and receipts
          </Button>
          <span>Inspect recorded outputs and evidence.</span>
        </li>
      </ol>
      <DisclosureToggle
        expanded={open}
        onToggle={() => setOpen(!open)}
        controls={id}
      >
        Inspect Project tools
      </DisclosureToggle>
      {open && (
        <div id={id}>
          <p>
            Engine support, account access and approvals are checked when work
            starts.
          </p>
          {authority ? (
            <ProjectToolInspection
              authority={authority}
              projectId={projectId}
              projectSlug={projectSlug}
            />
          ) : (
            <Empty
              variant="compact"
              label="Tool inspection needs a verified Station connection"
            />
          )}
        </div>
      )}
    </section>
  );
}

function ProjectToolInspection({
  authority,
  projectId,
  projectSlug,
}: {
  authority: ApiRequestScope;
  projectId: string;
  projectSlug: string;
}) {
  const client: ToolLibraryClient = {
    apiBase: authority.apiBase,
    options: { requestScope: authority },
  };
  const access = useOwnToolAccess(client);
  const project = access.data?.projects.find(
    (entry) => entry.id === projectId && entry.slug === projectSlug,
  );
  const allowed = !access.isError && project?.canManageAgents === true;
  const library = useToolLibrary(
    { ...client, principalId: access.data?.principalId },
    projectSlug,
    allowed,
  );
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(12);
  const query = search.trim().toLowerCase();
  const view = library.data;
  if (access.isError)
    return (
      <ErrorState
        variant="compact"
        title="Tool access unavailable"
        action={
          <Button onClick={() => void access.refetch()}>
            Retry tool access
          </Button>
        }
      />
    );
  if (!access.data)
    return <SkeletonList count={2} label="Checking tool access" />;
  if (!allowed)
    return (
      <Empty
        variant="compact"
        label="Project Agent management access is required to inspect tools"
      />
    );
  if (
    library.isError ||
    (view &&
      (view.project?.id !== projectId ||
        view.project.slug !== projectSlug ||
        !view.canManageAgents))
  )
    return (
      <ErrorState
        variant="compact"
        title="Project tools unavailable"
        action={
          <Button onClick={() => void library.refetch()}>
            Retry Project tools
          </Button>
        }
      />
    );
  if (!view) return <SkeletonList count={2} label="Loading Project tools" />;
  const sources = view.sources.filter(
    (source) =>
      source.kind === 'integration' ||
      (!source.installed && source.providesTools === true),
  );
  const matching = sources.filter((source) =>
    `${source.name} ${source.from} ${source.description ?? ''} ${source.tools.map((tool) => `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`).join(' ')}`
      .toLowerCase()
      .includes(query),
  );
  return (
    <div className="task-capability-path__catalog">
      <div className="task-capability-path__search">
        <label>
          Find a Project tool
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(12);
            }}
          />
        </label>
        <Button
          onClick={() => void library.refetch()}
          disabled={library.isFetching}
        >
          Refresh tools
        </Button>
      </div>
      {library.isFetching && <p role="status">Refreshing tool setup…</p>}
      {sources.length === 0 ? (
        <Empty
          variant="compact"
          description="The Project catalog returned an empty source list."
        />
      ) : matching.length === 0 ? (
        <FilteredEmpty
          query={search}
          noun="Project tools"
          onClear={() => setSearch('')}
        />
      ) : (
        <>
          <ul className="task-capability-path__sources">
            {matching.slice(0, limit).map((source) => (
              <SourceTools
                key={`${source.kind}:${source.id}:${query}`}
                source={source}
                query={query}
              />
            ))}
          </ul>
          {matching.length > limit && (
            <Button onClick={() => setLimit(limit + 12)}>
              Show more sources
            </Button>
          )}
        </>
      )}
      <p>
        Catalog setup is a snapshot. Inspect receipts to establish what actually
        ran.
      </p>
    </div>
  );
}

function SourceTools({
  source,
  query,
}: {
  source: ToolLibrarySource;
  query: string;
}) {
  const [limit, setLimit] = useState(20);
  const sourceMatches =
    `${source.name} ${source.from} ${source.description ?? ''}`
      .toLowerCase()
      .includes(query);
  const tools = source.tools.filter(
    (tool) =>
      sourceMatches ||
      `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`
        .toLowerCase()
        .includes(query),
  );
  return (
    <li>
      <details>
        <summary>
          <strong>{source.name}</strong>
          <span className="task-capability-path__badges">
            {!source.installed && (
              <Badge value="Not installed" tone="neutral" />
            )}
            {source.installed && !source.enabled && (
              <Badge value="Disabled or unavailable" tone="caution" />
            )}
            {!source.permitted && (
              <Badge
                value={
                  source.operatorOnly
                    ? 'Operator only'
                    : source.sharedWithProjects === false
                      ? 'Not shared with Projects'
                      : 'Excluded by Project policy'
                }
                tone="caution"
              />
            )}
            {source.installed && source.enabled && source.permitted && (
              <Badge value="Project permits source" tone="neutral" />
            )}
          </span>
        </summary>
        <p>From {source.from}</p>
        {!source.installed && (
          <p>
            Review installation in Registry or request it through Agents and
            tools.
          </p>
        )}
        {source.installed && !source.enabled && (
          <p>Check this source in Connections.</p>
        )}
        {!source.permitted && (
          <p>
            Ask your Project Owner or Station operator to review tool access.
          </p>
        )}
        {source.personalAccount && <p>Requires your connected account.</p>}
        {tools.length ? (
          <>
            <p>
              {query ? 'Matching reported tools' : 'Reported tools'} (
              {tools.length})
            </p>
            <ul>
              {tools.slice(0, limit).map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.title || tool.name}</strong>
                  {tool.title && <code>{tool.name}</code>}
                  {tool.disabled && <Badge value="Disabled" tone="caution" />}
                  {tool.description && <p>{tool.description}</p>}
                </li>
              ))}
            </ul>
            {tools.length > limit && (
              <Button onClick={() => setLimit(limit + 20)}>
                Show more tools from {source.name}
              </Button>
            )}
          </>
        ) : (
          <Empty
            variant="compact"
            description="This source reported an empty tool list."
          />
        )}
      </details>
    </li>
  );
}
