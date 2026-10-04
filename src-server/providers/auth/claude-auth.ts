import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';
import type { CliAuthState } from './cli-auth.js';

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
  };
};

function hasOAuthCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('claudeAiOauth' in value))
    return false;
  const oauth = value.claudeAiOauth;
  return (
    !!oauth &&
    typeof oauth === 'object' &&
    (('accessToken' in oauth &&
      typeof oauth.accessToken === 'string' &&
      oauth.accessToken.length > 0) ||
      ('refreshToken' in oauth &&
        typeof oauth.refreshToken === 'string' &&
        oauth.refreshToken.length > 0))
  );
}

async function secureAuthState(
  env: NodeJS.ProcessEnv,
  configDir: string,
  defaultNamespace: boolean,
): Promise<CliAuthState | undefined> {
  const account = env.USER?.trim() || userInfo().username;
  if (!/^[a-zA-Z0-9._-]+$/.test(account)) return 'unknown';
  const suffix = createHash('sha256')
    .update(configDir.normalize('NFC'))
    .digest('hex')
    .slice(0, 8);
  const service = defaultNamespace
    ? 'Claude Code-credentials'
    : `Claude Code-credentials-${suffix}`;
  return new Promise((complete) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-a', account, '-w', '-s', service],
      { timeout: 5000, maxBuffer: 65536, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        if (error) {
          // security returns errSecItemNotFound (-25300) as exit 44.
          complete(error.code === 44 && !error.killed ? undefined : 'unknown');
          return;
        }
        try {
          complete(
            hasOAuthCredential(JSON.parse(stdout))
              ? 'authenticated'
              : 'unknown',
          );
        } catch {
          complete('unknown');
        }
      },
    );
  });
}

export async function detectClaudeAuthState(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<CliAuthState> {
  if (
    env.ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  ) {
    return 'authenticated';
  }

  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  if (platform() === 'darwin') {
    const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() || configDir;
    const secure = await secureAuthState(
      env,
      secureDir,
      !env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() &&
        !env.CLAUDE_CONFIG_DIR?.trim() &&
        home === homedir(),
    );
    if (secure !== undefined) return secure;
  }
  try {
    const parsed = JSON.parse(
      await readFile(join(configDir, '.credentials.json'), 'utf8'),
    ) as ClaudeCredentials;
    const oauth = parsed.claudeAiOauth;
    if (
      (typeof oauth?.accessToken === 'string' &&
        oauth.accessToken.length > 0) ||
      (typeof oauth?.refreshToken === 'string' && oauth.refreshToken.length > 0)
    ) {
      return 'authenticated';
    }
    return 'unauthenticated';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'unauthenticated';
    }
    return 'unknown';
  }
}
