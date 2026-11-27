import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveTailscaleOfferEndpoint } from '../../packages/cli/src/commands/tailscale-serve.js';
import { findFreePortOutside } from '../../scripts/lib/free-ports.mjs';
import { readE2EOperatorCredential } from '../helpers/e2e-operator-credential.js';
import {
  allocateLiveStation,
  createRepository,
  prepareLiveStationBuild,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from '../helpers/live-station-task.js';

async function main() {
  assert.equal(process.platform, 'linux');
  const live = await allocateLiveStation('station-nearby-host-', 'nearby');
  const root = stationRootForLiveHome(live.home);
  const trafficPath = join(root, 'nearby-traffic.ndjson');
  const observerPath = join(root, 'nearby-observer.cjs');
  const controlToken = randomUUID();
  const servePort = await findFreePortOutside(live.serverPort, 8);
  const beforeServe = JSON.parse(
    execFileSync('tailscale', ['serve', 'status', '--json'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  let origin: string | undefined;
  let started = false;
  let approved = false;
  let configured = false;
  try {
    await prepareLiveStationBuild(live);
    writeFileSync(trafficPath, '');
    writeFileSync(
      observerPath,
      `
const { subscribe } = require('node:diagnostics_channel');
const { appendFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const record = (stage, { request, response }) => {
  if (request.socket.localPort !== ${live.serverPort}
      || request.headers['x-nearby-fixture-control'] === ${JSON.stringify(controlToken)}) return;
  appendFileSync(${JSON.stringify(trafficPath)}, JSON.stringify({
    stage, path: request.url, method: request.method, status: response.statusCode,
    authenticated: Boolean(request.headers.authorization),
    authorizationHash: request.headers.authorization
      ? createHash('sha256').update(request.headers.authorization).digest('hex') : null,
  }) + '\\n');
};
subscribe('http.server.request.start', message => record('start', message));
subscribe('http.server.response.finish', message => record('finish', message));
`,
    );
    started = true;
    await startStation(live, false, {
      deterministicReadiness: false,
      environment: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${observerPath}`,
      },
    });
    const credential = readE2EOperatorCredential(live.home);
    const operatorHeaders = {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      'x-nearby-fixture-control': controlToken,
    };
    const projectName = `nearby-${Date.now()}`;
    const projectRoot = join(root, 'project');
    await createRepository(projectRoot, 'fixture');
    const project = await fetch(`${live.api}/api/projects`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({
        name: projectName,
        slug: projectName,
        workingDirectory: projectRoot,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(project.status, 201, await project.text());
    const identity = (await fetch(`${live.api}/.well-known/station/v1`).then(
      (response) => response.json(),
    )) as { environmentId: string };
    const endpoint = await resolveTailscaleOfferEndpoint({
      localApiBase: live.api,
      environmentId: identity.environmentId,
      servePort,
    });
    origin = endpoint.endpoint;
    configured = endpoint.configured;
    writeFileSync(trafficPath, '');
    console.log(
      `NEARBY_REMOTE ${JSON.stringify({ kind: 'ready', origin, projectName, trafficPath })}`,
    );
    for await (const line of createInterface({ input: process.stdin })) {
      const command = JSON.parse(line) as { action: string };
      if (command.action === 'stop') break;
      const requests = await fetch(`${live.api}/api/pairing/requests`, {
        headers: operatorHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(requests.status, 200);
      const pending = (await requests.json()) as {
        requests: Array<{
          requestId: string;
          status: string;
          deviceName: string;
        }>;
      };
      const traffic = readFileSync(trafficPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              path: string;
              authenticated: boolean;
              authorizationHash: string | null;
            },
        );
      const operatorHash = createHash('sha256')
        .update(operatorHeaders.Authorization)
        .digest('hex');
      assert.ok(
        traffic.every((entry) => entry.authorizationHash !== operatorHash),
        'Remote operator credential must stay on fixture control requests',
      );
      if (!approved) assert.ok(traffic.every((entry) => !entry.authenticated));
      if (command.action === 'approve') {
        assert.equal(pending.requests.length, 1);
        assert.ok(
          traffic.some((entry) =>
            entry.path.endsWith('/pairing/access-request'),
          ),
        );
        assert.ok(traffic.every((entry) => !entry.authenticated));
        const confirmation = await fetch(
          `${live.api}/api/pairing/requests/${pending.requests[0].requestId}/confirm`,
          {
            method: 'POST',
            headers: operatorHeaders,
            signal: AbortSignal.timeout(10_000),
          },
        );
        assert.equal(confirmation.status, 200, await confirmation.text());
        approved = true;
      } else {
        assert.equal(command.action, 'observe');
      }
      console.log(
        `NEARBY_REMOTE ${JSON.stringify({ kind: command.action, requests: pending.requests, traffic })}`,
      );
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (configured && origin) {
        const current = JSON.parse(
          execFileSync('tailscale', ['serve', 'status', '--json'], {
            encoding: 'utf8',
            windowsHide: true,
          }),
        );
        const listener = new URL(origin).host;
        assert.deepEqual(current.Web?.[listener], {
          Handlers: { '/': { Proxy: live.api } },
        });
        execFileSync('tailscale', ['serve', `--https=${servePort}`, 'off'], {
          windowsHide: true,
        });
        const restored = JSON.parse(
          execFileSync('tailscale', ['serve', 'status', '--json'], {
            encoding: 'utf8',
            windowsHide: true,
          }),
        );
        assert.deepEqual(restored, beforeServe);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (started) await stopStation(live);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 0)
      rmSync(root, { recursive: true, force: true });
    if (cleanupErrors.length) {
      console.error(
        new AggregateError(
          cleanupErrors,
          'Nearby remote fixture cleanup failed',
        ),
      );
      process.exitCode = 1;
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
