import { readFileSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { win32 } from 'node:path';

/** Follow npm's Node launcher without passing arguments through cmd.exe. */
export function cliInvocation(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (platform() !== 'win32' || !/\.(?:cmd|bat)$/iu.test(command))
    return { command, args: [...args] };

  if (statSync(command).size > 64 * 1024)
    throw new Error('The Windows CLI launcher is too large to inspect safely.');
  const shim = readFileSync(command, 'utf8');
  const match = shim.match(
    /"%_prog%"\s+"%dp0%\\(node_modules\\[^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*/iu,
  );
  const relative = match?.[1];
  if (
    !relative ||
    relative
      .split(/[\\/]/u)
      .some((part) => !part || part === '.' || part === '..') ||
    /[%:]/u.test(relative)
  )
    throw new Error(
      'This Windows CLI launcher is not a supported npm Node shim. Configure a native executable or reinstall the CLI with npm.',
    );

  const entry = win32.join(win32.dirname(command), relative);
  if (!statSync(entry).isFile())
    throw new Error('The Windows npm CLI entry point is not a regular file.');
  return { command: process.execPath, args: [entry, ...args] };
}
