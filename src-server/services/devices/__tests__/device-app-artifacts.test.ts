import {
  link,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DeviceArtifactStaging } from '../device-app-artifacts.js';

const makeTempDir = trackTempDirs();
async function workspace() {
  const root = await realpath(makeTempDir('station-device-artifact-'));
  await mkdir(join(root, 'Sample.app'));
  await writeFile(join(root, 'Sample.app', 'Info.plist'), 'plist');
  await writeFile(join(root, 'Sample.app', 'Sample'), 'binary', {
    mode: 0o755,
  });
  return root;
}
async function apk(): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  zip.addBuffer(Buffer.from('manifest'), 'AndroidManifest.xml');
  zip.end();
  return done;
}

test('uploaded APK bytes are scoped under an owned staged handle', async () => {
  const store = new DeviceArtifactStaging();
  const allowed = async () => true;
  const receipt = await store.stageUpload(
    'project-a',
    await apk(),
    'android',
    allowed,
  );
  expect(receipt).toMatchObject({
    platform: 'android',
    source: 'upload',
    revision: null,
    state: 'staged',
  });
  await expect(
    store.withArtifact('project-b', receipt.handle, allowed, async () => true),
  ).rejects.toMatchObject({ code: 'artifact-unavailable' });
  await store.withArtifact(
    'project-a',
    receipt.handle,
    allowed,
    async (_receipt, payload) => {
      if (payload.platform !== 'android') throw new Error('wrong platform');
      payload.apk.fill(0);
    },
  );
  await store.withArtifact(
    'project-a',
    receipt.handle,
    allowed,
    async (again, payload) => {
      expect(again.digest).toBe(receipt.digest);
      if (payload.platform !== 'android') throw new Error('wrong platform');
      expect(payload.apk.subarray(0, 2).toString()).toBe('PK');
    },
  );
  await store.dispose();
});

test.skipIf(process.platform === 'win32')(
  'workspace snapshots reject paths and symlink escapes',
  async () => {
    const root = await workspace();
    const outside = await realpath(makeTempDir('station-device-outside-'));
    await writeFile(join(outside, 'secret.apk'), 'private');
    await symlink(outside, join(root, 'escape'));
    const store = new DeviceArtifactStaging();
    const allowed = async () => true;
    await expect(
      store.stageWorkspace(
        'project',
        root,
        '../outside/secret.apk',
        'android',
        allowed,
      ),
    ).rejects.toMatchObject({ code: 'invalid-source' });
    await expect(
      store.stageWorkspace(
        'project',
        root,
        'escape/secret.apk',
        'android',
        allowed,
      ),
    ).rejects.toMatchObject({ code: 'invalid-source' });
    await symlink(
      join(outside, 'secret.apk'),
      join(root, 'Sample.app', 'link'),
    );
    await expect(
      store.stageWorkspace('project', root, 'Sample.app', 'ios', allowed),
    ).rejects.toMatchObject({ code: 'invalid-source' });
    await rm(join(root, 'Sample.app', 'link'));
    await link(
      join(outside, 'secret.apk'),
      join(root, 'Sample.app', 'hardlink'),
    );
    await expect(
      store.stageWorkspace('project', root, 'Sample.app', 'ios', allowed),
    ).rejects.toMatchObject({ code: 'invalid-source' });
    await rm(join(root, 'Sample.app', 'hardlink'));
    const staged = await store.stageWorkspace(
      'project',
      root,
      'Sample.app',
      'ios',
      allowed,
    );
    expect(staged).toMatchObject({
      platform: 'ios',
      source: 'workspace',
      revision: null,
      state: 'staged',
    });
    await store.withArtifact(
      'project',
      staged.handle,
      allowed,
      async (_receipt, payload) => {
        if (payload.platform !== 'ios') throw new Error('wrong platform');
        expect(payload.files.map((file) => file.path).sort()).toEqual([
          'Info.plist',
          'Sample',
        ]);
      },
    );
    await store.dispose();
  },
);

test('revoked authorization prevents a staged artifact from being returned', async () => {
  const store = new DeviceArtifactStaging();
  let current = true;
  const receipt = await store.stageUpload(
    'project',
    await apk(),
    'android',
    async () => current,
  );
  current = false;
  await expect(
    store.withArtifact(
      'project',
      receipt.handle,
      async () => current,
      async () => true,
    ),
  ).rejects.toMatchObject({ code: 'not-authorized' });
  await store.dispose();
});

test('staged bytes expire without another request', async () => {
  const bytes = await apk();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const store = new DeviceArtifactStaging();
  try {
    const receipt = await store.stageUpload(
      'project',
      bytes,
      'android',
      async () => true,
    );
    vi.advanceTimersByTime(10 * 60_000);
    await expect(
      store.withArtifact(
        'project',
        receipt.handle,
        async () => true,
        async () => true,
      ),
    ).rejects.toMatchObject({ code: 'artifact-unavailable' });
  } finally {
    await store.dispose();
    vi.useRealTimers();
  }
});

test('shutdown cancels an in-flight artifact use and waits for it to settle', async () => {
  const store = new DeviceArtifactStaging();
  const receipt = await store.stageUpload(
    'project',
    await apk(),
    'android',
    async () => true,
  );
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let cancelled = false;
  const running = store.withArtifact(
    'project',
    receipt.handle,
    async () => true,
    async (_receipt, _payload, _current, signal) => {
      ready();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new Error('cancelled'));
          },
          { once: true },
        ),
      );
    },
  );
  const observed = running.then(
    () => 'unexpected',
    () => 'cancelled',
  );
  await started;
  await store.dispose();
  expect(cancelled).toBe(true);
  expect(await observed).toBe('cancelled');
});

test('Project quotas are independent and an install does not block new staging', async () => {
  const store = new DeviceArtifactStaging();
  const bytes = await apk();
  const allowed = async () => true;
  const first = await store.stageUpload(
    'a',
    Buffer.from(bytes),
    'android',
    allowed,
  );
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const install = store.withArtifact('a', first.handle, allowed, async () => {
    started();
    await wait;
  });
  await ready;
  let startedSecond!: () => void;
  const secondReady = new Promise<void>((resolve) => {
    startedSecond = resolve;
  });
  const second = store.withArtifact('a', first.handle, allowed, async () => {
    startedSecond();
    await wait;
  });
  await secondReady;
  await expect(
    store.withArtifact('a', first.handle, allowed, async () => true),
  ).rejects.toMatchObject({ code: 'artifact-capacity' });
  for (let i = 1; i < 10; i++)
    await store.stageUpload('a', Buffer.from(bytes), 'android', allowed);
  await expect(
    store.stageUpload('a', Buffer.from(bytes), 'android', allowed),
  ).rejects.toMatchObject({ code: 'artifact-capacity' });
  await expect(
    store.stageUpload('b', Buffer.from(bytes), 'android', allowed),
  ).resolves.toMatchObject({ state: 'staged' });
  release();
  await Promise.all([install, second]);
  await store.dispose();
});

test('global install-copy capacity is shared across three Projects', async () => {
  const store = new DeviceArtifactStaging();
  const allowed = async () => true;
  const bytes = await apk();
  const receipts = await Promise.all(
    ['a', 'b', 'c'].map((id) =>
      store.stageUpload(id, Buffer.from(bytes), 'android', allowed),
    ),
  );
  let entered = 0;
  let ready!: () => void;
  let firstThree!: () => void;
  let release!: () => void;
  const allReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const threeReady = new Promise<void>((resolve) => {
    firstThree = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const launch = (project: string, handle: string) =>
    store.withArtifact(project, handle, allowed, async () => {
      if (++entered === 3) firstThree();
      if (entered === 4) ready();
      await gate;
    });
  const runs = [
    launch('a', receipts[0]!.handle),
    launch('b', receipts[1]!.handle),
    launch('c', receipts[2]!.handle),
  ];
  await threeReady;
  runs.push(launch('a', receipts[0]!.handle));
  await allReady;
  await expect(launch('b', receipts[1]!.handle)).rejects.toMatchObject({
    code: 'artifact-capacity',
  });
  release();
  await Promise.all(runs);
  await store.dispose();
});

test('stored payload bytes have a host-wide ceiling across Projects', async () => {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  zip.addBuffer(Buffer.from('manifest'), 'AndroidManifest.xml');
  zip.addBuffer(Buffer.alloc(110 * 1024 * 1024), 'assets/large', {
    compress: false,
  });
  zip.end();
  const bytes = await done;
  const store = new DeviceArtifactStaging();
  const allowed = async () => true;
  try {
    for (const project of ['a', 'b', 'c', 'a'])
      await store.stageUpload(project, Buffer.from(bytes), 'android', allowed);
    await expect(
      store.stageUpload('b', Buffer.from(bytes), 'android', allowed),
    ).rejects.toMatchObject({ code: 'artifact-capacity' });
  } finally {
    await store.dispose();
  }
});
