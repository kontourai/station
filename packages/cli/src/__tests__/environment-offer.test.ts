import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeDevicePairingPayload } from '@kontourai/station-connect/device-pairing';
import {
  buildStationProofMessage,
  DEVICE_PAIRING_PROTOCOL_VERSION,
  pairingScopePresetString,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { describe, expect, test, vi } from 'vitest';
import { publishActiveLocalStation } from '../commands/active-local-station.js';
import { runEnvironmentCommand } from '../commands/environment.js';

const API_BASE = 'http://127.0.0.1:43141';
const CREDENTIAL = Buffer.from('a'.repeat(32)).toString('base64url');
const SNAPSHOT = {
  schemaVersion: 1,
  environmentId: 'environment-local',
  credential: CREDENTIAL,
};
type EnvironmentCommandDependencies = Parameters<
  typeof runEnvironmentCommand
>[1];
type OperatorJsonRequest = NonNullable<
  EnvironmentCommandDependencies['request']
>;
type StringWriter = NonNullable<EnvironmentCommandDependencies['stdout']>;

function proofFor(nonce: string) {
  return {
    protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
    environmentId: SNAPSHOT.environmentId,
    nonce,
    signature: createHmac('sha256', Buffer.from(CREDENTIAL, 'base64url'))
      .update(buildStationProofMessage(SNAPSHOT.environmentId, nonce))
      .digest('base64url'),
  };
}

function dependencies(
  request: ReturnType<typeof vi.fn<OperatorJsonRequest>>,
): EnvironmentCommandDependencies & {
  stdout: ReturnType<typeof vi.fn<StringWriter>>;
  offer: {
    readActiveLocalStation: () => string | undefined;
    renderQr: ReturnType<typeof vi.fn>;
  };
} {
  return {
    projectHome: '/tmp/station-home',
    createService: () => ({
      initialize: async () => SNAPSHOT,
      rotateCredential: async () => SNAPSHOT,
      resetEnvironment: async () => SNAPSHOT,
    }),
    request,
    stdout: vi.fn<StringWriter>(),
    offer: {
      readActiveLocalStation: () => API_BASE,
      renderQr: vi.fn(async () => 'QR-BLOCKS'),
    },
  };
}

describe('environment offer', () => {
  test.each([
    [
      'duplicate ports',
      [
        'offer',
        '--tailscale',
        '--tailscale-serve-port=8444',
        '--tailscale-serve-port=443',
      ],
    ],
    [
      'contradictory tailscale flags',
      ['offer', '--tailscale=false', '--tailscale'],
    ],
    ['port without tailscale', ['offer', '--tailscale-serve-port=8444']],
    [
      'bare duplicate port',
      ['offer', '--tailscale-serve-port', '--tailscale-serve-port=8444'],
    ],
  ])('rejects %s before any offer effect', async (_label, args) => {
    const request = vi.fn<OperatorJsonRequest>();
    const deps = dependencies(request);
    const createService = vi.fn(deps.createService!);
    deps.createService = createService;
    await expect(runEnvironmentCommand(args, deps)).rejects.toThrow(/Usage:/);
    expect(createService).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  test('discovers an offer host through the real published active-local record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-offer-active-local-'));
    try {
      publishActiveLocalStation(
        { apiBase: API_BASE, ownerPid: process.pid },
        root,
      );
      const request = vi
        .fn<OperatorJsonRequest>()
        .mockImplementation(async (_apiBase, path, init?: RequestInit) => {
          if (path === '/.well-known/station/v1') {
            return { environmentId: SNAPSHOT.environmentId };
          }
          if (path === '/.well-known/station/v1/proof') {
            const body = JSON.parse(String(init?.body)) as { nonce: string };
            return proofFor(body.nonce);
          }
          if (path === '/api/pairing/offers') {
            return {
              protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
              environmentId: '11111111-1111-4111-8111-111111111111',
              offerId: 'offer-real-reader',
              challenge: 'challenge-real-reader',
              manualCode: 'PAIRME2345',
              endpoint: API_BASE,
              scope: pairingScopePresetString('standard'),
              expiresAt: Date.now() + 60_000,
            };
          }
          throw new Error(`unexpected path ${path}`);
        });
      const deps = dependencies(request);
      deps.projectHome = root;
      delete (deps.offer as { readActiveLocalStation?: () => string })
        .readActiveLocalStation;

      await runEnvironmentCommand(['offer'], deps);

      expect(deps.stdout).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads the active-local record from the resolved channel home', async () => {
    const request = vi.fn<OperatorJsonRequest>();
    const deps = dependencies(request);
    deps.projectHome = '/tmp/station-beta';
    const readActiveLocalStation = vi.fn(() => undefined);
    deps.offer.readActiveLocalStation = readActiveLocalStation;

    await expect(runEnvironmentCommand(['offer'], deps)).rejects.toThrow(
      /No running local Station was discovered/,
    );
    expect(readActiveLocalStation).toHaveBeenCalledWith({
      path: '/tmp/station-beta/runtime/active-local.json',
    });
  });

  test('mints the existing pairing offer protocol and prints a QR, payload, endpoint, and expiry', async () => {
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path, init?: RequestInit) => {
        if (path === '/.well-known/station/v1') {
          return { environmentId: SNAPSHOT.environmentId };
        }
        if (path === '/.well-known/station/v1/proof') {
          const body = JSON.parse(String(init?.body)) as { nonce: string };
          return proofFor(body.nonce);
        }
        if (path === '/api/pairing/offers') {
          expect(init?.headers).toMatchObject({
            Authorization: `Bearer ${CREDENTIAL}`,
          });
          expect(JSON.parse(String(init?.body))).toEqual({
            endpoint: API_BASE,
          });
          return {
            protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
            environmentId: '11111111-1111-4111-8111-111111111111',
            offerId: 'offer-123',
            challenge: 'challenge-123',
            manualCode: 'PAIRME2345',
            endpoint: API_BASE,
            scope: pairingScopePresetString('standard'),
            expiresAt: Date.now() + 60_000,
          };
        }
        throw new Error(`unexpected path ${path}`);
      });
    const deps = dependencies(request);

    await runEnvironmentCommand(['offer'], deps);

    const output = deps.stdout.mock.calls[0]?.[0] as string;
    expect(output).toContain('Endpoint: http://127.0.0.1:43141');
    expect(output).toContain('Expires: ');
    expect(output).toContain('station-pairing:v1:');
    expect(output).toContain('QR-BLOCKS');
    expect(output).toContain('phone cannot reach it directly');
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('prints only a decodable payload carrying an explicit forwarded endpoint', async () => {
    const forwarded = 'http://127.0.0.1:45678';
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path, init?: RequestInit) => {
        if (path === '/.well-known/station/v1')
          return { environmentId: SNAPSHOT.environmentId };
        if (path === '/.well-known/station/v1/proof') {
          const body = JSON.parse(String(init?.body)) as { nonce: string };
          return proofFor(body.nonce);
        }
        if (path === '/api/pairing/offers') {
          expect(JSON.parse(String(init?.body))).toEqual({
            endpoint: forwarded,
          });
          return {
            protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
            environmentId: '11111111-1111-4111-8111-111111111111',
            offerId: 'offer-forwarded',
            challenge: 'challenge-forwarded',
            manualCode: 'PAIRME2345',
            endpoint: forwarded,
            scope: pairingScopePresetString('standard'),
            expiresAt: Date.now() + 60_000,
          };
        }
        throw new Error(`unexpected path ${path}`);
      });
    const deps = dependencies(request);
    await runEnvironmentCommand(
      ['offer', '--payload-only', '--advertise-url', forwarded],
      deps,
    );
    const output = deps.stdout.mock.calls[0]?.[0] as string;
    expect(output.startsWith('station-pairing:v1:')).toBe(true);
    expect(output).not.toContain('\n');
    expect(deps.offer.renderQr).not.toHaveBeenCalled();
  });

  test('fails loudly before contacting an untracked or stopped local listener', async () => {
    const request = vi.fn<OperatorJsonRequest>();
    const deps = dependencies(request);
    deps.offer.readActiveLocalStation = () => undefined;

    await expect(runEnvironmentCommand(['offer'], deps)).rejects.toThrow(
      /No running local Station was discovered/,
    );
    expect(request).not.toHaveBeenCalled();
  });

  test('refuses to send an operator credential when the listener cannot prove the local environment', async () => {
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path) => {
        if (path === '/.well-known/station/v1') {
          return { environmentId: SNAPSHOT.environmentId };
        }
        if (path === '/.well-known/station/v1/proof') {
          return { ...proofFor('wrong-nonce'), nonce: 'wrong-nonce' };
        }
        throw new Error(`unexpected path ${path}`);
      });
    const deps = dependencies(request);

    await expect(runEnvironmentCommand(['offer'], deps)).rejects.toThrow(
      /could not prove it owns this Station environment/,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalledWith(
      API_BASE,
      '/api/pairing/offers',
      expect.anything(),
    );
  });

  test('proves the local listener before attempting Tailscale publication', async () => {
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path) => {
        if (path === '/.well-known/station/v1') {
          return { environmentId: SNAPSHOT.environmentId };
        }
        if (path === '/.well-known/station/v1/proof') {
          return { ...proofFor('wrong-nonce'), nonce: 'wrong-nonce' };
        }
        throw new Error(`unexpected path ${path}`);
      });
    const deps = dependencies(request);
    const command = vi.fn();
    deps.offer.tailscale = { command, probe: vi.fn() };

    await expect(
      runEnvironmentCommand(['offer', '--tailscale'], deps),
    ).rejects.toThrow(/could not prove it owns this Station environment/);
    expect(command).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalledWith(
      API_BASE,
      '/api/pairing/offers',
      expect.anything(),
    );
  });

  test('offers a MagicDNS endpoint and prints manual Tailscale teardown guidance', async () => {
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path, init?: RequestInit) => {
        if (path === '/.well-known/station/v1') {
          return { environmentId: SNAPSHOT.environmentId };
        }
        if (path === '/.well-known/station/v1/proof') {
          const body = JSON.parse(String(init?.body)) as { nonce: string };
          return proofFor(body.nonce);
        }
        if (path === '/api/pairing/offers') {
          expect(JSON.parse(String(init?.body))).toEqual({
            endpoint: 'https://station.tailnet.ts.net',
          });
          return {
            protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
            environmentId: '11111111-1111-4111-8111-111111111111',
            offerId: 'offer-tailnet',
            challenge: 'challenge-tailnet',
            manualCode: 'PAIRME2345',
            endpoint: 'https://station.tailnet.ts.net',
            scope: pairingScopePresetString('standard'),
            expiresAt: Date.now() + 60_000,
          };
        }
        throw new Error(`unexpected path ${path}`);
      });
    const deps = dependencies(request);
    const command = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'status') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Self: { DNSName: 'station.tailnet.ts.net.', Online: true },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'serve' && args[1] === 'status') {
        return { exitCode: 0, stdout: JSON.stringify({ Web: {} }), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    deps.offer.tailscale = { command, probe: async () => 'unreachable' };

    await runEnvironmentCommand(['offer', '--tailscale'], deps);

    const output = deps.stdout.mock.calls[0]?.[0] as string;
    expect(output).toContain('published privately on this tailnet');
    expect(output).toContain('tailscale serve --https=443 off');
    expect(command).toHaveBeenCalledWith([
      'serve',
      '--bg',
      '--https=443',
      'http://127.0.0.1:43141',
    ]);
  });

  test('propagates an alternate Tailscale port through publish, mint, and output', async () => {
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_base, path, init) => {
        if (path === '/.well-known/station/v1')
          return { environmentId: SNAPSHOT.environmentId };
        if (path === '/.well-known/station/v1/proof')
          return proofFor(
            (JSON.parse(String(init?.body)) as { nonce: string }).nonce,
          );
        if (path === '/api/pairing/offers') {
          expect(JSON.parse(String(init?.body))).toEqual({
            endpoint: 'https://station.tailnet.ts.net:8444',
          });
          return {
            protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
            environmentId: SNAPSHOT.environmentId,
            offerId: 'offer-8444',
            challenge: 'challenge',
            manualCode: 'PAIRME2345',
            endpoint: 'https://station.tailnet.ts.net:8444',
            scope: pairingScopePresetString('standard'),
            expiresAt: Date.now() + 60_000,
          };
        }
        throw new Error(`unexpected ${path}`);
      });
    const deps = dependencies(request);
    const command = vi.fn(async (args: readonly string[]) =>
      args[0] === 'status'
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              Self: { DNSName: 'station.tailnet.ts.net.', Online: true },
            }),
            stderr: '',
          }
        : args[1] === 'status'
          ? { exitCode: 0, stdout: JSON.stringify({ Web: {} }), stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
    );
    deps.offer.tailscale = { command, probe: async () => 'unreachable' };
    await runEnvironmentCommand(
      ['offer', '--tailscale', '--tailscale-serve-port=8444'],
      deps,
    );
    expect(command).toHaveBeenCalledWith([
      'serve',
      '--bg',
      '--https=8444',
      'http://127.0.0.1:43141',
    ]);
    expect(deps.stdout.mock.calls[0]?.[0]).toContain(
      'tailscale serve --https=8444 off',
    );
    const output = deps.stdout.mock.calls[0]?.[0] as string;
    const payload = output
      .split('\n')
      .find((line) => line.startsWith('station-pairing:v1:'))!;
    expect(decodeDevicePairingPayload(payload)?.endpoint).toBe(
      'https://station.tailnet.ts.net:8444',
    );
    expect(deps.offer.renderQr).toHaveBeenCalledWith(payload);
    expect(output).toContain('Endpoint: https://station.tailnet.ts.net:8444');
  });

  test('names the alternate port in post-publication mint failure teardown', async () => {
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_base, path, init) => {
        if (path === '/.well-known/station/v1')
          return { environmentId: SNAPSHOT.environmentId };
        if (path === '/.well-known/station/v1/proof')
          return proofFor(
            (JSON.parse(String(init?.body)) as { nonce: string }).nonce,
          );
        if (path === '/api/pairing/offers') throw new Error('mint failed');
        throw new Error(`unexpected ${path}`);
      });
    const deps = dependencies(request);
    deps.offer.tailscale = {
      command: async (args) =>
        args[0] === 'status'
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                Self: { DNSName: 'station.tailnet.ts.net.', Online: true },
              }),
              stderr: '',
            }
          : args[1] === 'status'
            ? { exitCode: 0, stdout: JSON.stringify({ Web: {} }), stderr: '' }
            : { exitCode: 0, stdout: '', stderr: '' },
      probe: async () => 'unreachable',
    };
    const failure = await runEnvironmentCommand(
      ['offer', '--tailscale', '--tailscale-serve-port=8444'],
      deps,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('--https=8444 off');
    expect(String(failure)).not.toContain('--https=443 off');
  });
});
