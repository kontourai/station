import {
  PROJECT_MEMORY_NOTE_BODY_MAX_CHARS,
  PROJECT_MEMORY_NOTE_TITLE_MAX_CHARS,
  type ProjectMemoryNoteSummary,
} from '@kontourai/station-contracts/project-session-context';
import {
  createProjectMemoryNote,
  deleteProjectMemoryNote,
  getProjectMemoryNote,
  listProjectMemory,
  updateProjectMemoryNote,
} from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import { relativeTimeAgoFromIso } from '../../utils/relativeTime';

type Draft = { id?: string; title: string; body: string };

function authorLine(note: ProjectMemoryNoteSummary, now: number): string {
  const by =
    note.updatedBy.kind === 'agent'
      ? `${note.updatedBy.label} (agent)`
      : note.updatedBy.label;
  return `${by}, ${relativeTimeAgoFromIso(note.updatedAt, now)}`;
}

/**
 * #5065: the Project's memory notes. Agents save them when asked or
 * corrected; every new Session in the Project reads their titles as
 * background. Changes apply at once and reach new Sessions.
 */
export function MemorySection({ slug }: { slug: string }) {
  const authority = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const titleId = useId();
  const bodyId = useId();
  const key = [
    'project-memory',
    authority?.apiBase,
    authority?.authorityKey,
    slug,
  ];
  const list = useQuery({
    queryKey: key,
    enabled: !!authority,
    retry: false,
    queryFn: ({ signal }) =>
      listProjectMemory(authority!.apiBase, slug, {
        requestScope: authority!,
        signal,
      }),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [forgetting, setForgetting] = useState<ProjectMemoryNoteSummary | null>(
    null,
  );
  const open = useMutation({
    retry: false,
    mutationFn: (id: string) =>
      getProjectMemoryNote(authority!.apiBase, slug, id, {
        requestScope: authority!,
      }),
    onSuccess: (note) =>
      setDraft({ id: note.id, title: note.title, body: note.body }),
  });
  const save = useMutation({
    retry: false,
    mutationFn: (value: Draft) =>
      value.id
        ? updateProjectMemoryNote(
            authority!.apiBase,
            slug,
            value.id,
            { title: value.title, body: value.body },
            { requestScope: authority! },
          )
        : createProjectMemoryNote(
            authority!.apiBase,
            slug,
            { title: value.title, body: value.body },
            { requestScope: authority! },
          ),
    onSuccess: () => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const forget = useMutation({
    retry: false,
    mutationFn: (id: string) =>
      deleteProjectMemoryNote(authority!.apiBase, slug, id, {
        requestScope: authority!,
      }),
    onSuccess: () => {
      setForgetting(null);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const notes = list.data?.notes ?? [];
  const now = Date.now();

  return (
    <PageSection
      id="section-memory"
      className="project-settings__section"
      title="Memory"
      description="Notes agents save when you ask them to remember something. New Sessions read them as background."
      actions={
        draft ? undefined : (
          <Button
            onClick={() => setDraft({ title: '', body: '' })}
            disabled={!list.data}
          >
            Add note
          </Button>
        )
      }
    >
      {draft && (
        <form
          className="project-settings__memory-editor content-stack"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft);
          }}
        >
          <label htmlFor={titleId} className="page-row__label">
            Title
          </label>
          <input
            id={titleId}
            className="editor-input"
            type="text"
            maxLength={PROJECT_MEMORY_NOTE_TITLE_MAX_CHARS}
            value={draft.title}
            placeholder="The release moved to Friday"
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
          />
          <label htmlFor={bodyId} className="page-row__label">
            Note
          </label>
          <textarea
            id={bodyId}
            className="editor-input project-settings__memory-textarea"
            rows={5}
            maxLength={PROJECT_MEMORY_NOTE_BODY_MAX_CHARS}
            value={draft.body}
            onChange={(event) =>
              setDraft({ ...draft, body: event.target.value })
            }
          />
          {save.isError && (
            <ErrorState
              variant="compact"
              title="Couldn't save the note"
              description={userFacingErrorMessage(save.error)}
            />
          )}
          <div className="project-settings__memory-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={save.isPending || !draft.title.trim()}
            >
              {save.isPending ? 'Saving…' : 'Save note'}
            </Button>
            <Button onClick={() => setDraft(null)} disabled={save.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {list.isLoading ? (
        <SkeletonList count={3} label="Loading memory" />
      ) : list.isError ? (
        <ErrorState
          variant="compact"
          title="Couldn't load memory"
          description={userFacingErrorMessage(list.error)}
          action={<Button onClick={() => void list.refetch()}>Retry</Button>}
        />
      ) : notes.length === 0 ? (
        <Empty
          label="Nothing saved yet"
          description="Ask an agent in this Project to remember a decision, requirement or pitfall."
        />
      ) : (
        <ul className="project-settings__memory-list">
          {notes.map((note) => (
            <li key={note.id} className="project-settings__memory-item">
              <div className="project-settings__memory-text">
                <span className="project-settings__memory-title">
                  {note.title}
                </span>
                <span className="project-settings__memory-meta">
                  {authorLine(note, now)}
                </span>
              </div>
              <div className="project-settings__memory-actions">
                <Button
                  onClick={() => open.mutate(note.id)}
                  disabled={open.isPending}
                  aria-label={`Edit note: ${note.title}`}
                >
                  Edit
                </Button>
                <Button
                  variant="danger-outline"
                  onClick={() => setForgetting(note)}
                  aria-label={`Delete note: ${note.title}`}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {open.isError && (
        <ErrorState
          variant="compact"
          title="Couldn't open the note"
          description={userFacingErrorMessage(open.error)}
        />
      )}
      <ConfirmModal
        isOpen={!!forgetting}
        title="Delete this note?"
        message={`New Sessions stop seeing “${forgetting?.title ?? ''}”.`}
        confirmLabel="Delete"
        variant="danger"
        pending={forget.isPending}
        error={forget.isError ? userFacingErrorMessage(forget.error) : null}
        onConfirm={() => forgetting && forget.mutate(forgetting.id)}
        onCancel={() => {
          setForgetting(null);
          forget.reset();
        }}
      />
    </PageSection>
  );
}
