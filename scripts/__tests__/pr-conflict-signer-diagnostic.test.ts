import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const temp = trackTempDirs();
const base = 'b'.repeat(40);
const head = 'a'.repeat(40);
const repository = 'kontourai/station';

test.each([
  [
    'confirmed conflict',
    false,
    '',
    '42',
    'workflow_dispatch',
    'refs/heads/main',
    true,
  ],
  ['mergeable', true, '', '42', 'workflow_dispatch', 'refs/heads/main', false],
  ['unknown', null, '', '42', 'workflow_dispatch', 'refs/heads/main', false],
  [
    'moving head',
    false,
    'head',
    '42',
    'workflow_dispatch',
    'refs/heads/main',
    false,
  ],
  [
    'moving base',
    false,
    'base',
    '42',
    'workflow_dispatch',
    'refs/heads/main',
    false,
  ],
  [
    'foreign owner',
    false,
    'foreign',
    '42',
    'workflow_dispatch',
    'refs/heads/main',
    false,
  ],
  [
    'invalid number',
    false,
    '',
    '42; touch injected',
    'workflow_dispatch',
    'refs/heads/main',
    false,
  ],
  [
    'wrong event',
    false,
    '',
    '42',
    'pull_request_target',
    'refs/heads/main',
    false,
  ],
  [
    'wrong ref',
    false,
    '',
    '42',
    'workflow_dispatch',
    'refs/heads/feature',
    false,
  ],
] as const)(
  'diagnostic CLI: %s',
  async (_name, mergeable, change, number, event, ref, success) => {
    let count = 0;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.endsWith('/git/ref/heads/main')) {
        response.end(
          JSON.stringify({
            ref: 'refs/heads/main',
            object: { type: 'commit', sha: base },
          }),
        );
      } else if (request.url?.endsWith('/pulls/42')) {
        count++;
        response.end(
          JSON.stringify({
            number: 42,
            state: 'open',
            mergeable,
            merge_commit_sha: null,
            base: {
              ref: 'main',
              sha: change === 'base' && count > 2 ? 'c'.repeat(40) : base,
              repo: { full_name: repository, id: 1 },
            },
            head: {
              ref: 'feature',
              sha: change === 'head' && count > 2 ? 'c'.repeat(40) : head,
              repo: {
                full_name: change === 'foreign' ? 'other/repo' : repository,
                id: change === 'foreign' ? 2 : 1,
              },
            },
          }),
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('missing address');
      const receipt = join(temp('signer-diagnostic-'), 'receipt.json');
      const child = spawn(
        process.execPath,
        ['scripts/pr-mergeability-admission.mjs'],
        {
          windowsHide: true,
          timeout: 10000,
          stdio: 'ignore',
          env: {
            ...process.env,
            GITHUB_REPOSITORY: repository,
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
            GITHUB_EVENT_NAME: event,
            GITHUB_REF: ref,
            GITHUB_SHA: base,
            GITHUB_WORKFLOW_SHA: base,
            GITHUB_RUN_ID: '17',
            GITHUB_RUN_ATTEMPT: '2',
            STATION_DIAGNOSTIC_PR: number,
            STATION_CONFLICT_RECEIPT_PATH: receipt,
          },
        },
      );
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(code).toBe(success ? 0 : 1);
      expect(existsSync(receipt)).toBe(success);
      if (success)
        expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({
          schemaVersion: 1,
          kind: 'station-pr-conflict-signer-diagnostic',
          repository,
          pr: 42,
          head,
          base,
          workflowSha: base,
          runId: '17',
          attempt: 2,
        });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
