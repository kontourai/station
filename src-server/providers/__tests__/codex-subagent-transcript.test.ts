/**
 * A Codex child thread's transcript, read from a rollout laid out as Codex
 * writes it (`codex-subagent-rollout-fixture.ts`).
 */
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS } from '@kontourai/station-contracts/child-work';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  codexThreadIdTime,
  readCodexSubagentTranscriptPage,
} from '../adapters/codex-subagent-transcript.js';
import {
  CODEX_ROLLOUT_THREAD_ID,
  codexRolloutDay,
  installCodexSubagentRollout,
} from './codex-subagent-rollout-fixture.js';

const makeTempDir = trackTempDirs();

const ref = (home: string, threadId = CODEX_ROLLOUT_THREAD_ID) => ({
  kind: 'codex-thread' as const,
  threadId,
  configHome: home,
});

async function readAll(home: string, threadId?: string) {
  const outcome = await readCodexSubagentTranscriptPage(ref(home, threadId), {
    offset: 0,
    limit: 50,
  });
  if (outcome.status !== 'found') throw new Error(outcome.status);
  return outcome.page;
}

describe('Codex subagent transcript (rollout file)', () => {
  test('reads the child conversation in order; injected context, developer text and reasoning left out', async () => {
    const { home } = installCodexSubagentRollout(makeTempDir);
    const page = await readAll(home);
    expect(page.nextOffset).toBeUndefined();
    expect(
      page.entries.map((entry) =>
        entry.kind === 'text'
          ? `${entry.role}: ${entry.text}`
          : entry.kind === 'tool-call'
            ? `call ${entry.name}`
            : entry.kind === 'tool-result'
              ? `result ${entry.text ?? '(none)'}`
              : entry.kind,
      ),
    ).toEqual([
      'user: Message Type: NEW_TASK\nTask name: /root/fixture_review\nReview the fixture.',
      'assistant: I will look at the repository first.',
      'call exec',
      'result Script completed\nOutput:\n\n## main...origin/main',
      'call collaboration.send_message',
      'result (none)',
      'assistant: Findings: the fixture is clean.',
    ]);
    expect(page.entries[2]).toMatchObject({
      input: 'text(await tools.exec_command({cmd:"git status -sb"}))',
    });
    const all = JSON.stringify(page);
    // The AGENTS.md / environment context Codex injects as a user message.
    expect(all).not.toContain('AGENTS.md instructions');
    expect(all).not.toContain('environment_context');
    const texts = page.entries.flatMap((entry) =>
      'text' in entry && entry.text ? [entry.text] : [],
    );
    // The task's encrypted block and the reasoning's are never shown...
    expect(texts).not.toContain('gAAAAA-scrubbed');
    // ...nor developer instructions or reasoning summaries (both scrubbed).
    expect(texts).not.toContain('scrubbed');
  });

  test('pages by message: the next offset continues where the bounded page stopped', async () => {
    const { home } = installCodexSubagentRollout(makeTempDir);
    const first = await readCodexSubagentTranscriptPage(ref(home), {
      offset: 0,
      limit: 2,
    });
    if (first.status !== 'found') throw new Error(first.status);
    expect(first.page.nextOffset).toBe(2);
    expect(first.page.entries.map((entry) => entry.message)).toEqual([0, 1]);
    const rest = await readCodexSubagentTranscriptPage(ref(home), {
      offset: 2,
      limit: 50,
    });
    if (rest.status !== 'found') throw new Error(rest.status);
    expect(rest.page.nextOffset).toBeUndefined();
    expect(rest.page.entries.map((entry) => entry.message)).toEqual([
      2, 3, 4, 5, 6,
    ]);
    expect([...first.page.entries, ...rest.page.entries]).toEqual(
      (await readAll(home)).entries,
    );
  });

  test('a running child reads what Codex has appended since the last read', async () => {
    const { home, file } = installCodexSubagentRollout(makeTempDir);
    expect((await readAll(home)).entries).toHaveLength(7);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      file,
      `${JSON.stringify({
        timestamp: '2026-10-21T03:42:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'One more thing.' }],
        },
      })}\n`,
    );
    expect((await readAll(home)).entries.at(-1)).toMatchObject({
      kind: 'text',
      role: 'assistant',
      text: 'One more thing.',
    });
  });

  test('a rollout whose session_meta names another thread is not this child’s', async () => {
    const { home } = installCodexSubagentRollout(makeTempDir, {
      metaThreadId: '01a15c8b-0000-7000-8000-000000000099',
    });
    await expect(
      readCodexSubagentTranscriptPage(ref(home), { offset: 0, limit: 50 }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('a symlinked day directory is refused, though the file behind it is real', async () => {
    const { home } = installCodexSubagentRollout(makeTempDir);
    const [year, month, day] = codexRolloutDay(CODEX_ROLLOUT_THREAD_ID);
    const real = join(home, 'elsewhere');
    renameSync(join(home, 'sessions', year, month, day), real);
    symlinkSync(real, join(home, 'sessions', year, month, day));
    await expect(
      readCodexSubagentTranscriptPage(ref(home), { offset: 0, limit: 50 }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('a symlinked rollout file is refused', async () => {
    const elsewhere = installCodexSubagentRollout(makeTempDir);
    const home = makeTempDir('station-codex-home-');
    const [year, month, day] = codexRolloutDay(CODEX_ROLLOUT_THREAD_ID);
    const directory = join(home, 'sessions', year, month, day);
    mkdirSync(directory, { recursive: true });
    symlinkSync(
      elsewhere.file,
      join(directory, `rollout-x-${CODEX_ROLLOUT_THREAD_ID}.jsonl`),
    );
    await expect(
      readCodexSubagentTranscriptPage(ref(home), { offset: 0, limit: 50 }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('the ref’s home is the one read; another home’s rollout is not found', async () => {
    installCodexSubagentRollout(makeTempDir);
    const empty = makeTempDir('station-codex-home-');
    mkdirSync(join(empty, 'sessions'));
    await expect(
      readCodexSubagentTranscriptPage(ref(empty), { offset: 0, limit: 50 }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('a rollout filed under another day is found by the bounded recent-days search', async () => {
    const { home } = installCodexSubagentRollout(makeTempDir, {
      day: ['2026', '01', '15'],
    });
    expect(codexRolloutDay(CODEX_ROLLOUT_THREAD_ID).join('/')).not.toBe(
      '2026/01/15',
    );
    expect((await readAll(home)).entries).toHaveLength(7);
  });

  test('a long output is cut at the contract bound and flagged', async () => {
    const long = 'x'.repeat(CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS + 10);
    const { home } = installCodexSubagentRollout(makeTempDir, {
      extraRecords: [
        {
          timestamp: '2026-10-21T03:42:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_9999',
            output: long,
          },
        },
      ],
    });
    expect((await readAll(home)).entries.at(-1)).toMatchObject({
      kind: 'tool-result',
      text: 'x'.repeat(CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS),
      truncated: true,
    });
  });

  test('the thread id’s own UUIDv7 time names its day; other versions name none', () => {
    expect(codexThreadIdTime(CODEX_ROLLOUT_THREAD_ID)).toBe(0x01a15c8b0000);
    expect(
      codexThreadIdTime('00000000-0000-4000-8000-000000000003'),
    ).toBeUndefined();
  });
});
