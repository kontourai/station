import type {
  RepositoryAcquisition,
  RepositoryAcquisitionRequest,
} from '@kontourai/station-contracts/project';
import {
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import { Button } from '../Button';
import { RepositoryProviderPicker } from './RepositoryProviderPicker';

interface Props {
  onUseCheckout: (path: string, name: string, acquisitionId: string) => void;
  onBusyChange: (busy: boolean) => void;
}

export function NewProjectRepositorySource(props: Props) {
  const scope = useHostRequestAuthorityScope();
  if (!scope) return null;
  return (
    <RepositorySourceControls
      key={JSON.stringify([scope.apiBase, scope.authorityKey])}
      {...props}
      scope={scope}
    />
  );
}

function retainedId(key: string) {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function RepositorySourceControls({
  scope,
  onUseCheckout,
  onBusyChange,
}: Props & {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const storageKey = JSON.stringify([
    'repository-acquisition',
    scope.apiBase,
    scope.draftRecoveryKey,
  ]);
  const [requestId, setRequestId] = useState(() => retainedId(storageKey));
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [storageError, setStorageError] = useState(false);
  const sourceId = useId();
  const refId = useId();
  const client = useQueryClient();
  const key = [
    'repository-acquisition',
    scope.apiBase,
    scope.authorityKey,
    requestId,
  ];
  const acquire = useMutation({
    retry: false,
    mutationFn: async (input: {
      request: RepositoryAcquisitionRequest;
      retry: boolean;
    }) => {
      const path = input.retry
        ? `/api/projects/repository-acquisitions/${encodeURIComponent(input.request.requestId)}/retry`
        : '/api/projects/repository-acquisitions';
      const response = await mutateJson(
        `${scope.apiBase}${path}`,
        'POST',
        { requestScope: scope, timeoutMs: 180000 },
        input.retry ? {} : input.request,
      );
      const data = await readEnvelopeOrThrow<RepositoryAcquisition>(response);
      if (!data) throw new Error('Repository operation was not returned.');
      return data;
    },
    onSuccess: (data) =>
      client.setQueryData(
        [
          'repository-acquisition',
          scope.apiBase,
          scope.authorityKey,
          data.request.requestId,
        ],
        data,
      ),
  });
  const operation = useQuery({
    queryKey: key,
    enabled: Boolean(requestId) && !acquire.isPending,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.phase === 'acquiring' ? 2000 : false,
    queryFn: async () => {
      const response = await getJson(
        `${scope.apiBase}/api/projects/repository-acquisitions/${encodeURIComponent(requestId)}`,
        { requestScope: scope },
      );
      const data = await readEnvelopeOrThrow<RepositoryAcquisition>(response);
      if (!data) throw new Error('Repository operation was not returned.');
      return data;
    },
  });
  useEffect(() => {
    onBusyChange(acquire.isPending);
    return () => onBusyChange(false);
  }, [acquire.isPending, onBusyChange]);

  function begin() {
    const id = crypto.randomUUID();
    // Retain identity before dispatch so a lost response can be inspected.
    try {
      sessionStorage.setItem(storageKey, id);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
    setRequestId(id);
    acquire.mutate({
      request: {
        requestId: id,
        sourceUrl: sourceUrl.trim(),
        ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
      },
      retry: false,
    });
  }
  function clear() {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      setStorageError(true);
    }
    setRequestId('');
    acquire.reset();
  }
  const record = operation.data;
  return (
    <details className="new-project-modal__options">
      <summary>Start from a Git repository</summary>
      <p className="editor-hint">
        Station creates a working copy on this host using its Git credentials.
        Repository setup commands require a separate step.
      </p>
      {!requestId ? (
        <>
          <RepositoryProviderPicker
            scope={scope}
            onChoose={(url, branch) => {
              setSourceUrl(url);
              setSourceRef(branch ?? '');
            }}
          />
          <label className="editor-label" htmlFor={sourceId}>
            Repository URL
          </label>
          <input
            className="editor-input"
            id={sourceId}
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://github.com/owner/repository.git"
            autoComplete="off"
          />
          <label className="editor-label" htmlFor={refId}>
            Branch or tag (optional)
          </label>
          <input
            className="editor-input"
            id={refId}
            value={sourceRef}
            onChange={(event) => setSourceRef(event.target.value)}
            placeholder="Remote default branch"
          />
          <p className="editor-hint">
            Use HTTPS or SSH without credentials in the URL. An absolute path to
            a local Git mirror is also supported. This step requires the Station
            operator.
          </p>
          <Button
            type="button"
            disabled={!sourceUrl.trim() || acquire.isPending}
            onClick={begin}
          >
            Acquire repository
          </Button>
        </>
      ) : (
        <>
          <p className="editor-hint">Operation: {requestId}</p>
          {record && (
            <p>
              {record.request.sourceUrl}
              {record.request.sourceRef ? ` · ${record.request.sourceRef}` : ''}
            </p>
          )}
          {acquire.isPending && (
            <p role="status">Acquiring and verifying repository…</p>
          )}
          {record?.phase === 'ready' && (
            <>
              <p role="status">
                Working copy acquired at commit{' '}
                {record.resolvedCommit?.slice(0, 12)}.
              </p>
              <Button
                type="button"
                disabled={acquire.isPending}
                onClick={() => {
                  if (!scope.isCurrent()) return;
                  onUseCheckout(
                    record.checkoutPath,
                    record.request.sourceUrl
                      .split(/[/:]/)
                      .filter(Boolean)
                      .pop()
                      ?.replace(/\.git$/, '') ?? 'Repository',
                    record.request.requestId,
                  );
                }}
              >
                Use this checkout
              </Button>
            </>
          )}
          {record?.phase === 'failed' && <p role="alert">{record.error}</p>}
          {record?.phase === 'acquiring' && !acquire.isPending && (
            <p role="status">
              Acquisition was started. Check its result before retrying; an
              explicit retry preserves the earlier attempt.
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={acquire.isPending || operation.isFetching}
            onClick={() => void operation.refetch()}
          >
            Check operation
          </Button>
          {record && record.phase !== 'ready' && (
            <Button
              type="button"
              disabled={acquire.isPending}
              onClick={() =>
                acquire.mutate({ request: record.request, retry: true })
              }
            >
              Retry acquisition
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={acquire.isPending}
            onClick={clear}
          >
            Choose another source
          </Button>
        </>
      )}
      {storageError && (
        <p role="alert">
          This browser could not retain the operation ID. Keep it to inspect the
          result after closing this form.
        </p>
      )}
      {record?.phase !== 'ready' && (acquire.error || operation.error) && (
        <p role="alert">
          {userFacingErrorMessage(acquire.error ?? operation.error)}
        </p>
      )}
    </details>
  );
}
