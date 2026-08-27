/**
 * The ledger's lock is an on-disk coordination contract, so this proof uses
 * real Station child processes rather than a same-process Promise queue.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskAnswerSupportStore } from '../task-answer-support-module.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const sourceUrl = new URL('../task-answer-support-module.ts', import.meta.url)
  .href;
const bundleId = 'sb1.WyJ3b3Jrc3BhY2UiLCIiLCIiLCJhLmpzb24iXQ';
function input(referenceId: string, claimId = 'claim-a') {
  return {
    taskId: 'task-a',
    answerReferenceId: referenceId,
    sessionId: 'session-a',
    turnId: 'turn-a',
    projectSlug: 'project-a',
    bundleId,
    claimId,
  };
}

function child(home: string, operation: 'create' | 'replace', payload: object) {
  const script = `
    import { TaskAnswerSupportStore } from ${JSON.stringify(sourceUrl)};
    const [home, operation, raw] = process.argv.slice(1);
    const store = new TaskAnswerSupportStore(home);
    try {
      const value = JSON.parse(raw);
      const result = operation === 'create' ? await store.create(value) : await store.replace(value);
      process.stdout.write(JSON.stringify({ ok: true, revision: result.revision, id: result.id }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, name: error?.constructor?.name }));
    }
  `;
  return new Promise<{ code: number | null; output: string; stderr: string }>(
    (resolve) => {
      const childProcess = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          script,
          home,
          operation,
          JSON.stringify(payload),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      let output = '';
      let stderr = '';
      childProcess.stdout.on('data', (chunk) => (output += String(chunk)));
      childProcess.stderr.on('data', (chunk) => (stderr += String(chunk)));
      childProcess.on('close', (code) => resolve({ code, output, stderr }));
    },
  );
}

test('separate processes preserve concurrent creates and replay an exact CAS replacement without a partial index', async () => {
  const home = mkdtempSync(join(tmpdir(), 'station-answer-support-process-'));
  roots.push(home);
  const creates = await Promise.all([
    child(home, 'create', input('reference-a')),
    child(home, 'create', input('reference-b')),
  ]);
  for (const result of creates) expect(result.code, result.stderr).toBe(0);
  expect(creates.map((result) => JSON.parse(result.output).ok)).toEqual([
    true,
    true,
  ]);

  const store = new TaskAnswerSupportStore(home);
  expect(await store.readForTask('task-a')).toHaveLength(2);
  const replacements = await Promise.all([
    child(home, 'replace', {
      ...input('reference-a', 'claim-b'),
      expectedRevision: 1,
    }),
    child(home, 'replace', {
      ...input('reference-a', 'claim-b'),
      expectedRevision: 1,
    }),
  ]);
  for (const result of replacements) expect(result.code, result.stderr).toBe(0);
  expect(replacements.map((result) => JSON.parse(result.output))).toEqual([
    expect.objectContaining({ ok: true, revision: 2 }),
    expect.objectContaining({ ok: true, revision: 2 }),
  ]);
  expect(
    (await new TaskAnswerSupportStore(home).readForTask('task-a')).find(
      (r) => r.answerReferenceId === 'reference-a',
    ),
  ).toMatchObject({
    claimId: 'claim-b',
    revision: 2,
  });
  // A crash/corruption-shaped partial write must not be accepted as an empty
  // ledger on restart.
  writeFileSync(
    join(home, 'task-answer-support', 'index.json'),
    '{"schemaVersion":1',
  );
  await expect(
    new TaskAnswerSupportStore(home).readForTask('task-a'),
  ).rejects.toThrow('Answer support unavailable');
}, 120_000);
