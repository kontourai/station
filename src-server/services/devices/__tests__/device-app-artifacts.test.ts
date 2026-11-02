import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { DeviceArtifactStaging } from '../device-app-artifacts.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'station-device-artifact-')),
  );
  roots.push(root);
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

test('uploaded APK bytes are scoped and copied under an immutable staged handle', async () => {
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
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), 'station-device-outside-')),
    );
    roots.push(outside);
    await writeFile(join(outside, 'secret'), 'private');
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
    await symlink(join(outside, 'secret'), join(root, 'Sample.app', 'link'));
    await expect(
      store.stageWorkspace('project', root, 'Sample.app', 'ios', allowed),
    ).rejects.toMatchObject({ code: 'invalid-source' });
    await rm(join(root, 'Sample.app', 'link'));
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
