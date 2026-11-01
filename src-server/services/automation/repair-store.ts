import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AutomationActionIntent } from '@kontourai/station-contracts/automation';
import { parseAuthRef } from '@kontourai/station-contracts/datum-secret-reference';
import type {
  IsolatedRepairPhase,
  IsolatedRepairProjection,
} from '@kontourai/station-contracts/isolated-repair';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { ExactProcessIdentity } from '@kontourai/station-shared/process-identity';
import { z } from 'zod';
import { decodeAutomationActionIntent } from './automation-intent.js';
import type {
  RepairPublicationCheckpoint,
  RepairPublicationReceipt,
} from './repair-publisher.js';
import {
  type RepairResult,
  type RepairSourceSnapshot,
  repairDigest,
} from './repair-source.js';

const id = z.string().uuid();
const name = z.string().min(1).max(128);
const repository = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/);
const positive = z.number().int().positive().safe();
const auth = z.unknown().transform((value, ctx) => {
  try {
    return parseAuthRef(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid credential reference' });
    return z.NEVER;
  }
});
const common = {
  id,
  revision: positive,
  enabled: z.boolean(),
  repository,
  repositoryId: positive,
  configuredBy: name,
};
const executionProfile = z
  .object({
    ...common,
    kind: z.literal('execution'),
    projectId: name,
    agentId: name,
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    model: name,
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']),
    providerAuth: auth,
  })
  .strict();
const publisherProfile = z
  .object({
    ...common,
    kind: z.literal('publisher'),
    appId: positive,
    installationId: positive,
    privateKeyAuth: auth,
  })
  .strict();
const profile = z.discriminatedUnion('kind', [
  executionProfile,
  publisherProfile,
]);
const profilesSchema = z
  .object({ version: z.literal(1), profiles: z.array(profile).max(64) })
  .strict();
export type RepairExecutionProfile = z.infer<typeof executionProfile>;
export type RepairPublisherProfile = z.infer<typeof publisherProfile>;
type RepairProfile = RepairExecutionProfile | RepairPublisherProfile;
export type RepairOperator = { id: string; assertCurrent(): Promise<void> };
export interface RepairReview {
  id: string;
  resultDigest: string;
  bindingDigest: string;
  verdict: 'approve' | 'reject';
  rationale: string;
  operatorId: string;
  at: string;
}
export interface RepairGrant {
  id: string;
  reviewId: string;
  resultDigest: string;
  bindingDigest: string;
  publisherId: string;
  publisherDigest: string;
  operatorId: string;
  expiresAt: number;
  consumedAt?: number;
  revokedAt?: number;
}
export interface RepairRun {
  version: 1;
  runId: string;
  revision: number;
  phase: IsolatedRepairPhase;
  intent: AutomationActionIntent;
  taskId: string;
  taskIncarnation: string;
  profileId: string;
  profileDigest: string;
  owner: ExactProcessIdentity;
  ownerId: string;
  containerName: string;
  createdAt: string;
  source?: RepairSourceSnapshot;
  bindingDigest?: string;
  result?: RepairResult;
  workerReceiptDigest?: string;
  completedAt?: string;
  review?: RepairReview;
  grant?: RepairGrant;
  priorGrants: RepairGrant[];
  publicationAttempt?: {
    id: string;
    owner: ExactProcessIdentity;
    ownerId: string;
  };
  admissionReleasedAt?: string;
  followup?: { rationale: string; operatorId: string; at: string };
  checkpoints: RepairPublicationCheckpoint[];
  publication?: RepairPublicationReceipt;
  reasonCode?: string;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const mode = z.enum(['100644', '100755']);
const runSchema = z
  .object({
    version: z.literal(1),
    runId: id,
    revision: positive,
    phase: z.enum([
      'planned',
      'executing',
      'proposed',
      'rejected',
      'reviewed',
      'granted',
      'publishing',
      'published',
      'indeterminate',
      'canceled',
    ]),
    intent: z
      .unknown()
      .transform((value) =>
        decodeAutomationActionIntent(JSON.stringify(value)),
      ),
    taskId: name,
    taskIncarnation: z.string().datetime(),
    profileId: id,
    profileDigest: digest,
    owner: z.object({ pid: positive, start: name }).strict(),
    ownerId: id,
    containerName: z.string().regex(/^kontour-worker-[a-f0-9-]{36}$/),
    createdAt: z.string().datetime(),
    source: z
      .object({
        baseSha: sha,
        baseTreeSha: sha,
        digest,
        entries: z
          .array(
            z
              .object({
                path: z.string().min(1).max(1024),
                mode,
                sha,
                size: z
                  .number()
                  .int()
                  .nonnegative()
                  .max(16 * 1024 * 1024),
              })
              .strict(),
          )
          .max(50_000),
      })
      .strict()
      .optional(),
    bindingDigest: digest.optional(),
    result: z
      .object({
        digest,
        expectedTreeSha: sha,
        patch: z.string().max(4 * 1024 * 1024),
        files: z
          .array(
            z
              .object({
                path: z.string().min(1).max(240),
                mode,
                contentBase64: z.string().max(174_764).nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(40),
      })
      .strict()
      .optional(),
    workerReceiptDigest: digest.optional(),
    completedAt: z.string().datetime().optional(),
    review: z
      .object({
        id,
        resultDigest: digest,
        bindingDigest: digest,
        verdict: z.enum(['approve', 'reject']),
        rationale: z.string().min(1).max(4096),
        operatorId: name,
        at: z.string().datetime(),
      })
      .strict()
      .optional(),
    grant: z
      .object({
        id,
        reviewId: id,
        resultDigest: digest,
        bindingDigest: digest,
        publisherId: id,
        publisherDigest: digest,
        operatorId: name,
        expiresAt: positive,
        consumedAt: positive.optional(),
        revokedAt: positive.optional(),
      })
      .strict()
      .optional(),
    priorGrants: z
      .array(
        z
          .object({
            id,
            reviewId: id,
            resultDigest: digest,
            bindingDigest: digest,
            publisherId: id,
            publisherDigest: digest,
            operatorId: name,
            expiresAt: positive,
            consumedAt: positive.optional(),
            revokedAt: positive.optional(),
          })
          .strict(),
      )
      .max(32),
    publicationAttempt: z
      .object({
        id,
        owner: z.object({ pid: positive, start: name }).strict(),
        ownerId: id,
      })
      .strict()
      .optional(),
    admissionReleasedAt: z.string().datetime().optional(),
    followup: z
      .object({
        rationale: z.string().min(1).max(4096),
        operatorId: name,
        at: z.string().datetime(),
      })
      .strict()
      .optional(),
    checkpoints: z
      .array(
        z
          .object({
            phase: z.enum([
              'credential-intent',
              'credential-observed',
              'blob-intent',
              'blob-observed',
              'tree-intent',
              'tree-observed',
              'commit-intent',
              'commit-observed',
              'ref-intent',
              'ref-observed',
              'pull-request-intent',
              'pull-request-observed',
            ]),
            path: z.string().max(240).optional(),
            blobSha: sha.optional(),
            treeSha: sha.optional(),
            commitSha: sha.optional(),
            branch: z.string().max(240).optional(),
            pullRequestNumber: positive.optional(),
          })
          .strict(),
      )
      .max(128),
    publication: z
      .discriminatedUnion('outcome', [
        z
          .object({
            outcome: z.literal('published'),
            runId: id,
            bindingDigest: digest,
            resultDigest: digest,
            branch: z.string().max(240),
            treeSha: sha,
            commitSha: sha,
            pullRequestNumber: positive,
            pullRequestUrl: z.string().url().max(500),
          })
          .strict(),
        z
          .object({
            outcome: z.literal('indeterminate'),
            runId: id,
            reasonCode: name,
          })
          .strict(),
      ])
      .optional(),
    reasonCode: name.optional(),
  })
  .strict();

function privateJson(path: string, maximum: number): unknown | undefined {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > maximum ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('unsafe');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('repair-store-unavailable');
  }
}
function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeJsonDurably(path, value);
  chmodSync(path, 0o600);
}
export function repairProjection(run: RepairRun): IsolatedRepairProjection {
  return {
    runId: run.runId,
    taskId: run.taskId,
    taskIncarnation: run.taskIncarnation,
    intentId: run.intent.intentId,
    repository: run.intent.event.fields.repository,
    failedSha: run.intent.event.fields['run.head_sha'],
    workflowRun: run.intent.event.fields['run.id'],
    workflowAttempt: run.intent.event.fields['run.run_attempt'],
    phase: run.phase,
    bindingDigest: run.bindingDigest,
    resultDigest: run.result?.digest,
    reasonCode: run.reasonCode,
    ...(run.publication?.outcome === 'published'
      ? { pullRequestUrl: run.publication.pullRequestUrl }
      : {}),
  };
}

/** Durable file locks serialize profile revisions and run/grant compare-and-set across processes. */
export class RepairStore {
  readonly root: string;
  readonly profilePath: string;
  constructor(home: string) {
    this.root = join(home, 'automation', 'repairs');
    this.profilePath = join(home, 'security', 'repair-profiles.json');
  }
  profiles(): RepairProfile[] {
    return profilesSchema.parse(
      privateJson(this.profilePath, 1024 * 1024) ?? {
        version: 1,
        profiles: [],
      },
    ).profiles;
  }
  execution(id: string): RepairExecutionProfile | undefined {
    return this.profiles().find(
      (p): p is RepairExecutionProfile => p.id === id && p.kind === 'execution',
    );
  }
  publisher(id: string): RepairPublisherProfile | undefined {
    return this.profiles().find(
      (p): p is RepairPublisherProfile => p.id === id && p.kind === 'publisher',
    );
  }
  evidence(runId: string): unknown {
    return privateJson(
      join(this.directory(runId), 'worker-evidence.json'),
      16 * 1024 * 1024,
    );
  }
  profileProjections() {
    return this.profiles().map((p) => {
      const {
        providerAuth: _provider,
        privateKeyAuth: _key,
        ...projection
      } = { providerAuth: undefined, privateKeyAuth: undefined, ...p };
      return { ...projection, hasCredentialReference: true };
    });
  }
  async configure(
    input: unknown,
    operator: RepairOperator,
  ): Promise<ReturnType<RepairStore['profileProjections']>[number]> {
    await operator.assertCurrent();
    const parsed = z
      .object({
        profile: z.record(z.string(), z.unknown()),
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    const candidate = profile.parse({
      ...parsed.profile,
      id: parsed.profile.id ?? randomUUID(),
      revision: parsed.expectedRevision + 1,
      enabled: false,
      configuredBy: operator.id,
    });
    await this.lock(this.profilePath, async () => {
      await operator.assertCurrent();
      const profiles = this.profiles();
      const old = profiles.find((p) => p.id === candidate.id);
      if (
        (old?.revision ?? 0) !== parsed.expectedRevision ||
        (old && old.kind !== candidate.kind)
      )
        throw new Error('repair-profile-conflict');
      const next = profiles.filter((p) => p.id !== candidate.id);
      next.push(candidate);
      for (const execution of next.filter((p) => p.kind === 'execution')) {
        for (const publisher of next.filter((p) => p.kind === 'publisher')) {
          if (
            repairDigest(execution.providerAuth) ===
            repairDigest(publisher.privateKeyAuth)
          )
            throw new Error('repair-credential-reference-conflict');
        }
      }
      save(
        this.profilePath,
        profilesSchema.parse({ version: 1, profiles: next }),
      );
    });
    return this.profileProjections().find((p) => p.id === candidate.id)!;
  }
  async setEnabled(
    id: string,
    expectedRevision: number,
    enabled: boolean,
    operator: RepairOperator,
  ) {
    await this.lock(this.profilePath, async () => {
      await operator.assertCurrent();
      const profiles = this.profiles();
      const current = profiles.find((p) => p.id === id);
      if (!current || current.revision !== expectedRevision)
        throw new Error('repair-profile-conflict');
      save(
        this.profilePath,
        profilesSchema.parse({
          version: 1,
          profiles: profiles.map((p) =>
            p.id === id
              ? {
                  ...p,
                  enabled,
                  revision: p.revision + 1,
                  configuredBy: operator.id,
                }
              : p,
          ),
        }),
      );
    });
  }
  runPath(runId: string) {
    return join(this.root, `${id.parse(runId)}.json`);
  }
  directory(runId: string) {
    return join(this.root, id.parse(runId));
  }
  read(runId: string): RepairRun | undefined {
    const value =
      privateJson(this.runPath(runId), 16 * 1024 * 1024) ??
      privateJson(
        join(this.root, 'archive', `${id.parse(runId)}.json`),
        16 * 1024 * 1024,
      );
    return value === undefined ? undefined : runSchema.parse(value);
  }
  list(): RepairRun[] {
    try {
      return readdirSync(this.root)
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .map((name) => this.read(name.slice(0, -5))!)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async create(run: RepairRun): Promise<RepairRun> {
    return this.lock(join(this.root, 'index'), async () => {
      const runs = this.list();
      const found = runs.find((p) => p.intent.intentId === run.intent.intentId);
      if (found) return found;
      if (runs.length >= 16) throw new Error('repair-retention-capacity');
      save(this.runPath(run.runId), runSchema.parse(run));
      return run;
    });
  }
  async change(
    runId: string,
    expectedRevision: number,
    update: (run: RepairRun) => Promise<RepairRun> | RepairRun,
  ): Promise<RepairRun> {
    return this.lock(this.runPath(runId), async () => {
      const current = this.read(runId);
      if (!current || current.revision !== expectedRevision)
        throw new Error('repair-run-conflict');
      const next = runSchema.parse({
        ...(await update(current)),
        revision: current.revision + 1,
      });
      if (
        next.runId !== current.runId ||
        repairDigest(next.intent) !== repairDigest(current.intent) ||
        next.taskId !== current.taskId ||
        next.taskIncarnation !== current.taskIncarnation
      )
        throw new Error('repair-run-binding-changed');
      const activePath = this.runPath(runId);
      const target =
        privateJson(activePath, 16 * 1024 * 1024) === undefined
          ? join(this.root, 'archive', `${runId}.json`)
          : activePath;
      save(target, next);
      return next;
    });
  }
  async archive(runId: string, operator: RepairOperator): Promise<void> {
    await this.lock(join(this.root, 'index'), async () => {
      await this.lock(this.runPath(runId), async () => {
        await operator.assertCurrent();
        const run = this.read(runId);
        if (
          !run ||
          (!['published', 'rejected', 'canceled'].includes(run.phase) &&
            !(
              run.phase === 'indeterminate' &&
              run.followup &&
              run.admissionReleasedAt
            ))
        )
          throw new Error('repair-archive-conflict');
        const archive = join(this.root, 'archive');
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        if (readdirSync(archive).length >= 128)
          throw new Error('repair-archive-export-required');
        if (
          privateJson(join(archive, `${runId}.json`), 16 * 1024 * 1024) !==
          undefined
        )
          throw new Error('repair-already-archived');
        renameSync(this.runPath(runId), join(archive, `${runId}.json`));
      });
    });
  }
  private async lock<T>(path: string, work: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      return await work();
    } finally {
      await release();
    }
  }
}
