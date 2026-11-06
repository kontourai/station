/**
 * #4521: `station telemetry` on a machine whose managed policy turns
 * telemetry off. Runs `bin.ts` as a child process against a local server
 * that answers like the real routes (the server side is covered by
 * `src-server/services/__tests__/managed-telemetry-limit.test.ts`).
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const BIN = resolve(__dirname, '../bin.ts');
const DENIAL =
  "Acme's policy manages usage sharing: it is turned off. For help, visit https://help.example/station";
const makeTempDir = trackTempDirs();
let server: Server;
let base: string;
const puts: string[] = [];

beforeEach(async () => {
  puts.length = 0;
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'PUT' && request.url === '/config/app') {
        puts.push(body);
        response.statusCode = 403;
        response.end(
          JSON.stringify({
            success: false,
            code: 'managed-policy-capability-disabled',
            error: DENIAL,
            retryable: false,
          }),
        );
        return;
      }
      const managed = {
        tier: 'off',
        reason: 'managed',
        userChoice: 'full',
        managedDenial: DENIAL,
      };
      response.end(
        JSON.stringify({
          success: true,
          data: { publishers: { kontour: managed, operator: managed } },
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function run(args: string[]) {
  const home = makeTempDir('station-cli-managed-telemetry-');
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          BIN,
          'telemetry',
          ...args,
          `--api-base=${base}`,
          '--credential=operator-credential-for-test',
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

test('status names the managing organization for each destination', async () => {
  const result = await run(['status']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Kontour: Don't share (off); ${DENIAL}`);
  expect(result.stdout).toContain(
    `Additional destination: Don't share (off); ${DENIAL}`,
  );
}, 60_000);

test('set prints the managed refusal and exits non-zero', async () => {
  const result = await run(['set', 'operator', 'lite']);
  expect(puts).toEqual([
    JSON.stringify({ telemetryTier: { operator: 'lite' } }),
  ]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(DENIAL);
}, 60_000);
