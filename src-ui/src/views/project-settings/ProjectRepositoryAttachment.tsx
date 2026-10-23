import type { ProjectIdentityView } from '@kontourai/station-contracts/project-identity';
import {
  mutateJson,
  readEnvelopeOrThrow,
  useProjectIdentityQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { NewProjectRepositorySource } from '../../components/modals/NewProjectRepositorySource';
import { errorText } from '../../utils/errorText';

export function ProjectRepositoryAttachment({
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
  const client = useQueryClient();
  const [selection, setSelection] = useState<{
    acquisitionId: string;
    path: string;
    expected: ProjectIdentityView;
  } | null>(null);
  const [useForCode, setUseForCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const checkboxId = useId();
  const attach = useMutation({
    retry: false,
    mutationFn: async (intent: {
      expectedIdentity: ProjectIdentityView['identity'];
      expectedLocalProjectId: string;
      acquisitionId: string;
      useForCode: boolean;
    }) => {
      const response = await mutateJson(
        `${authority.apiBase}/api/projects/${encodeURIComponent(slug)}/identity/repositories`,
        'POST',
        { requestScope: authority },
        intent,
      );
      const result = await readEnvelopeOrThrow<ProjectIdentityView>(response);
      if (!result) throw new Error('Repository attachment was not returned.');
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['projects', slug] });
      setSelection(null);
    },
  });
  return (
    <section
      className="project-sources__form"
      aria-label="Add repository source"
    >
      <h3>Add a repository</h3>
      <p>
        Choose a repository to add to this Project. You can download a working
        copy or reuse one on this Station. Existing files stay in place.
      </p>
      {identity.isError ? (
        <p role="alert">
          Could not read current Project identity. {errorText(identity.error)}{' '}
          <Button onClick={() => void identity.refetch()}>Retry</Button>
        </p>
      ) : identity.isPending ? (
        <p role="status">Checking current Project identity…</p>
      ) : (
        <NewProjectRepositorySource
          onBusyChange={setBusy}
          onUseCheckout={(path, _name, acquisitionId) => {
            if (!identity.data || attach.isPending) return;
            attach.reset();
            setSelection({ path, acquisitionId, expected: identity.data });
          }}
        />
      )}
      {selection && (
        <>
          <p>
            Selected working copy: <code>{selection.path}</code>
          </p>
          <label className="project-sources__consent" htmlFor={checkboxId}>
            <input
              id={checkboxId}
              type="checkbox"
              checked={useForCode}
              disabled={attach.isPending || attach.isError}
              onChange={(event) => setUseForCode(event.target.checked)}
            />{' '}
            Use this repository for code work in this Project
          </label>
          {!selection.expected.identity.repos.length && (
            <p>
              This Project has no existing resource. Choose code work explicitly
              to attach its first repository.
            </p>
          )}
          <p>
            Choosing it for code work changes where new Agent sessions start.
            Other sources stay attached.
          </p>
          <Button
            type="button"
            disabled={
              busy ||
              attach.isPending ||
              identity.isFetching ||
              (!selection.expected.identity.repos.length && !useForCode)
            }
            onClick={() =>
              attach.mutate(
                attach.isError && attach.variables
                  ? attach.variables
                  : {
                      expectedIdentity: selection.expected.identity,
                      expectedLocalProjectId:
                        selection.expected.association.localProjectId,
                      acquisitionId: selection.acquisitionId,
                      useForCode,
                    },
              )
            }
          >
            {attach.isPending
              ? 'Attaching…'
              : attach.isError
                ? 'Retry saved attachment'
                : 'Attach repository'}
          </Button>
        </>
      )}
      {attach.isError && (
        <p role="alert">
          {errorText(attach.error)} Check Sources before retrying; a binding may
          already have been recorded. Existing files are preserved.
        </p>
      )}
      {attach.isSuccess && (
        <p role="status">
          Repository attached. Sources reflects its current state.
        </p>
      )}
    </section>
  );
}
