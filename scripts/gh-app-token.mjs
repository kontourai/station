#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/**
 * Mint a short-lived GitHub App installation token for automation (#2926).
 *
 * Agent sessions and tools that arm auto-merge, read the merge queue or poll
 * checks shared the owner's personal GraphQL quota and exhausted it. An
 * installation token of a dedicated app has its own quota. This helper mints
 * one, narrowed to the one repository and to the permissions the call needs:
 *
 *     GH_TOKEN=$(node scripts/gh-app-token.mjs) gh api repos/kontourai/station/pulls/1
 *     node scripts/gh-app-token.mjs --permissions pull_requests:write,contents:write,workflows:write -- gh pr merge 1 --repo kontourai/station --auto
 *
 * Setup, the least-privilege reasoning and key rotation are in
 * docs/guides/development.md#github-automation-token.
 *
 * Nothing is cached or written: the private key is read into memory (macOS
 * Keychain by default, or an explicit key file), the token is printed or
 * handed to one child command, and both die with the process.
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { invokedDirectly } from './lib/module-entry.mjs';

export const SETUP_DOC = 'docs/guides/development.md#github-automation-token';
/** EX_CONFIG: the helper is not set up, or its setup is unsafe. */
export const EXIT_UNCONFIGURED = 78;
/** GitHub refused, or answered with something this helper cannot use. */
export const EXIT_GITHUB = 69;
/** A usage error on the command line. */
export const EXIT_USAGE = 64;

const DEFAULT_OWNER = 'kontourai';
const DEFAULT_REPOSITORY = 'station';
const DEFAULT_KEYCHAIN_SERVICE = 'kontourai-station-automation';
const DEFAULT_API_URL = 'https://api.github.com';

/**
 * The installation permissions a token may request, and the read-only set it
 * gets when the caller asks for nothing. These mirror what the dedicated
 * automation app is granted; a scope the app lacks makes GitHub refuse the
 * mint, which is the right failure.
 */
const REQUESTABLE_PERMISSIONS = Object.freeze({
  actions: Object.freeze(['read']),
  checks: Object.freeze(['read']),
  contents: Object.freeze(['read', 'write']),
  issues: Object.freeze(['read', 'write']),
  metadata: Object.freeze(['read']),
  pull_requests: Object.freeze(['read', 'write']),
  statuses: Object.freeze(['read']),
  workflows: Object.freeze(['write']),
});
export const DEFAULT_PERMISSIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(REQUESTABLE_PERMISSIONS)
      .filter(([, levels]) => levels.includes('read'))
      .map(([name]) => [name, 'read']),
  ),
);

class GhAppTokenError extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   * @param {string} [reason] a stable code, printed first, for callers and
   * tests that must not depend on the wording (#2927)
   */
  constructor(message, exitCode, reason = 'error') {
    super(message);
    this.name = 'GhAppTokenError';
    this.exitCode = exitCode;
    this.reason = reason;
  }
}

function unconfigured(message, reason = 'unconfigured') {
  return new GhAppTokenError(
    `${message}\nSet up the automation app first: see ${SETUP_DOC}`,
    EXIT_UNCONFIGURED,
    reason,
  );
}

/** `name:level[,name:level]` -> a permissions object, strictly validated. */
function parsePermissions(text) {
  const permissions = {};
  for (const item of String(text).split(',')) {
    const [name, level, extra] = item.trim().split(':');
    const allowed = REQUESTABLE_PERMISSIONS[name];
    if (extra !== undefined || !allowed || !allowed.includes(level))
      throw new GhAppTokenError(
        `--permissions entry '${item.trim().slice(0, 64)}' must be one of: ${Object.entries(
          REQUESTABLE_PERMISSIONS,
        )
          .flatMap(([key, levels]) => levels.map((l) => `${key}:${l}`))
          .join(', ')}`,
        EXIT_USAGE,
      );
    permissions[name] = level;
  }
  return permissions;
}

/** `[options..., '--', command...]` */
function parseArguments(argv) {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let permissions = { ...DEFAULT_PERMISSIONS };
  for (let index = 0; index < own.length; index += 1) {
    const argument = own[index];
    if (argument === '--permissions') {
      const value = own[++index];
      if (value === undefined)
        throw new GhAppTokenError('--permissions needs a value', EXIT_USAGE);
      permissions = parsePermissions(value);
    } else if (argument.startsWith('--permissions='))
      permissions = parsePermissions(argument.slice('--permissions='.length));
    else
      throw new GhAppTokenError(
        `unrecognized argument: ${argument.slice(0, 64)}`,
        EXIT_USAGE,
      );
  }
  if (separator !== -1 && command.length === 0)
    throw new GhAppTokenError('nothing to run after --', EXIT_USAGE);
  // GitHub grants metadata:read with any repository permission; asking for
  // it explicitly keeps the request honest about what the token can do.
  return { permissions: { metadata: 'read', ...permissions }, command };
}

function repositoryRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? realOrSelf(result.stdout.trim()) : null;
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function insideRepository(path, root) {
  if (!root) return false;
  const real = realOrSelf(path);
  return real === root || real.startsWith(root + sep);
}

/**
 * App identity and key source: environment first, then the user config file
 * (`$STATION_GH_APP_CONFIG`, else `$XDG_CONFIG_HOME/station/gh-app.json`,
 * else `~/.config/station/gh-app.json`). A config or key file inside the
 * repository is refused: a key must never be one `git add` from a commit.
 */
function resolveConfiguration({ env = process.env, cwd = process.cwd() } = {}) {
  const configPath =
    env.STATION_GH_APP_CONFIG ||
    join(
      env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'),
      'station',
      'gh-app.json',
    );
  const root = repositoryRoot(cwd);
  let file = {};
  if (existsSync(configPath)) {
    if (insideRepository(configPath, root))
      throw unconfigured(
        `refusing the config file ${configPath}: it is inside the repository ${root}`,
        'config-in-repository',
      );
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw unconfigured(
        `config file ${configPath} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!file || typeof file !== 'object' || Array.isArray(file))
      throw unconfigured(`config file ${configPath} must hold a JSON object`);
  }
  const pick = (envName, key) => {
    const value = env[envName] || file[key];
    return value === undefined || value === '' ? undefined : String(value);
  };
  const appId = pick('STATION_GH_APP_ID', 'appId');
  if (!appId)
    throw unconfigured(
      `no GitHub App ID: set STATION_GH_APP_ID or "appId" in ${configPath}`,
    );
  if (!/^[1-9][0-9]*$/.test(appId))
    throw unconfigured(`GitHub App ID must be a positive integer`);
  const installationId = pick(
    'STATION_GH_APP_INSTALLATION_ID',
    'installationId',
  );
  if (installationId !== undefined && !/^[1-9][0-9]*$/.test(installationId))
    throw unconfigured('installation ID must be a positive integer');
  const privateKeyPath = pick(
    'STATION_GH_APP_PRIVATE_KEY_PATH',
    'privateKeyPath',
  );
  if (privateKeyPath && insideRepository(privateKeyPath, root))
    throw unconfigured(
      `refusing the private key ${privateKeyPath}: it is inside the repository ${root}`,
      'key-in-repository',
    );
  const apiUrl = pick('STATION_GH_API_URL', 'apiUrl') ?? DEFAULT_API_URL;
  let parsedApi;
  try {
    parsedApi = new URL(apiUrl);
  } catch {
    throw unconfigured(`API URL is not a valid URL: ${apiUrl.slice(0, 200)}`);
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(
    parsedApi.hostname,
  );
  if (parsedApi.protocol !== 'https:' && !loopback)
    throw unconfigured(`API URL must use https: ${apiUrl}`);
  return {
    configPath,
    appId,
    installationId,
    owner: pick('STATION_GH_APP_OWNER', 'owner') ?? DEFAULT_OWNER,
    repository:
      pick('STATION_GH_APP_REPOSITORY', 'repository') ?? DEFAULT_REPOSITORY,
    keychainService:
      pick('STATION_GH_APP_KEYCHAIN_SERVICE', 'keychainService') ??
      DEFAULT_KEYCHAIN_SERVICE,
    keychainAccount:
      pick('STATION_GH_APP_KEYCHAIN_ACCOUNT', 'keychainAccount') ?? appId,
    privateKeyPath: privateKeyPath ? resolve(cwd, privateKeyPath) : undefined,
    apiUrl: apiUrl.replace(/\/+$/, ''),
  };
}

/**
 * `security find-generic-password -w` prints a multi-line secret (a PEM) as
 * hex. A value that is entirely hex is decoded in memory; anything else is
 * used as written.
 */
export function decodeKeychainSecret(value) {
  const trimmed = String(value).trim();
  if (/^(?:[0-9a-fA-F]{2})+$/.test(trimmed))
    return Buffer.from(trimmed, 'hex').toString('utf8');
  return trimmed;
}

/** The PEM private key, from the key file when one is configured, else the Keychain. */
function readPrivateKey(config, { run = spawnSync, warn = () => {} } = {}) {
  let pem;
  if (config.privateKeyPath) {
    try {
      // A key others on the machine can read is a leak waiting to happen.
      if (statSync(config.privateKeyPath).mode & 0o077)
        warn(
          `gh-app-token: warning: ${config.privateKeyPath} is readable by group or others; run chmod 600 on it\n`,
        );
      pem = readFileSync(config.privateKeyPath, 'utf8');
    } catch (error) {
      throw unconfigured(
        `cannot read the private key file ${config.privateKeyPath}: ${error?.code ?? 'unreadable'}`,
      );
    }
  } else {
    const result = run(
      'security',
      [
        'find-generic-password',
        '-s',
        config.keychainService,
        '-a',
        config.keychainAccount,
        '-w',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error || result.status !== 0 || !result.stdout?.trim())
      throw unconfigured(
        result.error?.code === 'ENOENT'
          ? 'no macOS `security` tool to read the Keychain; set STATION_GH_APP_PRIVATE_KEY_PATH to a key file outside the repository'
          : `no Keychain generic password for service '${config.keychainService}', account '${config.keychainAccount}'`,
      );
    pem = decodeKeychainSecret(result.stdout);
  }
  try {
    return createPrivateKey(pem);
  } catch {
    // Never echo the material itself.
    throw unconfigured(
      'the configured private key is not a readable PEM private key',
    );
  }
}

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * The app JWT GitHub expects: RS256, issued a minute in the past for clock
 * skew, valid nine minutes (GitHub's ceiling is ten).
 */
export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: String(appId) }),
  );
  const signature = cryptoSign(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function github(config, fetchImpl, path, { method = 'GET', jwt, body }) {
  let response;
  try {
    response = await fetchImpl(`${config.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'station-gh-app-token',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new GhAppTokenError(
      `GitHub request ${method} ${path} failed: ${error instanceof Error ? error.message : error}`,
      EXIT_GITHUB,
    );
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok)
    throw new GhAppTokenError(
      `GitHub ${method} ${path} answered ${response.status}: ${String(parsed?.message ?? text).slice(0, 200)}`,
      EXIT_GITHUB,
    );
  return parsed;
}

/**
 * Mint an installation token narrowed to `config.repository` and
 * `permissions`. The installation is the configured one, or the app's single
 * installation on `config.owner`.
 */
async function mintInstallationToken({
  config,
  permissions,
  privateKey,
  fetchImpl = fetch,
  now = Date.now(),
}) {
  const jwt = createAppJwt({ appId: config.appId, privateKey, now });
  let installationId = config.installationId;
  if (!installationId) {
    const installations = await github(
      config,
      fetchImpl,
      '/app/installations',
      {
        jwt,
      },
    );
    const matching = (Array.isArray(installations) ? installations : []).filter(
      (installation) =>
        String(installation?.account?.login).toLowerCase() ===
        config.owner.toLowerCase(),
    );
    if (matching.length !== 1)
      throw new GhAppTokenError(
        `expected one installation of app ${config.appId} on ${config.owner}, found ${matching.length}; set STATION_GH_APP_INSTALLATION_ID`,
        EXIT_GITHUB,
      );
    installationId = String(matching[0].id);
  }
  const minted = await github(
    config,
    fetchImpl,
    `/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      jwt,
      body: { repositories: [config.repository], permissions },
    },
  );
  if (typeof minted?.token !== 'string' || minted.token.length === 0)
    throw new GhAppTokenError(
      'GitHub returned no installation token',
      EXIT_GITHUB,
    );
  return { token: minted.token, expiresAt: minted.expires_at, installationId };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = fetch,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  run = spawnSync,
  isTerminal = () => Boolean(process.stdout.isTTY),
} = {}) {
  try {
    const { permissions, command } = parseArguments(argv);
    // A bare run prints the token; on a terminal that lands it in a session
    // transcript. `$(...)` and the `-- command` form never reach a terminal.
    if (command.length === 0 && isTerminal())
      throw new GhAppTokenError(
        'refusing to print a token to a terminal; capture it with GH_TOKEN=$(node scripts/gh-app-token.mjs) or run a command after --',
        EXIT_USAGE,
        'stdout-is-terminal',
      );
    const config = resolveConfiguration({ env, cwd });
    const privateKey = readPrivateKey(config, { run, warn: stderr });
    const { token } = await mintInstallationToken({
      config,
      permissions,
      privateKey,
      fetchImpl,
    });
    if (command.length === 0) {
      stdout(`${token}\n`);
      return 0;
    }
    const { GITHUB_TOKEN: _ignored, ...rest } = env;
    const child = run(command[0], command.slice(1), {
      cwd,
      env: { ...rest, GH_TOKEN: token },
      stdio: 'inherit',
      windowsHide: true,
    });
    if (child.error) {
      stderr(
        `gh-app-token: could not run ${command[0]}: ${child.error.message}\n`,
      );
      return EXIT_USAGE;
    }
    return child.status ?? 1;
  } catch (error) {
    if (error instanceof GhAppTokenError) {
      stderr(`gh-app-token: ${error.reason}: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

if (invokedDirectly(import.meta.url)) process.exitCode = await main();
