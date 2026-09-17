import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';
import {
  isSessionSourceAffinity,
  snapshotSessionSourceAffinity,
} from '../sessions/session-source-affinity.js';

export interface ClaudeSourceResumeCursor {
  claudeSessionId: string;
  sourceAffinity: ProviderSessionSourceAffinity;
}

/** Legacy string cursors stay valid; source-bound children retain their home. */
export function claudeSourceResumeCursor(
  value: unknown,
): ClaudeSourceResumeCursor | undefined {
  if (value === undefined || typeof value === 'string') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Claude resume cursor is invalid.');
  const cursor = value as Record<string, unknown>;
  if (
    typeof cursor.claudeSessionId !== 'string' ||
    !cursor.claudeSessionId.trim() ||
    Buffer.byteLength(cursor.claudeSessionId) > 512 ||
    !isSessionSourceAffinity(cursor.sourceAffinity) ||
    cursor.sourceAffinity.kind !== 'claude-config-home'
  )
    throw new Error('Claude source resume cursor is invalid.');
  return Object.freeze({
    claudeSessionId: cursor.claudeSessionId,
    sourceAffinity: snapshotSessionSourceAffinity(cursor.sourceAffinity),
  });
}

export function claudeResumeSessionId(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : claudeSourceResumeCursor(value)?.claudeSessionId;
}
