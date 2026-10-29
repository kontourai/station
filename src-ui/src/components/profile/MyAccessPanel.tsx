import { useOwnToolAccess } from '@kontourai/station-sdk/tool-library';
import { useState } from 'react';
import { useToolLibraryClient } from '../../views/agent-editor/ToolLibraryContext';
import { ProjectAgentsPanel } from '../../views/project-settings/ProjectAgentsPanel';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SkeletonList } from '../state';
import './MyAccessPanel.css';
export function MyAccessPanel({ compact = false }: { compact?: boolean }) {
  const client = useToolLibraryClient();
  const [selected, setSelected] = useState<{
    id: string;
    slug: string;
    name: string;
  }>();
  const access = useOwnToolAccess(client);
  if (access.isPending)
    return (
      <SkeletonList
        count={compact ? 1 : 2}
        withIcon={!compact}
        label="Checking your access"
      />
    );
  if (access.isError || !access.data)
    return <p role="status">Access unavailable</p>;
  const view = access.data;
  if (compact)
    return (
      <span>
        {view.station.operator ? 'Operator' : 'Member'} on {view.station.name}
      </span>
    );
  return (
    <section aria-label="My access" className="tool-access-panel">
      <h2>My access</h2>
      <p>
        <strong>{view.station.operator ? 'Operator' : 'Member'}</strong> on{' '}
        {view.station.name}
      </p>
      <ul>
        {view.projects.map((project) => (
          <li key={project.id}>
            <div className="tool-access-panel__project">
              <div className="tool-access-panel__identity">
                <strong>{project.name}</strong>
                <span className="tool-access-panel__role">
                  {project.role === 'operator'
                    ? 'Operator'
                    : project.role.charAt(0).toUpperCase() +
                      project.role.slice(1)}
                </span>
              </div>
              <small>
                {[
                  project.canManageAgents ? 'Create agents' : undefined,
                  project.canManageTools ? 'Manage tools' : undefined,
                  project.canExecute ? 'Request runs' : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'View shared work'}
              </small>
            </div>
            {project.canManageAgents && (
              <Button variant="ghost" onClick={() => setSelected(project)}>
                Agents and tools
              </Button>
            )}
          </li>
        ))}
      </ul>
      {selected && (
        <Dialog
          title={selected.name}
          closeLabel="Close Project tools"
          onClose={() => setSelected(undefined)}
          size="lg"
        >
          <ProjectAgentsPanel project={selected} />
        </Dialog>
      )}
    </section>
  );
}
