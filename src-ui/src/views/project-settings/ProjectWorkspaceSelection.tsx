import type { ProjectExecutionRootMutationRequest } from '@kontourai/station-contracts/project-identity';
import {
  useProjectIdentityQuery,
  useProjectResolutionQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { updateProjectExecutionRoot } from '@kontourai/station-sdk/project-identity';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';

type Draft = {
  repoId: string;
  path: string;
  request: ProjectExecutionRootMutationRequest;
};

export function ProjectWorkspaceSelection({
  slug,
  projectId,
  authority,
}: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope;
}) {
  const identity = useProjectIdentityQuery(slug, {
    requestScope: authority,
    expectedProjectId: projectId,
  });
  const resolution = useProjectResolutionQuery(slug, {
    requestScope: authority,
    requireRequestScope: true,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const repoInput = useId(),
    pathInput = useId();
  const client = useQueryClient();
  const save = useMutation({
    retry: false,
    mutationFn: (request: ProjectExecutionRootMutationRequest) =>
      updateProjectExecutionRoot(authority.apiBase, slug, request, {
        requestScope: authority,
      }),
    onSuccess: () => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
  const { DiscardModal } = useUnsavedGuard(Boolean(draft), () => {
    if (save.isPending) return false;
    setDraft(null);
    save.reset();
    return true;
  });
  const view = identity.data;
  const primary =
    view?.identity.repos.find((repo) => repo.role === 'primary') ??
    (view?.identity.repos.length === 1 ? view.identity.repos[0] : undefined);
  const currentRepo = view?.identity.executionRoot?.repoId ?? primary?.id ?? '';
  const selectedRepo = draft?.repoId ?? currentRepo;
  const selectedPath = draft?.path ?? view?.identity.executionRoot?.path ?? '.';
  const resources =
    resolution.data?.posture === 'backing' ? resolution.data.resources : [];
  const busy = save.isPending || save.isError;
  function change(repoId: string, path: string) {
    if (!view || busy) return;
    if (save.isSuccess) save.reset();
    const expected = draft?.request ?? {
      expectedIdentity: view.identity,
      expectedLocalProjectId: view.association.localProjectId,
      executionRoot: null,
    };
    setDraft({
      repoId,
      path,
      request: { ...expected, executionRoot: { repoId, path } },
    });
  }
  return (
    <section className="project-sources__form" aria-label="Project workspace">
      <h3>Agent starting directory</h3>
      <p>
        A Project can contain several repositories. New sessions start in the
        selected checkout and directory. Other attached repositories remain
        separate sources; this does not combine checkouts into a shared parent
        folder. Existing sessions keep their original directory. Documents
        remain available through Knowledge tools.
      </p>
      {identity.isError || resolution.isError ? (
        <p role="alert">
          Could not read the workspace.{' '}
          {errorText(identity.error ?? resolution.error)}{' '}
          <Button
            onClick={() => {
              void identity.refetch();
              void resolution.refetch();
            }}
          >
            Retry workspace
          </Button>
        </p>
      ) : !view ? (
        <p role="status">Checking workspace…</p>
      ) : !view.identity.repos.length ? (
        <p>
          No local workspace is selected. You can use documents and connected
          tools without one.
        </p>
      ) : (
        <>
          <label htmlFor={repoInput}>Starting repository or folder</label>
          <select
            className="editor-input"
            id={repoInput}
            value={selectedRepo}
            disabled={busy}
            onChange={(event) => change(event.target.value, '.')}
          >
            {!selectedRepo && (
              <option value="">Choose a resource explicitly</option>
            )}
            {view.identity.repos.map((repo) => (
              <option
                key={repo.id}
                value={repo.id}
                disabled={
                  !resources.some(
                    (resource) =>
                      resource.resourceId === repo.id &&
                      resource.state === 'bound',
                  )
                }
              >
                {repo.id}
              </option>
            ))}
          </select>
          <label htmlFor={pathInput}>
            Starting directory within that resource
          </label>
          <input
            className="editor-input"
            id={pathInput}
            value={selectedPath}
            disabled={busy || !selectedRepo}
            onChange={(event) => change(selectedRepo, event.target.value)}
          />
          <p>
            Use . for the checkout root, or a relative directory such as
            apps/web. Source paths and availability are shown above. An
            unavailable resource must be repaired before use.
          </p>
          <Button
            disabled={
              !draft ||
              save.isPending ||
              identity.isFetching ||
              resolution.isFetching ||
              !selectedPath.trim()
            }
            onClick={() => {
              if (save.isError && save.variables) save.mutate(save.variables);
              else if (draft) save.mutate(draft.request);
            }}
          >
            {save.isPending
              ? 'Updating starting directory…'
              : save.isError
                ? 'Retry saved directory choice'
                : 'Apply starting directory'}
          </Button>
          {draft && (
            <Button
              disabled={save.isPending}
              onClick={() => {
                setDraft(null);
                save.reset();
                void identity.refetch();
                void resolution.refetch();
              }}
            >
              Discard directory choice
            </Button>
          )}
        </>
      )}
      {save.isError && (
        <p role="alert">
          {errorText(save.error)} Check the current workspace before retrying; a
          lost response may already have applied this exact choice.
        </p>
      )}
      {save.isSuccess && (
        <p role="status">Starting directory updated for new sessions.</p>
      )}
      <DiscardModal />
    </section>
  );
}
