import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH } from '@kontourai/station-contracts/environment-security';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSelfAuthOutcome } from '../commands/local-self-auth.js';
import { readProfileStore, upsertProfile } from '../commands/profile-store.js';
import { runSetupCommand } from '../commands/setup-command.js';

let home: string;
let root: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'station-setup-root-'));
  home = join(root, 'instances', 'stable');
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = home;
  process.env.STATION_ROOT = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

function dependencies() {
  return {
    installLocalService: vi.fn(async () => ({ rollback: vi.fn() })),
    pair: vi.fn(async (input) => {
      const result = upsertProfile({
        name: input.name!,
        endpoint: input.endpoint,
        environmentId: 'env-paired',
        credentialRef: { kind: 'station-bearer', id: 'env-paired' },
        setupSource: input.setupSource ?? 'paired',
        configurationState: 'configured',
        makeDefault: input.makeDefault,
        force: true,
      });
      return { profile: result.profile, alreadyPaired: false };
    }),
    stdout: vi.fn(),
  };
}

describe('station setup', () => {
  it('installs local service before selecting kontour as default', async () => {
    const deps = dependencies();
    await runSetupCommand(['local', '--port=43141'], deps);
    expect(deps.installLocalService).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--port=43141',
        expect.stringMatching(/^--base=/),
      ]),
    );
    expect(readProfileStore()).toMatchObject({
      defaultProfile: 'kontour',
      profiles: [
        {
          name: 'kontour',
          endpoint: 'http://127.0.0.1:43141',
          setupSource: 'local',
          configurationState: 'configured',
        },
      ],
    });
  });

  it('publishes shared profile genesis before local setup populates its runtime', async () => {
    const deps = dependencies();
    deps.installLocalService.mockImplementationOnce(async () => {
      expect(readProfileStore()).toMatchObject({ revision: 0, profiles: [] });
      mkdirSync(join(home, 'service-state'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'service-state', 'installed'), 'yes', {
        mode: 0o600,
      });
      return { rollback: vi.fn() };
    });

    await runSetupCommand(['local'], deps);
    expect(readProfileStore()).toMatchObject({
      revision: 1,
      defaultProfile: 'kontour',
      profiles: [expect.objectContaining({ name: 'kontour' })],
    });
  });

  it('saves the reachable bind address while wildcard binds use loopback', async () => {
    const deps = dependencies();
    await runSetupCommand(
      ['local', '--name=lan', '--host=192.0.2.40', '--port=43142'],
      deps,
    );
    expect(readProfileStore().profiles[0]?.endpoint).toBe(
      'http://192.0.2.40:43142',
    );
    expect(deps.installLocalService).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--host=192.0.2.40',
        '--port=43142',
        expect.stringMatching(/^--base=/),
      ]),
    );

    await runSetupCommand(
      ['local', '--name=wildcard', '--host=0.0.0.0', '--port=43143'],
      deps,
    );
    expect(
      readProfileStore().profiles.find((profile) => profile.name === 'wildcard')
        ?.endpoint,
    ).toBe('http://127.0.0.1:43143');
  });

  it('deletes a credential reference discarded by setup replacement', async () => {
    upsertProfile({
      name: 'kontour',
      endpoint: 'https://old.example.test',
      credentialRef: { kind: 'station-bearer', id: 'old-ref' },
      environmentId: 'old-environment',
      force: true,
    });
    const deleted: string[] = [];
    const deps = {
      ...dependencies(),
      credentialStore: {
        get: () => undefined,
        set: () => undefined,
        delete: (ref: { id: string }) => deleted.push(ref.id),
        status: () => 'available' as const,
      },
    };

    await runSetupCommand(['local'], deps);

    expect(deleted).toEqual(['old-ref']);
    expect(readProfileStore().profiles[0]?.credentialRef).toBeUndefined();
  });

  it('does not save or select a local Station when service install fails', async () => {
    const deps = dependencies();
    deps.installLocalService.mockRejectedValueOnce(new Error('install failed'));
    await expect(runSetupCommand(['local'], deps)).rejects.toThrow(
      'install failed',
    );
    expect(readProfileStore().defaultProfile).toBeNull();
  });

  it('rolls back a completed service install when saved Station persistence races', async () => {
    const rollback = vi.fn();
    const deps = dependencies();
    deps.installLocalService.mockImplementationOnce(async () => {
      const config = join(root, 'config');
      mkdirSync(config, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(config, 'profiles.json.lock'),
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: Date.now() })}\n`,
        { mode: 0o600 },
      );
      return { rollback };
    });

    await expect(runSetupCommand(['local'], deps)).rejects.toThrow(
      'service installation was rolled back',
    );
    expect(rollback).toHaveBeenCalledOnce();
    expect(readProfileStore().defaultProfile).toBeNull();
  });

  it('can deliberately select an existing Station without pairing', async () => {
    const deps = dependencies();
    await runSetupCommand(['existing', 'media', 'https://media.example'], deps);
    expect(deps.pair).not.toHaveBeenCalled();
    expect(readProfileStore()).toMatchObject({
      defaultProfile: 'media',
      profiles: [
        {
          name: 'media',
          setupSource: 'existing',
          configurationState: 'unconfigured',
        },
      ],
    });
  });

  it('validates explicit pairing flags before setup can pair or write metadata', async () => {
    const deps = dependencies();
    await expect(
      runSetupCommand(
        [
          'existing',
          'media',
          'https://media.example',
          '--pair=false',
          '--device-name=device',
        ],
        deps,
      ),
    ).rejects.toThrow(/device-name requires --pair/);
    await expect(
      runSetupCommand(
        [
          'existing',
          'media',
          'https://media.example',
          '--pair',
          '--pair=false',
        ],
        deps,
      ),
    ).rejects.toThrow(/Duplicate option --pair/);
    await expect(
      runSetupCommand(
        ['hosted', '--device-name=one', '--device-name=two'],
        deps,
      ),
    ).rejects.toThrow(/Duplicate option --device-name/);
    expect(deps.pair).not.toHaveBeenCalled();
    expect(readProfileStore()).toMatchObject({
      defaultProfile: null,
      profiles: [],
    });
  });

  it('pairs hosted through the saved-Station pipeline before selecting it', async () => {
    const deps = dependencies();
    await runSetupCommand(['hosted'], deps);
    expect(deps.pair).toHaveBeenCalledWith({
      name: 'station.kontourai.io',
      endpoint: 'https://station.kontourai.io',
      setupSource: 'hosted',
      makeDefault: true,
    });
    expect(readProfileStore()).toMatchObject({
      defaultProfile: 'station.kontourai.io',
      profiles: [
        {
          endpoint: 'https://station.kontourai.io',
          setupSource: 'hosted',
          configurationState: 'configured',
          environmentId: 'env-paired',
        },
      ],
    });
  });

  it('leaves no new hosted binding when pairing is denied', async () => {
    const deps = dependencies();
    deps.pair.mockRejectedValueOnce(new Error('pairing denied'));
    await expect(runSetupCommand(['hosted'], deps)).rejects.toThrow(
      'pairing denied',
    );
    expect(readProfileStore()).toMatchObject({
      defaultProfile: null,
      profiles: [],
    });
  });

  it('self-authorizes the CLI against the installed local service (#1098)', async () => {
    // A loopback stand-in for the freshly installed service, answering the
    // server's real local-grant route with its real wire shapes.
    const secret = randomBytes(32).toString('base64url');
    const credential = `issued-${randomUUID()}`;
    const exchanged: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (
          request.method === 'POST' &&
          request.url === PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH
        ) {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            secret?: string;
          };
          exchanged.push(body as Record<string, unknown>);
          if (body.secret !== secret) {
            response.writeHead(403, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'local_grant_forbidden' }));
            return;
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              environmentId: 'env-local',
              device: {
                id: randomUUID(),
                name: 'stub device',
                scope: 'chat',
                kind: 'device',
                createdAt: Date.now(),
              },
              credential,
            }),
          );
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server.address() as { port: number }).port;
    try {
      const stored = new Map<string, string>();
      const deps = {
        ...dependencies(),
        credentialStore: {
          get: (ref: { id: string }) => stored.get(ref.id),
          set: (ref: { id: string }, value: string) =>
            void stored.set(ref.id, value),
          delete: (ref: { id: string }) => void stored.delete(ref.id),
          status: () => 'available' as const,
        },
      };
      deps.installLocalService.mockImplementationOnce(async () => {
        // The installed service materializes its per-boot secret with the
        // server's exact bytes: 32 random bytes base64url, no newline, 0600.
        mkdirSync(join(home, 'runtime'), { recursive: true, mode: 0o700 });
        writeFileSync(join(home, 'runtime', 'local-grant.secret'), secret, {
          encoding: 'utf8',
          mode: 0o600,
        });
        return { rollback: vi.fn() };
      });

      await runSetupCommand(['local', `--port=${port}`], deps);

      expect(exchanged).toHaveLength(1);
      const profile = readProfileStore().profiles[0];
      expect(profile?.credentialRef?.id).toMatch(/^local-grant:/);
      expect(profile?.environmentId).toBe('env-local');
      expect(stored.get(profile!.credentialRef!.id)).toBe(credential);
      expect(deps.stdout).toHaveBeenCalledWith(
        expect.stringContaining('CLI authorized'),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps a healthy install and prints the remedy when self-authorization fails', async () => {
    const rollback = vi.fn();
    const deps = {
      ...dependencies(),
      selfAuthorizeLocal: vi.fn(
        async (): Promise<LocalSelfAuthOutcome> => ({
          status: 'failed',
          reason: 'the service is unreachable',
        }),
      ),
    };
    deps.installLocalService.mockImplementationOnce(async () => ({
      rollback,
    }));

    await runSetupCommand(['local', '--port=43141'], deps);

    expect(rollback).not.toHaveBeenCalled();
    expect(readProfileStore()).toMatchObject({
      defaultProfile: 'kontour',
      profiles: [{ name: 'kontour', configurationState: 'configured' }],
    });
    expect(deps.stdout).toHaveBeenCalledWith(
      expect.stringMatching(
        /not yet authorized \(the service is unreachable\).*station stations pair kontour/,
      ),
    );
  });

  it('keeps a healthy install even when self-authorization throws', async () => {
    const rollback = vi.fn();
    const deps = {
      ...dependencies(),
      selfAuthorizeLocal: vi.fn(async (): Promise<LocalSelfAuthOutcome> => {
        throw new Error('keyring exploded');
      }),
    };
    deps.installLocalService.mockImplementationOnce(async () => ({
      rollback,
    }));

    await runSetupCommand(['local', '--port=43141'], deps);

    expect(rollback).not.toHaveBeenCalled();
    expect(readProfileStore().defaultProfile).toBe('kontour');
    expect(deps.stdout).toHaveBeenCalledWith(
      expect.stringContaining('not yet authorized (keyring exploded)'),
    );
  });

  it('names pairing as the remedy for a non-loopback local endpoint', async () => {
    const deps = dependencies();
    await runSetupCommand(
      ['local', '--name=lan', '--host=192.0.2.40', '--port=43142'],
      deps,
    );
    expect(deps.stdout).toHaveBeenCalledWith(
      expect.stringMatching(
        /cannot self-authorize a non-loopback endpoint.*station stations pair lan/,
      ),
    );
    expect(readProfileStore().profiles[0]?.credentialRef).toBeUndefined();
  });

  it('preserves an existing default when an existing-target pairing is denied', async () => {
    upsertProfile({
      name: 'media',
      endpoint: 'https://media.example',
      makeDefault: true,
      force: true,
    });
    const deps = dependencies();
    deps.pair.mockRejectedValueOnce(new Error('pairing denied'));
    await expect(
      runSetupCommand(
        ['existing', 'media', 'https://media.example', '--pair'],
        deps,
      ),
    ).rejects.toThrow('pairing denied');
    expect(readProfileStore().defaultProfile).toBe('media');
  });
});
