import { describe, expect, test } from 'vitest';
import {
  deriveToolProgressSummary,
  formatToolName,
} from '../utils/chat-progress';

describe('formatToolName', () => {
  test('humanizes a programmatic name', () => {
    expect(formatToolName('shell_exec')).toBe('shell exec');
    expect(formatToolName('mcp__github__create_issue')).toBe(
      'mcp github create issue',
    );
    expect(formatToolName('github/create-issue')).toBe('github/create-issue');
    // Deliberate: a hyphenated single token is kept as written.
    expect(formatToolName('git-lfs')).toBe('git-lfs');
  });

  test('never rewrites display text: a command line or a path is shown as written', () => {
    for (const title of [
      'ps -o pid,lstart -p 946878',
      "git -c core.sshCommand='ssh -F /dev/null' fetch origin --quiet",
      'npm run gate:for -- Dockerfile docs/user/getting-started.md',
      'STATION_DOCS_FRESHNESS=scoped npm run docs:check',
      'docs/user/getting-started.md',
    ])
      expect(formatToolName(title)).toBe(title);
    expect(formatToolName('  echo  a\n b ')).toBe('echo a b');
  });
});

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
