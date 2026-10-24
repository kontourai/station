import type { AnalyticsSourceEnrollmentIntent } from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';
import { AuthorityObservationRejected } from '../services/identity/authority-observation.js';
import { AnalyticsPrivateFile } from './private-analytics-file.js';
import {
  enrollmentIdentity,
  enrollmentIntentSchema,
  enrollmentOperationId,
  enrollmentOwnerSchema,
  sourceEnrollmentInput,
} from './source-enrollment-protocol.js';

type SourceEnrollmentInput = z.infer<typeof sourceEnrollmentInput>;

import { UsageExportRejected } from './usage-export-reader.js';

const fileSchema = z
  .object({
    version: z.literal(1),
    sourceStationId: enrollmentIdentity,
    intents: z
      .array(
        z
          .object({
            view: enrollmentIntentSchema,
            owner: enrollmentOwnerSchema,
          })
          .strict(),
      )
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
export interface EnrollmentActor extends z.infer<typeof enrollmentOwnerSchema> {
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
  private readonly file: AnalyticsPrivateFile<File>;
  constructor(
    home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new AnalyticsPrivateFile(
      home,
      'analytics-source-enrollments.json',
      fileSchema,
      1024 * 1024,
    );
  }
  private initial(sourceStationId: string): File {
    return { version: 1, sourceStationId, intents: [] };
  }
  private checkSource(file: File, sourceStationId: string) {
    if (file.sourceStationId !== sourceStationId)
      throw new SourceEnrollmentRejected('source_enrollment_unavailable', 503);
    return file;
  }
  private read(sourceStationId: string): File {
    try {
      return this.checkSource(
        this.file.read(this.initial(sourceStationId)),
        sourceStationId,
      );
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
    if (!enrollmentOperationId.safeParse(operationId).success)
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
      const owner = enrollmentOwnerSchema.parse({
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
  async forApproval(actor: EnrollmentActor, operationId: string) {
    if (!enrollmentOperationId.safeParse(operationId).success)
      throw new SourceEnrollmentRejected('source_enrollment_invalid', 400);
    await actor.assertCurrent();
    const entry = this.read(actor.sourceStationId).intents.find(
      (item) =>
        item.view.operationId === operationId && this.owned(actor, item),
    );
    if (!entry)
      throw new SourceEnrollmentRejected('source_enrollment_not_found', 404);
    const current = enrollmentOwnerSchema.parse({
      userId: actor.userId,
      mode: actor.mode,
      tenantId: actor.tenantId,
      ownerIds: actor.ownerIds,
    });
    if (
      entry.view.phase !== 'prepared' ||
      Date.parse(entry.view.expiresAt) <= this.now() ||
      JSON.stringify(entry.owner) !== JSON.stringify(current)
    )
      throw new SourceEnrollmentRejected('source_enrollment_conflict', 409);
    await actor.assertCurrent();
    return entry.view;
  }
  async guardApproval<T>(
    actor: EnrollmentActor,
    apply: () => Promise<T>,
  ): Promise<T> {
    return this.file.withLock(actor.assertCurrent, apply);
  }

  async cancel(
    actor: EnrollmentActor,
    operationId: string,
  ): Promise<AnalyticsSourceEnrollmentIntent> {
    if (!enrollmentOperationId.safeParse(operationId).success)
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
    try {
      return await this.file.update(
        this.initial(actor.sourceStationId),
        actor.assertCurrent,
        (file) => update(this.checkSource(file, actor.sourceStationId)),
      );
    } catch (error) {
      if (
        error instanceof SourceEnrollmentRejected ||
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        throw error;
      throw new SourceEnrollmentRejected('source_enrollment_unavailable', 503);
    }
  }
}
