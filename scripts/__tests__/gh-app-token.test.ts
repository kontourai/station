/**
 * The automation-token helper (#2926), end to end with no network: a
 * generated key, a fake `security` on PATH, and a loopback GitHub that
 * verifies the app JWT with the matching public key before it mints.
 */
import { spawn } from 'node:child_process';
import { verify as cryptoVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  createAppJwt,
  DEFAULT_PERMISSIONS,
  decodeKeychainSecret,
  EXIT_GITHUB,
  EXIT_UNCONFIGURED,
  EXIT_USAGE,
  main,
  SETUP_DOC,
} from '../gh-app-token.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/gh-app-token.mjs');
const makeTempDir = trackTempDirs();
const posix = process.platform !== 'win32';

const APP_ID = '12345';
const INSTALLATION_ID = 777;
const TOKEN = 'ghs_fixtureInstallationToken';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_HEX = Buffer.from(PEM, 'utf8').toString('hex');

function decodeJwt(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    valid: cryptoVerify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
  };
}

describe('the app JWT', () => {
  it('is RS256, signed by the app key, issued a minute back and valid nine minutes from now', () => {
    const now = 1_700_000_000_000;
    const { header, payload, valid } = decodeJwt(
      createAppJwt({ appId: APP_ID, privateKey, now }),
    );
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toEqual({
      iss: APP_ID,
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
    });
  });

  it('decodes a hex Keychain secret and leaves a plain PEM alone', () => {
    expect(decodeKeychainSecret(`${PEM_HEX}\n`)).toBe(PEM);
    expect(decodeKeychainSecret(PEM)).toBe(PEM.trim());
  });
});

type Seen = { method: string; url: string; body: unknown; jwt: unknown };

/** A loopback GitHub: verifies the JWT, lists one installation, mints. */
async function fakeGitHub({
  failMint = false,
}: {
  failMint?: boolean;
} = {}): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const read = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      request.on('data', (chunk) => {
        text += chunk;
      });
      request.on('end', () => resolve(text));
    });
  const server = createServer(async (request, response) => {
    const raw = await read(request);
    const auth = String(request.headers.authorization ?? '');
    const jwt = auth.startsWith('Bearer ')
      ? decodeJwt(auth.slice('Bearer '.length))
      : null;
    seen.push({
      method: request.method ?? '',
      url: request.url ?? '',
      body: raw ? JSON.parse(raw) : null,
      jwt,
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (!jwt?.valid || jwt.payload.iss !== APP_ID)
      return send(401, { message: 'A JSON web token could not be decoded' });
    if (request.method === 'GET' && request.url === '/app/installations')
      return send(200, [
        { id: 1, account: { login: 'someone-else' } },
        { id: INSTALLATION_ID, account: { login: 'kontourai' } },
      ]);
    if (
      request.method === 'POST' &&
      request.url === `/app/installations/${INSTALLATION_ID}/access_tokens`
    )
      return failMint
        ? send(422, { message: 'The permissions requested are not granted' })
        : send(201, { token: TOKEN, expires_at: '2099-01-01T00:00:00Z' });
    return send(404, { message: 'Not Found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return { url: `http://127.0.0.1:${port}`, seen, server };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A `security` that answers only the expected lookup, as the real one prints it. */
function fakeSecurity(secret: string | null) {
  const bin = makeTempDir('station-fake-security-');
  const secretFile = join(bin, 'secret');
  writeFileSync(secretFile, secret ?? '');
  writeFileSync(
    join(bin, 'security'),
    [
      '#!/bin/sh',
      `if [ "$*" = "find-generic-password -s kontourai-station-automation -a ${APP_ID} -w" ] && [ -s "${secretFile}" ]; then`,
      `  cat "${secretFile}"; echo`,
      '  exit 0',
      'fi',
      'echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2',
      'exit 44',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'security'), 0o755);
  return bin;
}

async function runHelper(
  args: string[],
  env: Record<string, string>,
  cwd = ROOT,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve) =>
    child.on('close', resolve),
  );
  return { status, stdout, stderr };
}

function baseEnv(extra: Record<string, string> = {}) {
  const home = makeTempDir('station-gh-app-home-');
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    ...extra,
  };
}

describe('printing the token', () => {
  it('refuses a bare run on a terminal before reading any key or calling GitHub', async () => {
    const printed: string[] = [];
    const errors: string[] = [];
    let requests = 0;
    const status = await main({
      argv: [],
      env: { STATION_GH_APP_ID: APP_ID },
      fetchImpl: (async () => {
        requests += 1;
        throw new Error('no request expected');
      }) as typeof fetch,
      stdout: (text: string) => {
        printed.push(text);
        return true;
      },
      stderr: (text: string) => {
        errors.push(text);
        return true;
      },
      run: (() => {
        throw new Error('no Keychain read expected');
      }) as any,
      isTerminal: () => true,
    });
    expect(status).toBe(EXIT_USAGE);
    expect(printed).toEqual([]);
    expect(requests).toBe(0);
    expect(errors.join('')).toMatch(/^gh-app-token: stdout-is-terminal:/);
  });
});

describe.skipIf(!posix)('gh-app-token as a child process', () => {
  it('mints a narrowed read-only token from a hex Keychain secret by default', async () => {
    const github = await fakeGitHub();
    const env = baseEnv({
      STATION_GH_APP_ID: APP_ID,
      STATION_GH_API_URL: github.url,
    });
    env.PATH = `${fakeSecurity(PEM_HEX)}:${env.PATH}`;
    const result = await runHelper([], env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${TOKEN}\n`);
    const mint = github.seen.at(-1);
    expect(mint?.method).toBe('POST');
    expect(mint?.body).toEqual({
      repositories: ['station'],
      permissions: DEFAULT_PERMISSIONS,
    });
    expect(Object.values(DEFAULT_PERMISSIONS)).toEqual(
      Object.values(DEFAULT_PERMISSIONS).map(() => 'read'),
    );
    for (const request of github.seen)
      expect(request.jwt).toMatchObject({
        valid: true,
        payload: { iss: APP_ID },
      });
  });

  it('requests exactly the write scope asked for, and runs a command with the token', async () => {
    const github = await fakeGitHub();
    const keyDir = makeTempDir('station-gh-app-key-');
    writeFileSync(join(keyDir, 'app.pem'), PEM, { mode: 0o600 });
    const env = baseEnv({
      STATION_GH_APP_ID: APP_ID,
      STATION_GH_API_URL: github.url,
      STATION_GH_APP_PRIVATE_KEY_PATH: join(keyDir, 'app.pem'),
      GITHUB_TOKEN: 'owner-personal-token',
    });
    const result = await runHelper(
      [
        '--permissions',
        'pull_requests:write',
        '--',
        process.execPath,
        '-e',
        'process.stdout.write(process.env.GH_TOKEN + "|" + (process.env.GITHUB_TOKEN ?? "unset"))',
      ],
      env,
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The child saw the app token, and not the owner's personal one.
    expect(result.stdout).toBe(`${TOKEN}|unset`);
    expect(github.seen.at(-1)?.body).toEqual({
      repositories: ['station'],
      permissions: { metadata: 'read', pull_requests: 'write' },
    });
  });

  it('requests workflows write only when explicitly selected for workflow PR arming', async () => {
    const github = await fakeGitHub();
    const keyDir = makeTempDir('station-gh-workflow-key-');
    writeFileSync(join(keyDir, 'app.pem'), PEM, { mode: 0o600 });
    const env = baseEnv({
      STATION_GH_APP_ID: APP_ID,
      STATION_GH_API_URL: github.url,
      STATION_GH_APP_PRIVATE_KEY_PATH: join(keyDir, 'app.pem'),
    });
    expect(DEFAULT_PERMISSIONS).not.toHaveProperty('workflows');
    const result = await runHelper(
      ['--permissions', 'pull_requests:write,contents:write,workflows:write'],
      env,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(github.seen.at(-1)?.body).toEqual({
      repositories: ['station'],
      permissions: {
        metadata: 'read',
        pull_requests: 'write',
        contents: 'write',
        workflows: 'write',
      },
    });
    const invalid = await runHelper(['--permissions', 'workflows:read'], env);
    expect(invalid.status).toBe(EXIT_USAGE);
  });

  it('fails closed with the setup pointer when unconfigured', async () => {
    const result = await runHelper([], baseEnv());
    expect(result.status).toBe(EXIT_UNCONFIGURED);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(SETUP_DOC);
  });

  it('fails closed when the Keychain has no item, and never prints a token', async () => {
    const github = await fakeGitHub();
    const env = baseEnv({
      STATION_GH_APP_ID: APP_ID,
      STATION_GH_API_URL: github.url,
    });
    env.PATH = `${fakeSecurity(null)}:${env.PATH}`;
    const result = await runHelper([], env);
    expect(result.status).toBe(EXIT_UNCONFIGURED);
    expect(result.stdout).toBe('');
    expect(github.seen).toEqual([]);
  });

  /** A repository whose files the helper must refuse to read secrets from. */
  async function repository() {
    const repo = makeTempDir('station-gh-app-repo-');
    const init = spawn('git', ['init', '-q', repo], { windowsHide: true });
    await new Promise((resolve) => init.on('close', resolve));
    return repo;
  }
  /** The reason code a refusal prints first (#2927). */
  const refusal = (stderr: string) =>
    /^gh-app-token: ([a-z-]+):/.exec(stderr)?.[1];

  it('refuses a config file inside a repository, before any request, even when the rest would mint', async () => {
    const github = await fakeGitHub();
    const keyDir = makeTempDir('station-gh-app-key-');
    writeFileSync(join(keyDir, 'app.pem'), PEM, { mode: 0o600 });
    const repo = await repository();
    mkdirSync(join(repo, 'conf'));
    // Everything in this config works: only its location is wrong.
    writeFileSync(
      join(repo, 'conf/gh-app.json'),
      JSON.stringify({
        appId: APP_ID,
        privateKeyPath: join(keyDir, 'app.pem'),
        apiUrl: github.url,
      }),
    );
    const result = await runHelper(
      [],
      baseEnv({ STATION_GH_APP_CONFIG: join(repo, 'conf/gh-app.json') }),
      repo,
    );
    expect(refusal(result.stderr)).toBe('config-in-repository');
    expect(result.status).toBe(EXIT_UNCONFIGURED);
    expect(result.stdout).toBe('');
    expect(github.seen).toEqual([]);
  });

  it('refuses a private key inside a repository, before any request', async () => {
    const github = await fakeGitHub();
    const repo = await repository();
    writeFileSync(join(repo, 'app.pem'), PEM, { mode: 0o600 });
    const result = await runHelper(
      [],
      baseEnv({
        STATION_GH_APP_ID: APP_ID,
        STATION_GH_API_URL: github.url,
        STATION_GH_APP_PRIVATE_KEY_PATH: join(repo, 'app.pem'),
      }),
      repo,
    );
    expect(refusal(result.stderr)).toBe('key-in-repository');
    expect(result.status).toBe(EXIT_UNCONFIGURED);
    expect(result.stdout).toBe('');
    expect(github.seen).toEqual([]);
  });

  it('warns about a key file others can read, and still mints', async () => {
    const github = await fakeGitHub();
    const keyDir = makeTempDir('station-gh-app-key-');
    writeFileSync(join(keyDir, 'app.pem'), PEM, { mode: 0o644 });
    chmodSync(join(keyDir, 'app.pem'), 0o644);
    const result = await runHelper(
      [],
      baseEnv({
        STATION_GH_APP_ID: APP_ID,
        STATION_GH_API_URL: github.url,
        STATION_GH_APP_PRIVATE_KEY_PATH: join(keyDir, 'app.pem'),
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${TOKEN}\n`);
    expect(result.stderr).toMatch(/^gh-app-token: warning: /);
  });

  it('refuses an invalid API URL cleanly', async () => {
    const result = await runHelper(
      [],
      baseEnv({ STATION_GH_APP_ID: APP_ID, STATION_GH_API_URL: 'not a url' }),
    );
    expect(result.status).toBe(EXIT_UNCONFIGURED);
    expect(refusal(result.stderr)).toBe('unconfigured');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('refuses a permission the helper does not offer', async () => {
    const result = await runHelper(
      ['--permissions', 'administration:write'],
      baseEnv({ STATION_GH_APP_ID: APP_ID }),
    );
    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stdout).toBe('');
  });

  it('reports a refused mint as a GitHub failure, with no token', async () => {
    const github = await fakeGitHub({ failMint: true });
    const env = baseEnv({
      STATION_GH_APP_ID: APP_ID,
      STATION_GH_API_URL: github.url,
    });
    env.PATH = `${fakeSecurity(PEM_HEX)}:${env.PATH}`;
    const result = await runHelper([], env);
    expect(result.status).toBe(EXIT_GITHUB);
    expect(result.stdout).toBe('');
    // The key never reaches the output, in any encoding.
    expect(result.stderr).not.toContain('PRIVATE KEY');
    expect(result.stderr).not.toContain(PEM_HEX.slice(0, 64));
  });
});
