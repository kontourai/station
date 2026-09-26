/**
 * #2377 slice A, decision 4, with a REAL separate process: a pooled stdio
 * station-control child (the internal token in its env, no per-session
 * caller credential) against this process's production boundary and guard.
 *
 * The child runs the stdio entry's own credential install
 * (`installStationControlStdioCallerCredential`) and then the same `api()`
 * every stdio tool uses. It never minted the server attestation — that lives
 * only in this (server) process's memory — so it can reach reads and nothing
 * else, and it cannot send the attestation even when it tries to enter a
 * server scope of its own.
 */
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { resolveStationControlCallerForRequest } from '../../runtime/mcp/station-control-caller.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { getInternalApiToken } from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { createStationControlAuthorityGuard } from '../station-control-authority-guard.js';
import {
  __resetStationServerSelfAttestationForTests,
  INTERNAL_SERVER_SELF_HEADER,
} from '../station-server-scope.js';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const probe = `
import {api,installStationControlStdioCallerCredential} from './src-server/tools/station-control-shared.ts';
import {runAsStationServer} from './src-server/security/station-server-scope.ts';
installStationControlStdioCallerCredential();
const read=await api('/agents');
const write=await api('/config/app',{method:'PUT',body:JSON.stringify({theme:'dark'})});
const scopedWrite=await runAsStationServer(()=>api('/config/app',{method:'PUT',body:'{}'}));
console.log(JSON.stringify({read,write,scopedWrite}));
`;

let server: ReturnType<typeof serve>;
let baseUrl: string;
const seen: Array<{ path: string; self: boolean }> = [];

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: () => false,
      resolveGrantedScope: () => undefined,
      now: () => Date.now(),
      maxFailures: 100,
      windowMs: 60_000,
      audit: () => {},
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request),
      isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
    }),
  );
  const record = (c: any) => {
    seen.push({
      path: c.req.path,
      self: c.req.header(INTERNAL_SERVER_SELF_HEADER) !== undefined,
    });
    return c.json(c.req.path === '/agents' ? [] : { success: true });
  };
  app.get('/agents', record);
  app.put('/config/app', record);
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((done) => {
    resolvePort = done;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  baseUrl = `http://127.0.0.1:${await listening}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  __resetStationServerSelfAttestationForTests();
});

test('a real pooled stdio child reaches reads only, and never carries the server attestation', async () => {
  const result = await run(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', probe],
    {
      cwd: root,
      env: {
        ...process.env,
        // The internal token Station hands its built-in child; no caller.
        STATION_INTERNAL_API_TOKEN: getInternalApiToken(),
        STATION_API_BASE: baseUrl,
        STATION_CONTROL_CALLER_TOKEN: '',
      },
      timeout: 30_000,
      maxBuffer: 16_384,
      windowsHide: true,
    },
  );
  const output = JSON.parse(result.stdout) as {
    read: unknown;
    write: { success: boolean; code?: string };
    scopedWrite: { success: boolean; code?: string };
  };
  expect(output.read).toEqual([]);
  expect(output.write).toMatchObject({
    success: false,
    code: 'station_control_caller_required',
  });
  // Entering a server scope in the child proves nothing: it holds no
  // attestation to send.
  expect(output.scopedWrite).toMatchObject({
    success: false,
    code: 'station_control_caller_required',
  });
  expect(seen).toEqual([{ path: '/agents', self: false }]);
}, 45_000);
