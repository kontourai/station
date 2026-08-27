import {
  parseWorkspaceOpenFilePreviewIntent,
  type WorkspaceOpenFilePreviewIntent,
} from '@kontourai/station-contracts/workspace-file-preview';

export type OpenFilePreviewIntent = WorkspaceOpenFilePreviewIntent;

export const OPEN_FILE_PREVIEW_QUERY_KEYS = {
  path: 'previewPath',
  lineStart: 'previewLineStart',
  lineEnd: 'previewLineEnd',
} as const;

function parseCanonicalPositiveInteger(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parses only the canonical shareable File Preview query shape. The Project
 * identity remains route-owned, so a link can never select another Project.
 */
export function parseOpenFilePreviewIntent(
  projectSlug: string | null | undefined,
  search: URLSearchParams,
): OpenFilePreviewIntent | null {
  const path = search.get(OPEN_FILE_PREVIEW_QUERY_KEYS.path);
  const start = search.get(OPEN_FILE_PREVIEW_QUERY_KEYS.lineStart);
  const end = search.get(OPEN_FILE_PREVIEW_QUERY_KEYS.lineEnd);
  if (!path || !projectSlug || (start === null) !== (end === null)) return null;

  const lineRange =
    start === null
      ? undefined
      : (() => {
          const parsedStart = parseCanonicalPositiveInteger(start);
          const parsedEnd = parseCanonicalPositiveInteger(end);
          return parsedStart === null || parsedEnd === null
            ? null
            : { start: parsedStart, end: parsedEnd };
        })();
  if (lineRange === null) return null;
  return parseWorkspaceOpenFilePreviewIntent({ projectSlug, path, lineRange });
}

/** Serializes the one canonical query representation, including both range ends. */
export function serializeOpenFilePreviewIntent(
  intent: OpenFilePreviewIntent,
): Record<string, string> | null {
  const normalized = parseWorkspaceOpenFilePreviewIntent(intent);
  if (!normalized) return null;
  return {
    [OPEN_FILE_PREVIEW_QUERY_KEYS.path]: normalized.path,
    ...(normalized.lineRange
      ? {
          [OPEN_FILE_PREVIEW_QUERY_KEYS.lineStart]: String(
            normalized.lineRange.start,
          ),
          [OPEN_FILE_PREVIEW_QUERY_KEYS.lineEnd]: String(
            normalized.lineRange.end,
          ),
        }
      : {}),
  };
}

/** Builds the canonical route for sharing one exact preview. */
export function openFilePreviewDirectLink(
  intent: OpenFilePreviewIntent,
  layoutSlug: string | null | undefined,
): string | null {
  const params = serializeOpenFilePreviewIntent(intent);
  const layout = layoutSlug?.trim();
  if (!params || !layout) return null;
  return `/projects/${encodeURIComponent(intent.projectSlug)}/layouts/${encodeURIComponent(layout)}?${new URLSearchParams(params).toString()}`;
}

/** Parameters that clear every canonical File Preview query field. */
export function clearOpenFilePreviewIntent(): Record<string, null> {
  return {
    [OPEN_FILE_PREVIEW_QUERY_KEYS.path]: null,
    [OPEN_FILE_PREVIEW_QUERY_KEYS.lineStart]: null,
    [OPEN_FILE_PREVIEW_QUERY_KEYS.lineEnd]: null,
  };
}
