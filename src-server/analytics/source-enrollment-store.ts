import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AnalyticsSourceEnrollmentIntent } from '@kontourai/station-contracts/usage-export';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { AuthorityObservationRejected } from '../services/identity/authority-observation.js';
import {
  readPrivateJsonFile,
  writePrivateJsonFileSync,
} from '../services/notifications/private-json-file.js';
import { UsageExportRejected } from './usage-export-reader.js';

const id = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
const identity = z.string().min(1).max(200);
const retention = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('live-mirror') }).strict(),
  z
    .object({
      mode: z.literal('retained-copy'),
      days: z.number().int().min(1).max(90),
    })
    .strict(),
]);
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
export const sourceEnrollmentInput = z
  .object({
    operationId: id,
    proposedDestination: z.object({ stationId: identity, origin }).strict(),
    scope: z.enum(['individual', 'personal-account']),
    expiresAt: z
      .string()
      .datetime()
      .refine((value) => new Date(value).toISOString() === value),
    retention,
  })
  .strict();
type SourceEnrollmentInput = z.infer<typeof sourceEnrollmentInput>;
const ownerSchema = z
  .object({
    userId: identity,
    mode: z.enum(['personal', 'hosted']),
    tenantId: identity.nullable(),
    ownerIds: z.array(identity).min(1).max(1000),
  })
  .strict()
  .refine(
    (value) =>
      (value.mode === 'hosted') === (value.tenantId !== null) &&
      value.ownerIds.includes(value.userId) &&
      JSON.stringify(value.ownerIds) ===
        JSON.stringify([...new Set(value.ownerIds)].sort()),
  );
const viewSchema = sourceEnrollmentInput
  .extend({
    protocol: z.literal('station-analytics-source-enrollment-intent/v1'),
    sourceStationId: identity,
    destinationVerified: z.literal(false),
    phase: z.enum(['prepared', 'cancelled']),
    createdAt: z.string().datetime(),
    exportAuthority: z.literal(false),
  })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(1),
    sourceStationId: identity,
    intents: z
      .array(z.object({ view: viewSchema, owner: ownerSchema }).strict())
      .max(1000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.intents.map((item) => item.view.operationId)).size ===
        value.intents.length &&
      value.intents.every(
        (item) =>
          item.view.sourceStationId === value.sourceStationId &&
          (item.view.scope !== 'individual' ||
            JSON.stringify(item.owner.ownerIds) ===
              JSON.stringify([item.owner.userId])) &&
          (item.owner.mode !== 'hosted' || item.view.scope === 'individual'),
      ),
  );

type File = z.infer<typeof fileSchema>;
export interface EnrollmentActor extends z.infer<typeof ownerSchema> {
  sourceStationId: string;
  assertCurrent(): Promise<void>;
}
export class SourceEnrollmentRejected extends Error {
  constructor(
    readonly code:
      | 'source_enrollment_unavailable'
      | 'source_enrollment_conflict'
      | 'source_enrollment_not_found'
      | 'source_enrollment_invalid',
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
  }
}

/** Durable proposals only: this store never issues or accepts an export credential. */
export class SourceEnrollmentStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(
    home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = join(home, 'security');
    this.path = join(this.directory, 'analytics-source-enrollments.json');
  }
  private ensure() {
    try {
      mkdirSync(this.directory, { mode: 0o700 });
      fsyncDirectorySync(dirname(this.directory));
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error;
    }
    const entry = lstatSync(this.directory);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()))
    )
      throw new Error('Unsafe private storage');
  }
  private read(sourceStationId: string): File {
    try {
      this.ensure();
      let present = false;
      try {
        const entry = lstatSync(this.path);
        present = true;
        if (process.platform !== 'win32' && entry.uid !== process.getuid?.())
          throw new Error('Foreign file owner');
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      const raw = readPrivateJsonFile(
        this.path,
        1024 * 1024,
        'Analytics enrollment intents',
      );
      if (raw === null && !present)
        return { version: 1, sourceStationId, intents: [] };
      const value = fileSchema.parse(raw);
      if (value.sourceStationId !== sourceStationId)
        throw new Error('Source changed');
      return value;
    } catch {
      throw new SourceEnrollmentRejected('source_enrollment_unavailable', 503);
    }
  }
  private owned(actor: EnrollmentActor, entry: File['intents'][number]) {
    return (
      entry.owner.userId === actor.userId &&
      entry.owner.mode === actor.mode &&
      entry.owner.tenantId === actor.tenantId
    );
  }
  async list(
    actor: EnrollmentActor,
  ): Promise<AnalyticsSourceEnrollmentIntent[]> {
    await actor.assertCurrent();
    const value = this.read(actor.sourceStationId)
      .intents.filter((entry) => this.owned(actor, entry))
      .slice(-20)
      .reverse()
      .map((entry) => entry.view);
    await actor.assertCurrent();
    return value;
  }
  async get(
    actor: EnrollmentActor,
    operationId: string,
  ): Promise<AnalyticsSourceEnrollmentIntent> {
    if (!id.safeParse(operationId).success)
      throw new SourceEnrollmentRejected('source_enrollment_invalid', 400);
    await actor.assertCurrent();
    const entry = this.read(actor.sourceStationId).intents.find(
      (item) =>
        item.view.operationId === operationId && this.owned(actor, item),
    );
    if (!entry)
      throw new SourceEnrollmentRejected('source_enrollment_not_found', 404);
    await actor.assertCurrent();
    return entry.view;
  }
  async prepare(
    actor: EnrollmentActor,
    input: SourceEnrollmentInput,
  ): Promise<AnalyticsSourceEnrollmentIntent> {
    return this.mutate(actor, (file) => {
      const owner = ownerSchema.parse({
        userId: actor.userId,
        mode: actor.mode,
        tenantId: actor.tenantId,
        ownerIds: actor.ownerIds,
      });
      const existing = file.intents.find(
        (entry) => entry.view.operationId === input.operationId,
      );
      if (existing) {
        if (!this.owned(actor, existing))
          throw new SourceEnrollmentRejected(
            'source_enrollment_not_found',
            404,
          );
        const previous = sourceEnrollmentInput.parse({
          operationId: existing.view.operationId,
          proposedDestination: existing.view.proposedDestination,
          scope: existing.view.scope,
          expiresAt: existing.view.expiresAt,
          retention: existing.view.retention,
        });
        if (
          JSON.stringify(previous) !== JSON.stringify(input) ||
          JSON.stringify(existing.owner) !== JSON.stringify(owner)
        )
          throw new SourceEnrollmentRejected('source_enrollment_conflict', 409);
        return existing.view;
      }
      const now = this.now(),
        expires = Date.parse(input.expiresAt);
      if (expires <= now || expires > now + 30 * 86400000)
        throw new SourceEnrollmentRejected('source_enrollment_invalid', 400);
      if (
        file.intents.length >= 1000 ||
        file.intents.filter(
          (entry) =>
            this.owned(actor, entry) &&
            entry.view.phase === 'prepared' &&
            Date.parse(entry.view.expiresAt) > now,
        ).length >= 20
      )
        throw new SourceEnrollmentRejected('source_enrollment_conflict', 409);
      const view: AnalyticsSourceEnrollmentIntent = {
        ...input,
        protocol: 'station-analytics-source-enrollment-intent/v1',
        sourceStationId: actor.sourceStationId,
        destinationVerified: false,
        phase: 'prepared',
        createdAt: new Date(now).toISOString(),
        exportAuthority: false,
      };
      file.intents.push({ view, owner });
      return view;
    });
  }
  async cancel(
    actor: EnrollmentActor,
    operationId: string,
  ): Promise<AnalyticsSourceEnrollmentIntent> {
    if (!id.safeParse(operationId).success)
      throw new SourceEnrollmentRejected('source_enrollment_invalid', 400);
    return this.mutate(actor, (file) => {
      const entry = file.intents.find(
        (item) =>
          item.view.operationId === operationId && this.owned(actor, item),
      );
      if (!entry)
        throw new SourceEnrollmentRejected('source_enrollment_not_found', 404);
      entry.view.phase = 'cancelled';
      return entry.view;
    });
  }
  private async mutate(
    actor: EnrollmentActor,
    update: (file: File) => AnalyticsSourceEnrollmentIntent,
  ) {
    await actor.assertCurrent();
    this.ensure();
    const release = await acquireFileMutationLockAsync(`${this.path}.mutation`);
    try {
      const file = this.read(actor.sourceStationId);
      const result = update(file);
      await actor.assertCurrent();
      writePrivateJsonFileSync(
        this.path,
        fileSchema.parse(file),
        1024 * 1024,
        'Analytics enrollment intents',
      );
      fsyncDirectorySync(this.directory);
      await actor.assertCurrent();
      return result;
    } catch (error) {
      if (
        error instanceof SourceEnrollmentRejected ||
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        throw error;
      throw new SourceEnrollmentRejected('source_enrollment_unavailable', 503);
    } finally {
      await release();
    }
  }
}
