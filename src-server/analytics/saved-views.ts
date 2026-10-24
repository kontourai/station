import {
  type AnalyticsSavedView,
  type AnalyticsViewDefinition,
  parseAnalyticsViewDefinition,
} from '@kontourai/station-contracts/analytics-views';
import { canonicalUsageExportJson } from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';
import { AnalyticsPrivateFile } from './private-analytics-file.js';
import {
  enrollmentIdentity,
  enrollmentOperationId,
  enrollmentOwnerSchema,
} from './source-enrollment-protocol.js';
import type { EnrollmentActor } from './source-enrollment-store.js';
export class SavedViewRejected extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}
const definitionSchema = z.custom<AnalyticsViewDefinition>((value) => {
  try {
    parseAnalyticsViewDefinition(value);
    return true;
  } catch {
    return false;
  }
});
const base = {
  id: enrollmentOperationId,
  owner: enrollmentOwnerSchema,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  updatedAt: z.string().datetime(),
};
const rowSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...base,
      state: z.literal('active'),
      definition: definitionSchema,
    })
    .strict(),
  z.object({ ...base, state: z.literal('deleted') }).strict(),
]);
const schema = z
  .object({
    version: z.literal(1),
    destinationStationId: enrollmentIdentity,
    records: z.array(rowSchema).max(1000),
  })
  .strict()
  .refine(
    (file) =>
      new Set(file.records.map((row) => row.id)).size === file.records.length,
  );
type File = z.infer<typeof schema>;
type Row = z.infer<typeof rowSchema>;
export class AnalyticsSavedViews {
  private readonly file: AnalyticsPrivateFile<File>;
  constructor(
    home: string,
    private readonly assertSources: (
      actor: EnrollmentActor,
      ids: readonly string[],
    ) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new AnalyticsPrivateFile(
      home,
      'analytics-saved-views.json',
      schema,
      4 * 1024 * 1024,
    );
  }
  private initial(actor: EnrollmentActor): File {
    return {
      version: 1,
      destinationStationId: actor.sourceStationId,
      records: [],
    };
  }
  private read(actor: EnrollmentActor) {
    const file = this.file.read(this.initial(actor));
    this.check(file, actor);
    return file;
  }
  private check(file: File, actor: EnrollmentActor) {
    if (file.destinationStationId !== actor.sourceStationId)
      throw new SavedViewRejected(403, 'saved_view_authority_changed');
  }
  private owned(actor: EnrollmentActor, row: Row) {
    return (
      row.owner.userId === actor.userId &&
      row.owner.mode === actor.mode &&
      row.owner.tenantId === actor.tenantId
    );
  }
  private find(file: File, actor: EnrollmentActor, id: string) {
    const row = file.records.find((r) => r.id === id && this.owned(actor, r));
    if (!row) throw new SavedViewRejected(404, 'saved_view_not_found');
    return row;
  }
  private view(row: Row): AnalyticsSavedView {
    if (row.state !== 'active')
      throw new SavedViewRejected(404, 'saved_view_not_found');
    return {
      id: row.id,
      revision: row.revision,
      definition: row.definition,
      updatedAt: row.updatedAt,
    };
  }
  private async sources(
    actor: EnrollmentActor,
    definitions: readonly AnalyticsViewDefinition[],
  ) {
    try {
      await this.assertSources(actor, [
        ...new Set(
          definitions.flatMap((d) => d.sources.map((s) => s.recipientId)),
        ),
      ]);
    } catch {
      await actor.assertCurrent();
      throw new SavedViewRejected(403, 'saved_view_source_unavailable');
    }
  }
  async list(actor: EnrollmentActor) {
    await actor.assertCurrent();
    const rows = this.read(actor).records.filter(
      (r) => this.owned(actor, r) && r.state === 'active',
    );
    const result = rows.map((r) => this.view(r));
    await this.sources(
      actor,
      result.map((v) => v.definition),
    );
    await actor.assertCurrent();
    return result;
  }
  async get(actor: EnrollmentActor, id: string) {
    await actor.assertCurrent();
    const result = this.view(this.find(this.read(actor), actor, id));
    await this.sources(actor, [result.definition]);
    await actor.assertCurrent();
    return result;
  }
  async create(actor: EnrollmentActor, id: string, raw: unknown) {
    const definition = parseAnalyticsViewDefinition(raw);
    return this.file.update(
      this.initial(actor),
      actor.assertCurrent,
      async (file) => {
        this.check(file, actor);
        await this.sources(actor, [definition]);
        const existing = file.records.find((row) => row.id === id);
        if (existing) {
          if (!this.owned(actor, existing))
            throw new SavedViewRejected(404, 'saved_view_not_found');
          if (
            existing.state !== 'active' ||
            canonicalUsageExportJson(existing.definition) !==
              canonicalUsageExportJson(definition)
          )
            throw new SavedViewRejected(409, 'saved_view_conflict');
          return this.view(existing);
        }
        if (
          file.records.length >= 1000 ||
          file.records.filter(
            (row) => this.owned(actor, row) && row.state === 'active',
          ).length >= 100
        )
          throw new SavedViewRejected(503, 'saved_view_capacity');
        const row: Row = {
          id,
          owner: {
            userId: actor.userId,
            mode: actor.mode,
            tenantId: actor.tenantId,
            ownerIds: actor.ownerIds,
          },
          revision: 1,
          updatedAt: new Date(this.now()).toISOString(),
          state: 'active',
          definition,
        };
        file.records.push(row);
        return this.view(row);
      },
    );
  }
  async update(
    actor: EnrollmentActor,
    id: string,
    revision: number,
    raw: unknown,
  ) {
    const definition = parseAnalyticsViewDefinition(raw);
    return this.file.update(
      this.initial(actor),
      actor.assertCurrent,
      async (file) => {
        this.check(file, actor);
        const row = this.find(file, actor, id);
        if (row.state !== 'active')
          throw new SavedViewRejected(404, 'saved_view_not_found');
        if (row.revision !== revision)
          throw new SavedViewRejected(409, 'saved_view_conflict');
        await this.sources(actor, [definition]);
        row.definition = definition;
        row.revision++;
        row.updatedAt = new Date(this.now()).toISOString();
        return this.view(row);
      },
    );
  }
  async remove(actor: EnrollmentActor, id: string, revision: number) {
    return this.file.update(
      this.initial(actor),
      actor.assertCurrent,
      (file) => {
        this.check(file, actor);
        const row = this.find(file, actor, id);
        if (row.state === 'deleted') {
          if (revision !== row.revision - 1)
            throw new SavedViewRejected(409, 'saved_view_conflict');
          return { deleted: true as const, revision: row.revision };
        }
        if (row.revision !== revision)
          throw new SavedViewRejected(409, 'saved_view_conflict');
        const tombstone: Row = {
          id: row.id,
          owner: row.owner,
          revision: row.revision + 1,
          updatedAt: new Date(this.now()).toISOString(),
          state: 'deleted',
        };
        file.records[file.records.indexOf(row)] = tombstone;
        return { deleted: true as const, revision: tombstone.revision };
      },
    );
  }
}
