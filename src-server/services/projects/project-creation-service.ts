import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LayoutConfig } from '@kontourai/station-contracts/layout';
import type {
  ProjectConfig,
  ProjectCreationRequest,
} from '@kontourai/station-contracts/project';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { FileStorageNotFoundError } from '../../domain/project-file-transactions.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { JsonFileStore } from '../infra/json-store.js';

const recordSchema = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string().uuid(),
    request: z.record(z.unknown()),
    phase: z.enum(['creating', 'created']),
    starter: z
      .object({
        catalogId: z.string().min(1),
        id: z.string().uuid(),
        phase: z.enum(['applying', 'applied']),
      })
      .strict()
      .optional(),
  })
  .strict();
type CreationRecord = z.infer<typeof recordSchema>;

export class ProjectCreationConflict extends Error {}

/** A creation intent is durable before publication; unknown outcomes are never replayed. */
export class ProjectCreationService {
  private readonly root: string;
  constructor(
    homeDir: string,
    private readonly storage: Pick<
      IStorageAdapter,
      'getProject' | 'listProjects' | 'listLayouts' | 'getLayout'
    >,
  ) {
    this.root = join(homeDir, 'project-creation-requests');
  }
  private store(id: string) {
    z.string().uuid().parse(id);
    return new JsonFileStore<CreationRecord | null>(
      join(this.root, id, 'operation.json'),
      null,
      {
        onCorruption: 'throw',
        durableAtomicWrite: true,
        maxReadBytes: 65536,
      },
    );
  }
  private read(id: string): CreationRecord | null {
    const value = this.store(id).read();
    if (value === null) return null;
    const record = recordSchema.parse(value);
    if (
      record.requestId !== id ||
      typeof record.request.slug !== 'string' ||
      !record.request.slug
    ) {
      throw new Error('Project creation receipt does not match its request.');
    }
    if (
      record.starter &&
      record.starter.catalogId !== record.request.starterLayoutId
    )
      throw new Error('Starter receipt does not match its creation request.');
    return record;
  }
  private observe(record: CreationRecord): ProjectCreationRequest {
    const requestedSlug = String(record.request.slug);
    let project: ProjectConfig | undefined;
    try {
      const candidate = this.storage.getProject(requestedSlug);
      if (candidate.id === record.projectId) project = candidate;
    } catch (error) {
      if (!(error instanceof FileStorageNotFoundError)) throw error;
    }
    if (!project) {
      const moved = this.storage
        .listProjects()
        .find((candidate) => candidate.id === record.projectId);
      if (moved) {
        const candidate = this.storage.getProject(moved.slug);
        if (candidate.id === record.projectId) project = candidate;
      }
    }
    return {
      requestId: record.requestId,
      projectId: record.projectId,
      phase: project
        ? 'created'
        : record.phase === 'created'
          ? 'unavailable'
          : 'uncertain',
      ...(project ? { project } : {}),
      ...(record.starter
        ? { starter: this.observeStarter(record, project) }
        : {}),
    };
  }
  private observeStarter(
    record: CreationRecord,
    project?: ProjectConfig,
  ): NonNullable<ProjectCreationRequest['starter']> {
    const starter = record.starter;
    if (!starter) throw new Error('Starter receipt is absent.');
    let layout: LayoutConfig | undefined;
    if (project) {
      const entry = this.storage
        .listLayouts(project.slug)
        .find((candidate) => candidate.id === starter.id);
      if (entry) {
        const candidate = this.storage.getLayout(project.slug, entry.slug);
        if (candidate.id === starter.id) layout = candidate;
      }
    }
    return {
      catalogId: starter.catalogId,
      layoutId: starter.id,
      phase: layout
        ? 'applied'
        : starter.phase === 'applied'
          ? 'unavailable'
          : 'uncertain',
      ...(layout ? { layoutSlug: layout.slug } : {}),
    };
  }
  async applyStarter(
    id: string,
    projectSlug: string,
    catalogId: string,
    publish: (
      reservedLayoutId: string,
      expectedProjectId: string,
    ) => Promise<LayoutConfig>,
    retryUncertain = false,
  ): Promise<LayoutConfig> {
    const directory = join(this.root, z.string().uuid().parse(id));
    mkdirSync(directory, { recursive: true });
    const release = await acquireFileMutationLockAsync(
      join(directory, 'operation.mutation'),
    );
    try {
      const record = this.read(id);
      if (!record || record.request.starterLayoutId !== catalogId)
        throw new ProjectCreationConflict(
          'The creation request did not select this starter.',
        );
      const observed = this.observe(record);
      if (
        observed.phase !== 'created' ||
        !observed.project ||
        observed.project.slug !== projectSlug
      )
        throw new ProjectCreationConflict(
          'The original Project is unavailable.',
        );
      if (record.starter) {
        if (record.starter.catalogId !== catalogId)
          throw new ProjectCreationConflict('The starter selection changed.');
        if (
          observed.starter?.phase === 'applied' &&
          observed.starter.layoutSlug
        ) {
          const layout = this.storage.getLayout(
            projectSlug,
            observed.starter.layoutSlug,
          );
          this.store(id).write({
            ...record,
            phase: 'created',
            starter: { ...record.starter, phase: 'applied' },
          });
          return layout;
        }
        if (record.starter.phase === 'applied' || !retryUncertain)
          throw new ProjectCreationConflict(
            'Starter outcome is unresolved or unavailable.',
          );
      }
      const starter = {
        catalogId,
        id: record.starter?.id ?? randomUUID(),
        phase: 'applying' as const,
      };
      this.store(id).write({ ...record, phase: 'created', starter });
      const layout = await publish(starter.id, observed.project.id);
      if (layout.id !== starter.id)
        throw new Error(
          'Starter publication did not retain its reserved identity.',
        );
      this.store(id).write({
        ...record,
        phase: 'created',
        starter: { ...starter, phase: 'applied' },
      });
      return layout;
    } finally {
      await release();
    }
  }

  get(id: string): ProjectCreationRequest | null {
    const record = this.read(id);
    return record ? this.observe(record) : null;
  }
  async create(
    id: string,
    raw: Record<string, unknown>,
    publish: (
      projectId: string,
      request: Record<string, unknown>,
    ) => Promise<ProjectConfig>,
  ): Promise<ProjectCreationRequest> {
    z.string().uuid().parse(id);
    const serialized = JSON.stringify(raw);
    if (
      Buffer.byteLength(serialized) > 32768 ||
      typeof raw.slug !== 'string' ||
      !raw.slug.trim()
    ) {
      throw new ProjectCreationConflict(
        'A durable creation request needs an explicit slug and an input no larger than 32 KiB.',
      );
    }
    const request: Record<string, unknown> = JSON.parse(serialized);
    const directory = join(this.root, id);
    mkdirSync(directory, { recursive: true });
    const release = await acquireFileMutationLockAsync(
      join(directory, 'operation.mutation'),
    );
    try {
      const prior = this.read(id);
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request)) {
          throw new ProjectCreationConflict(
            'This creation request already names different Project inputs.',
          );
        }
        const observed = this.observe(prior);
        if (observed.phase === 'created' && prior.phase !== 'created') {
          this.store(id).write({ ...prior, phase: 'created' });
        }
        return observed;
      }
      const record: CreationRecord = {
        requestId: id,
        projectId: randomUUID(),
        request,
        phase: 'creating',
      };
      this.store(id).write(record);
      const project = await publish(
        record.projectId,
        JSON.parse(JSON.stringify(record.request)),
      );
      if (project.id !== record.projectId)
        throw new Error(
          'Project publication did not retain the reserved identity.',
        );
      this.store(id).write({ ...record, phase: 'created' });
      return {
        requestId: id,
        projectId: project.id,
        phase: 'created',
        project,
      };
    } finally {
      await release();
    }
  }
}
