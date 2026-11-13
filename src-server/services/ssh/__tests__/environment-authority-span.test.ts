import fs, { mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { expect, onTestFinished, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';
import { HomeWriterOwner } from '../home-writer-owner.js';

const temporary = trackTempDirs();
async function setup() {
  const home = realpathSync(temporary('station-authority-span-'));
  ensureStationHomeSchemaSync(home);
  const service = new EnvironmentSecurityService({ homeDir: home });
  const record = await service.initialize();
  return { home, service, record };
}

test('authority composition adds no Home identity reads beyond the pairing owner and keeps physical exclusion', async () => {
  const { home, service, record } = await setup();
  const probe = await prepareFileMutationOwner(
    join(home, 'security', '.home-writer.mutation'),
  );
  onTestFinished(() => probe.close());
  const unexpected: Array<
    Extract<ReturnType<typeof probe.tryAcquire>, { kind: 'acquired' }>['lease']
  > = [];
  let reads = 0;
  const realpath = fs.realpathSync;
  const spy = vi.spyOn(fs, 'realpathSync').mockImplementation((...args) => {
    if (args[0] === home) reads++;
    return realpath(...args);
  });
  syncBuiltinESMExports();
  const check = () => {
    const lock = probe.tryAcquire();
    if (lock.kind === 'acquired') unexpected.push(lock.lease);
    return {
      authorized: service.verifyCredential(record.credential),
      physical: lock.kind,
    };
  };
  try {
    const direct = service.devicePairing.withCurrentRegistry(check);
    const baseline = reads;
    reads = 0;
    const composed = service.withCurrentAuthority(check);
    expect(direct).toEqual({ authorized: true, physical: 'busy' });
    expect(composed).toEqual(direct);
    expect(baseline).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(baseline);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
    for (const lease of unexpected) await lease.release();
  }
  const rotated = await service.rotateCredential();
  expect(
    service.withCurrentAuthority(() =>
      service.verifyCredential(record.credential),
    ),
  ).toBe(false);
  expect(
    service.withCurrentAuthority(() =>
      service.verifyCredential(rotated.credential),
    ),
  ).toBe(true);
});

test('authority composition refuses a Home replacement before returning the observation', async () => {
  const { home, service, record } = await setup();
  const moved = `${home}-moved`;
  let swapped = false;
  try {
    expect(() =>
      service.withCurrentAuthority(() => {
        renameSync(home, moved);
        swapped = true;
        mkdirSync(home, { mode: 0o700 });
        return 'must not be disclosed';
      }),
    ).toThrow();
    expect(swapped).toBe(true);
  } finally {
    if (swapped) {
      rmSync(home, { recursive: true, force: true });
      renameSync(moved, home);
      await (await HomeWriterOwner.forHome(home)).settlePendingCleanup();
    }
  }
  expect(
    service.withCurrentAuthority(() =>
      service.verifyCredential(record.credential),
    ),
  ).toBe(true);
});

test('authority composition refuses an external registry rewrite before returning the observation', async () => {
  const { home, service } = await setup();
  const offer = service.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1:43979',
  });
  const request = service.devicePairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'registry-currency-control',
    requesterPosition: 'unproven',
  });
  service.devicePairing.confirmRequest(request.requestId, {
    kind: 'presented-credential',
  });
  const paired = service.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
  const path = join(home, 'security', 'paired-devices.json');
  const original = fs.readFileSync(path);
  try {
    expect(() =>
      service.withCurrentAuthority(() => {
        fs.writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
        return 'must not be disclosed';
      }),
    ).toThrow('Paired-device registry revision changed');
  } finally {
    fs.writeFileSync(path, original);
  }
  expect(
    service.withCurrentAuthority(() =>
      service.verifyCredential(paired.credential),
    ),
  ).toBe(true);
});

test('authority composition rejects thenables and does not lend a synchronous span across await', async () => {
  const { service, record } = await setup();
  expect(() =>
    service.withCurrentAuthority(() => Promise.resolve(true)),
  ).toThrow('synchronous');
  let late!: Promise<boolean>;
  service.withCurrentAuthority(() => {
    late = Promise.resolve().then(() =>
      service.withCurrentAuthority(() =>
        service.verifyCredential(record.credential),
      ),
    );
  });
  await expect(late).rejects.toMatchObject({ reason: 'borrow-unavailable' });
  expect(
    service.withCurrentAuthority(() =>
      service.verifyCredential(record.credential),
    ),
  ).toBe(true);
});
