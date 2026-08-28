import { execFile } from 'node:child_process';

/**
 * The one "is this CLI on PATH" probe (archive#1575 review): system status and
 * native-engine adoption must agree on what "installed" means, so both use
 * this helper. Non-empty stdout is required — a locator exiting 0 with no
 * path (shell-wrapper edge cases) is not an installation.
 */
export function detectCliOnPath(command: string): Promise<boolean> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(locator, [command], { windowsHide: true }, (error, stdout) =>
      resolve(!error && stdout.trim().length > 0),
    );
  });
}
