import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import { runConnectedAgentTests } from '../run-connected-agent-tests.mjs';
import {
  buildFocusedVitestInvocation,
  runFocusedTests,
} from '../run-focused-tests.mjs';
import { PROCESS_EXCLUSIVE_VITEST_FILES } from '../vitest-resource-manifest.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const files = [
  'src-server/providers/llm/__tests__/bedrock-adapter.test.ts',
  'src-server/providers/__tests__/claude-adapter.test.ts',
  'src-server/providers/__tests__/codex-adapter.test.ts',
  'src-server/services/orchestration/__tests__/orchestration-service.test.ts',
  'src-server/services/orchestration/__tests__/event-store.test.ts',
  'src-server/routes/orchestration/__tests__/orchestration.routes.test.ts',
];

function executor(exitCode = 0) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.stdout.write(` RUN vfixture ${root}\n`);
      child.emit('close', exitCode, null);
    });
    return child as unknown as ChildProcess;
  });
}

describe('connected-agent macro execution boundary', () => {
  it('delegates the unchanged six suites and 10s deadline to the exclusive focused runner', async () => {
    const spawnProcess = executor();
    const provenance = vi.fn();
    expect(
      await runConnectedAgentTests({
        root,
        spawnProcess,
        assertDependencyProvenance: provenance,
        testTimeoutMs: 60_000,
      }),
    ).toBe(0);
    expect(provenance).toHaveBeenCalledWith({ cwd: root });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      object,
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      path.join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--root',
      root,
      ...files,
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--testTimeout=10000',
    ]);
    expect(options).toMatchObject({ cwd: root, windowsHide: true });
    expect(
      files.filter((file) => PROCESS_EXCLUSIVE_VITEST_FILES.includes(file)),
    ).toContain(
      'src-server/services/orchestration/__tests__/event-store.test.ts',
    );
    // Supplement the execution proof with the package entry's routing: the real
    // connected macro is run separately, not six heavyweight suites in this test.
    expect(packageJson.scripts['test:connected-agents']).toBe(
      'node scripts/run-connected-agent-tests.mjs',
    );
  });

  it('propagates a nonzero suite result and preserves provenance refusal before spawn', async () => {
    expect(
      await runConnectedAgentTests({
        root,
        spawnProcess: executor(1),
        assertDependencyProvenance: () => {},
      }),
    ).toBe(1);
    const spawnProcess = executor();
    await expect(
      runConnectedAgentTests({
        root,
        spawnProcess,
        assertDependencyProvenance: () => {
          throw new Error('stale dependencies');
        },
      }),
    ).rejects.toThrow('stale dependencies');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, '10000'])(
    'refuses invalid programmatic timeout %s without spawning',
    async (testTimeoutMs) => {
      const spawnProcess = executor();
      await expect(
        runFocusedTests([files[0]], {
          root,
          spawnProcess: spawnProcess as unknown as typeof spawn,
          assertDependencyProvenance: () => ({
            repositoryRoot: root,
            packages: [],
          }),
          // Deliberately violate the typed boundary to test runtime refusal.
          testTimeoutMs: testTimeoutMs as number,
        }),
      ).rejects.toThrow('testTimeoutMs');
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );

  it('leaves ordinary focused defaults and CLI option refusal unchanged', () => {
    expect(buildFocusedVitestInvocation([files[0]], root).args).not.toContain(
      '--testTimeout=10000',
    );
    expect(() =>
      buildFocusedVitestInvocation(['--testTimeout=60000'], root),
    ).toThrow('not options');
  });
});
