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
