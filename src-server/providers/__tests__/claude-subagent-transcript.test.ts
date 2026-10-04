/**
 * #3163: a Claude subagent's transcript, read through the REAL SDK reader
 * (`getSubagentMessages`) from a transcript laid out as Claude Code writes it.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
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

  test('no symlink below the config home is followed: a linked session or projects directory finds nothing', async () => {
    const real = installClaudeSubagentTranscript(makeTempDir, {
      asProfile: true,
    });
    const realSession = join(
      real.configDir,
      'projects',
      '-workspace-example',
      TRANSCRIPT_SESSION_ID,
    );
    // Control: the real tree is found.
    expect(
      (
        await readClaudeSubagentTranscriptPage(
          { ...ref, configHome: real.configDir },
          { offset: 0, limit: 30 },
        )
      ).status,
    ).toBe('found');
    const linkedSession = makeTempDir('station-claude-3163-linked-session-');
    mkdirSync(join(linkedSession, 'projects', '-workspace-example'), {
      recursive: true,
    });
    symlinkSync(
      realSession,
      join(
        linkedSession,
        'projects',
        '-workspace-example',
        TRANSCRIPT_SESSION_ID,
      ),
    );
    const linkedProjects = makeTempDir('station-claude-3163-linked-projects-');
    symlinkSync(
      join(real.configDir, 'projects'),
      join(linkedProjects, 'projects'),
    );
    for (const configHome of [linkedSession, linkedProjects]) {
      expect(
        await readClaudeSubagentTranscriptPage(
          { ...ref, configHome },
          { offset: 0, limit: 30 },
        ),
      ).toEqual({ status: 'unavailable' });
    }
  });

  test('a record past the byte cap is skipped as one too-large entry, and reading goes on after it', async () => {
    const profile = installClaudeSubagentTranscript(makeTempDir, {
      asProfile: true,
    });
    const file = join(
      profile.configDir,
      'projects',
      '-workspace-example',
      TRANSCRIPT_SESSION_ID,
      'subagents',
      `agent-${TRANSCRIPT_AGENT_ID}.jsonl`,
    );
    // A 5 MiB record, written a MiB at a time (never held whole here).
    const mib = 'x'.repeat(1024 * 1024);
    appendFileSync(
      file,
      '{"type":"assistant","message":{"role":"assistant","content":"',
    );
    for (let chunk = 0; chunk < 5; chunk++) appendFileSync(file, mib);
    appendFileSync(file, '"}}\n');
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'AFTER THE BIG ONE' }] } })}\n`,
    );
    const outcome = await readClaudeSubagentTranscriptPage(
      { ...ref, configHome: profile.configDir },
      { offset: 0, limit: 30 },
    );
    if (outcome.status !== 'found') throw new Error(outcome.status);
    const kinds = outcome.page.entries.map((entry) => entry.kind);
    expect(kinds.slice(-2)).toEqual(['too-large', 'text']);
    expect(outcome.page.entries.at(-1)).toMatchObject({
      text: 'AFTER THE BIG ONE',
    });
    // The skipped record keeps its place in the message numbering.
    const [big, after] = outcome.page.entries.slice(-2);
    expect(after.message).toBe(big.message + 1);
  });

  describe('a cached path is re-checked on every read', () => {
    /** A profile whose transcript sits one workflow level below `subagents`. */
    function workflowProfile() {
      const profile = installClaudeSubagentTranscript(makeTempDir, {
        asProfile: true,
      });
      const subagents = join(
        profile.configDir,
        'projects',
        '-workspace-example',
        TRANSCRIPT_SESSION_ID,
        'subagents',
      );
      const workflow = join(subagents, 'workflows', 'wf_3163');
      mkdirSync(workflow, { recursive: true });
      const file = join(workflow, `agent-${TRANSCRIPT_AGENT_ID}.jsonl`);
      renameSync(join(subagents, `agent-${TRANSCRIPT_AGENT_ID}.jsonl`), file);
      return { configHome: profile.configDir, subagents, workflow, file };
    }

    async function read(configHome: string) {
      return readClaudeSubagentTranscriptPage(
        { ...ref, configHome },
        { offset: 0, limit: 30 },
      );
    }

    /**
     * Moves `path` OUT of the config home and leaves a symlink to it in its
     * place, so the only way to the transcript is through the link.
     */
    function swapForLink(path: string) {
      const real = join(makeTempDir('station-claude-3163-moved-'), 'target');
      renameSync(path, real);
      symlinkSync(real, path);
    }

    test('the file swapped for a symlink', async () => {
      const tree = workflowProfile();
      expect((await read(tree.configHome)).status).toBe('found');
      swapForLink(tree.file);
      expect(await read(tree.configHome)).toEqual({ status: 'unavailable' });
    });

    test('the subagents directory swapped for a symlink', async () => {
      const tree = workflowProfile();
      expect((await read(tree.configHome)).status).toBe('found');
      swapForLink(tree.subagents);
      expect(await read(tree.configHome)).toEqual({ status: 'unavailable' });
    });

    test('a workflow level swapped for a symlink', async () => {
      const tree = workflowProfile();
      expect((await read(tree.configHome)).status).toBe('found');
      swapForLink(tree.workflow);
      expect(await read(tree.configHome)).toEqual({ status: 'unavailable' });
    });

    test.skipIf(process.platform === 'win32')(
      'the file swapped for a FIFO is refused without blocking',
      async () => {
        const tree = workflowProfile();
        expect((await read(tree.configHome)).status).toBe('found');
        renameSync(tree.file, `${tree.file}-real`);
        execFileSync('mkfifo', [tree.file]);
        expect(await read(tree.configHome)).toEqual({ status: 'unavailable' });
      },
      5_000,
    );
  });
});
