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
    <section aria-label="Add repository source">
      <h3>Add a repository</h3>
      <p>
        Acquire or reuse a verified working copy, then attach it to this
        Project. Existing resources and files are preserved.
      </p>
      {identity.isError ? (
        <p role="alert">
          Could not read current Project identity. {errorText(identity.error)}{' '}
          <Button onClick={() => void identity.refetch()}>Retry</Button>
        </p>
      ) : identity.isPending || identity.isFetching ? (
        <p role="status">Checking current Project identity…</p>
      ) : (
        <NewProjectRepositorySource
          onBusyChange={setBusy}
          onUseCheckout={(path, _name, acquisitionId) => {
            if (!identity.data || identity.isFetching || attach.isPending)
              return;
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
          <label htmlFor={checkboxId}>
            <input
              id={checkboxId}
              type="checkbox"
              checked={useForCode}
              disabled={attach.isPending || attach.isError}
              onChange={(event) => setUseForCode(event.target.checked)}
            />{' '}
            Use this repository for code work in this Project
          </label>
          <p>
            The optional code selection changes the execution root explicitly.
            It does not remove or replace the primary resource.
          </p>
          <Button
            type="button"
            disabled={busy || attach.isPending || identity.isFetching}
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
