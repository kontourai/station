import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';

// Only operating-system launch inputs reach children. In particular, no model
// credentials, NODE_OPTIONS, Station configuration or certificate overrides.
export function localLabEnvironment() {
  const env = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function own(executable, args, cwd) {
  const execution = executeOwnedCommand(executable, args, spawn, 'local lab', {
    cwd,
    env: localLabEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const capture = captureOwnedProcessOutput(execution, { maxBytes: 64 * 1024 });
  return { execution, capture };
}

async function stop(execution) {
  const result = await terminateSuiteExecution(execution, {
    waitForSuiteSettlement,
    terminationGraceMs: 2000,
    terminationForceMs: 3000,
    processLabel: 'local lab',
  });
  if (!result.settled || result.errors.length)
    throw new Error('Local lab process tree did not settle cleanly');
}

export async function runLabCommand(executable, args, cwd, timeoutMs = 30000) {
  const { execution, capture } = own(executable, args, cwd);
  const errors = [];
  let timer;
  try {
    const result = await Promise.race([
      execution.completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Local lab command timed out')),
          timeoutMs,
        );
      }),
    ]);
    if (result.status !== 0 || result.error)
      throw new Error(
        `Local lab command failed: ${executable} (status ${result.status})`,
      );
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
  }
  try {
    await stop(execution);
  } catch (error) {
    errors.push(error);
  }
  const output = capture.finish();
  if (output.truncated || output.invalidUtf8)
    errors.push(
      new Error('Local lab child output exceeded its capture contract'),
    );
  if (errors.length)
    throw new AggregateError(errors, 'Local lab command failed');
}

export async function startLabRelay(targetPort, directory, mode = 'forward') {
  const readyPath = join(directory, 'ready.json');
  const { execution, capture } = own(
    process.execPath,
    [
      join(import.meta.dirname, 'local-collaboration-relay.mjs'),
      String(targetPort),
      directory,
      mode,
    ],
    directory,
  );
  let closing;
  const close = () => {
    closing ??= (async () => {
      await stop(execution);
      const output = capture.finish();
      if (
        output.truncated ||
        output.invalidUtf8 ||
        existsSync(join(directory, 'failed.json'))
      )
        throw new Error('Relay failed its bounded lifecycle/capture contract');
    })();
    return closing;
  };
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(readyPath)) {
      if (!execution.isAlive())
        throw new Error('Local relay exited before readiness');
      if (Date.now() >= deadline)
        throw new Error('Local relay readiness timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const { port } = JSON.parse(readFileSync(readyPath, 'utf8'));
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      [3000, 3141].includes(port)
    )
      throw new Error('Local relay returned an invalid or reserved port');
    return { port, close, capturePath: join(directory, 'traffic.bin') };
  } catch (error) {
    await close();
    throw error;
  }
}
