import assert from 'node:assert/strict';
import fs, {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../local-grant-observation-owner.js';
import {
  type ObservationFailure,
  ProviderCredentialObservationError,
  type ProviderCredentialObservationSources,
  ProviderCredentialObservationStore,
  readObservedSdkProviderCredential,
} from '../provider-credential-observation.js';

const makeTempDir = trackTempDirs();
// Filesystem/durability cases only; actual-owner authorization cases live in
// local-grant-observation-owner.test.ts. Mint stamps are owned fixture setup.
async function setup(signal?: AbortSignal) {
  const home = realpathSync(makeTempDir('credential-observation-test-'));
  chmodSync(home, 0o700);
  const loader = new ConfigLoader({
    projectHomeDir: home,
    enforceHomeSchema: true,
  });
  await loader.ensureHomeSchema();
  const environment = new EnvironmentSecurityService({ homeDir: home });
  await environment.initialize();
  const offer = environment.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1:43979',
  });
  const pairing = environment.devicePairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'observation-filesystem-fixture',
    requesterPosition: 'unproven',
  });
  environment.devicePairing.confirmRequest(pairing.requestId, {
    kind: 'presented-credential',
  });
  const paired = environment.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: pairing.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  const request = new Request('http://127.0.0.1:43979/api/orchestration/chat', {
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
  setRuntimeAuthenticatedRequestPrincipal(request, {
    kind: 'credential',
    authority: 'device-credential',
    credential: paired.credential,
    source: 'bearer',
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  bindRuntimeLocalOperator(request);
  const authority = await captureEnvironmentLocalGrantObservationOwner(
    request,
    environment,
    environment,
  );
  const adapter = new FileStorageAdapter(home);
  for (const id of ['selected', 'other'])
    await adapter.saveProviderConnection({
      id,
      name: id,
      type: 'anthropic',
      enabled: true,
      capabilities: ['llm'],
      config: {
        apiKey: `synthetic-${id}-key`,
        baseUrl: 'https://api.anthropic.com/v1',
      },
    });
  const sources: ProviderCredentialObservationSources = {
    adapter,
    authority,
    captureConfigurationFence: () =>
      loader.capturePreparationConfigurationFence(['worker']),
    // UNWIRED(#91): fixture configuration stability only, not a production runtime/projection fence.
    captureRuntimeFence: () =>
      loader.capturePreparationConfigurationFence(['worker']),
  };
  const store = new ProviderCredentialObservationStore(home, sources);
  return {
    home,
    adapter,
    request,
    store,
    sources,
    reopen: () => new ProviderCredentialObservationStore(home, sources),
    path: join(home, 'config', 'providers.json'),
    directory: join(home, 'security', 'provider-credential-observations-v1'),
  };
}
function descriptorIs(fd: number, path: string): boolean {
  const held = fs.fstatSync(fd);
  const target = fs.statSync(path);
  return held.dev === target.dev && held.ino === target.ino;
}
function refuses(operation: () => unknown, code?: ObservationFailure) {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof ProviderCredentialObservationError &&
      (code === undefined || error.code === code),
  );
}
test('real adapter unrelated provider edits invalidate ALL observations; new local prepare creates a distinct observation', async () => {
  const h = await setup();
  {
    const selected = h.store.capture(h.request, 'selected');
    const other = h.store.capture(h.request, 'other');
    const row = h.adapter.getProviderConnection('other');
    await h.adapter.saveProviderConnection({
      ...row,
      config: { ...row.config, apiKey: 'changed-other-key' },
    });
    for (const observation of [selected, other])
      refuses(
        () => h.reopen().revalidate(h.request, observation.observationId),
        'observation_obsolete',
      );
    const next = h.store.capture(h.request, 'selected');
    assert.notEqual(next.observationId, selected.observationId);
    assert.equal(
      h.reopen().revalidate(h.request, next.observationId).observationId,
      next.observationId,
    );
    const bytes = readFileSync(h.path);
    const replacement = `${h.path}.replacement`;
    writeFileSync(replacement, bytes, { mode: 0o600 });
    renameSync(replacement, h.path);
    refuses(
      () => h.reopen().revalidate(h.request, next.observationId),
      'observation_obsolete',
    );
  }
});
test('nofollow bounded source witness rejects symlinks, hardlinks, oversized files and a replaced private store', async () => {
  for (const kind of [
    'symlink',
    'hardlink',
    'oversized',
    'store-symlink',
    'unsafe-ancestor',
  ] as const) {
    const h = await setup();
    if (kind === 'symlink') {
      renameSync(h.path, `${h.path}.original`);
      symlinkSync(`${h.path}.original`, h.path);
    }
    if (kind === 'hardlink') linkSync(h.path, `${h.path}.link`);
    if (kind === 'oversized')
      writeFileSync(h.path, ' '.repeat(2 * 1024 * 1024 + 1));
    if (kind === 'store-symlink') {
      mkdirSync(join(h.home, 'elsewhere'), { mode: 0o700 });
      symlinkSync(join(h.home, 'elsewhere'), h.directory);
    }
    if (kind === 'unsafe-ancestor') {
      const parent = join(h.home, 'unsafe-parent');
      mkdirSync(parent);
      chmodSync(parent, 0o777);
      const nested = join(parent, 'nested-home');
      mkdirSync(nested, { mode: 0o700 });
      mkdirSync(join(nested, 'config'), { mode: 0o700 });
      writeFileSync(
        join(nested, 'config', 'providers.json'),
        readFileSync(h.path),
        { mode: 0o600 },
      );
      const unsafe = new ProviderCredentialObservationStore(nested, {
        ...h.sources,
        adapter: new FileStorageAdapter(nested),
      });
      refuses(
        () => unsafe.capture(h.request, 'selected'),
        'unsupported_source',
      );
    } else refuses(() => h.store.capture(h.request, 'selected'));
  }
});
test('corrupt, hardlinked or permissive private records never replay as observed credentials', async () => {
  for (const kind of [
    'truncated',
    'private-key-compare',
    'hardlink',
    'mode',
  ] as const) {
    const h = await setup();
    {
      const observation = h.store.capture(h.request, 'selected');
      const path = join(h.directory, `${observation.observationId}.json`);
      if (kind === 'truncated') writeFileSync(path, '{');
      if (kind === 'private-key-compare') {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.source.staticKeySha256 = 'a'.repeat(64);
        writeFileSync(path, JSON.stringify(record));
      }
      if (kind === 'hardlink') linkSync(path, `${path}.link`);
      if (kind === 'mode') chmodSync(path, 0o644);
      refuses(() =>
        h.reopen().revalidate(h.request, observation.observationId),
      );
    }
  }
});
test('directory fsync failure after publication never returns a confirmed observation; incomplete temp files do not replay', async () => {
  const h = await setup();
  const original = fs.fsyncSync;
  try {
    const confirmed = h.store.capture(h.request, 'selected'); // Private directories already exist.
    let count = 0;
    fs.fsyncSync = (fd: number) => {
      if (descriptorIs(fd, h.directory)) {
        count++;
        throw new Error('synthetic-directory-sync-failure');
      }
      original(fd);
    };
    syncBuiltinESMExports();
    refuses(
      () => h.store.capture(h.request, 'selected'),
      'durability_unconfirmed',
    );
    assert.equal(count, 1);
    fs.fsyncSync = original;
    syncBuiltinESMExports();
    const orphan = readdirSync(h.directory).find(
      (name) =>
        name.endsWith('.json') && name !== `${confirmed.observationId}.json`,
    )!;
    assert.ok(orphan);
    fs.fsyncSync = (fd: number) => {
      if (descriptorIs(fd, join(h.directory, orphan)))
        throw new Error('synthetic-replay-sync-failure');
      original(fd);
    };
    syncBuiltinESMExports();
    refuses(
      () => h.reopen().revalidate(h.request, orphan.slice(0, -5)),
      'durability_unconfirmed',
    );
    fs.fsyncSync = original;
    syncBuiltinESMExports();
    assert.equal(
      h.reopen().revalidate(h.request, orphan.slice(0, -5)).kind,
      'credential-source-observation',
    );
    writeFileSync(join(h.directory, 'incomplete.tmp'), '{', { mode: 0o600 });
    refuses(
      () => h.reopen().revalidate(h.request, 'incomplete.tmp'),
      'observation_unavailable',
    );
    assert.ok(readdirSync(h.directory).includes('incomplete.tmp'));
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
});

test.each(['file', 'directory'] as const)(
  'confirmed unchanged custody avoids repeat flushes but changed %s and reopened custody must reconfirm durability',
  async (change) => {
    const h = await setup();
    const observation = h.store.capture(h.request, 'selected');
    const reader = h.reopen();
    reader.revalidate(h.request, observation.observationId);
    const original = fs.fsyncSync;
    let attempts = 0;
    try {
      fs.fsyncSync = (fd: number) => {
        if (
          descriptorIs(fd, h.directory) ||
          descriptorIs(
            fd,
            join(h.directory, `${observation.observationId}.json`),
          )
        ) {
          attempts++;
          throw Error('controlled new durability failure');
        }
        original(fd);
      };
      syncBuiltinESMExports();
      assert.equal(
        reader.revalidate(h.request, observation.observationId).observationId,
        observation.observationId,
      );
      assert.equal(attempts, 0);
      const path = join(h.directory, `${observation.observationId}.json`);
      const bytes = readFileSync(path);
      if (change === 'file') writeFileSync(path, bytes);
      else
        writeFileSync(
          join(h.directory, 'new-directory-entry.tmp'),
          'owned diagnostic entry',
          { mode: 0o600 },
        );
      refuses(
        () => reader.revalidate(h.request, observation.observationId),
        'durability_unconfirmed',
      );
      assert.equal(attempts, 1);
      fs.fsyncSync = original;
      syncBuiltinESMExports();
      reader.revalidate(h.request, observation.observationId);
      fs.fsyncSync = (fd: number) => {
        if (descriptorIs(fd, h.directory) || descriptorIs(fd, path)) {
          attempts++;
          throw Error('controlled reopened durability failure');
        }
        original(fd);
      };
      syncBuiltinESMExports();
      reader.revalidate(h.request, observation.observationId);
      assert.equal(attempts, 1);
      refuses(
        () => h.reopen().revalidate(h.request, observation.observationId),
        'durability_unconfirmed',
      );
      assert.equal(attempts, 2);
    } finally {
      fs.fsyncSync = original;
      syncBuiltinESMExports();
    }
  },
);

test.each([
  'source-key-change',
  'same-bytes-replacement',
  'adapter-parity',
  'revoked-mid-read',
  'expires-mid-read',
  'clock-reverses-mid-read',
] as const)(
  'SDK credential observation refuses %s before returning a key',
  async (fault) => {
    const h = await setup();
    let now = 1000;
    const store = new ProviderCredentialObservationStore(
      h.home,
      h.sources,
      () => now,
    );
    const credential = store.captureSdkCredential(h.request, 'selected', 100);
    const records = readdirSync(h.directory).filter((name) =>
      name.endsWith('.json'),
    );
    assert.equal(records.length, 1);
    const recordName = records[0];
    assert.ok(recordName);
    const observationId = recordName.slice(0, -5);
    const recordPath = join(h.directory, recordName);
    assert.equal(
      readFileSync(recordPath, 'utf8').includes('synthetic-selected-key'),
      false,
    );
    const readCredential = () =>
      readObservedSdkProviderCredential(credential, 'anthropic', h.request);
    const value = readCredential();
    assert.equal(value.apiKey, 'synthetic-selected-key');
    assert.equal(
      JSON.stringify(value).includes('synthetic-selected-key'),
      false,
    );
    assert.equal(
      readFileSync(recordPath, 'utf8').includes('synthetic-selected-key'),
      false,
    );
    const list = h.adapter.listProviderConnections.bind(h.adapter);
    let applied = false;
    const observe = vi
      .spyOn(h.adapter, 'listProviderConnections')
      .mockImplementation(() => {
        const rows = list();
        if (applied) return rows;
        applied = true;
        if (fault === 'adapter-parity')
          return rows.map((row) =>
            row.id === 'other'
              ? { ...row, name: 'unpersisted adapter row' }
              : row,
          );
        if (
          fault === 'source-key-change' ||
          fault === 'same-bytes-replacement'
        ) {
          const replacement = `${h.path}.read-fault`;
          const bytes =
            fault === 'same-bytes-replacement'
              ? readFileSync(h.path)
              : JSON.stringify(
                  rows.map((row) =>
                    row.id === 'selected'
                      ? {
                          ...row,
                          config: {
                            ...row.config,
                            apiKey: 'synthetic-changed-key',
                          },
                        }
                      : row,
                  ),
                );
          writeFileSync(replacement, bytes, { mode: 0o600 });
          renameSync(replacement, h.path);
        } else if (fault === 'revoked-mid-read') {
          store.revoke(h.request, observationId);
        } else if (fault === 'expires-mid-read') {
          now = 1100;
        } else if (fault === 'clock-reverses-mid-read') {
          now = 999;
        }
        return rows;
      });
    try {
      refuses(readCredential, 'observation_obsolete');
      assert.equal(applied, true);
      if (fault === 'revoked-mid-read')
        assert.ok(
          readdirSync(h.directory).includes(`${observationId}.revoked`),
        );
    } finally {
      observe.mockRestore();
    }
    const fresh = store.captureSdkCredential(h.request, 'selected', 100);
    assert.equal(
      readObservedSdkProviderCredential(fresh, 'anthropic', h.request).apiKey,
      fault === 'source-key-change'
        ? 'synthetic-changed-key'
        : 'synthetic-selected-key',
    );
  },
);

test.each([
  'captured-foreign-url',
  'changed-foreign-url',
  'captured-baseURL-alias',
] as const)(
  'SDK credential source preserves refusal classification for %s',
  async (fault) => {
    const h = await setup();
    const credential =
      fault === 'changed-foreign-url'
        ? h.store.captureSdkCredential(h.request, 'selected')
        : undefined;
    const selected = h.adapter.getProviderConnection('selected');
    await h.adapter.saveProviderConnection({
      ...selected,
      config: {
        ...selected.config,
        ...(fault === 'captured-baseURL-alias'
          ? { baseURL: 'https://api.anthropic.com/v1' }
          : { baseUrl: 'https://foreign-provider.invalid/v1' }),
      },
    });
    if (credential)
      refuses(
        () =>
          readObservedSdkProviderCredential(credential, 'anthropic', h.request),
        'observation_obsolete',
      );
    else
      refuses(
        () => h.store.captureSdkCredential(h.request, 'selected'),
        'unsupported_source',
      );
  },
);

test('an SDK credential read refuses request abortion during its canonical source observation', async () => {
  const abort = new AbortController();
  const h = await setup(abort.signal);
  const credential = h.store.captureSdkCredential(h.request, 'selected');
  assert.equal(
    readObservedSdkProviderCredential(credential, 'anthropic', h.request)
      .apiKey,
    'synthetic-selected-key',
  );
  const list = h.adapter.listProviderConnections.bind(h.adapter);
  let applied = false;
  const observe = vi
    .spyOn(h.adapter, 'listProviderConnections')
    .mockImplementation(() => {
      const rows = list();
      applied = true;
      abort.abort('controlled source-read cancellation');
      return rows;
    });
  try {
    refuses(
      () =>
        readObservedSdkProviderCredential(credential, 'anthropic', h.request),
      'authorization_unavailable',
    );
    assert.equal(applied, true);
  } finally {
    observe.mockRestore();
  }
  refuses(
    () => readObservedSdkProviderCredential(credential, 'anthropic', h.request),
    'authorization_unavailable',
  );
});
