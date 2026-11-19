import type {
  ProjectDeletionPreview,
  ProjectLifecycle,
  ProjectLifecycleAction,
  ProjectLifecycleResult,
} from '@kontourai/station-contracts/project-lifecycle';
import {
  useDeleteProjectMutation,
  useProjectDeletionPreviewQuery,
  useProjectLifecycleMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { userFacingErrorMessage } from '../../utils/errorText';
import './ProjectLifecycleSection.css';

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a finished Pause or Archive did, in one line. */
export function lifecycleResultSummary(result: ProjectLifecycleResult): string {
  if (!result.lifecycle) return 'Project is active again.';
  const verb = result.lifecycle.state === 'paused' ? 'Paused' : 'Archived';
  if (result.interrupted === 0) return `${verb}. Nothing was running.`;
  const stopped = `${verb}. Stopped ${plural(result.interrupted, 'running chat')}.`;
  return result.stillRunning > 0
    ? `${stopped} ${plural(result.stillRunning, 'chat')} still finishing.`
    : stopped;
}

/** Delete's confirmation: what goes, what stops, what stays. */
export function deletionPreviewLines(preview: ProjectDeletionPreview): {
  removes: string[];
  stops: string[];
  keeps: string[];
} {
  return {
    removes: [
      'Project settings',
      plural(preview.removes.layouts, 'Layout'),
      plural(preview.removes.knowledgeDocuments, 'knowledge document'),
      plural(preview.removes.schedules, 'schedule'),
    ],
    stops:
      preview.stops.runningSessions > 0
        ? [plural(preview.stops.runningSessions, 'running chat')]
        : [],
    keeps: [
      plural(preview.keeps.tasks, 'Task'),
      plural(preview.keeps.sessions, 'chat'),
      'the repository checkout, pushed branches and pull requests',
    ],
  };
}

/** A Station without the route answers 404 (`StationHttpError.status`). */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}

function lifecycleErrorText(error: unknown): string {
  return isNotFound(error)
    ? 'This Station needs an update to pause or archive Projects.'
    : userFacingErrorMessage(error);
}

export function ProjectLifecycleSection({
  slug,
  name,
  lifecycle,
  pauseArchiveEnabled = true,
  onDeleted,
}: {
  slug: string;
  name: string;
  lifecycle: ProjectLifecycle | undefined;
  /**
   * The `project-pause-archive` preview. Off hides Pause and Archive; a held
   * Project still offers Resume or Unarchive.
   */
  pauseArchiveEnabled?: boolean;
  onDeleted: () => void;
}) {
  const lifecycleMutation = useProjectLifecycleMutation(slug);
  const deleteMutation = useDeleteProjectMutation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const preview = useProjectDeletionPreviewQuery(slug, {
    enabled: deleteOpen,
  });
  const state = lifecycle?.state;

  async function run(action: ProjectLifecycleAction) {
    setOutcome(null);
    try {
      setOutcome(
        lifecycleResultSummary(await lifecycleMutation.mutateAsync(action)),
      );
    } catch {
      // The mutation's error renders below.
    }
  }

  async function deleteProject() {
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(slug);
      onDeleted();
    } catch (failure) {
      setDeleteError(userFacingErrorMessage(failure));
    }
  }

  const lines = preview.data ? deletionPreviewLines(preview.data) : undefined;
  const previewMissing = isNotFound(preview.error);

  return (
    <>
      <PageSection
        id="section-danger"
        className="project-settings__section"
        title={
          pauseArchiveEnabled || state
            ? 'Pause, archive, delete'
            : 'Danger zone'
        }
        tone="danger"
      >
        {(pauseArchiveEnabled || state === 'paused') && (
          <PageRow
            label={state === 'paused' ? 'Resume' : 'Pause'}
            description={
              state === 'paused'
                ? 'Chats here accept messages and schedules run again.'
                : 'Stops every running chat here and holds its schedules until you resume.'
            }
            control={
              <Button
                variant={state === 'paused' ? 'primary' : 'secondary'}
                disabled={lifecycleMutation.isPending || state === 'archived'}
                onClick={() =>
                  void run(state === 'paused' ? 'resume' : 'pause')
                }
              >
                {state === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            }
          />
        )}
        {(pauseArchiveEnabled || state === 'archived') && (
          <PageRow
            label={state === 'archived' ? 'Unarchive' : 'Archive'}
            description={
              state === 'archived'
                ? 'Returns it to the sidebar, active.'
                : 'Pauses it and hides it from the sidebar.'
            }
            control={
              <Button
                variant="secondary"
                disabled={lifecycleMutation.isPending}
                onClick={() =>
                  void run(state === 'archived' ? 'unarchive' : 'archive')
                }
              >
                {state === 'archived' ? 'Unarchive' : 'Archive'}
              </Button>
            }
          />
        )}
        {lifecycleMutation.isPending && (
          <p className="project-lifecycle__status" role="status">
            Stopping running chats…
          </p>
        )}
        {outcome && !lifecycleMutation.isPending && (
          <p className="project-lifecycle__status" role="status">
            {outcome}
          </p>
        )}
        {lifecycleMutation.error && (
          <p className="editor-error" role="alert">
            {lifecycleErrorText(lifecycleMutation.error)}
          </p>
        )}
        <PageRow
          label="Delete"
          description="Removes the Project. This cannot be undone."
          control={
            <Button
              variant="danger-outline"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              Delete Project
            </Button>
          }
        />
      </PageSection>

      <ConfirmModal
        isOpen={deleteOpen}
        title="Delete Project"
        message={`Delete "${name}"? This cannot be undone.`}
        details={
          lines ? (
            <dl className="project-lifecycle__counts">
              <dt>Removes</dt>
              <dd>{lines.removes.join(', ')}</dd>
              {lines.stops.length > 0 && (
                <>
                  <dt>Stops</dt>
                  <dd>{lines.stops.join(', ')}</dd>
                </>
              )}
              <dt>Keeps</dt>
              <dd>{lines.keeps.join(', ')}</dd>
            </dl>
          ) : preview.isError && !previewMissing ? (
            <p className="editor-error">
              Counts unavailable.{' '}
              <Button variant="ghost" onClick={() => void preview.refetch()}>
                Retry
              </Button>
            </p>
          ) : previewMissing ? (
            <p className="station-dialog__message">
              Removes Project settings and Layouts. Tasks, chats, the checkout,
              pushed branches and pull requests stay.
            </p>
          ) : (
            <p className="project-lifecycle__status" role="status">
              Counting what this removes…
            </p>
          )
        }
        confirmLabel="Delete"
        variant="danger"
        pending={deleteMutation.isPending}
        error={deleteError}
        onConfirm={() => void deleteProject()}
        onCancel={() => {
          setDeleteOpen(false);
          setDeleteError(null);
        }}
      />
    </>
  );
}
