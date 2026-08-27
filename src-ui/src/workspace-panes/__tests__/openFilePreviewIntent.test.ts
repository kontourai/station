import { describe, expect, test } from 'vitest';
import {
  OPEN_FILE_PREVIEW_QUERY_KEYS,
  openFilePreviewDirectLink,
  parseOpenFilePreviewIntent,
  serializeOpenFilePreviewIntent,
} from '../openFilePreviewIntent';

describe('OpenFilePreviewIntent direct link', () => {
  test('round-trips the exact project path and inclusive range', () => {
    const intent = {
      projectSlug: 'station',
      path: 'src-ui/src/App.tsx',
      lineRange: { start: 12, end: 18 },
    };
    const params = serializeOpenFilePreviewIntent(intent)!;

    expect(
      parseOpenFilePreviewIntent('station', new URLSearchParams(params)),
    ).toEqual(intent);
    expect(openFilePreviewDirectLink(intent, 'coding')).toBe(
      '/projects/station/layouts/coding?previewPath=src-ui%2Fsrc%2FApp.tsx&previewLineStart=12&previewLineEnd=18',
    );
  });

  test('rejects incomplete, noncanonical, and path-escaping direct links', () => {
    expect(
      parseOpenFilePreviewIntent(
        'station',
        new URLSearchParams({
          [OPEN_FILE_PREVIEW_QUERY_KEYS.path]: '../secret',
        }),
      ),
    ).toBeNull();
    expect(
      parseOpenFilePreviewIntent(
        'station',
        new URLSearchParams({
          [OPEN_FILE_PREVIEW_QUERY_KEYS.path]: 'src/App.tsx',
          [OPEN_FILE_PREVIEW_QUERY_KEYS.lineStart]: '08',
          [OPEN_FILE_PREVIEW_QUERY_KEYS.lineEnd]: '9',
        }),
      ),
    ).toBeNull();
    expect(
      parseOpenFilePreviewIntent(
        'station',
        new URLSearchParams({
          [OPEN_FILE_PREVIEW_QUERY_KEYS.path]: 'src/App.tsx',
          [OPEN_FILE_PREVIEW_QUERY_KEYS.lineStart]: '8',
        }),
      ),
    ).toBeNull();
  });
});
