import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliAuthState } from './cli-auth.js';

type CodexCredentials = {
  tokens?: {
    access_token?: unknown;
  };
  OPENAI_API_KEY?: unknown;
};

/**
 * archive#896 wave 2: Codex's global config dir, mirroring the Codex CLI's own
 * resolution order (`CODEX_HOME` when set, else `~/.codex`).
 */
export function defaultCodexGlobalConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.CODEX_HOME?.trim() || join(home, '.codex');
}

/**
 * archive#896 wave 2: reads `<configDir>/auth.json` — the only per-config-dir
 * signal Codex exposes (unlike Claude, there is no env-var shortcut: Codex's
 * `OPENAI_API_KEY` is read from that same file, not the process env, and a
 * `cli_auth_credentials_store = "keychain"` user reads as `unauthenticated`
 * here — disclosed in route copy, Ambiguity D). `authenticated` when
 * `tokens.access_token` or `OPENAI_API_KEY` is a non-empty string; ENOENT ⇒
 * `unauthenticated`; any other read/parse error ⇒ `unknown` (fail closed,
 * exact shape of `detectClaudeAuthState`).
 */
export async function detectCodexAuthState(
  configDir: string,
): Promise<CliAuthState> {
  try {
    const parsed = JSON.parse(
      await readFile(join(configDir, 'auth.json'), 'utf8'),
    ) as CodexCredentials;
    const accessToken = parsed.tokens?.access_token;
    const apiKey = parsed.OPENAI_API_KEY;
    if (
      (typeof accessToken === 'string' && accessToken.length > 0) ||
      (typeof apiKey === 'string' && apiKey.length > 0)
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
