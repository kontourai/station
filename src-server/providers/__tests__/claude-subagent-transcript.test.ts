/**
 * #3163: a Claude subagent's transcript, read through the REAL SDK reader
 * (`getSubagentMessages`) from a transcript laid out as Claude Code writes it.
 */
import { CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS } from '@kontourai/station-contracts/child-work';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  claudeTranscriptEntries,
  readClaudeSubagentTranscriptPage,
} from '../adapters/claude-subagent-transcript.js';
import {
  installClaudeSubagentTranscript,
  TRANSCRIPT_AGENT_ID,
  TRANSCRIPT_SESSION_ID,
} from './claude-subagent-transcript-fixture.js';

const ref = {
  kind: 'claude-subagent' as const,
  sessionId: TRANSCRIPT_SESSION_ID,
  agentId: TRANSCRIPT_AGENT_ID,
};

const makeTempDir = trackTempDirs();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('#3163 Claude subagent transcript', () => {
  test('reads the agent conversation in order: prompt, tool call, tool result, answer; thinking and attachments left out', async () => {
    ({ restore } = installClaudeSubagentTranscript(makeTempDir));
    const outcome = await readClaudeSubagentTranscriptPage(ref, {
      offset: 0,
      limit: 30,
    });
    expect(outcome.status).toBe('found');
    if (outcome.status !== 'found') return;
    expect(outcome.page.nextOffset).toBeUndefined();
    expect(outcome.page.entries.map((entry) => entry.kind)).toEqual([
      'text',
      'tool-call',
      'tool-result',
      'text',
    ]);
    expect(outcome.page.entries[0]).toMatchObject({
      kind: 'text',
      role: 'user',
      text: expect.stringMatching(/^Use the Task tool yourself/),
    });
    expect(outcome.page.entries[1]).toMatchObject({
      kind: 'tool-call',
      name: 'Agent',
      input: expect.stringContaining('Reply with exactly INNER DONE'),
    });
    expect(outcome.page.entries[2]).toEqual(
      expect.objectContaining({ kind: 'tool-result', text: 'INNER DONE' }),
    );
    expect(outcome.page.entries[3]).toMatchObject({
      kind: 'text',
      role: 'assistant',
      text: 'INNER DONE',
    });
  });

  test('pages by message: a bounded page names the next offset, and the next page continues it', async () => {
    ({ restore } = installClaudeSubagentTranscript(makeTempDir));
    const first = await readClaudeSubagentTranscriptPage(ref, {
      offset: 0,
      limit: 2,
    });
    if (first.status !== 'found') throw new Error(first.status);
    expect(first.page.nextOffset).toBe(2);
    const second = await readClaudeSubagentTranscriptPage(ref, {
      offset: 2,
      limit: 30,
    });
    if (second.status !== 'found') throw new Error(second.status);
    expect(second.page.nextOffset).toBeUndefined();
    const messages = [...first.page.entries, ...second.page.entries].map(
      (entry) => entry.message,
    );
    // Message indexes run on across pages.
    expect(messages).toEqual([...messages].sort((a, b) => a - b));
    expect(second.page.entries.at(-1)).toMatchObject({ text: 'INNER DONE' });
  });

  test('the ref’s config home wins over the server’s: a profile session reads its own transcript', async () => {
    ({ restore } = installClaudeSubagentTranscript(makeTempDir, {
      withAgent: false,
    }));
    const profile = installClaudeSubagentTranscript(makeTempDir, {
      asProfile: true,
    });
    expect(
      (await readClaudeSubagentTranscriptPage(ref, { offset: 0, limit: 30 }))
        .status,
    ).toBe('unavailable');
    const outcome = await readClaudeSubagentTranscriptPage(
      { ...ref, configHome: profile.configDir },
      { offset: 0, limit: 30 },
    );
    expect(outcome.status).toBe('found');
  });

  test('inline image data is redacted before any cut, in text, tool input and tool result', () => {
    const image = `data:image/png;base64,${'A'.repeat(CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS * 2)}`;
    const entries = claudeTranscriptEntries(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `Screenshot: ${image}` },
            { type: 'tool_use', name: 'Write', input: { content: image } },
            {
              type: 'tool_result',
              content: [{ type: 'text', text: `saved ${image}` }],
            },
          ],
        },
      },
      0,
    );
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      const text = JSON.stringify(entry);
      expect(text).not.toContain('base64,');
      expect(text).toContain('[inline image data omitted]');
      expect(entry.truncated).toBeUndefined();
    }
  });

  test('a cut never splits a surrogate pair', () => {
    const text = `${'x'.repeat(CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS - 1)}😀😀`;
    const [entry] = claudeTranscriptEntries(
      { type: 'user', message: { role: 'user', content: text } },
      0,
    );
    if (entry.kind !== 'text') throw new Error('kind');
    expect(entry.truncated).toBe(true);
    expect(entry.text.endsWith('😀')).toBe(true);
    expect(entry.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  test('an agent with no transcript on disk is unavailable, not an empty transcript', async () => {
    ({ restore } = installClaudeSubagentTranscript(makeTempDir, {
      withAgent: false,
    }));
    expect(
      await readClaudeSubagentTranscriptPage(ref, {
        offset: 0,
        limit: 30,
      }),
    ).toEqual({ status: 'unavailable' });
  });

  test('entries are bounded: long text is cut and flagged', () => {
    const entries = claudeTranscriptEntries(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'x'.repeat(CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS + 1),
            },
          ],
        },
      },
      0,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'text', truncated: true });
    if (entries[0].kind !== 'text') throw new Error('kind');
    expect(entries[0].text).toHaveLength(CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS);
  });
});
