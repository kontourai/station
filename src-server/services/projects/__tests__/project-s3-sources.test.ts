import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ProjectS3Sources } from '../project-s3-sources.js';

const credentials = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: () => () => credentials.resolve(),
}));
const listXml =
  '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents><Key>selected/notes.md</Key><ETag>&quot;etag&quot;</ETag><Size>5</Size></Contents></ListBucketResult>';

const makeTemp = trackTempDirs();
let home: string;
let service: ProjectS3Sources;
let enabled: boolean;
let allowed: boolean;
const authority = {
  assertCurrent: () => {
    if (!allowed) throw new Error('Source authority ended');
  },
};
function input() {
  return {
    id: randomUUID(),
    projectId: 'project-research',
    displayName: 'Research archive',
    accountId: '123456789012',
    region: 'us-west-2',
    bucket: 'research-fixture',
    prefix: 'selected/',
    profile: 'fixture-only',
  };
}
beforeEach(() => {
  credentials.resolve.mockResolvedValue({
    accessKeyId: 'fixture-only',
    secretAccessKey: 'fixture-only',
  });
  home = makeTemp('project-s3-sources-');
  enabled = allowed = true;
  service = new ProjectS3Sources(home, () => enabled);
});

test('real SDK serialization enforces owner/prefix and If-Match without permitting custom endpoints', async () => {
  vi.stubEnv('AWS_ENDPOINT_URL', 'http://untrusted-endpoint.invalid');
  const source = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  const handle = vi
    .spyOn(NodeHttpHandler.prototype, 'handle')
    .mockImplementationOnce(async () => ({
      response: {
        statusCode: 200,
        headers: { 'content-type': 'application/xml' },
        body: Readable.from([Buffer.from(listXml)]),
      },
    }))
    .mockImplementationOnce(async () => ({
      response: {
        statusCode: 200,
        headers: {
          etag: '"etag"',
          'content-length': '5',
          'x-amz-version-id': 'fixture-version',
        },
        body: Readable.from([Buffer.from('notes')]),
      },
    }));
  const page = await service.objects(source, undefined, authority);
  expect(page.objects).toEqual([
    { key: 'selected/notes.md', etag: '"etag"', bytes: 5 },
  ]);
  const listed = handle.mock.calls[0]![0];
  expect(listed.hostname).toBe('research-fixture.s3.us-west-2.amazonaws.com');
  expect(listed.query).toMatchObject({ prefix: 'selected/', 'max-keys': '50' });
  expect(listed.headers['x-amz-expected-bucket-owner']).toBe(source.accountId);
  const read = await service.read(
    source,
    { key: 'selected/notes.md', etag: '"etag"' },
    authority,
  );
  expect(read.text).toBe('notes');
  expect(read.object.versionId).toBe('fixture-version');
  expect(handle.mock.calls[1]![0].headers['if-match']).toBe('"etag"');
  expect(handle).toHaveBeenCalledTimes(2);
});

test('authority revoked during actual SDK credential resolution prevents the HTTP dispatch', async () => {
  const source = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  credentials.resolve.mockImplementation(async () => {
    entered();
    await held;
    return { accessKeyId: 'fixture-only', secretAccessKey: 'fixture-only' };
  });
  const handle = vi
    .spyOn(NodeHttpHandler.prototype, 'handle')
    .mockImplementation(async () => ({
      response: {
        statusCode: 200,
        headers: { 'content-type': 'application/xml' },
        body: Readable.from([listXml]),
      },
    }));
  const outcome = service
    .objects(source, undefined, authority)
    .catch((error) => error);
  await started;
  allowed = false;
  release();
  expect(await outcome).toMatchObject({ status: 503 });
  expect(handle).not.toHaveBeenCalled();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('S3 is default-off and disabled operations create no registration or AWS call', async () => {
  vi.stubEnv('STATION_EXPERIMENTAL_S3_SOURCES', '');
  const send = vi.spyOn(S3Client.prototype, 'send');
  const disabled = new ProjectS3Sources(home);
  await expect(
    disabled.attach(input(), 'human:local:operator', authority),
  ).rejects.toMatchObject({ status: 404 });
  expect(existsSync(join(home, 'project-s3-sources.json'))).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

test('registrations survive restart, bind exact intent, withhold profile, and cannot resurrect after disconnect', async () => {
  const request = input();
  const source = await service.attach(
    request,
    'human:local:operator',
    authority,
  );
  expect(source).not.toHaveProperty('profile');
  expect(source).not.toHaveProperty('actorId');
  const restarted = new ProjectS3Sources(home, () => true);
  expect(
    await restarted.attach(request, 'human:local:operator', authority),
  ).toEqual(source);
  expect(restarted.list(request.projectId)).toEqual([source]);
  expect(restarted.list('another-project')).toEqual([]);
  await expect(
    restarted.attach(
      { ...request, prefix: 'different/' },
      'human:local:operator',
      authority,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await restarted.disconnect(source, authority);
  expect(restarted.get(source.id)).toBeUndefined();
  await expect(
    restarted.attach(request, 'human:local:operator', authority),
  ).rejects.toMatchObject({ status: 409 });
});

test('Unicode byte-capacity rejection preserves existing list/read/disconnect access', async () => {
  const selected = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  const path = join(home, 'project-s3-sources.json');
  const [base] = JSON.parse(readFileSync(path, 'utf8'));
  const expanded = { ...base, prefix: `${'文'.repeat(1023)}/` };
  const max = 2 * 1024 * 1024;
  const cost = Buffer.byteLength(JSON.stringify([expanded], null, 2)) - 2;
  const count = Math.floor(
    (max - Buffer.byteLength(JSON.stringify([base], null, 2))) / cost,
  );
  const entries = [
    base,
    ...Array.from({ length: count }, () => ({ ...expanded, id: randomUUID() })),
  ];
  const before = JSON.stringify(entries, null, 2);
  expect(Buffer.byteLength(before)).toBeLessThanOrEqual(max);
  expect(entries.length).toBeLessThan(1000);
  writeFileSync(path, before);
  await expect(
    service.attach(
      { ...input(), prefix: expanded.prefix },
      'human:local:operator',
      authority,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(service.get(selected.id)).toEqual(selected);
  expect(service.list(selected.projectId)).toHaveLength(entries.length);
  await service.disconnect(selected, authority);
  expect(service.get(selected.id)).toBeUndefined();
  expect(service.list(selected.projectId)).toHaveLength(entries.length - 1);
});

test.each([
  '',
  'selected',
  '../selected/',
  '/selected/',
  'selected/../',
  'selected/\\escape/',
])('unsafe or ambiguous prefix %s is refused before saving', async (prefix) => {
  await expect(
    service.attach({ ...input(), prefix }, 'human:local:operator', authority),
  ).rejects.toThrow();
  expect(existsSync(join(home, 'project-s3-sources.json'))).toBe(false);
});

test('one listing page pins bucket owner, prefix and continuation and never claims complete coverage', async () => {
  const source = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  const send = vi
    .spyOn(S3Client.prototype, 'send')
    .mockImplementation(async () => ({
      Contents: [{ Key: 'selected/notes.md', ETag: '"etag-one"', Size: 5 }],
      IsTruncated: true,
      NextContinuationToken: 'next-page',
    }));
  const page = await service.objects(source, 'previous-page', authority);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0].input).toMatchObject({
    Bucket: source.bucket,
    ExpectedBucketOwner: source.accountId,
    Prefix: source.prefix,
    MaxKeys: 50,
    ContinuationToken: 'previous-page',
  });
  expect(page).toMatchObject({
    truncated: true,
    continuationToken: 'next-page',
    objects: [{ key: 'selected/notes.md', etag: '"etag-one"', bytes: 5 }],
  });
});

test('prefix escape, stale registration, disconnect and flag loss refuse AWS access', async () => {
  const source = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  const send = vi.spyOn(S3Client.prototype, 'send');
  for (const key of [
    'other/notes.md',
    'selected/../private.md',
    'selected/notes.pdf',
  ])
    await expect(
      service.read(source, { key, etag: '"etag"' }, authority),
    ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.objects({ ...source, prefix: 'other/' }, undefined, authority),
  ).rejects.toMatchObject({ status: 409 });
  enabled = false;
  await expect(
    service.objects(source, undefined, authority),
  ).rejects.toMatchObject({ status: 404 });
  enabled = true;
  await service.disconnect(source, authority);
  await expect(
    service.objects(source, undefined, authority),
  ).rejects.toMatchObject({ status: 409 });
  expect(send).not.toHaveBeenCalled();
});

test('object read preserves UTF-8 bytes/hash/version citation and binds the selected ETag', async () => {
  const source = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  const bytes = Buffer.from('\ufeff\nSelected source\r\n');
  const send = vi
    .spyOn(S3Client.prototype, 'send')
    .mockImplementation(async () => ({
      ETag: '"etag-one"',
      ContentLength: bytes.length,
      VersionId: 'version/one',
      Body: {
        transformToWebStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
      },
    }));
  const result = await service.read(
    source,
    { key: 'selected/notes.md', etag: '"etag-one"' },
    authority,
  );
  expect(result.text).toBe('\ufeff\nSelected source\r\n');
  expect(result.object).toMatchObject({
    etag: '"etag-one"',
    versionId: 'version/one',
    bytes: bytes.length,
  });
  expect(result.citation).toBe(
    's3://research-fixture/selected/notes.md?versionId=version%2Fone',
  );
  expect(send.mock.calls[0]?.[0].input).toMatchObject({
    ExpectedBucketOwner: source.accountId,
    Key: 'selected/notes.md',
    IfMatch: '"etag-one"',
  });
});

test('revocation during body delivery withholds partial text and cancels the stream', async () => {
  const source = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  const cancelled = vi.fn();
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({
    ETag: '"etag"',
    ContentLength: 5,
    Body: {
      transformToWebStream: () =>
        new ReadableStream({
          pull(controller) {
            allowed = false;
            controller.enqueue(Buffer.from('notes'));
          },
          cancel: cancelled,
        }),
    },
  }));
  await expect(
    service.read(
      source,
      { key: 'selected/notes.md', etag: '"etag"' },
      authority,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(cancelled).toHaveBeenCalled();
});

test('oversized actual body, changed ETag and invalid UTF-8 never return source text', async () => {
  const source = await service.attach(
    input(),
    'human:local:operator',
    authority,
  );
  const send = vi.spyOn(S3Client.prototype, 'send');
  for (const [bytes, etag, status] of [
    [Buffer.alloc(262145, 'x'), '"etag"', 413],
    [Buffer.from('text'), '"changed"', 409],
    [Buffer.from([255]), '"etag"', 400],
  ] as const) {
    send.mockImplementationOnce(async () => ({
      ETag: etag,
      ContentLength: Math.min(bytes.length, 262144),
      Body: {
        transformToWebStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
      },
    }));
    await expect(
      service.read(
        source,
        { key: 'selected/notes.md', etag: '"etag"' },
        authority,
      ),
    ).rejects.toMatchObject({ status });
  }
});
