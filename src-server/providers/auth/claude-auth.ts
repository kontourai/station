import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliAuthState } from './cli-auth.js';

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
  };
};

export async function detectClaudeAuthState(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<CliAuthState> {
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) {
    return 'authenticated';
  }

  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
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
