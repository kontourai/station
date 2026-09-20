import {
  type CheckpointRestorePreview,
  confirmCheckpointRestore,
  previewCheckpointRestore,
} from '@kontourai/station-sdk/client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  const load = async () => {
    if (!authority || !authority.isCurrent()) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(
        await previewCheckpointRestore(apiBase, sessionId, turnId, authority),
      );
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
                      void queryClient.invalidateQueries({
                        predicate: (query) =>
                          query.queryKey.includes(preview.repoRoot),
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
