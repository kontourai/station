import type { ChildProcess } from 'node:child_process';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../run-load-reliability.mjs';

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_FORCE_MS = 1_000;

type ProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type InstallerProcessInput = {
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  command?: string;
  processLabel?: string;
  terminationGraceMs?: number;
  terminationForceMs?: number;
};

type OwnedExecution = ReturnType<typeof executeOwnedProcess> & {
  child: ChildProcess;
};

type InstallerProcessHarness = {
  execute(
    executable: string,
    args: string[],
    processLabel: string,
    env: NodeJS.ProcessEnv,
  ): OwnedExecution;
  terminate: typeof terminateSuiteExecution;
  waitForSettlement: typeof waitForSuiteSettlement;
};

const defaultHarness: InstallerProcessHarness = {
  execute(executable, args, processLabel, env) {
    return executeOwnedProcess(executable, args, undefined, processLabel, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as OwnedExecution;
  },
  terminate: terminateSuiteExecution,
  waitForSettlement: waitForSuiteSettlement,
};

function collectOutput(child: ChildProcess) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    read: () => ({ stdout, stderr }),
  };
}

export async function runInstallerProcess(
  input: InstallerProcessInput,
  harness: InstallerProcessHarness = defaultHarness,
): Promise<ProcessResult> {
  const command = input.command ?? 'zsh';
  const processLabel = input.processLabel ?? 'macOS installer harness';
  const execution = harness.execute(
    command,
    input.args,
    processLabel,
    input.env,
  );
  const output = collectOutput(execution.child);
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol('timed-out');
  const result = await Promise.race([
    execution.promise,
    new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), input.timeoutMs);
    }),
  ]);

  if (result !== timedOut) {
    clearTimeout(timeout);
    if (result.error) {
      throw new Error(
        `failed to spawn ${processLabel}: ${result.error.message}`,
      );
    }
    if (execution.isAlive()) {
      const cleanup = await terminateOwnedProcess(input, execution, harness);
      const cleanupFailure = formatCleanupFailure(cleanup);
      throw new Error(
        `${processLabel} exited while owned descendants remained alive${
          cleanupFailure ? `; cleanup failed: ${cleanupFailure}` : ''
        }`,
      );
    }
    return { status: result.status, ...output.read() };
  }

  const cleanup = await terminateOwnedProcess(input, execution, harness);
  const cleanupFailure = formatCleanupFailure(cleanup);
  if (cleanupFailure) {
    throw new Error(
      `${processLabel} exceeded ${input.timeoutMs}ms and cleanup failed: ${cleanupFailure}`,
    );
  }
  throw new Error(`${processLabel} exceeded ${input.timeoutMs}ms`);
}

function terminateOwnedProcess(
  input: InstallerProcessInput,
  execution: OwnedExecution,
  harness: InstallerProcessHarness,
) {
  return harness.terminate(execution, {
    processLabel: input.processLabel ?? 'macOS installer harness',
    waitForSuiteSettlement: harness.waitForSettlement,
    terminationGraceMs:
      input.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    terminationForceMs:
      input.terminationForceMs ?? DEFAULT_TERMINATION_FORCE_MS,
  });
}

function formatCleanupFailure(
  cleanup: Awaited<ReturnType<typeof terminateSuiteExecution>>,
) {
  if (cleanup.settled && cleanup.errors.length === 0) return '';
  const diagnostics = cleanup.errors
    .map((error) => `${error.signal}: ${error.message}`)
    .join('; ');
  return diagnostics || 'process tree did not settle';
}
