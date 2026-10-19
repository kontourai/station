/**
 * `station telemetry producers` as the published entry point runs it: a child
 * process of `bin.ts`, against a local HTTP server that answers like the
 * management routes. The server side of the contract is covered by
 * `src-server/monitoring/__tests__/telemetry-producer-ingest.routes.test.ts`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const BIN = resolve(__dirname, '../bin.ts');
const CREDENTIAL = 'operator-credential-for-test';
const TOKEN = `sti_${'a'.repeat(43)}`;

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

const makeTempDir = trackTempDirs();
let server: Server;
let base: string;
let seen: Seen[];
let reply: (request: Seen) => { status: number; body: unknown };

const readBody = (request: IncomingMessage) =>
  new Promise<string>((done) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => done(body));
  });

beforeEach(async () => {
  seen = [];
  server = createServer(async (request, response) => {
    const entry: Seen = {
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization,
      body: await readBody(request),
    };
    seen.push(entry);
    const { status, body } = reply(entry);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function run(args: string[]) {
  const home = makeTempDir('station-cli-producers-');
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          BIN,
          'telemetry',
          'producers',
          ...args,
          `--api-base=${base}`,
          `--credential=${CREDENTIAL}`,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            STATION_HOME: home,
            STATION_ROOT: home,
            STATION_API_CREDENTIAL: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('close', (status) => done({ status, stdout, stderr }));
    },
  );
}

const producer = {
  name: 'flow-agents',
  createdAt: '2026-10-19T00:00:00.000Z',
  expiresAt: null,
  expired: false,
  allowRemote: true,
  lastUsedAt: null,
};

describe('station telemetry producers', () => {
  test('create posts the request and prints the token once', async () => {
    reply = () => ({
      status: 201,
      body: { success: true, data: { producer, token: TOKEN } },
    });
    const result = await run([
      'create',
      'flow-agents',
      '--allow-remote',
      '--expires-in-days=30',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/telemetry-producers',
      authorization: `Bearer ${CREDENTIAL}`,
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      name: 'flow-agents',
      allowRemote: true,
      expiresInDays: 30,
    });
    expect(result.stdout.split(TOKEN)).toHaveLength(2);
    expect(result.stdout).toContain(`${base}/v1/agent-events`);
  }, 60_000);

  test('create --token-file writes an owner-only file and never prints the token', async () => {
    reply = () => ({
      status: 201,
      body: { success: true, data: { producer, token: TOKEN } },
    });
    const directory = makeTempDir('station-cli-token-file-');
    const tokenFile = join(directory, 'station-ingest.token');
    const result = await run([
      'create',
      'flow-agents',
      `--token-file=${tokenFile}`,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(tokenFile, 'utf8')).toBe(`${TOKEN}\n`);
    if (process.platform !== 'win32')
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(result.stdout).not.toContain(TOKEN);
  }, 60_000);

  test('create refuses an existing token file before minting', async () => {
    reply = () => ({ status: 500, body: { success: false } });
    const directory = makeTempDir('station-cli-token-file-');
    const tokenFile = join(directory, 'taken');
    writeFileSync(tokenFile, 'keep me');
    const result = await run(['create', 'x', `--token-file=${tokenFile}`]);

    expect(result.status).not.toBe(0);
    expect(seen).toHaveLength(0);
    expect(readFileSync(tokenFile, 'utf8')).toBe('keep me');
  }, 60_000);

  test('a refused create exits non-zero with the server message', async () => {
    reply = () => ({
      status: 409,
      body: {
        success: false,
        error: 'At most 32 telemetry producers can exist. Revoke one first.',
        code: 'producer_limit_reached',
      },
    });
    const result = await run(['create', 'one-too-many']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('At most 32 telemetry producers');
    expect(result.stdout).not.toContain('sti_');
  }, 60_000);

  test('list and revoke call the management routes', async () => {
    reply = (request) =>
      request.method === 'GET'
        ? {
            status: 200,
            body: { success: true, data: { producers: [producer] } },
          }
        : {
            status: 200,
            body: { success: true, data: { revoked: 'flow-agents' } },
          };
    const listed = await run(['list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('flow-agents');
    expect(listed.stdout).toContain('remote allowed');

    const revoked = await run(['revoke', 'flow-agents']);
    expect(revoked.status, revoked.stderr).toBe(0);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/telemetry-producers',
      'DELETE /api/telemetry-producers/flow-agents',
    ]);
  }, 60_000);

  test('a usage error exits non-zero without calling Station', async () => {
    reply = () => ({ status: 500, body: { success: false } });
    const result = await run(['revoke']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('station telemetry producers');
    expect(seen).toHaveLength(0);
  }, 60_000);
});
