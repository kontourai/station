import {
  useAgentWorkflowsQuery,
  useCreateWorkflowMutation,
  useDeleteWorkflowMutation,
  useUpdateWorkflowMutation,
  useWorkflowContentQuery,
} from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { SkeletonBlock } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';

/**
 * The agent's workflow files, managed in place (station#2693).
 *
 * The management UI was deleted by the #2677 dead-surface sweep because
 * nothing navigated to it and the #1563 editor redesign was pending; the
 * redesign has landed, the routes (`/agents/:slug/workflows/*`) and SDK
 * hooks never went away, and the editor had been pointing at a CLI command
 * instead. This section is that note made true: list, open, edit, create
 * and delete against the same API the CLI speaks, with the server's own
 * refusals (bad filename, duplicate, unsafe content, reserved identity)
 * shown verbatim.
 *
 * Unsaved edits arbitrate through `useUnsavedGuard`, so both an in-section
 * transition and a route-level navigation reach the same decision.
 */
export function AgentEditorWorkflows({
  slug,
  locked,
}: {
  slug: string;
  locked: boolean;
}) {
  const workflowsQuery = useAgentWorkflowsQuery(slug || undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFilename, setNewFilename] = useState('');
  const [newContent, setNewContent] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The loaded content the draft edits against; null until seeded. */
  const [baseline, setBaseline] = useState<string | null>(null);

  const contentQuery = useWorkflowContentQuery(
    slug || undefined,
    selectedId ?? undefined,
  );

  // Seed the draft when a DIFFERENT workflow's content arrives. A refetch of
  // the same workflow (the update mutation invalidates this key) must not
  // clobber edits made while it was in flight.
  useEffect(() => {
    if (selectedId === null) return;
    if (baseline !== null) return;
    if (typeof contentQuery.data !== 'string') return;
    setBaseline(contentQuery.data);
    setDraft(contentQuery.data);
  }, [selectedId, baseline, contentQuery.data]);

  const dirty = selectedId !== null && baseline !== null && draft !== baseline;

  const { guard, DiscardModal } = useUnsavedGuard(dirty);

  /** Every guarded transition runs exactly ONE raw body — never another
   * guarded helper, or a dirty state would ask twice. */
  const closeEditor = () => {
    setSelectedId(null);
    setCreating(false);
    setDraft(null);
    setBaseline(null);
    setActionError(null);
  };

  const selectWorkflow = (id: string) => {
    guard(() => {
      setCreating(false);
      setSelectedId(id);
      setDraft(null);
      setBaseline(null);
      setActionError(null);
    });
  };

  const updateMutation = useUpdateWorkflowMutation(slug, {
    onSuccess: () => {
      setBaseline(draft);
      setActionError(null);
    },
    onError: (error) => setActionError(error.message),
  });

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const deleteMutation = useDeleteWorkflowMutation(slug, {
    onSuccess: (_data, workflowId) => {
      setDeleteTarget(null);
      setActionError(null);
      if (workflowId === selectedId) closeEditor();
    },
    onError: (error) => {
      setDeleteTarget(null);
      setActionError(error.message);
    },
  });

  const createMutation = useCreateWorkflowMutation(slug, {
    onSuccess: (_data, variables) => {
      setCreating(false);
      setNewFilename('');
      setNewContent('');
      setActionError(null);
      setSelectedId(variables.filename);
      setBaseline(variables.content);
      setDraft(variables.content);
    },
    onError: (error) => setActionError(error.message),
  });

  if (!slug) {
    return (
      <div className="editor-field">
        <span className="editor-label">Workflows</span>
        <span className="editor-hint">
          Save the agent to manage its workflow files (.ts, .js, .mjs, .cjs).
        </span>
      </div>
    );
  }

  const workflows = workflowsQuery.data ?? [];
  const showEditor = selectedId !== null && !creating;

  return (
    <div className="editor-field">
      <div className="editor-label-row">
        <span className="editor-label">Workflows</span>
        <span className="editor-label-row__actions">
          {!locked && !creating && (
            <button
              type="button"
              className="editor-enrich-btn"
              onClick={() => {
                guard(() => {
                  closeEditor();
                  setCreating(true);
                });
              }}
            >
              + Add workflow
            </button>
          )}
        </span>
      </div>
      <span className="editor-hint">
        Workflow scripts saved with this agent. Filenames must end with .ts,
        .js, .mjs, or .cjs.
      </span>
      {workflowsQuery.isLoading ? (
        <SkeletonBlock />
      ) : workflowsQuery.error ? (
        <div className="editor-error" role="alert">
          {errorText(workflowsQuery.error)}
        </div>
      ) : (
        <div className="editor__tools-list">
          {workflows.map((workflow) => (
            <div
              key={workflow.id}
              className={`editor__tool-item${
                workflow.id === selectedId ? ' editor__tool-item--active' : ''
              }`}
            >
              <button
                type="button"
                className="editor__tools-link"
                onClick={() => selectWorkflow(workflow.id)}
              >
                {workflow.label}
              </button>
              <span className="editor__tool-desc">{workflow.id}</span>
              {!locked && (
                <button
                  type="button"
                  className="editor-enrich-btn"
                  onClick={() => setDeleteTarget(workflow.id)}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {creating && (
        <div className="editor__tools-server">
          <label className="editor-label" htmlFor="agent-workflow-filename">
            Filename
          </label>
          <input
            id="agent-workflow-filename"
            className="editor-input"
            placeholder="review-draft.ts"
            value={newFilename}
            onChange={(event) => setNewFilename(event.target.value)}
          />
          <label className="editor-label" htmlFor="agent-workflow-new-content">
            Content
          </label>
          <textarea
            id="agent-workflow-new-content"
            className="editor-input"
            rows={8}
            value={newContent}
            onChange={(event) => setNewContent(event.target.value)}
          />
          <div className="editor-label-row__actions">
            <button
              type="button"
              className="editor-btn"
              disabled={createMutation.isPending || newFilename.trim() === ''}
              onClick={() =>
                createMutation.mutate({
                  filename: newFilename.trim(),
                  content: newContent,
                })
              }
            >
              {createMutation.isPending ? 'Creating…' : 'Create workflow'}
            </button>
            <button
              type="button"
              className="editor-enrich-btn"
              onClick={() => {
                guard(() => {
                  setCreating(false);
                  setNewFilename('');
                  setNewContent('');
                  setActionError(null);
                });
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {showEditor && selectedId !== null && (
        <div className="editor__tools-server">
          <div className="editor__tool-name">{selectedId}</div>
          {contentQuery.isLoading ? (
            <SkeletonBlock />
          ) : contentQuery.error ? (
            <div className="editor-error" role="alert">
              {errorText(contentQuery.error)}
            </div>
          ) : (
            <>
              <label className="editor-label" htmlFor="agent-workflow-content">
                Content
              </label>
              <textarea
                id="agent-workflow-content"
                className="editor-input"
                rows={12}
                value={draft ?? ''}
                onChange={(event) => setDraft(event.target.value)}
                disabled={locked}
              />
              <div className="editor-label-row__actions">
                <button
                  type="button"
                  className="editor-btn"
                  disabled={locked || !dirty || updateMutation.isPending}
                  onClick={() =>
                    updateMutation.mutate({
                      workflowId: selectedId,
                      content: draft ?? '',
                    })
                  }
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="editor-enrich-btn"
                  disabled={locked || updateMutation.isPending}
                  onClick={() =>
                    guard(() => {
                      setDraft(baseline);
                      setActionError(null);
                    })
                  }
                >
                  Revert
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {actionError && (
        <div className="editor-error" role="alert">
          {actionError}
        </div>
      )}
      {deleteTarget !== null && (
        <ConfirmModal
          isOpen
          title="Delete workflow?"
          message={`This permanently deletes ${deleteTarget} from this agent's workflows. Agents that reference it will no longer run it.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => deleteMutation.mutate(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      <DiscardModal />
    </div>
  );
}
