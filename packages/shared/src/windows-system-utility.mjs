import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

// Plain JS so process-identity.mjs (loaded by node-run scripts without tsx)
// and windows-path-trust.ts share one resolver.

/**
 * System tools are invoked before Station can use PowerShell to inspect a
 * caller-controlled path, and process-identity probes run under sanitized
 * environments (service managers, the portable archive's minimal PATH).
 * Resolve their protected System32 locations directly; never allow an
 * inherited PATH to select them — or fail to find them: Windows PowerShell
 * lives under System32\WindowsPowerShell\v1.0, which is not on a minimal PATH.
 */
export function windowsSystemUtilityPath(utility, env = process.env) {
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot) || systemRoot.startsWith('\\\\')) {
    throw new Error('Windows SystemRoot must be a local absolute path');
  }
  const system32 = win32.join(win32.normalize(systemRoot), 'System32');
  switch (utility) {
    case 'powershell':
      return win32.join(
        system32,
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
    default:
      return win32.join(system32, `${utility}.exe`);
  }
}

function localAbsoluteDirectory(value) {
  return typeof value === 'string' &&
    win32.isAbsolute(value) &&
    !value.startsWith('\\\\')
    ? win32.normalize(value)
    : null;
}

/**
 * PowerShell 7 (`pwsh.exe`) installs to `%ProgramFiles%\PowerShell\7`, which
 * a minimal or service-manager PATH does not include (#2805). Return that
 * absolute path when the file is there, else the bare name so a PATH that
 * does carry pwsh (a portable or user-scoped install) still finds it.
 *
 * `ProgramW6432` names the native Program Files even from a 32-bit process.
 * When neither variable is set (the portable smoke's scrubbed environment),
 * the default is `Program Files` on the Windows directory's drive. A relative
 * or UNC value is ignored, as `windowsSystemUtilityPath` refuses one.
 */
export function windowsPowerShell7Path(
  env = process.env,
  fileExists = existsSync,
) {
  const roots = [env.ProgramW6432, env.ProgramFiles]
    .map(localAbsoluteDirectory)
    .filter(Boolean);
  const systemRoot = localAbsoluteDirectory(env.SystemRoot ?? env.WINDIR);
  roots.push(
    win32.join(win32.parse(systemRoot ?? 'C:\\Windows').root, 'Program Files'),
  );
  for (const root of new Set(roots)) {
    const candidate = win32.join(root, 'PowerShell', '7', 'pwsh.exe');
    try {
      if (fileExists(candidate)) return candidate;
    } catch {
      // An unreadable location is an absent one; PATH lookup still follows.
    }
  }
  return 'pwsh.exe';
}
