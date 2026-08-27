export const TURN_CHANGED_FILES_UNAVAILABLE_REASONS = [
  'checkpoint_missing',
  'checkpoint_failed',
  'checkpoint_pruned',
  'repository_changed',
  'checkpoint_identity_invalid',
  'diff_failed',
  'diff_output_limit_exceeded',
] as const;

export type TurnChangedFilesUnavailableReason =
  (typeof TURN_CHANGED_FILES_UNAVAILABLE_REASONS)[number];

export interface TurnChangedFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export type TurnChangedFiles =
  | { status: 'available'; files: TurnChangedFile[] }
  | { status: 'unavailable'; reason: TurnChangedFilesUnavailableReason };

export function isTurnChangedFilesUnavailableReason(
  value: unknown,
): value is TurnChangedFilesUnavailableReason {
  return (
    typeof value === 'string' &&
    (TURN_CHANGED_FILES_UNAVAILABLE_REASONS as readonly string[]).includes(
      value,
    )
  );
}
