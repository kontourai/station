import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { vi } from 'vitest';
import {
  captureCompanionHomeCustody,
  companionCustodyDigest,
} from '../../telemetry-companion-storage.js';

export async function managedCompanionFixture(
  makeTempDir: (prefix: string) => string,
  docker: ReturnType<typeof vi.fn>,
  metadata = {
    source: 'a'.repeat(40),
    version: '0.7.0',
    manifestSha256: 'b'.repeat(64),
    artifactSha256: 'c'.repeat(64),
    channel: 'stable',
  },
) {
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
    source: metadata.source,
    version: metadata.version,
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
    manifestSha256: metadata.manifestSha256,
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
              'station.telemetry.channel': metadata.channel,
              'station.telemetry.archive': metadata.artifactSha256,
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

  return { root, home, installationId, daemonId, directory, containers, state };
}
