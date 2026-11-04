import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = fileURLToPath(
  new URL('./__fixtures__/voltagent-stream-finish-flush.mts', import.meta.url),
);
const cases = (['cjs', 'esm'] as const).flatMap((format) =>
  (['always-fulfill', 'always-reject', 'auto', 'never'] as const).map(
    (mode) => [format, mode] as const,
  ),
);

describe.sequential('native Volt stream finish flush', () => {
  test.each(cases)(
    '%s %s settles before consumer EOF',
    async (format, mode) => {
      const execution = executeOwnedCommand(
        process.execPath,
        [fixture, format, mode],
        spawn,
        `Volt finish flush ${format}/${mode}`,
        {
          cwd: root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const child = execution.child;
      if (!('once' in child)) {
        throw new Error(
          `FLUSH_KEEPER_SPAWN_FAILED: NOT_PROVEN ${JSON.stringify(await execution.completion)}`,
        );
      }
      const closed = new Promise<void>((resolveClose) => {
        child.once('close', () => resolveClose());
      });
      const capture = captureOwnedProcessOutput(execution, {
        maxBytes: 64 * 1024,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let containment: Awaited<ReturnType<typeof terminateSuiteExecution>>;
      let result: Awaited<typeof execution.completion> | undefined;
      let failure: unknown;
      let naturalSettlement = false;
      let actualClose = false;
      try {
        result = await Promise.race([
          execution.completion,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error('FLUSH_KEEPER_CHILD_WATCHDOG: NOT_PROVEN')),
              18_000,
            );
          }),
        ]);
        // Windows retains its owned launcher until the completed Job is acknowledged.
        naturalSettlement =
          'completionRequiresCleanup' in execution &&
          execution.completionRequiresCleanup
            ? result.status === 0
            : await waitForSuiteSettlement(execution, 1_000);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
        containment = await terminateSuiteExecution(execution, {
          waitForSuiteSettlement,
          terminationGraceMs: 1_000,
          terminationForceMs: 2_000,
          processLabel: `Volt finish flush ${format}/${mode}`,
        });
        try {
          await Promise.race([
            closed.then(() => {
              actualClose = true;
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error('FLUSH_KEEPER_CHILD_CLOSE_MISSING: NOT_PROVEN'),
                  ),
                1_000,
              );
            }),
          ]);
        } catch (error) {
          failure ??= error;
        } finally {
          clearTimeout(timer);
        }
      }
      const output = capture.finish();
      const diagnostic = JSON.stringify({
        format,
        mode,
        result,
        failure: failure instanceof Error ? failure.message : failure,
        containment,
        naturalSettlement,
        actualClose,
        stdout: output.stdout.text,
        stderr: output.stderr.text,
      });
      expect(failure, diagnostic).toBeUndefined();
      expect(actualClose, diagnostic).toBe(true);
      expect(naturalSettlement, diagnostic).toBe(true);
      expect(result, diagnostic).toMatchObject({ status: 0, signal: null });
      expect(output.truncated, diagnostic).toBe(false);
      expect(output.invalidUtf8, diagnostic).toBe(false);
      expect(containment, diagnostic).toEqual({
        settled: true,
        escalated: false,
        errors: [],
      });
      expect(execution.isAlive(), diagnostic).toBe(false);
      const receipts = output.stdout.text
        .split(/\r?\n/)
        .filter((line) =>
          line.startsWith('{"schema":"volt-stream-finish-flush/1"'),
        );
      expect(receipts, diagnostic).toHaveLength(1);
      const receipt: unknown = JSON.parse(receipts[0]);
      const enabled = mode.startsWith('always-');
      expect(receipt, diagnostic).toMatchObject({
        schema: 'volt-stream-finish-flush/1',
        status: 'PASS',
        format,
        mode,
        versions: { core: '2.11.0', ai: '6.0.317' },
        text: 'FLUSH_KEEPER',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        callbacks: { start: 1, step: 1, end: 1, finish: 1 },
        nativeCalls: { stream: 1, generate: 0 },
        root: { ended: true, state: 'completed' },
        forceFlush: {
          calls: enabled ? 1 : 0,
          settled: enabled ? 1 : 0,
          rejected: mode === 'always-reject' ? 1 : 0,
        },
        consumer: 'eof',
        cleanup: {
          acquisition: 'fulfilled',
          consumer: 'fulfilled',
          processor: enabled
            ? [mode === 'always-reject' ? 'rejected' : 'fulfilled']
            : [],
          shutdown: true,
          storage: true,
          processorShutdowns: 1,
        },
        failures: [],
      });
    },
    28_000,
  );
});
