import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  ProjectToolPolicy,
  ToolAccessRequest,
  ToolLibrarySource,
} from '@kontourai/station-contracts/tool-library';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { JsonFileStore } from '../infra/json-store.js';
import { ProjectMembershipRefusal } from '../projects/project-membership-store.js';

const policySchema = z
  .object({
    mode: z.enum(['all', 'selected']),
    sources: z.array(z.string().min(1).max(512)).max(200),
    revision: z.number().int().positive(),
  })
  .strict();
const requestSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    projectSlug: z.string(),
    projectName: z.string(),
    requesterId: z.string(),
    requesterName: z.string(),
    sourceId: z.string(),
    sourceKind: z.enum(['integration', 'plugin']),
    sourceName: z.string(),
    registryId: z.string().optional(),
    status: z.enum([
      'pending',
      'setting-up',
      'available',
      'declined',
      'failed',
    ]),
    createdAt: z.string(),
    updatedAt: z.string(),
    error: z.string().optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    shared: z.record(z.boolean()),
    pluginServers: z.record(z.array(z.string())).default({}),
    policies: z.record(policySchema),
    requests: z.array(requestSchema).max(1000),
    agents: z.record(
      z.object({ projectId: z.string(), projectSlug: z.string() }).strict(),
    ),
  })
  .strict();
type State = z.infer<typeof stateSchema>;

export class ToolLibraryRefusal extends ProjectMembershipRefusal {
  constructor(
    readonly code: 'forbidden' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(code);
    this.message = message;
  }
}

export class ToolLibraryService {
  private readonly file: string;
  private readonly store: JsonFileStore<State>;
  constructor(home: string) {
    this.file = join(home, 'security', 'tool-library.json');
    this.store = new JsonFileStore<State>(
      this.file,
      {
        version: 1,
        shared: {},
        pluginServers: {},
        policies: {},
        requests: [],
        agents: {},
      },
      {
        onCorruption: 'throw',
        durableAtomicWrite: true,
        maxReadBytes: 2 * 1024 * 1024,
      },
    );
  }
  private read(): State {
    return stateSchema.parse(this.store.read());
  }
  private async change<T>(
    authorize: () => Promise<void>,
    apply: (state: State) => T,
  ): Promise<T> {
    await authorize();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const release = await acquireFileMutationLockAsync(`${this.file}.lock`);
    try {
      await authorize();
      const state = this.read();
      const result = apply(state);
      this.store.write(stateSchema.parse(state));
      return result;
    } finally {
      release();
    }
  }
  view(projectId?: string) {
    const state = this.read();
    const policy = projectId
      ? (state.policies[projectId] ?? {
          mode: 'all' as const,
          sources: [],
          revision: 1,
        })
      : { mode: 'all' as const, sources: [], revision: 1 };
    return {
      policy,
      shared: state.shared,
      requests: state.requests,
      agents: state.agents,
      pluginServers: state.pluginServers,
    };
  }
  policy(projectId: string): ProjectToolPolicy {
    return (
      this.read().policies[projectId] ?? {
        mode: 'all',
        sources: [],
        revision: 1,
      }
    );
  }
  allows(projectId: string, sourceId: string): boolean {
    const state = this.read();
    const policy = state.policies[projectId];
    return (
      sourceId !== 'station-control' &&
      state.shared[sourceId] !== false &&
      (!policy ||
        policy.mode === 'all' ||
        policy.sources.includes(sourceId) ||
        policy.sources.some((id) =>
          state.pluginServers[id]?.includes(sourceId),
        ))
    );
  }
  assertSources(projectId: string, sources: readonly string[]): void {
    const state = this.view(projectId);
    for (const source of sources)
      if (
        source === 'station-control' ||
        state.shared[source] === false ||
        (state.policy.mode === 'selected' &&
          !state.policy.sources.includes(source) &&
          !state.policy.sources.some((id) =>
            state.pluginServers[id]?.includes(source),
          ))
      )
        throw new ToolLibraryRefusal(
          'forbidden',
          `This Project does not allow ${source}.`,
        );
  }
  async setShared(
    sourceId: string,
    shared: boolean,
    authorize: () => Promise<void>,
    pluginServers: Record<string, string[]> = {},
  ) {
    return this.change(authorize, (state) => {
      Object.assign(state.pluginServers, pluginServers);
      state.shared[sourceId] = shared;
      for (const server of state.pluginServers[sourceId] ?? [])
        state.shared[server] = shared;
    });
  }
  async setPolicy(
    projectId: string,
    policy: Pick<ProjectToolPolicy, 'mode' | 'sources'>,
    expectedRevision: number,
    authorize: () => Promise<void>,
    pluginServers: Record<string, string[]> = {},
  ) {
    return this.change(authorize, (state) => {
      const current = state.policies[projectId] ?? { revision: 1 };
      if (current.revision !== expectedRevision)
        throw new ToolLibraryRefusal(
          'conflict',
          'Tool permissions changed. Refresh and try again.',
        );
      const next = {
        ...policy,
        sources: [...new Set(policy.sources)],
        revision: current.revision + 1,
      };
      state.policies[projectId] = next;
      Object.assign(state.pluginServers, pluginServers);
      return next;
    });
  }
  requests(): ToolAccessRequest[] {
    return this.read().requests;
  }
  async request(
    input: Omit<ToolAccessRequest, 'id' | 'status' | 'createdAt' | 'updatedAt'>,
    authorize: () => Promise<void>,
  ) {
    return this.change(authorize, (state) => {
      const existing = state.requests.find(
        (row) =>
          row.projectId === input.projectId &&
          row.sourceId === input.sourceId &&
          row.sourceKind === input.sourceKind &&
          ['pending', 'setting-up'].includes(row.status),
      );
      if (existing) return existing;
      if (
        state.requests.filter((row) =>
          ['pending', 'setting-up'].includes(row.status),
        ).length >= 100 ||
        state.requests.filter(
          (row) =>
            row.requesterId === input.requesterId &&
            ['pending', 'setting-up'].includes(row.status),
        ).length >= 10
      )
        throw new ToolLibraryRefusal(
          'conflict',
          'Resolve an existing tool request first.',
        );
      const now = new Date().toISOString();
      const request: ToolAccessRequest = {
        ...input,
        id: randomUUID(),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      state.requests = [
        ...state.requests
          .filter((row) => ['pending', 'setting-up'].includes(row.status))
          .slice(-100),
        ...state.requests
          .filter((row) => !['pending', 'setting-up'].includes(row.status))
          .slice(-800),
        request,
      ];
      return request;
    });
  }
  async transition(
    id: string,
    status: ToolAccessRequest['status'],
    authorize: () => Promise<void>,
    error?: string,
  ) {
    return this.change(authorize, (state) => {
      const row = state.requests.find((request) => request.id === id);
      if (!row)
        throw new ToolLibraryRefusal(
          'conflict',
          'Tool request is unavailable.',
        );
      if (row.status === 'available' || row.status === 'declined') {
        if (row.status === status) return row;
        throw new ToolLibraryRefusal(
          'conflict',
          'This request is already resolved.',
        );
      }
      if (status === 'setting-up' && row.status === 'setting-up')
        throw new ToolLibraryRefusal(
          'conflict',
          'Setup is already in progress.',
        );
      row.status = status;
      row.updatedAt = new Date().toISOString();
      row.error = error;
      return row;
    });
  }
  async admitRequest(
    id: string,
    source: ToolLibrarySource,
    authorize: () => Promise<void>,
  ) {
    return this.change(authorize, (state) => {
      const request = state.requests.find((row) => row.id === id);
      if (!request || request.status === 'declined')
        throw new ToolLibraryRefusal(
          'conflict',
          'Tool request is unavailable.',
        );
      if (
        request.sourceId !== source.id ||
        request.sourceKind !== source.kind ||
        request.registryId !== source.origin?.registryId ||
        !source.installed ||
        !source.enabled
      )
        throw new ToolLibraryRefusal(
          'conflict',
          'Finish setting up the requested source first.',
        );
      if (source.operatorOnly)
        throw new ToolLibraryRefusal(
          'forbidden',
          'This source is reserved for the Station operator.',
        );
      const policy = state.policies[request.projectId];
      const required = [source.id];
      if (
        policy?.mode === 'selected' &&
        required.some((id) => !policy.sources.includes(id))
      )
        throw new ToolLibraryRefusal(
          'forbidden',
          'The Project owner must allow this source first.',
        );
      if (
        [source.id, ...(source.serverIds ?? [])].some(
          (id) => state.shared[id] === false,
        )
      )
        throw new ToolLibraryRefusal(
          'forbidden',
          'This source is no longer shared with Projects.',
        );
      if (source.kind === 'plugin')
        state.pluginServers[source.id] = source.serverIds ?? [];
      request.status = 'available';
      request.error = undefined;
      request.updatedAt = new Date().toISOString();
      return request;
    });
  }
  assertAgent(
    slug: string,
    spec: AgentSpec,
    projectId: string | undefined,
    additions: readonly string[] = [],
  ): void {
    const binding = this.agentBinding(slug);
    if (
      binding &&
      (!projectId ||
        projectId !== binding.projectId ||
        spec.project !== binding.projectSlug)
    )
      throw new ToolLibraryRefusal(
        'forbidden',
        'This Agent belongs to a different Project incarnation.',
      );
    if (!projectId) return;
    this.assertSources(
      projectId,
      [...(spec.tools?.mcpServers ?? []), ...additions].filter(
        (id) => binding || id !== 'station-control',
      ),
    );
  }
  agentBinding(slug: string) {
    return this.read().agents[slug];
  }
  async bindAgent(
    slug: string,
    projectId: string,
    projectSlug: string,
    authorize: () => Promise<void>,
  ) {
    return this.change(authorize, (state) => {
      const binding = state.agents[slug];
      if (binding && binding.projectId !== projectId)
        throw new ToolLibraryRefusal('conflict', 'Agent ownership changed.');
      state.agents[slug] = { projectId, projectSlug };
    });
  }
}
