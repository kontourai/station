/**
 * `station environment operator passkeys …` against the REAL host routes and
 * registry (#3257, S2b). The CLI's HTTP seam (`request`) is wired straight to
 * the Hono app, so a change to either side's path, verb, body or error code
 * shows up here; only the TCP hop and the loopback proof are scripted.
 */
import { createHmac } from 'node:crypto';
import {
  buildStationProofMessage,
  PUBLIC_STATION_PROOF_PATH,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runEnvironmentCommand } from '../../../../packages/cli/src/commands/environment.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createOperatorPasskeyHostRoutes } from '../../../routes/operator-passkeys/operator-passkey-host-routes.js';
import { OperatorPasskeyEnrollmentService } from '../../../services/identity/operator-passkey-enrollment.js';
import { OperatorPasskeyRegistry } from '../../../services/identity/operator-passkey-registry.js';

const HOME = {
  schemaVersion: 1 as const,
  environmentId: '44444444-4444-4444-8444-444444444444',
  credential: 'operator-secret-that-must-not-leak',
};
const API = 'http://127.0.0.1:47822';
const ORIGIN = 'https://station.example.ts.net';
const makeTempDir = trackTempDirs();

let registry: OperatorPasskeyRegistry;
let service: OperatorPasskeyEnrollmentService;
let app: Hono;
const seenAuthorization: Array<string | undefined> = [];

beforeEach(() => {
  seenAuthorization.length = 0;
  registry = OperatorPasskeyRegistry.open(makeTempDir('station-passkey-cli-'));
  service = new OperatorPasskeyEnrollmentService({ registry, origin: ORIGIN });
  app = new Hono();
  app.route(
    '/api/pairing/operator-passkeys',
    createOperatorPasskeyHostRoutes({
      service,
      isOperator: (c) => {
        const header = (
          c as { req: { header(name: string): string | undefined } }
        ).req.header('authorization');
        seenAuthorization.push(header);
        return header === `Bearer ${HOME.credential}`;
      },
    }),
  );
});
afterEach(() => registry.close());

/** The CLI's transport, answered by the real routes. */
const request = vi.fn(
  async (_apiBase: string, path: string, init?: RequestInit) => {
    if (path === '/.well-known/station/v1') {
      return { environmentId: HOME.environmentId };
    }
    if (path === PUBLIC_STATION_PROOF_PATH) {
      const nonce = (JSON.parse(String(init?.body)) as { nonce: string }).nonce;
      return {
        protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
        environmentId: HOME.environmentId,
        nonce,
        signature: createHmac(
          'sha256',
          Buffer.from(HOME.credential, 'base64url'),
        )
          .update(buildStationProofMessage(HOME.environmentId, nonce))
          .digest('base64url'),
      };
    }
    if (forcedCode && path.startsWith('/api/pairing')) {
      throw Object.assign(new Error('raw upstream text must not show'), {
        code: forcedCode,
      });
    }
    const response = await app.request(path, init);
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}: ${body.error}`), {
        status: response.status,
        code: body.error,
      });
    }
    return body;
  },
);

let forcedCode: string | undefined;
const stdout = vi.fn();
const printed = () => stdout.mock.calls.map((call) => call[0]).join('\n');
const confirmPrompt = vi.fn<(question: string) => Promise<boolean>>();
let interactive = false;
const run = (...args: string[]) =>
  runEnvironmentCommand(
    ['operator', 'passkeys', ...args, `--api-base=${API}`],
    {
      createService: () =>
        ({
          initialize: vi.fn().mockResolvedValue(HOME),
          readExistingRecord: vi.fn().mockResolvedValue(HOME),
          rotateCredential: vi.fn(),
          resetEnvironment: vi.fn(),
        }) as never,
      projectHome: '/tmp/station-home',
      request: request as never,
      stdout,
      stderr: vi.fn(),
      isInteractive: interactive,
      confirm: confirmPrompt,
    },
  );

const DEVICE = {
  kind: 'paired-device' as const,
  deviceId: 'aaaa1111-0000-4000-8000-000000000001',
  pairedAt: Date.UTC(2026, 8, 1),
  scope: 'orchestration:read',
};
const ask = (deviceLabel = 'Phone browser') =>
  service.createRequest({
    credential: 'browser',
    deviceLabel,
    requester: DEVICE,
  });

beforeEach(() => {
  stdout.mockReset();
  request.mockClear();
  confirmPrompt.mockReset();
  interactive = false;
  forcedCode = undefined;
});

function enroll(label: string) {
  // Mint a stored passkey through the registry, as a finished ceremony would.
  return registry.add({
    credentialId: `cred-${label}`,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ['internal'],
    deviceType: 'multiDevice',
    backedUp: true,
    label,
    rpId: 'station.example.ts.net',
    origin: ORIGIN,
  });
}

describe('station environment operator passkeys', () => {
  test('list shows passkeys and pending requests, never a code, and nudges toward a second passkey', async () => {
    enroll('Primary');
    const { code } = ask();
    await run();
    const text = printed();
    expect(text).toContain('Primary');
    expect(text).toContain('Phone browser');
    expect(text).toContain('Enroll a second passkey');
    expect(text).not.toContain(code);
    expect(text).not.toContain(HOME.credential);
    // The home's operator credential reached the route.
    expect(seenAuthorization).toContain(`Bearer ${HOME.credential}`);
  });

  test('list shows who asked: device id, pairing date and scopes, plus the device-chosen name', async () => {
    ask();
    await run();
    const text = printed();
    expect(text).toContain('Device name (chosen by the device): Phone browser');
    expect(text).toContain('Device id: aaaa1111');
    expect(text).toContain('Paired: 2026-09-01T00:00:00.000Z');
    expect(text).toContain('Scopes: orchestration:read');
  });

  test('non-interactive approve needs --device, and refuses before confirming anything', async () => {
    const { code } = ask();
    await expect(run('approve', code)).rejects.toThrow(/--device/);
    expect(service.listPending()).toHaveLength(1);
    const paths = request.mock.calls.map((call) => call[1]);
    expect(paths.some((path) => path.includes('/requests/'))).toBe(false);
  });

  test('approve --device <prefix> confirms when it matches; a split code works too', async () => {
    const { code } = ask();
    await run('approve', code.slice(0, 3), code.slice(3), '--device=AAAA1111');
    expect(printed()).toContain('Confirmed');
    expect(service.listPending()).toEqual([]);
  });

  test('approve --device that names another device is refused and confirms nothing', async () => {
    const { code } = ask();
    await expect(run('approve', code, '--device=bbbb2222')).rejects.toThrow(
      /not opened by the device you named/,
    );
    expect(service.listPending()).toHaveLength(1);
  });

  test('interactive approve shows the requester and needs a yes', async () => {
    interactive = true;
    const { code } = ask();
    confirmPrompt.mockResolvedValueOnce(false);
    await run('approve', code);
    expect(printed()).toContain('Device id: aaaa1111');
    expect(printed()).toContain('Scopes: orchestration:read');
    expect(printed()).toContain('Cancelled');
    expect(service.listPending()).toHaveLength(1);

    confirmPrompt.mockResolvedValueOnce(true);
    await run('approve', code);
    expect(confirmPrompt).toHaveBeenCalledTimes(2);
    expect(printed()).toContain('Confirmed');
    expect(service.listPending()).toEqual([]);
  });

  test('deny withdraws a request that was already approved', async () => {
    const { code } = ask();
    await run('approve', code, '--device=aaaa1111');
    await run('deny', code);
    expect(printed()).toContain('Denied');
  });

  test('approve with a wrong code fails with the readable reason and confirms nothing', async () => {
    const { code } = ask();
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    await expect(run('approve', wrong, '--device=aaaa1111')).rejects.toThrow(
      /No pending enrollment/,
    );
    expect(service.listPending()).toHaveLength(1);
  });

  test('a malformed code is refused before any Station is contacted', async () => {
    await expect(run('approve', '12')).rejects.toThrow(/6-digit/);
    expect(request).not.toHaveBeenCalled();
  });

  test('deny <code> closes the request', async () => {
    const { code } = ask();
    await run('deny', code);
    expect(printed()).toContain('Denied');
    expect(service.listPending()).toEqual([]);
  });

  test('revoke <id> revokes the passkey on the host', async () => {
    const primary = enroll('Primary');
    const backup = enroll('Backup');
    await run('revoke', primary.id);
    expect(printed()).toContain('Revoked passkey "Primary"');
    expect(registry.listActive().map((passkey) => passkey.id)).toEqual([
      backup.id,
    ]);
    await expect(run('revoke', primary.id)).rejects.toThrow(
      /No active operator passkey/,
    );
  });

  test('says why enrollment is unavailable without a consent origin', async () => {
    const off = new OperatorPasskeyEnrollmentService({
      registry,
      origin: null,
    });
    app = new Hono();
    app.route(
      '/api/pairing/operator-passkeys',
      createOperatorPasskeyHostRoutes({ service: off, isOperator: () => true }),
    );
    await run();
    expect(printed()).toContain('Enrollment is unavailable');
    expect(printed()).toContain('STATION_TRUSTED_CONSENT_ORIGIN');
    await expect(run('approve', '123456', '--device=aaaa1111')).rejects.toThrow(
      /STATION_TRUSTED_CONSENT_ORIGIN/,
    );
  });

  test('rejects unknown verbs and extra flags', async () => {
    await expect(run('frobnicate')).rejects.toThrow(/Usage/);
    await expect(
      runEnvironmentCommand(
        ['operator', 'passkeys', 'approve', '123456', '--json'],
        {
          createService: () => ({}) as never,
          projectHome: '/tmp/x',
          request: request as never,
          stdout,
          stderr: vi.fn(),
          isInteractive: false,
        },
      ),
    ).rejects.toThrow(/Usage/);
  });

  test('every code the host routes can answer has readable CLI text, not the raw error', async () => {
    const hostCodes = [
      'invalid_code',
      'rate_limited',
      'enrollment_unavailable',
      'store_unavailable',
      'passkey_not_found',
      'device_mismatch',
      'device_gone',
      'authentication_required',
    ];
    for (const code of hostCodes) {
      forcedCode = code;
      const failure = await run('revoke', 'someid').then(
        () => null,
        (error: Error) => error,
      );
      expect(failure, code).not.toBeNull();
      expect(failure?.message, code).not.toContain('raw upstream');
      expect(failure?.message.length, code).toBeGreaterThan(20);
    }
  });
});
