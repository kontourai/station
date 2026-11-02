import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ZipFile } from 'yazl';
import { DeviceArtifactStaging } from '../../services/devices/device-app-artifacts.js';
import { createDeviceArtifactRoutes } from '../device-artifacts.js';

const roots: string[] = [];
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function apk() {
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
function fixture(root: string | null, decide?: () => Promise<boolean>) {
  const staging = new DeviceArtifactStaging();
  let allowed = true;
  const routes = createDeviceArtifactRoutes({
    staging,
    enabled: () => true,
    current: () => true,
    human: (c) => c.req.header('x-human') === 'yes',
    project: (slug) =>
      slug === 'demo' ? { id: 'project-id', root } : undefined,
    authorize: async () => allowed && (decide ? await decide() : true),
  });
  disposals.push(() => routes.dispose());
  return {
    app: routes,
    dispose: routes.dispose,
    staging,
    deny: () => {
      allowed = false;
    },
  };
}

test('upload intake requires a person and current Project authority and scopes its handle', async () => {
  const h = fixture(null);
  const data = await apk();
  const path = '/projects/demo/device-artifacts/upload?platform=android';
  const denied = await h.app.request(path, { method: 'POST', body: data });
  expect(denied.status).toBe(403);
  const accepted = await h.app.request(path, {
    method: 'POST',
    headers: { 'x-human': 'yes' },
    body: data,
  });
  expect(accepted.status).toBe(201);
  const body = (await accepted.json()) as {
    data: { handle: string; source: string; revision: unknown };
  };
  expect(body.data).toMatchObject({ source: 'upload', revision: null });
  await expect(
    h.staging.withArtifact(
      'another-project',
      body.data.handle,
      async () => true,
      async () => true,
    ),
  ).rejects.toMatchObject({ code: 'artifact-unavailable' });
  h.deny();
  expect(
    (
      await h.app.request(path, {
        method: 'POST',
        headers: { 'x-human': 'yes' },
        body: data,
      })
    ).status,
  ).toBe(403);
});

test.skipIf(process.platform === 'win32')(
  'workspace intake refuses host paths and symlink escapes',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'station-device-route-')),
    );
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), 'station-device-outside-')),
    );
    roots.push(root, outside);
    await writeFile(join(outside, 'app.apk'), await apk());
    await symlink(outside, join(root, 'escape'));
    const h = fixture(root);
    for (const relativePath of [
      '/tmp/app.apk',
      '../app.apk',
      'escape/app.apk',
    ]) {
      const response = await h.app.request(
        '/projects/demo/device-artifacts/workspace',
        {
          method: 'POST',
          headers: { 'x-human': 'yes', 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'android', relativePath }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'workspace intake stages a Project-relative APK',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'station-device-route-')),
    );
    roots.push(root);
    await writeFile(join(root, 'app.apk'), await apk());
    const h = fixture(root);
    const response = await h.app.request(
      '/projects/demo/device-artifacts/workspace',
      {
        method: 'POST',
        headers: { 'x-human': 'yes', 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'android', relativePath: 'app.apk' }),
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { source: 'workspace', platform: 'android', revision: null },
    });
  },
);

test('upload intake refuses malformed and oversized archives', async () => {
  const h = fixture(null);
  const path = '/projects/demo/device-artifacts/upload?platform=android';
  expect(
    (
      await h.app.request(path, {
        method: 'POST',
        headers: { 'x-human': 'yes' },
        body: 'not an apk',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await h.app.request(path, {
        method: 'POST',
        headers: {
          'x-human': 'yes',
          'content-length': String(128 * 1024 * 1024 + 1),
        },
        body: 'x',
      })
    ).status,
  ).toBe(400);
});

test('authority revoked after admission prevents staging publication', async () => {
  let checks = 0;
  const h = fixture(null, async () => ++checks === 1);
  const response = await h.app.request(
    '/projects/demo/device-artifacts/upload?platform=android',
    {
      method: 'POST',
      headers: { 'x-human': 'yes' },
      body: await apk(),
    },
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    success: false,
    code: 'not-authorized',
  });
});

test('shutdown cancels an incomplete upload and joins its cleanup', async () => {
  const h = fixture(null);
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
      if (++pulls >= 2) started();
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(
    'http://station.test/projects/demo/device-artifacts/upload?platform=android',
    {
      method: 'POST',
      headers: { 'x-human': 'yes' },
      body: stream,
      duplex: 'half',
    } as RequestInit,
  );
  const pending = h.app.request(request);
  await reading;
  await h.dispose();
  expect((await pending).status).toBe(400);
  expect(cancelled).toBe(true);
});
