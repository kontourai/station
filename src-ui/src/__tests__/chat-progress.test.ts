import { describe, expect, test } from 'vitest';
import { deriveToolProgressSummary } from '../utils/chat-progress';

describe('chat progress utils', () => {
  test('returns null when there is no running tool', () => {
    expect(deriveToolProgressSummary(undefined)).toBeNull();
    expect(
      deriveToolProgressSummary([
        {
          type: 'tool-invocation',
          name: 'search_files',
          state: 'completed',
        },
      ]),
    ).toBeNull();
  });

  test('builds a fallback label for a running tool without progress text', () => {
    expect(
      deriveToolProgressSummary([
        {
          type: 'tool-invocation',
          name: 'search_files',
          state: 'running',
        },
      ]),
    ).toEqual({
      label: 'Running search files',
      toolName: 'search files',
    });
  });

  test('prefers the most recently updated running tool progress message', () => {
    expect(
      deriveToolProgressSummary([
        {
          type: 'tool-invocation',
          name: 'read_file',
          state: 'running',
          progressMessage: 'Reading repository files',
          activityAt: '2026-04-05T12:00:02.000Z',
        },
        {
          type: 'tool-invocation',
          name: 'grep',
          state: 'running',
          progressMessage: 'Scanning for command handlers',
          activityAt: '2026-04-05T12:00:04.000Z',
        },
      ]),
    ).toEqual({
      label: 'Scanning for command handlers',
      toolName: 'grep',
    });
  });

  test('keeps the newest progress update even when tool parts stay in original order', () => {
    expect(
      deriveToolProgressSummary([
        {
          type: 'tool-invocation',
          name: 'read_file',
          state: 'running',
          progressMessage: 'Reading repository files',
          activityAt: '2026-04-05T12:00:05.000Z',
        },
        {
          type: 'tool-invocation',
          name: 'grep',
          state: 'running',
          progressMessage: 'Scanning for command handlers',
          activityAt: '2026-04-05T12:00:04.000Z',
        },
      ]),
    ).toEqual({
      label: 'Reading repository files',
      toolName: 'read file',
    });
  });
});
