import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';
import { runBoundedFixture } from './helpers/bounded-fixture-process.mjs';

const script = resolve('scripts/install-smoke-file-server.mjs');
const directories: string[] = [];
const executions: ReturnType<typeof executeOwnedCommand>[] = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'install-smoke-files-'));
  directories.push(root);
  return root;
}

afterEach(async () => {
  for (const execution of executions.splice(0)) {
    const cleanup = await terminateSuiteExecution(execution, {
      processLabel: 'install fixture',
      waitForSuiteSettlement,
      terminationGraceMs: 2000,
      terminationForceMs: 2000,
    });
    expect(cleanup.settled).toBe(true);
    expect(cleanup.errors).toEqual([]);
  }
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function start(directory: string): Promise<string> {
  const execution = executeOwnedCommand(
    process.execPath,
    [script, '0', directory],
    undefined,
    'install fixture',
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  executions.push(execution);
  const output = captureOwnedProcessOutput(execution);
  return new Promise((resolveReady, rejectReady) => {
    let text = '';
    const timer = setTimeout(
      () => rejectReady(new Error('Fixture never listened')),
      10_000,
    );
    const read = (chunk: Buffer) => {
      text += chunk.toString();
      const match = text.match(
        /Fixture files ready at (http:\/\/127\.0\.0\.1:\d+)\r?\n/,
      );
      if (!match) return;
      clearTimeout(timer);
      execution.child.stdout?.removeListener('data', read);
      resolveReady(match[1]);
    };
    execution.child.stdout?.on('data', read);
    void execution.completion.then((result) => {
      clearTimeout(timer);
      rejectReady(
        new Error(
          `Fixture exited before readiness: ${result.status}; ${output.finish().stderr.text}`,
        ),
      );
    });
  });
}

const request = (url: string, method = 'GET') =>
  fetch(url, {
    method,
    signal: AbortSignal.timeout(5000),
  });

test('the CLI serves three distinct origins, exact HEAD/GET bytes, and replacement artifacts', async () => {
  const root = temporaryRoot();
  const names = ['artifacts', 'manifests', 'keys'];
  for (const name of names) mkdirSync(join(root, name));
  const bytes = Buffer.from([0, 255, 42, 7]);
  writeFileSync(join(root, 'artifacts/station-portable.tar.gz'), bytes);
  writeFileSync(join(root, 'manifests/manifest.json'), '{"version":"fixture"}');
  writeFileSync(join(root, 'keys/public.pem'), 'public fixture key');
  const [artifact, manifest, key] = await Promise.all(
    names.map((name) => start(join(root, name))),
  );
  expect(new Set([artifact, manifest, key]).size).toBe(3);
  const head = await request(`${artifact}/station-portable.tar.gz`, 'HEAD');
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(bytes.length));
  expect(await head.text()).toBe('');
  expect(
    Buffer.from(
      await (
        await request(`${artifact}/station-portable.tar.gz`)
      ).arrayBuffer(),
    ),
  ).toEqual(bytes);
  expect(await (await request(`${manifest}/manifest.json`)).json()).toEqual({
    version: 'fixture',
  });
  expect(await (await request(`${key}/public.pem`)).text()).toBe(
    'public fixture key',
  );
  expect((await request(`${artifact}/public.pem`)).status).toBe(404);
  writeFileSync(join(root, 'artifacts/station-portable.tar.gz'), 'replacement');
  expect(
    await (await request(`${artifact}/station-portable.tar.gz`)).text(),
  ).toBe('replacement');
  expect(
    (await request(`${artifact}/station-portable.tar.gz`, 'POST')).status,
  ).toBe(405);
  writeFileSync(join(root, 'outside.txt'), 'must stay outside');
  expect((await request(`${artifact}/%2e%2e%2foutside.txt`)).status).toBe(404);
}, 30_000);

test('the CLI fails before readiness when its fixture directory is missing', async () => {
  const result = await runBoundedFixture(
    process.execPath,
    [script, '0', join(temporaryRoot(), 'missing')],
    {},
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stdout).not.toContain('Fixture files ready');
});
