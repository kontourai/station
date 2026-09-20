import {
  type CheckpointRestorePreview,
  confirmCheckpointRestore,
  previewCheckpointRestore,
} from '@kontourai/station-sdk/client/checkpoint-restore';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { useToast } from '../../contexts/ToastContext';
import { Dialog } from '../Dialog';

function restoreFailureMessage(cause: unknown): string {
  const refusal =
    cause && typeof cause === 'object'
      ? (cause as { reason?: unknown })
      : undefined;
  if (
    typeof refusal?.reason === 'string' &&
    /^(?:workspace_(?:changed|has_active_turn)|preview_invalid|checkpoint_(?:missing|pruned|identity_mismatch)|authorization_changed)$/u.test(
      refusal.reason,
    )
  ) {
    const action =
      refusal.reason === 'workspace_changed'
        ? 'The workspace changed after the preview. Review a new preview.'
        : refusal.reason === 'workspace_has_active_turn'
          ? 'Wait for the active workspace turn to finish, then review a new preview.'
          : refusal.reason === 'checkpoint_missing' ||
              refusal.reason === 'checkpoint_pruned'
            ? 'That checkpoint is no longer available. Choose another checkpoint.'
            : refusal.reason === 'authorization_changed' ||
                refusal.reason === 'preview_invalid'
              ? 'The preview expired or its authority changed. Review a new preview.'
              : 'The checkpoint identity changed. Review a new preview.';
    return `${action} No files were changed.`;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Restore outcome not confirmed: ${detail}. Inspect the workspace before trying again.`;
}

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
  useEffect(() => {
    if (ownerRef.current !== owner) return;
    setPreview(undefined);
    setError(undefined);
    setBusy(false);
  }, [owner]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const load = async () => {
    if (!authority?.isCurrent()) return;
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
      if (operation === generation.current && authority.isCurrent())
        setError(restoreFailureMessage(cause));
    } finally {
      if (operation === generation.current && authority.isCurrent())
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
                  const operation = ++generation.current;
                  const capturedPreview = preview;
                  const capturedAuthority = authority!;
                  setBusy(true);
                  void confirmCheckpointRestore(
                    apiBase,
                    sessionId,
                    turnId,
                    capturedPreview,
                    capturedAuthority,
                  )
                    .then(() => {
                      if (
                        operation !== generation.current ||
                        !capturedAuthority.isCurrent()
                      )
                        return;
                      for (const queryKey of [
                        ['coding-files', capturedPreview.repoRoot],
                        ['coding-diff', capturedPreview.repoRoot],
                        ['git-status', capturedPreview.repoRoot],
                        ['git-log', capturedPreview.repoRoot],
                      ])
                        void queryClient.invalidateQueries({ queryKey });
                      setPreview(undefined);
                      showToast('Workspace restored.');
                    })
                    .catch((cause: unknown) => {
                      if (
                        operation === generation.current &&
                        capturedAuthority.isCurrent()
                      )
                        setError(restoreFailureMessage(cause));
                    })
                    .finally(() => {
                      if (
                        operation === generation.current &&
                        capturedAuthority.isCurrent()
                      )
                        setBusy(false);
                    });
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
          {error && <p role="alert">{error}</p>}
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
