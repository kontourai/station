import { envelopeError } from './api-error-message';
import { type ApiRequestScope, mutateJson, StationHttpError } from './http';
import { rethrowDeadline } from './request-deadline';

export type CheckpointRestoreRefusalReason =
  | 'workspace_changed'
  | 'workspace_has_active_turn'
  | 'preview_invalid'
  | 'checkpoint_missing'
  | 'checkpoint_pruned'
  | 'authorization_changed'
  | 'checkpoint_identity_mismatch'
  | 'repository_config_refused'
  | 'repository_config_unreadable';

export type CheckpointRestoreClientError = StationHttpError & {
  readonly reason?: CheckpointRestoreRefusalReason;
};

export interface CheckpointRestorePreview {
  previewId: string;
  threadId: string;
  turnId: string;
  phase: 'baseline' | 'settle';
  checkpointId: string;
  repoRoot: string;
  targetTreeSha: string;
  currentTreeSha: string;
  paths: Array<{ path: string; status: string }>;
  pathsTruncated: boolean;
  expiresAt: string;
}

async function unwrap<T>(response: Response): Promise<T> {
  const fallback = `Checkpoint restore failed: ${response.status}`;
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    throw envelopeError(response, undefined, fallback);
  }
  const envelope = body && typeof body === 'object' ? body : undefined;
  if (
    !response.ok ||
    !envelope ||
    !('success' in envelope) ||
    envelope.success !== true ||
    !('data' in envelope)
  ) {
    const error = envelopeError(response, body, fallback);
    if (envelope && 'reason' in envelope && typeof envelope.reason === 'string')
      Object.assign(error, { reason: envelope.reason });
    throw error;
  }
  return envelope.data as T;
}

export async function previewCheckpointRestore(
  apiBase: string,
  threadId: string,
  turnId: string,
  requestScope: ApiRequestScope,
  phase: CheckpointRestorePreview['phase'] = 'settle',
): Promise<CheckpointRestorePreview> {
  return unwrap(
    await mutateJson(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/checkpoints/${encodeURIComponent(turnId)}/restore-preview`,
      'POST',
      { requestScope, redirect: 'error', readOnly: true },
      { phase },
    ),
  );
}

export async function confirmCheckpointRestore(
  apiBase: string,
  threadId: string,
  turnId: string,
  preview: Pick<CheckpointRestorePreview, 'previewId' | 'currentTreeSha'>,
  requestScope: ApiRequestScope,
): Promise<unknown> {
  return unwrap(
    await mutateJson(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/checkpoints/${encodeURIComponent(turnId)}/restore`,
      'POST',
      { requestScope, redirect: 'error' },
      {
        confirmed: true,
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
      },
    ),
  );
}
