import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import type {
  ProjectS3ObjectPage,
  ProjectS3ObjectRead,
  ProjectS3Source,
} from '@kontourai/station-contracts/project';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { z } from 'zod/v3';
import { JsonFileStore } from '../infra/json-store.js';

const MAX_OBJECT_BYTES = 256 * 1024;
const MAX_PAGE_OBJECTS = 50;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const sourceSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    displayName: z.string().trim().min(1).max(120),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
    prefix: z.string().min(1).max(1024),
    createdAt: z.string().datetime(),
  })
  .strict();
const projectS3AttachmentSchema = sourceSchema
  .omit({ createdAt: true })
  .extend({
    profile: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.@/+-]+$/),
  })
  .strict();
const entrySchema = sourceSchema
  .extend({
    profile: projectS3AttachmentSchema.shape.profile,
    actorId: z.string().min(1),
    disconnected: z.boolean(),
  })
  .strict();
const registrySchema = z.array(entrySchema).max(1000);
type Entry = z.infer<typeof entrySchema>;
export interface ProjectS3Authority {
  assertCurrent: () => void;
  signal?: AbortSignal;
}

export class ProjectS3SourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 503,
  ) {
    super(message);
  }
}

export function projectS3SourcesEnabled(): boolean {
  return process.env.STATION_EXPERIMENTAL_S3_SOURCES === '1';
}

export function hasProjectS3Sources(home: string, projectId: string): boolean {
  return (
    projectS3SourcesEnabled() &&
    new ProjectS3Sources(home).list(projectId).length > 0
  );
}

function publicSource(entry: Entry): ProjectS3Source {
  const {
    profile: _profile,
    actorId: _actorId,
    disconnected: _disconnected,
    ...source
  } = entry;
  return source;
}
function safeKey(key: string): boolean {
  return (
    !Array.from(key).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        character === '\\',
    ) && !key.split('/').some((part) => part === '.' || part === '..')
  );
}
function validateSelection(source: Pick<ProjectS3Source, 'prefix' | 'bucket'>) {
  if (
    !source.prefix.endsWith('/') ||
    !safeKey(source.prefix) ||
    source.prefix.startsWith('/') ||
    source.bucket.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(source.bucket)
  )
    throw new ProjectS3SourceError(
      'Choose a bucket and a nonempty directory prefix ending in a slash.',
      400,
    );
}

async function awaitS3<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () =>
      reject(
        new ProjectS3SourceError(
          'S3 request ended or exceeded its time limit.',
          503,
        ),
      );
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Local registrations only; the AWS client exposes no write/delete operation here. */
export class ProjectS3Sources {
  private readonly file: JsonFileStore<Entry[]>;
  private readonly path: string;
  constructor(
    home: string,
    private readonly enabled = projectS3SourcesEnabled,
  ) {
    this.path = join(home, 'project-s3-sources.json');
    this.file = new JsonFileStore(this.path, [], {
      onCorruption: 'throw',
      durableAtomicWrite: true,
      maxReadBytes: MAX_REGISTRY_BYTES,
    });
  }
  private requireEnabled() {
    if (!this.enabled())
      throw new ProjectS3SourceError(
        'S3 sources are disabled pending verification.',
        404,
      );
  }
  private save(entries: Entry[]) {
    if (
      Buffer.byteLength(JSON.stringify(entries, null, 2)) > MAX_REGISTRY_BYTES
    )
      throw new ProjectS3SourceError(
        'S3 source registration byte capacity reached. Existing sources are unchanged.',
        503,
      );
    this.file.write(entries);
  }
  private entries(): Entry[] {
    this.requireEnabled();
    try {
      const entries = registrySchema.parse(this.file.read());
      for (const entry of entries) validateSelection(entry);
      return entries;
    } catch {
      throw new ProjectS3SourceError(
        'S3 source registrations are unavailable.',
        503,
      );
    }
  }
  list(projectId: string): ProjectS3Source[] {
    return this.entries()
      .filter(
        (source) => source.projectId === projectId && !source.disconnected,
      )
      .map(publicSource);
  }
  get(id: string): ProjectS3Source | undefined {
    const found = this.entries().find(
      (source) => source.id === id && !source.disconnected,
    );
    return found && publicSource(found);
  }
  private current(
    expected: ProjectS3Source,
    authority: ProjectS3Authority,
  ): Entry {
    this.requireEnabled();
    authority.assertCurrent();
    if (authority.signal?.aborted)
      throw new ProjectS3SourceError('S3 source request ended.', 403);
    const entry = this.entries().find(
      (source) => source.id === expected.id && !source.disconnected,
    );
    if (!entry || !isDeepStrictEqual(publicSource(entry), expected))
      throw new ProjectS3SourceError(
        'S3 source registration is no longer available.',
        409,
      );
    return entry;
  }
  async attach(
    raw: unknown,
    actorId: string,
    authority: ProjectS3Authority,
  ): Promise<ProjectS3Source> {
    this.requireEnabled();
    authority.assertCurrent();
    const input = projectS3AttachmentSchema.parse(raw);
    validateSelection(input);
    z.string().min(1).parse(actorId);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await acquireFileMutationLockAsync(`${this.path}.mutation`);
    try {
      this.requireEnabled();
      authority.assertCurrent();
      const entries = this.entries();
      const existing = entries.find((entry) => entry.id === input.id);
      if (existing) {
        const { createdAt: _createdAt, disconnected, ...prior } = existing;
        if (disconnected || !isDeepStrictEqual(prior, { ...input, actorId }))
          throw new ProjectS3SourceError(
            'This source request already names a different or disconnected registration.',
            409,
          );
        return publicSource(existing);
      }
      if (entries.length >= 1000)
        throw new ProjectS3SourceError(
          'S3 source registration capacity reached.',
          503,
        );
      const entry: Entry = {
        ...input,
        actorId,
        createdAt: new Date().toISOString(),
        disconnected: false,
      };
      entries.push(entry);
      authority.assertCurrent();
      this.save(entries);
      return publicSource(entry);
    } finally {
      await release();
    }
  }
  async disconnect(
    expected: ProjectS3Source,
    authority: ProjectS3Authority,
  ): Promise<void> {
    this.current(expected, authority);
    const release = await acquireFileMutationLockAsync(`${this.path}.mutation`);
    try {
      this.current(expected, authority);
      const entries = this.entries();
      const entry = entries.find((candidate) => candidate.id === expected.id)!;
      entry.disconnected = true;
      authority.assertCurrent();
      this.save(entries);
    } finally {
      await release();
    }
  }
  private client(
    expected: ProjectS3Source,
    authority: ProjectS3Authority,
  ): S3Client {
    const entry = this.current(expected, authority);
    const current = () => this.current(expected, authority);
    class SourceHttpHandler extends NodeHttpHandler {
      override handle(...args: Parameters<NodeHttpHandler['handle']>) {
        current();
        return super.handle(...args);
      }
    }
    return new S3Client({
      region: entry.region,
      credentials: fromIni({ profile: entry.profile }),
      maxAttempts: 1,
      followRegionRedirects: false,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: new SourceHttpHandler({
        connectionTimeout: 20000,
        requestTimeout: 20000,
      }),
    });
  }
  private refusal(error: unknown): never {
    if (error instanceof ProjectS3SourceError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (['PreconditionFailed', 'NoSuchKey', 'NoSuchVersion'].includes(name))
      throw new ProjectS3SourceError(
        'The selected object changed or was removed. List the source again.',
        409,
      );
    throw new ProjectS3SourceError(
      'S3 read unavailable. Check the selected AWS profile, bucket owner, region and permission.',
      503,
    );
  }
  async objects(
    expected: ProjectS3Source,
    token: string | undefined,
    authority: ProjectS3Authority,
  ): Promise<ProjectS3ObjectPage> {
    if (token !== undefined && (!token || token.length > 4096))
      throw new ProjectS3SourceError('Invalid continuation token.', 400);
    const signal = AbortSignal.any([
      AbortSignal.timeout(20000),
      ...(authority.signal ? [authority.signal] : []),
    ]);
    const client = this.client(expected, { ...authority, signal });
    try {
      const response = await awaitS3(
        client.send(
          new ListObjectsV2Command({
            Bucket: expected.bucket,
            ExpectedBucketOwner: expected.accountId,
            Prefix: expected.prefix,
            MaxKeys: MAX_PAGE_OBJECTS,
            ContinuationToken: token,
          }),
          { abortSignal: signal },
        ),
        signal,
      );
      this.current(expected, authority);
      if (
        (response.Contents?.length ?? 0) > MAX_PAGE_OBJECTS ||
        response.Contents?.some(
          (object) => !object.Key?.startsWith(expected.prefix),
        )
      )
        throw new ProjectS3SourceError(
          'S3 listing exceeded its selected page or prefix.',
          503,
        );
      const objects = (response.Contents ?? [])
        .filter(
          (object) =>
            object.Key &&
            object.Key.startsWith(expected.prefix) &&
            safeKey(object.Key) &&
            object.ETag &&
            object.Size !== undefined,
        )
        .map((object) => ({
          key: object.Key!,
          etag: object.ETag!,
          bytes: object.Size!,
          ...(object.LastModified
            ? { modifiedAt: object.LastModified.toISOString() }
            : {}),
        }));
      return {
        source: expected,
        objects,
        ...(response.NextContinuationToken
          ? { continuationToken: response.NextContinuationToken }
          : {}),
        observedAt: new Date().toISOString(),
        truncated: response.IsTruncated === true,
      };
    } catch (error) {
      return this.refusal(error);
    } finally {
      client.destroy();
    }
  }
  async read(
    expected: ProjectS3Source,
    input: { key: string; etag: string },
    authority: ProjectS3Authority,
  ): Promise<ProjectS3ObjectRead> {
    if (
      !input.key.startsWith(expected.prefix) ||
      !safeKey(input.key) ||
      input.key.length > 1024 ||
      !/\.(md|markdown|txt)$/i.test(input.key) ||
      !input.etag ||
      input.etag.length > 200 ||
      /[\r\n]/.test(input.etag)
    )
      throw new ProjectS3SourceError(
        'Choose a listed Markdown or text object inside the attached prefix.',
        400,
      );
    const signal = AbortSignal.any([
      AbortSignal.timeout(20000),
      ...(authority.signal ? [authority.signal] : []),
    ]);
    const client = this.client(expected, { ...authority, signal });
    try {
      const response = await awaitS3(
        client.send(
          new GetObjectCommand({
            Bucket: expected.bucket,
            ExpectedBucketOwner: expected.accountId,
            Key: input.key,
            IfMatch: input.etag,
          }),
          { abortSignal: signal },
        ),
        signal,
      );
      this.current(expected, authority);
      if (
        !response.Body ||
        response.ContentLength === undefined ||
        response.ContentLength > MAX_OBJECT_BYTES ||
        response.ContentLength <= 0
      )
        throw new ProjectS3SourceError(
          'Choose a nonempty supported object at most 256 KiB.',
          413,
        );
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.Body.transformToWebStream().getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        while (true) {
          const result = await reader.read();
          this.current(expected, authority);
          if (signal.aborted)
            throw new ProjectS3SourceError(
              'S3 read exceeded its time limit.',
              503,
            );
          if (result.done) break;
          length += result.value.length;
          if (length > MAX_OBJECT_BYTES)
            throw new ProjectS3SourceError(
              'Object exceeded the 256 KiB read limit.',
              413,
            );
          chunks.push(result.value);
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      this.current(expected, authority);
      const bytes = Buffer.concat(chunks);
      if (length !== response.ContentLength || response.ETag !== input.etag)
        throw new ProjectS3SourceError(
          'Object identity or length changed during the read.',
          409,
        );
      let text: string;
      try {
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new ProjectS3SourceError(
          'Object is not supported UTF-8 text.',
          400,
        );
      }
      if (!text.trim() || text.includes('\0'))
        throw new ProjectS3SourceError(
          'Object is not supported UTF-8 text.',
          400,
        );
      const object = {
        key: input.key,
        etag: input.etag,
        bytes: length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(response.VersionId ? { versionId: response.VersionId } : {}),
        ...(response.LastModified
          ? { modifiedAt: response.LastModified.toISOString() }
          : {}),
      };
      return {
        source: expected,
        object,
        text,
        observedAt: new Date().toISOString(),
        citation: `s3://${expected.bucket}/${input.key.split('/').map(encodeURIComponent).join('/')}?${response.VersionId ? `versionId=${encodeURIComponent(response.VersionId)}` : `etag=${encodeURIComponent(input.etag)}`}`,
      };
    } catch (error) {
      return this.refusal(error);
    } finally {
      client.destroy();
    }
  }
}
