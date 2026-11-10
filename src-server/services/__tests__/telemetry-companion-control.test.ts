import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { installManagedListenerAdmission } from '../../security/managed-network-exposure.js';
import {
  captureTelemetryCompanionPrivateUsageTarget,
  controlTelemetryCompanion,
  readTelemetryCompanionManagedState,
  readTelemetryCompanionProductTrends,
  readTelemetryCompanionSavedPorts,
} from '../telemetry-companion-control.js';
import {
  captureCompanionHomeCustody,
  companionCustodyDigest,
} from '../telemetry-companion-storage.js';
import { managedCompanionFixture } from './fixtures/telemetry-companion-managed.js';

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

// Dispatch races use attested artifact facts; custody and the actual target call remain real.
vi.mock(
  '@kontourai/station-shared/release-manifest',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@kontourai/station-shared/release-manifest')
    >()),
    verifyReleaseManifest: () => ({
      sourceSha: 'a'.repeat(40),
      version: '0.7.0',
      artifacts: [{ sha256: 'c'.repeat(64), format: 'tar.gz' }],
    }),
  }),
);
vi.mock('../telemetry-companion-artifact.mjs', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../telemetry-companion-artifact.mjs')
  >()),
  verifyTelemetryCompanion: async () => ({
    source: 'a'.repeat(40),
    qualification: { qualifications: [{ architecture: 'arm64' }] },
  }),
}));

const managedFixture = () => managedCompanionFixture(makeTempDir, docker);

afterEach(() => installManagedListenerAdmission(undefined));

/** A stopped companion whose artifact verifies, so Start reaches its effects. */
async function startableFixture() {
  const fixture = await managedFixture();
  const manifest = Buffer.from('{}');
  fixture.state.manifestSha256 = createHash('sha256')
    .update(manifest)
    .digest('hex');
  await writeFile(
    join(fixture.directory, 'deployment.json'),
    JSON.stringify(fixture.state),
    { mode: 0o600 },
  );
  await mkdir(join(fixture.directory, 'payload'), { mode: 0o700 });
  await writeFile(
    join(fixture.directory, 'payload/companion-manifest.json'),
    manifest,
    { mode: 0o600 },
  );
  await writeFile(
    join(fixture.directory, 'intent.json'),
    JSON.stringify({ envelope: {} }),
    { mode: 0o600 },
  );
  return fixture;
}

const dockerStarts = () =>
  docker.mock.calls.filter((call) => call[1].slice(2)[0] === 'start').length;

test.skipIf(process.platform === 'win32')(
  '#4519: Start admits every saved companion port first; a Serve route to one refuses it before any container starts',
  async () => {
    const { home, installationId, state } = await startableFixture();
    expect(await readTelemetryCompanionSavedPorts(home)).toEqual(state.ports);
    const admitted: number[] = [];
    installManagedListenerAdmission({
      localClientsOnly: true,
      admit: async ({ name, host, port }) => {
        admitted.push(port);
        expect([name, host]).toEqual(['telemetry companion', '127.0.0.1']);
        if (port === state.ports[1])
          throw new Error(`Tailscale Serve forwards port ${port} to it`);
      },
    });
    docker.mockClear();
    await expect(
      controlTelemetryCompanion(home, installationId, {
        operationId: '31234567-89ab-4cde-8fab-0123456789ab',
        action: 'start',
        requireOperator: async () => {},
      }),
    ).rejects.toThrow(`Tailscale Serve forwards port ${state.ports[1]} to it`);
    expect(admitted).toEqual(state.ports.slice(0, 2));
    expect(dockerStarts()).toBe(0);

    // Admitted, the same Start goes on to start containers (stopped here
    // by aborting once the first start is issued).
    admitted.length = 0;
    installManagedListenerAdmission({
      localClientsOnly: true,
      admit: async ({ port }) => {
        admitted.push(port);
      },
    });
    const controller = new AbortController();
    const implementation = docker.getMockImplementation()!;
    docker.mockImplementation(async (...args) => {
      if (args[1].slice(2)[0] === 'start') controller.abort();
      return implementation(...args);
    });
    await expect(
      controlTelemetryCompanion(home, installationId, {
        operationId: '41234567-89ab-4cde-8fab-0123456789ab',
        action: 'start',
        requireOperator: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(admitted).toEqual(state.ports);
    expect(dockerStarts()).toBe(1);
  },
);

test.skipIf(process.platform === 'win32')(
  '#4519: the saved ports are none without an installation',
  async () => {
    expect(
      await readTelemetryCompanionSavedPorts(makeTempDir('companion-none-')),
    ).toEqual([]);
  },
);

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
    const { root, home, installationId, daemonId } = await managedFixture();
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

test
  .skipIf(process.platform === 'win32')
  .each(['operator', 'person', 'preparation', 'abort', 'lifecycle'] as const)(
  'private allocation checks %s after a late target probe at dispatch',
  async (change) => {
    const { home, directory, containers, state } = await managedFixture();
    for (const container of containers) {
      container.State.Running = true;
      container.State.Status = 'running';
      container.NetworkSettings.Ports = container.HostConfig.PortBindings;
    }
    const manifest = Buffer.from('{}');
    state.manifestSha256 = createHash('sha256').update(manifest).digest('hex');
    await writeFile(join(directory, 'deployment.json'), JSON.stringify(state), {
      mode: 0o600,
    });
    await mkdir(join(directory, 'payload'), { mode: 0o700 });
    await writeFile(
      join(directory, 'payload/companion-manifest.json'),
      manifest,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, 'intent.json'),
      JSON.stringify({ envelope: {} }),
      { mode: 0o600 },
    );
    await mkdir(join(directory, 'secrets'), { mode: 0o700 });
    await writeFile(
      join(directory, 'secrets/product-operator-key'),
      `sto_${'k'.repeat(43)}`,
      { mode: 0o600 },
    );
    let person = true,
      operator = true,
      generation = 1;
    const controller = new AbortController();
    const target = await captureTelemetryCompanionPrivateUsageTarget(
      home,
      Object.assign(async () => {}, {
        assertLocalCurrent() {
          if (!person || generation !== 1)
            throw new Error('Person/preparation revoked');
        },
      }),
      Object.assign(
        async () => {
          if (!operator) throw new Error('Operator revoked');
        },
        {
          assertLocalCurrent() {
            if (!operator) throw new Error('Operator revoked');
          },
        },
      ),
      controller.signal,
    );
    const fetch = vi.fn(async () =>
      Response.json({ created: true, receiverEpoch: crypto.randomUUID() }),
    );
    vi.stubGlobal('fetch', fetch);
    let release = () => {};
    let entered = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const implementation = docker.getMockImplementation()!;
    let blockedOnce = false;
    docker.mockImplementation(async (...args) => {
      if (!blockedOnce && args[1].slice(2)[0] === 'image') {
        blockedOnce = true;
        entered();
        await blocked;
      }
      return implementation(...args);
    });
    const pending = target.provision('d'.repeat(64));
    try {
      await reached;
      if (change === 'lifecycle') {
        for (const action of ['start', 'stop'] as const)
          await expect(
            controlTelemetryCompanion(
              home,
              '01234567-89ab-4cde-8fab-0123456789ab',
              {
                operationId: crypto.randomUUID(),
                action,
                requireOperator: async () => {},
              },
            ),
          ).rejects.toMatchObject({ reason: 'reconciliation-required' });
      }
      if (change === 'preparation') generation++;
      if (change === 'operator') operator = false;
      if (change === 'person') person = false;
      if (change === 'abort') controller.abort();
      const outcome =
        change === 'lifecycle'
          ? expect(pending).resolves.toHaveProperty('receiverEpoch')
          : expect(pending).rejects.toThrow();
      release();
      await outcome;
      expect(fetch).toHaveBeenCalledTimes(change === 'lifecycle' ? 1 : 0);
      // Completion/refusal releases the shared resource owner.
      await expect(
        readFile(
          join(home, 'telemetry-companion/installations/installation.lock'),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release();
      vi.unstubAllGlobals();
    }
  },
);
