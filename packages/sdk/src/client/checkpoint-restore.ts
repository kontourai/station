import { type ApiRequestScope, mutateJson, StationHttpError } from './http';

export type CheckpointRestoreRefusalReason =
  | 'workspace_changed'
  | 'workspace_has_active_turn'
  | 'preview_invalid'
  | 'checkpoint_missing'
  | 'checkpoint_pruned'
  | 'authorization_changed'
  | 'checkpoint_identity_mismatch';

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
  let body: { success?: boolean; data?: T; error?: string; reason?: unknown };
  try {
    body = await response.json();
  } catch {
    throw new StationHttpError(
      response.status,
      `Checkpoint restore failed: ${response.status}`,
    );
  }
  if (!response.ok || !body.success) {
    const error = new StationHttpError(
      response.status,
      body.error ?? `Checkpoint restore failed: ${response.status}`,
    );
    if (typeof body.reason === 'string')
      Object.assign(error, { reason: body.reason });
    throw error;
  }
  return body.data as T;
}

export async function previewCheckpointRestore(
  apiBase: string,
  threadId: string,
  turnId: string,
  requestScope: ApiRequestScope,
): Promise<CheckpointRestorePreview> {
  return unwrap(
    await mutateJson(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/checkpoints/${encodeURIComponent(turnId)}/restore-preview`,
      'POST',
      { requestScope },
      { phase: 'settle' },
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
      { requestScope },
      {
        confirmed: true,
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
      },
    ),
  );
}
