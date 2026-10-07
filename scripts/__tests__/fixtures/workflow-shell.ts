import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  execFileSyncBounded,
  spawnSyncBounded,
} from '../../lib/bounded-capture.mjs';

function workflowShell(): string {
  if (process.platform !== 'win32') return 'bash';
  const gitExecPath = execFileSyncBounded('git', ['--exec-path'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }).trim();
  const bash = resolve(gitExecPath, '../../../bin/bash.exe');
  if (!existsSync(bash))
    throw new Error(`Workflow fixture requires Git Bash: ${bash}`);
  return bash;
}

function workflowPath(path: string): string {
  if (process.platform !== 'win32') return path;
  return path
    .replaceAll('\\', '/')
    .replace(
      /^([a-z]):/i,
      (_match, drive: string) => `/${drive.toLowerCase()}`,
    );
}

/** Execute the workflow bytes with host tools, without inherited CI context. */
export function runWorkflowShell(
  script: string,
  cwd: string,
  bindings: Record<string, string>,
  timeout?: number,
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GITHUB_') && key !== 'RUNNER_TEMP',
    ),
  );
  for (const [key, value] of Object.entries(bindings)) {
    env[key] =
      key === 'GITHUB_OUTPUT' || key === 'RUNNER_TEMP'
        ? workflowPath(value)
        : value;
  }
  return spawnSyncBounded(
    workflowShell(),
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
    {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout,
      windowsHide: true,
    },
  );
}
