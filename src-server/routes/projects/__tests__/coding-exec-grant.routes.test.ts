/**
 * #2412, owner decision (2026-09-23): `POST /api/coding/exec` stays at the
 * `orchestration:operate` tier and ALSO needs a per-device `coding:exec`
 * grant, which the operator gives once by promoting the paired device
 * (`setDeviceScope`, the `operator-promotion` path every elevated token
 * uses) and takes away the same way. The operator in person never needs it.
 *
 * Everything real except the command: the Station's own security service
 * pairs the devices and stores the grant, the runtime auth boundary stamps
 * the principal and scope, and the coding routes decide. The command
 * writes a marker, so "allowed" means it ran and "refused" means it did not.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_CODING_EXEC,
  PAIRING_SCOPE_PRESETS,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import * as childWorkload from '@kontourai/station-shared/child-workload';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { bindFullAccessRefusalIdentity } from '../../../security/full-access-refusal.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createCodingRoutes } from '../coding.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(options: { hostCli?: string } = {}) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = mkdtempSync(join(tmpdir(), 'station-coding-exec-grant-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'home'),
  });
  const operator = await security.initialize();

  const pair = (
    name: string,
    mint: { locality?: 'home-possession'; mintKind?: 'local-grant' } = {},
  ) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
      ...mint,
    });
  };

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'coding-exec-grant-test', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  // As the runtime composition binds it: the host's own operator CLI.
  if (options.hostCli) {
    const hostCli = options.hostCli;
    app.use('*', async (c, next) => {
      bindFullAccessRefusalIdentity(c.req.raw, {
        environmentId: () => undefined,
        deviceName: () => undefined,
        hostCli: () => hostCli,
      });
      await next();
    });
  }
  app.route(
    '/api/coding',
    createCodingRoutes(new FileTreeService(), {
      resolveProjectFolder: (slug) => (slug === 'acme' ? project : undefined),
    }),
  );

  let runs = 0;
  /** POSTs a command that leaves a fresh marker; reports whether it ran. */
  const exec = async (credential: string) => {
    const marker = join(project, `ran-${++runs}`);
    const res = await app.request('/api/coding/exec', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectSlug: 'acme',
        command: `touch ${JSON.stringify(marker)}`,
      }),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      ran: existsSync(marker),
    };
  };

  const grant = (deviceId: string, on: boolean) =>
    security.devicePairing.setDeviceScope(
      deviceId,
      [
        ...PAIRING_SCOPE_PRESETS.standard,
        ...(on ? [PAIRING_SCOPE_CODING_EXEC] : []),
      ],
      { kind: 'presented-credential' },
    );

  return { operator, pair, exec, grant };
}

test('a paired device without the grant is refused with a stable code, and nothing runs', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');

  const refused = await f.exec(phone.credential);

  expect(refused).toEqual({
    status: 403,
    body: {
      success: false,
      code: 'coding-exec-not-granted',
      error: `This device is not allowed to run commands on this Station's computer. The Station's operator can allow it: on the Station's host, run: station environment access scope ${phone.device.id.slice(0, 8)} --add coding:exec; or in the Station desktop app on its host, select the Station name (top right) → Paired devices → this device → Change access → Run commands → Apply.`,
    },
    ran: false,
  });
});

test("the refusal's host command names this Station's own CLI, as the operator runs it", async () => {
  // A nightly host has no `station` on its PATH.
  const f = await fixture({ hostCli: 'npx @kontourai/station-cli@nightly' });
  const phone = f.pair('Phone');

  const refused = await f.exec(phone.credential);

  expect(refused.status).toBe(403);
  expect(refused.body.error).toContain(
    `run: npx @kontourai/station-cli@nightly environment access scope ${phone.device.id.slice(0, 8)} --add coding:exec;`,
  );
  expect(refused.ran).toBe(false);
});

test('the operator grants it once, the device runs commands, and revoking takes it away', async () => {
  const f = await fixture();
  const phone = f.pair('Phone');

  f.grant(phone.device.id, true);
  const granted = await f.exec(phone.credential);
  expect(granted.status).toBe(200);
  expect(granted.ran).toBe(true);
  // Once is enough: the grant is stored on the device, not per request.
  expect((await f.exec(phone.credential)).ran).toBe(true);

  f.grant(phone.device.id, false);
  const revoked = await f.exec(phone.credential);
  expect(revoked.status).toBe(403);
  expect(revoked.body.code).toBe('coding-exec-not-granted');
  expect(revoked.ran).toBe(false);
});

test("one device's grant is not another's", async () => {
  const f = await fixture();
  const phone = f.pair('Phone');
  const tablet = f.pair('Tablet');
  f.grant(phone.device.id, true);

  expect((await f.exec(phone.credential)).ran).toBe(true);
  const other = await f.exec(tablet.credential);
  expect(other.status).toBe(403);
  expect(other.ran).toBe(false);
});

test('the operator in person needs no grant: the operator credential', async () => {
  const f = await fixture();

  const res = await f.exec(f.operator.credential);

  expect(res.status).toBe(200);
  expect(res.ran).toBe(true);
});

test('the operator in person needs no grant: the desktop app, minted by proving possession of this home', async () => {
  const f = await fixture();
  const desktop = f.pair('Desktop app', {
    locality: 'home-possession',
    mintKind: 'local-grant',
  });

  const res = await f.exec(desktop.credential);

  expect(res.status).toBe(200);
  expect(res.ran).toBe(true);
});

test('an authorized project command does not run when workload admission refuses it', async () => {
  const f = await fixture();
  const admission = vi
    .spyOn(childWorkload, 'execFileChildWorkload')
    .mockRejectedValue(new Error('workload enforcement unavailable'));
  try {
    const refused = await f.exec(f.operator.credential);
    expect(refused.body.success).toBe(false);
    expect(refused.ran).toBe(false);
    expect(admission).toHaveBeenCalled();
  } finally {
    admission.mockRestore();
  }
});
