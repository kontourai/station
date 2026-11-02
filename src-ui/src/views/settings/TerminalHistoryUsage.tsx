import {
  TerminalHistoryUnsupportedError,
  useClearTerminalHistoryMutation,
  useTerminalHistoryQuery,
} from '@kontourai/station-sdk';
import { type ReactNode, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useProjects } from '../../contexts/ProjectsContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import './TerminalHistoryUsage.css';

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Host options: disk used by terminal history, per Project, with a clear
 * action for one Project or for everything (#3994). Clearing deletes ended
 * terminals' history; running terminals keep theirs.
 */
export function TerminalHistoryUsage() {
  const usage = useTerminalHistoryQuery();
  const clear = useClearTerminalHistoryMutation();
  const { projects } = useProjects();
  // `null` asks to clear everything; a string, one Project.
  const [confirming, setConfirming] = useState<string | null | undefined>();
  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? projectId;

  let body: ReactNode;
  if (usage.isLoading)
    body = <SkeletonBlock count={2} label="Reading terminal history" />;
  else if (usage.error instanceof TerminalHistoryUnsupportedError)
    body = <p className="settings__field-hint">{usage.error.message}</p>;
  else if (usage.error || !usage.data)
    body = (
      <ErrorState
        variant="compact"
        title="Could not read terminal history"
        description={
          usage.error
            ? userFacingErrorMessage(usage.error)
            : 'Station did not report terminal history.'
        }
        action={<Button onClick={() => usage.refetch()}>Retry</Button>}
      />
    );
  else {
    const data = usage.data;
    body = (
      <>
        <p className="settings__field-hint terminal-history__summary">
          {size(data.bytes)} for {data.terminals} terminal
          {data.terminals === 1 ? '' : 's'} in {data.directory}
        </p>
        {data.projects.length > 0 && (
          <table className="terminal-history__table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Terminals</th>
                <th scope="col">Size</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((project) => (
                <tr key={project.projectId}>
                  <th scope="row">{projectName(project.projectId)}</th>
                  <td>
                    {project.terminals}
                    {project.running > 0 && ` (${project.running} running)`}
                  </td>
                  <td>{size(project.bytes)}</td>
                  <td>
                    <Button
                      size="sm"
                      disabled={project.terminals === project.running}
                      onClick={() => setConfirming(project.projectId)}
                    >
                      Clear
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {clear.data && (
          <p className="settings__field-hint" role="status">
            Cleared {clear.data.cleared} terminal
            {clear.data.cleared === 1 ? '' : 's'}
            {clear.data.running > 0 &&
              `; ${clear.data.running} running kept their history`}
            .
          </p>
        )}
        <Button
          variant="danger-outline"
          disabled={data.terminals === 0}
          onClick={() => setConfirming(null)}
        >
          Clear all terminal history
        </Button>
      </>
    );
  }

  return (
    <div
      className="settings__subsection terminal-history"
      id="terminal-history-usage"
      tabIndex={-1}
    >
      <h3 className="settings__field-label">Terminal history usage</h3>
      {body}
      <ConfirmModal
        isOpen={confirming !== undefined}
        title={
          confirming === null
            ? 'Clear all terminal history?'
            : `Clear terminal history for ${confirming ? projectName(confirming) : ''}?`
        }
        message="Ended terminals’ output is deleted. Running terminals keep theirs."
        confirmLabel="Clear history"
        variant="danger"
        role="alertdialog"
        pending={clear.isPending}
        error={clear.error ? userFacingErrorMessage(clear.error) : null}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() =>
          clear.mutate(confirming ?? undefined, {
            onSuccess: () => setConfirming(undefined),
          })
        }
      />
    </div>
  );
}
