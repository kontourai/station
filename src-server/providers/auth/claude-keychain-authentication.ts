import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

const MAX_KEYCHAIN_BYTES = 65_536;
const KEYCHAIN_TIMEOUT_MS = 5_000;

export function claudeKeychainScope(
  env: NodeJS.ProcessEnv,
  configDir: string,
  defaultNamespace: boolean,
): { account: string; service: string } | undefined {
  let account: string;
  try {
    account = env.USER || userInfo().username;
  } catch {
    return undefined;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(account)) return undefined;
  const suffix = createHash('sha256')
    .update(configDir.normalize('NFC'))
    .digest('hex')
    .slice(0, 8);
  return {
    account,
    service: defaultNamespace
      ? 'Claude Code-credentials'
      : `Claude Code-credentials-${suffix}`,
  };
}

function keychainFingerprint(bytes: string): string {
  try {
    const value: unknown = JSON.parse(bytes);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    throw new Error('ensemble_auth_store_unsupported');
  }
}

/** Private equality witness only; positive login remains the CLI's decision. */
export async function observeClaudeKeychain(scope: {
  account: string;
  service: string;
}): Promise<() => void> {
  const args = [
    'find-generic-password',
    '-a',
    scope.account,
    '-w',
    '-s',
    scope.service,
  ];
  const options = {
    timeout: KEYCHAIN_TIMEOUT_MS,
    maxBuffer: MAX_KEYCHAIN_BYTES,
    encoding: 'utf8' as const,
    windowsHide: true,
    killSignal: 'SIGKILL' as const,
  };
  const expected = await new Promise<string | undefined>((resolve, reject) => {
    execFile('/usr/bin/security', args, options, (error, stdout) => {
      if (error) {
        if (error.code === 44 && !error.killed) resolve(undefined);
        else reject(new Error('ensemble_auth_store_unsupported'));
        return;
      }
      try {
        resolve(keychainFingerprint(stdout));
      } catch {
        reject(new Error('ensemble_auth_store_unsupported'));
      }
    });
  });
  return () => {
    let actual: string | undefined;
    try {
      actual = keychainFingerprint(
        execFileSync('/usr/bin/security', args, { ...options, stdio: 'pipe' }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'status' in error &&
        error.status === 44 &&
        (!('signal' in error) || !error.signal)
      )
        actual = undefined;
      else throw new Error('ensemble_auth_store_unavailable');
    }
    if (actual !== expected) throw new Error('ensemble_auth_store_changed');
  };
}
