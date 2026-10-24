import { cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  controlTelemetryCompanion,
  readTelemetryCompanionManagedState,
  readTelemetryCompanionProductTrends,
} from '../telemetry-companion-control.js';
import {
  captureCompanionHomeCustody,
  companionCustodyDigest,
} from '../telemetry-companion-storage.js';

const docker = vi.hoisted(() => vi.fn());
vi.mock('../../utils/process-group-exec.js', () => ({
  runInProcessGroup: docker,
}));
vi.mock('../telemetry-companion.js', () => ({
  readTelemetryCompanionHost: async () => ({
    kind: 'available',
    endpoint: 'unix:///fixture.sock',
    architecture: 'arm64',
  }),
}));
const makeTempDir = trackTempDirs();

test.skipIf(process.platform === 'win32')(
  'missing current pointer preserves an unknown lock or orphaned installation instead of reporting a clean absence',
  async () => {
    const home = makeTempDir('companion-index-gap-');
    const requireOperator = async () => {};
    docker.mockClear();
    expect(
      (await readTelemetryCompanionManagedState(home, requireOperator)).runtime,
    ).toBe('not-installed');
    const base = join(home, 'telemetry-companion');
    await mkdir(base, { mode: 0o700 });
    const root = join(base, 'installations');
    await mkdir(root, { mode: 0o700 });
    const lock = join(root, 'installation.lock');
    await writeFile(lock, '{}', { mode: 0o600 });
    const locked = await readTelemetryCompanionManagedState(
      home,
      requireOperator,
    );
    expect(locked.hasOperationLock).toBe(true);
    expect(locked.runtime).toBe('unavailable');
    await unlink(lock);
    await mkdir(join(root, '01234567-89ab-4cde-8fab-0123456789ab'), {
      mode: 0o700,
    });
    const orphan = await readTelemetryCompanionManagedState(
      home,
      requireOperator,
    );
    expect(orphan.hasOperationLock).toBe(false);
    expect(orphan.runtime).toBe('unavailable');
    expect(docker).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === 'win32')(
  'copied metadata cannot authorize another home even when its cached custody fields are forged',
  async () => {
    const root = makeTempDir('companion-custody-');
    const home = join(root, 'original');
    await mkdir(home, { mode: 0o700 });
    const installationId = '01234567-89ab-4cde-8fab-0123456789ab';
    const owner = '1'.repeat(24),
      project = `station-telemetry-${owner}`,
      daemonId = 'daemon-fixture';
    const ids = ['1', '2', '3', '4', '5', '6'].map((value) => value.repeat(64));
    const services = [
      'postgres',
      'receiver',
      'collector',
      'prometheus',
      'tempo',
      'grafana',
    ];
    const ports = [51001, 51002, 51003],
      imageId = `sha256:${'7'.repeat(64)}`;
    const homeCustody = await captureCompanionHomeCustody(home);
    const custody = companionCustodyDigest(homeCustody, daemonId);
    const base = join(home, 'telemetry-companion');
    await mkdir(base, { mode: 0o700 });
    const installations = join(base, 'installations');
    await mkdir(installations, { mode: 0o700 });
    const directory = join(installations, installationId);
    await mkdir(directory, { mode: 0o700 });
    const receipt = {
      protocol: 'station-companion-installation/v1',
      installationId,
      preparationId: '11234567-89ab-4cde-8fab-0123456789ab',
      source: 'a'.repeat(40),
      version: '0.7.0',
      architecture: 'arm64',
      phase: 'installed',
      createdAt: '2026-10-24T00:00:00.000Z',
      host: 'selected-station',
      storage: 'managed-docker-volumes',
      configuresSending: false,
    };
    const state = {
      owner,
      project,
      endpoint: 'unix:///fixture.sock',
      daemonId,
      architecture: 'arm64',
      imageId,
      manifestSha256: 'b'.repeat(64),
      custody,
      homeCustody,
      ports,
      containerIds: ids,
    };
    await writeFile(
      join(installations, 'current.json'),
      JSON.stringify({ installationId }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt), {
      mode: 0o600,
    });
    await writeFile(join(directory, 'deployment.json'), JSON.stringify(state), {
      mode: 0o600,
    });
    // These are external daemon facts. Copying/editing the home does not edit its resources.
    const containers = services.map((service, index) => {
      const port =
        service === 'receiver'
          ? ['43891', ports[0]]
          : service === 'collector'
            ? ['4318', ports[1]]
            : service === 'grafana'
              ? ['3000', ports[2]]
              : null;
      return {
        Id: ids[index],
        Image: service === 'receiver' ? imageId : `sha256:${'8'.repeat(64)}`,
        State: {
          Running: false,
          Paused: false,
          Restarting: false,
          Status: 'created',
        },
        Config: {
          Labels: {
            'com.docker.compose.project': project,
            'com.docker.compose.service': service,
            'station.telemetry.custody': custody,
          },
        },
        HostConfig: {
          PortBindings: port
            ? {
                [`${port[0]}/tcp`]: [
                  { HostIp: '127.0.0.1', HostPort: String(port[1]) },
                ],
              }
            : {},
        },
        NetworkSettings: { Ports: {} },
      };
    });
    docker.mockImplementation(async (_file: string, raw: string[]) => {
      const args = raw.slice(2);
      let output: unknown;
      if (args[0] === 'info') return { stdout: daemonId, stderr: '' };
      if (args[0] === 'inspect') output = containers;
      else if (args[0] === 'image')
        output = [
          {
            Id: imageId,
            Config: {
              Labels: {
                'station.telemetry.owner': owner,
                'station.telemetry.installation': installationId,
                'station.telemetry.custody': custody,
                'station.telemetry.manifest': state.manifestSha256,
                'station.telemetry.source': receipt.source,
              },
            },
          },
        ];
      else if (args[0] === 'volume' || args[0] === 'network')
        output = args.slice(2).map((Name) => ({
          Name,
          Labels: {
            'com.docker.compose.project': project,
            'station.telemetry.custody': custody,
          },
        }));
      else throw new Error('Unexpected Docker mutation in custody refusal');
      return { stdout: JSON.stringify(output), stderr: '' };
    });
    const requireOperator = async () => {};
    const original = await readTelemetryCompanionManagedState(
      home,
      requireOperator,
    );
    expect(original.runtime).toBe('stopped');
    expect(original.storage).toBe('not-checked');
    const clone = join(root, 'clone');
    await cp(home, clone, { recursive: true });
    const cloneDirectory = join(
      clone,
      'telemetry-companion/installations',
      installationId,
    );
    const forged = JSON.parse(
      await readFile(join(cloneDirectory, 'deployment.json'), 'utf8'),
    );
    forged.homeCustody = await captureCompanionHomeCustody(clone);
    forged.custody = companionCustodyDigest(forged.homeCustody, daemonId);
    await writeFile(
      join(cloneDirectory, 'deployment.json'),
      JSON.stringify(forged),
      { mode: 0o600 },
    );
    const copied = await readTelemetryCompanionManagedState(
      clone,
      requireOperator,
    );
    expect(copied.installation?.phase).toBe('installed');
    expect(copied.runtime).toBe('unavailable');
    expect(copied.storage).toBe('not-checked');
    await expect(
      controlTelemetryCompanion(clone, installationId, {
        operationId: '21234567-89ab-4cde-8fab-0123456789ab',
        action: 'start',
        requireOperator,
      }),
    ).rejects.toMatchObject({ reason: 'custody-mismatch' });
    await expect(
      readTelemetryCompanionProductTrends(
        clone,
        {
          from: '2026-10-23T00:00:00.000Z',
          to: '2026-10-24T00:00:00.000Z',
        },
        requireOperator,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: 'custody-mismatch' });
    expect(
      (await readTelemetryCompanionManagedState(home, requireOperator)).runtime,
    ).toBe('stopped');
  },
);
