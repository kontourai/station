import {
  type CheckpointRestorePreview,
  confirmCheckpointRestore,
  previewCheckpointRestore,
} from '@kontourai/station-sdk/client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { useToast } from '../../contexts/ToastContext';
import { Dialog } from '../Dialog';

export function CheckpointRestoreButton({
  sessionId,
  turnId,
}: {
  sessionId: string;
  turnId: string;
}) {
  const { apiBase } = useApiBase();
  const authority = useHostRequestAuthorityScope();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<CheckpointRestorePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const owner = `${sessionId}\0${turnId}\0${authority?.authorityKey ?? ''}`;
  const ownerRef = useRef(owner);
  if (ownerRef.current !== owner) {
    ownerRef.current = owner;
    generation.current += 1;
  }
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const load = async () => {
    if (!authority || !authority.isCurrent()) return;
    setBusy(true);
    setError(undefined);
    const operation = ++generation.current;
    try {
      const result = await previewCheckpointRestore(
        apiBase,
        sessionId,
        turnId,
        authority,
      );
      if (operation === generation.current && authority.isCurrent())
        setPreview(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="button button--secondary"
        disabled={busy || !authority}
        onClick={() => void load()}
      >
        {busy ? 'Checking workspace…' : 'Restore workspace to here…'}
      </button>
      {error && !preview && <span role="alert">{error}</span>}
      {preview && (
        <Dialog
          title="Restore workspace?"
          closeLabel="Cancel workspace restore"
          onClose={() => {
            if (!busy) setPreview(undefined);
          }}
          dismissible={!busy}
          role="alertdialog"
          footer={
            <>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => setPreview(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void confirmCheckpointRestore(
                    apiBase,
                    sessionId,
                    turnId,
                    preview,
                    authority!,
                  )
                    .then(() => {
                      if (!authority?.isCurrent()) return;
                      void queryClient.invalidateQueries({
                        queryKey: ['git-status', preview.repoRoot],
                      });
                      void queryClient.invalidateQueries({
                        queryKey: ['git-log', preview.repoRoot],
                      });
                      setPreview(undefined);
                      showToast('Workspace restored.');
                    })
                    .catch((cause: unknown) =>
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Restore workspace
              </button>
            </>
          }
        >
          <p>
            This changes files only. Conversation history and external tool
            effects are not undone.
          </p>
          {busy && <p role="status">Restoring workspace…</p>}
          {error && (
            <p role="alert">
              Restore outcome not confirmed: {error}. Inspect the workspace
              before trying again.
            </p>
          )}
          <ul>
            {preview.paths.map((path) => (
              <li key={`${path.status}:${path.path}`}>
                {path.status} {path.path}
              </li>
            ))}
          </ul>
          {preview.pathsTruncated && <p>Additional paths are not shown.</p>}
        </Dialog>
      )}
    </>
  );
}
