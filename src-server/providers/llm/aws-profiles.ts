/**
 * AWS profile *name* discovery for the Bedrock connection's "named profile"
 * auth mode (docs/design/connections-onboarding.md §3.1).
 *
 * This module only ever reads INI section headers — `[profile foo]` /
 * `[default]` in `~/.aws/config`, `[foo]` in `~/.aws/credentials` — and
 * returns the parsed *names*. It never reads a key/value line, so it can
 * never surface `aws_access_key_id`, `aws_secret_access_key`, or any other
 * secret material. This keeps profile listing inside the detection
 * principle: observe infrastructure, never read secrets.
 *
 * Header matching is deliberately strict (whole-line, closed charset, no
 * trailing content past the closing bracket): a malformed or hostile line
 * like `[profile work] aws_secret_access_key = [supersecret]` — or any
 * other content living on the same line as a header — must never be
 * accepted as a profile name. A rejected line is silently excluded from the
 * result, never partially parsed; a profile briefly missing from the list
 * is safe, a leaked fragment of a secret line is not. Non-profile config
 * section kinds (`[sso-session X]`, `[services X]`) are rejected the same
 * way, by construction: only the two profile-shaped patterns below are
 * ever matched against `~/.aws/config`.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AwsProfilesResult {
  /** Sorted, de-duplicated profile names from config + credentials files. */
  profiles: string[];
  /** Whether either file was found on disk. */
  available: boolean;
}

// AWS profile names are conventionally word-safe: letters, digits, and
// `_.@/+-`. Closed charset — no spaces, brackets, or other punctuation that
// could smuggle extra content past the header.
const PROFILE_NAME_CHARS = 'A-Za-z0-9_.@/+\\-';
const CONFIG_DEFAULT_HEADER_RE = /^\[default\]\s*$/;
const CONFIG_PROFILE_HEADER_RE = new RegExp(
  `^\\[profile[ \\t]+([${PROFILE_NAME_CHARS}]+)\\]\\s*$`,
);
const CREDENTIALS_PROFILE_HEADER_RE = new RegExp(
  `^\\[([${PROFILE_NAME_CHARS}]+)\\]\\s*$`,
);

export function defaultAwsConfigPath(): string {
  return process.env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config');
}

export function defaultAwsCredentialsPath(): string {
  return (
    process.env.AWS_SHARED_CREDENTIALS_FILE ||
    join(homedir(), '.aws', 'credentials')
  );
}

function isCommentOrBlank(line: string): boolean {
  return !line || line.startsWith('#') || line.startsWith(';');
}

/**
 * Parse `~/.aws/config`-style section headers: `[default]` and
 * `[profile NAME]` only. `[sso-session X]`, `[services X]`, and any other
 * section kind never match either pattern, so they are excluded by
 * construction rather than by an explicit denylist.
 */
function parseConfigProfileNames(content: string): string[] {
  const names: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isCommentOrBlank(line)) continue;
    if (CONFIG_DEFAULT_HEADER_RE.test(line)) {
      names.push('default');
      continue;
    }
    const match = CONFIG_PROFILE_HEADER_RE.exec(line);
    if (match) names.push(match[1]!);
    // Anything else — a malformed header, one with trailing content past
    // the closing bracket (including an inline comment or embedded
    // secret-shaped text), or a non-profile section kind — is rejected.
  }
  return names;
}

/** Parse `~/.aws/credentials`-style bare `[NAME]` section headers only. */
function parseCredentialsProfileNames(content: string): string[] {
  const names: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isCommentOrBlank(line)) continue;
    const match = CREDENTIALS_PROFILE_HEADER_RE.exec(line);
    if (match) names.push(match[1]!);
  }
  return names;
}

async function readProfileNames(
  path: string,
  parse: (content: string) => string[],
): Promise<{ names: string[]; exists: boolean }> {
  try {
    const content = await readFile(path, 'utf8');
    return { names: parse(content), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { names: [], exists: false };
    }
    throw error;
  }
}

/**
 * List the AWS profile *names* visible to this environment: `[profile X]`
 * (and the implicit `[default]`) section headers in `~/.aws/config`, plus
 * `[X]` section headers in `~/.aws/credentials`. Explicit file paths are
 * accepted for testing; production callers should rely on the
 * `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` env-honoring defaults.
 */
export async function listAwsProfiles(options?: {
  configPath?: string;
  credentialsPath?: string;
}): Promise<AwsProfilesResult> {
  const configPath = options?.configPath ?? defaultAwsConfigPath();
  const credentialsPath =
    options?.credentialsPath ?? defaultAwsCredentialsPath();

  const [configResult, credentialsResult] = await Promise.all([
    readProfileNames(configPath, parseConfigProfileNames),
    readProfileNames(credentialsPath, parseCredentialsProfileNames),
  ]);

  const profiles = new Set<string>();
  for (const name of configResult.names) profiles.add(name);
  for (const name of credentialsResult.names) profiles.add(name);

  return {
    profiles: [...profiles].sort((a, b) => a.localeCompare(b)),
    available: configResult.exists || credentialsResult.exists,
  };
}
