import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

function validateWindowsNpmCli(npmExecPath) {
  if (
    typeof npmExecPath !== 'string' ||
    !isAbsolute(npmExecPath) ||
    basename(npmExecPath) !== 'npm-cli.js' ||
    !existsSync(npmExecPath)
  ) {
    throw new Error(
      'Windows desktop builds require npm_execpath to be an absolute npm-cli.js file',
    );
  }
  try {
    if (!statSync(npmExecPath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(
      'Windows desktop builds require npm_execpath to be an absolute npm-cli.js file',
    );
  }
  return npmExecPath;
}

export function npmBuildInvocation(
  npmArgs,
  {
    platform = process.platform,
    npmExecPath = process.env.npm_execpath,
    nodeExecutable = process.execPath,
  } = {},
) {
  if (platform !== 'win32') return { command: 'npm', args: npmArgs };
  const npmCli = validateWindowsNpmCli(npmExecPath);
  return { command: nodeExecutable, args: [npmCli, ...npmArgs] };
}
