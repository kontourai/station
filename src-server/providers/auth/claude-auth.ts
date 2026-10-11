import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';
import type { CliAuthState, CliCommandResult } from './cli-auth.js';

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
  let account: string;
  try {
    account = env.USER || userInfo().username;
  } catch {
    return 'unknown';
  }
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

/**
 * Asks the Claude CLI itself whether it is logged in (`claude auth status`),
 * for the case the credentials file cannot answer: on macOS the login lives
 * in the Keychain and `.credentials.json` is absent (#3303). The caller owns
 * the command, its env and its deadline; this only runs it.
 */
export type ClaudeAuthStatusProbe = () => Promise<CliCommandResult | null>;

/**
 * Reads `claude auth status` output. Only an explicit boolean `loggedIn` is an
 * answer, taken from stdout whatever the exit code (the CLI exits 1 when logged
 * out, still printing the JSON). A timeout, output cut at the capture bound,
 * or anything unparseable is `unknown`: a probe failure must never read as authenticated.
 */
export function parseClaudeAuthStatus(
  result: CliCommandResult | null,
): CliAuthState {
  if (!result || result.timedOut || result.outputTruncated) return 'unknown';
  const output = result.stdout.trim();
  if (output.length === 0) return 'unknown';
  try {
    const parsed: unknown = JSON.parse(output);
    const loggedIn =
      parsed && typeof parsed === 'object'
        ? (parsed as { loggedIn?: unknown }).loggedIn
        : undefined;
    if (loggedIn === true) return 'authenticated';
    if (loggedIn === false) return 'unauthenticated';
  } catch {
    // Not JSON (a banner, or a CLI that does not know the command): unknown.
  }
  return 'unknown';
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function detectClaudeAuthState(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  /**
   * Consulted only when neither the environment nor the credentials file
   * established auth. Omit it (the credential-profile route does) to keep the
   * file-only answer.
   */
  probe?: ClaudeAuthStatusProbe,
): Promise<CliAuthState> {
  if (
    env.ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  ) {
    return 'authenticated';
  }

  const configDir = (env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')).normalize(
    'NFC',
  );
  const storageOverride = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const storageDir =
    storageOverride === undefined
      ? configDir
      : (storageOverride || join(home, '.claude')).normalize('NFC');
  if (platform() === 'darwin') {
    const secure = await secureAuthState(
      env,
      storageDir,
      storageOverride === undefined
        ? !env.CLAUDE_CONFIG_DIR && home === homedir()
        : storageOverride.length === 0,
    );
    if (secure !== undefined) return secure;
  }
  try {
    const parsed = JSON.parse(
      await readFile(join(storageDir, '.credentials.json'), 'utf8'),
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
      // The CLI itself writes into its config dir even to answer `auth
      // status`, so a dir that does not exist yet is never probed: a login
      // would have created it, and a readiness read must create nothing.
      if (
        !probe ||
        !(await isDirectory(storageDir)) ||
        (storageDir !== configDir && !(await isDirectory(configDir)))
      )
        return 'unauthenticated';
      return parseClaudeAuthStatus(await probe().catch(() => null));
    }
    return 'unknown';
  }
}
