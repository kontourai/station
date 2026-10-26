import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';

async function runFixture(mode: string, caller: string) {
  const execution = executeOwnedCommand(
    process.execPath,
    [
      resolve(import.meta.dirname, 'fixtures/dependency-http-availability.mjs'),
      mode,
      caller,
    ],
    spawn,
    `dependency HTTP ${mode} ${caller}`,
    {
      cwd: resolve(import.meta.dirname, '../..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = captureOwnedProcessOutput(execution, { maxBytes: 32 * 1024 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      execution.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `dependency HTTP fixture did not settle: ${mode} ${caller}`,
              ),
            ),
          15_000,
        );
      }),
    ]);
    const output = capture.finish();
    expect(output.truncated).toBe(false);
    expect(output.invalidUtf8).toBe(false);
    expect(result, output.stderr.text).toMatchObject({
      status: 0,
      signal: null,
    });
    const report = JSON.parse(output.stdout.text);
    expect(report).toMatchObject({ mode, caller, healthy: true });
    return report;
  } finally {
    clearTimeout(timer);
    const cleanup = await terminateSuiteExecution(execution, {
      waitForSuiteSettlement,
      terminationGraceMs: 2000,
      terminationForceMs: 3000,
      processLabel: 'dependency HTTP fixture',
    });
    expect(cleanup).toMatchObject({ settled: true, errors: [] });
  }
}

for (const caller of ['a2a-express', 'express']) {
  test(`${caller} parser survives bytes arriving after a compressed frame`, async () => {
    const report = await runFixture('body', caller);
    expect(report.accepted).toBe(true);
  }, 25_000);
}

for (const caller of ['provider-utils', 'jsdom']) {
  test(`${caller} fetch rejects excessive encodings without an orphan-stream crash`, async () => {
    const report = await runFixture('fetch', caller);
    expect(report.rejected).toBe(true);
  }, 25_000);
  for (const mode of ['sse-fields', 'sse-line']) {
    test(`${caller} EventSource bounds ${mode} after decompression`, async () => {
      const report = await runFixture(mode, caller);
      expect(report.denied).toBe(true);
    }, 25_000);
  }
}
