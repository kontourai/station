import { createHash } from 'node:crypto';
import {
  isProductTelemetryTrendWindow,
  type ProductTelemetryIncidentLink,
  type ProductTelemetryIncidentLinkReceipt,
} from '@kontourai/station-contracts/product-telemetry';
import { workItemRefFromGitHubIssueUrl } from '@kontourai/station-contracts/work-item-provider';
import { z } from 'zod/v3';
import { AnalyticsPrivateFile } from '../analytics/private-analytics-file.js';

export const incidentWindow = z
  .object({ from: z.string(), to: z.string() })
  .strict()
  .refine((w) => isProductTelemetryTrendWindow(w.from, w.to));
export const incidentGroupId = z.string().regex(/^[a-f0-9]{64}$/);
export const incidentLinkId = z
  .string()
  .uuid()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
export const incidentLinkInput = z
  .object({
    operationId: incidentLinkId,
    window: incidentWindow,
    issueUrl: z
      .string()
      .max(2048)
      .refine((value) => workItemRefFromGitHubIssueUrl(value) !== null),
  })
  .strict();
const base = {
  id: incidentLinkId,
  installationId: incidentLinkId,
  groupId: incidentGroupId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};
const rowSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        ...base,
        state: z.literal('active'),
        issue: z
          .object({
            provider: z.literal('github'),
            url: z.string().max(2048),
            workItemRef: z.string().max(512),
          })
          .strict(),
        window: incidentWindow,
      })
      .strict(),
    z.object({ ...base, state: z.literal('deleted') }).strict(),
  ])
  .refine(
    (row) =>
      row.state === 'deleted' ||
      workItemRefFromGitHubIssueUrl(row.issue.url) === row.issue.workItemRef,
  );
const fileSchema = z
  .object({ version: z.literal(1), records: z.array(rowSchema).max(1000) })
  .strict()
  .refine(
    (file) =>
      new Set(file.records.map((row) => row.id)).size === file.records.length,
  );
type File = z.infer<typeof fileSchema>;
export interface IncidentLinkScope {
  installationId: string;
  groupIds: ReadonlySet<string>;
  assertCurrent(): Promise<void>;
}
export class IncidentLinkRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503 | 507,
    readonly code: string,
  ) {
    super(code);
  }
}

export class TelemetryIncidentLinks {
  private readonly file: AnalyticsPrivateFile<File>;
  constructor(
    home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new AnalyticsPrivateFile(
      home,
      'telemetry-incident-links.json',
      fileSchema,
      1024 * 1024,
    );
  }
  private requireGroup(scope: IncidentLinkScope, id: string) {
    if (!incidentGroupId.safeParse(id).success)
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    if (!scope.groupIds.has(id))
      throw new IncidentLinkRefused(404, 'incident_group_unavailable');
  }
  private view(
    row: Extract<File['records'][number], { state: 'active' }>,
  ): ProductTelemetryIncidentLink {
    return {
      id: row.id,
      groupId: row.groupId,
      issue: row.issue,
      window: row.window,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
  async list(
    scope: IncidentLinkScope,
    groupId: string,
  ): Promise<ProductTelemetryIncidentLink[]> {
    await scope.assertCurrent();
    this.requireGroup(scope, groupId);
    const file = this.file.read({ version: 1, records: [] });
    const rows = file.records.filter(
      (row) =>
        row.installationId === scope.installationId &&
        row.groupId === groupId &&
        row.state === 'active' &&
        Date.parse(row.expiresAt) > this.now(),
    );
    const result = rows.flatMap((row) =>
      row.state === 'active' ? [this.view(row)] : [],
    );
    await scope.assertCurrent();
    return result;
  }
  async link(
    scope: IncidentLinkScope,
    groupId: string,
    value: unknown,
  ): Promise<ProductTelemetryIncidentLinkReceipt> {
    const parsed = incidentLinkInput.safeParse(value);
    if (!parsed.success)
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    const input = parsed.data;
    this.requireGroup(scope, groupId);
    const workItemRef = workItemRefFromGitHubIssueUrl(input.issueUrl);
    if (!workItemRef)
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          scope.installationId,
          groupId,
          input.window.from,
          input.window.to,
          input.issueUrl,
        ]),
      )
      .digest('hex');
    return this.file.update(
      { version: 1, records: [] },
      () => scope.assertCurrent(),
      async (file) => {
        file.records = file.records.filter(
          (row) => Date.parse(row.expiresAt) > this.now(),
        );
        const prior = file.records.find((row) => row.id === input.operationId);
        if (prior) {
          if (
            prior.installationId !== scope.installationId ||
            prior.digest !== digest
          )
            throw new IncidentLinkRefused(
              409,
              'incident_link_operation_conflict',
            );
          return { id: prior.id, state: prior.state };
        }
        const active = file.records.filter(
          (row) =>
            row.installationId === scope.installationId &&
            row.groupId === groupId &&
            row.state === 'active',
        );
        if (
          active.some(
            (row) =>
              row.state === 'active' && row.issue.workItemRef === workItemRef,
          )
        )
          throw new IncidentLinkRefused(409, 'incident_link_exists');
        if (active.length >= 8 || file.records.length >= 1000)
          throw new IncidentLinkRefused(507, 'incident_link_capacity');
        const createdAt = new Date(this.now()).toISOString(),
          expiresAt = new Date(this.now() + 30 * 86400000).toISOString();
        file.records.push({
          id: input.operationId,
          installationId: scope.installationId,
          groupId,
          digest,
          createdAt,
          expiresAt,
          state: 'active',
          window: input.window,
          issue: { provider: 'github', url: input.issueUrl, workItemRef },
        });
        return { id: input.operationId, state: 'active' };
      },
    );
  }
  async unlink(
    scope: IncidentLinkScope,
    groupId: string,
    id: string,
  ): Promise<ProductTelemetryIncidentLinkReceipt> {
    if (
      !incidentGroupId.safeParse(groupId).success ||
      !incidentLinkId.safeParse(id).success
    )
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    return this.file.update(
      { version: 1, records: [] },
      () => scope.assertCurrent(),
      async (file) => {
        const index = file.records.findIndex(
          (row) =>
            row.installationId === scope.installationId &&
            row.groupId === groupId &&
            row.id === id &&
            Date.parse(row.expiresAt) > this.now(),
        );
        const row = file.records[index];
        if (!row) throw new IncidentLinkRefused(404, 'incident_link_not_found');
        file.records[index] = {
          id: row.id,
          installationId: row.installationId,
          groupId: row.groupId,
          digest: row.digest,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          state: 'deleted',
        };
        return { id: row.id, state: 'deleted' };
      },
    );
  }
}
