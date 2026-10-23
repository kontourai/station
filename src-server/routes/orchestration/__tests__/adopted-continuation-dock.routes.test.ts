/**
 * #3429: after Continue in Station, the dock opens the continuation and a
 * follow-up sent from it reaches the continuation's engine in its folder.
 *
 * Everything real except the engines and the Station's own HTTP discovery
 * reads: the security service owns this Station's Environment, a real
 * ConfigLoader holds the engine's Agent (materialized the way boot adoption
 * does), the real OrchestrationService adopts the attached conversation, and
 * the real orchestration and conversation routes open and continue it. The
 * engines record what Station handed them and publish `session.started` with
 * the start metadata, as the real adapters do.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { materializeEngineAgent } from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ensureStationHomeSchemaSync } from '../../../domain/home-schema-gate.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSession,
  ProviderSessionAdoptInput,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createAgentDispatchActorResolver } from '../../../runtime/mcp/station-control-caller.js';
import { createAdoptedChildExecutionBindingResolver } from '../../../services/orchestration/adopted-child-execution-binding.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { ProjectBindingsStore } from '../../../services/projects/project-binding-store.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectSessionDirectoryResolver } from '../../../services/projects/project-session-directory.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createStarterSessionOwner } from '../../../services/starter-work/starter-session-owner.js';
import { createLogger } from '../../../utils/logger.js';
import { createGlobalConversationRoutes } from '../../chat/conversations.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const CURRENT_API = 'http://adopted-dock.test';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

function repository(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return path;
}

/**
 * The follow-up the dock sends (`foregroundMessageDispatch.ts`): a tab with
 * a project names only that project; one without names this Station.
 */
function dockFollowUp(
  agent: string,
  conversationId: string | undefined,
  projectSlug: string | undefined,
  message: string,
) {
  return {
    target: {
      ...(!projectSlug ? { environment: { kind: 'current' } } : {}),
      agent,
      ...(projectSlug ? { workspace: { kind: 'project', projectSlug } } : {}),
    },
    message,
    conversationId,
  };
}
process.env.STATION_API_BASE = CURRENT_API;

const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Engine = 'claude' | 'codex';

/**
 * The Station's own discovery reads, answered from the real Agent store and
 * Environment record so they cannot disagree with what adoption read.
 */
function installStationDiscovery(
  loader: ConfigLoader,
  security: EnvironmentSecurityService,
  projects: () => Array<{ slug: string; workingDirectory?: string }>,
  resolveDirectory?: (slug: string) => Promise<string | undefined>,
): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`)
      return json({
        environmentId: (await security.readExistingRecord()).environmentId,
      });
    const agent = url.match(/\/api\/agents\/([^/]+)$/)?.[1];
    if (agent) {
      const spec = await loader.loadAgent(decodeURIComponent(agent));
      return json({
        success: true,
        data: { ...spec, slug: agent, available: true },
      });
    }
    const project = url.match(/\/api\/projects\/([^/]+)$/)?.[1];
    if (project) {
      const found = projects().find(
        (candidate) => candidate.slug === decodeURIComponent(project),
      );
      return found
        ? json({
            success: true,
            data: {
              ...found,
              ...(resolveDirectory
                ? { workingDirectory: await resolveDirectory(found.slug) }
                : {}),
            },
          })
        : json({ success: false, error: 'Project not found' }, 404);
    }
    const connection = url.match(/\/api\/connections\/([^/]+)$/)?.[1];
    if (connection)
      return json({
        success: true,
        data: {
          id: connection,
          kind: 'agent',
          type: connection,
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          config: { provider: connection },
        },
      });
    throw new Error(`Unexpected request in adopted-dock test: ${url}`);
  });
}

/** An engine that forks attached conversations and records every turn. */
class AdoptingEngine implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly adoptions: ProviderSessionAdoptInput[] = [];
  readonly starts: Array<{ threadId: string; cwd?: string }> = [];
  readonly turns: Array<{ threadId: string; input: string }> = [];
  readonly turnWorkingDirectories: string[] = [];
  private readonly sessions = new Map<string, ProviderSession>();

  constructor(
    readonly provider: Engine,
    private readonly probeWorkingDirectory = false,
  ) {
    this.metadata = {
      displayName: provider,
      description: `${provider} adopted-dock test engine`,
      capabilities: ['agent-runtime'],
    };
  }

  private publishStart(input: {
    threadId: string;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }) {
    this.events.push({
      eventId: `${input.threadId}:session.started:${this.starts.length}`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      sessionId: input.threadId,
      metadata: { ...input.metadata, cwd: input.cwd },
    } as CanonicalRuntimeEvent);
  }

  async adoptSession(input: ProviderSessionAdoptInput) {
    this.adoptions.push(input);
    this.starts.push({ threadId: input.threadId, cwd: input.cwd });
    this.publishStart(input);
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      cwd: input.cwd,
      resumeCursor: `child-of-${input.sourceSessionId}`,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  async discardSession(): Promise<void> {}

  /** What the engine reports about its own setup. */
  prerequisites: Prerequisite[] = [];
  async getPrerequisites(): Promise<Prerequisite[]> {
    return this.prerequisites;
  }

  async startSession(input: {
    threadId: string;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }) {
    this.starts.push({ threadId: input.threadId, cwd: input.cwd });
    this.publishStart(input);
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  async sendTurn(input: { threadId: string; input: string }) {
    if (this.probeWorkingDirectory) {
      const cwd = this.sessions.get(input.threadId)?.cwd;
      if (!cwd)
        throw new Error('The engine has no workspace to execute this turn in.');
      this.turnWorkingDirectories.push(
        execFileSync(process.execPath, ['-p', 'process.cwd()'], {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
      );
    }
    this.turns.push({ threadId: input.threadId, input: input.input });
    return {
      threadId: input.threadId,
      turnId: `${this.provider}-turn-${this.turns.length}`,
    };
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }

  /** The engine process ends on its own, as a real one does when it exits. */
  exit(threadId: string): void {
    this.sessions.delete(threadId);
    this.events.push({
      eventId: `${threadId}:exited:${this.starts.length}`,
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
    } as CanonicalRuntimeEvent);
  }
  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  async stopAll(): Promise<void> {}
  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
}

const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: {
  engineAgent: boolean;
  boundResources?: boolean;
  unqualifiedProject?: boolean;
}) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = realpathSync.native(makeTempDir('station-adopted-dock-'));
  const home = join(root, 'home');
  // Boot claims the home's schema before anything is written to it.
  ensureStationHomeSchemaSync(home);
  const security = new EnvironmentSecurityService({ homeDir: home });
  const operator = await security.initialize();
  const loader = new ConfigLoader({ projectHomeDir: home });
  // The engines' own Agents, as boot adoption of a detected engine writes
  // them (`native-engine-adoption.ts`).
  if (options.engineAgent) {
    await materializeEngineAgent(loader, 'claude', 'Claude Code');
    await materializeEngineAgent(loader, 'codex', 'Codex');
  }

  // The user's home folder is the test's own: a No project continuation is
  // allowed only inside it (#3386). Station's data folder stays outside it.
  const userHome = join(root, 'user');
  vi.stubEnv('HOME', userHome);
  vi.stubEnv('STATION_HOME', home);
  const project = repository(join(userHome, 'dev', 'station'));
  const folder = join(project, 'packages', 'app');
  mkdirSync(folder, { recursive: true });
  const worktree = join(userHome, 'dev', 'station-worktrees', 'lane');
  git(project, 'worktree', 'add', '-q', '-b', 'lane', worktree);
  const ownFolder = join(userHome, 'code', 'scratch');
  mkdirSync(ownFolder, { recursive: true });
  const otherProject = repository(join(userHome, 'dev', 'other'));
  let projectList = [
    { slug: 'station', workingDirectory: project },
    { slug: 'other', workingDirectory: otherProject },
  ];
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const bindings = new ProjectBindingsStore(home);
  const firstRepo = 'github.com/example/first';
  const secondRepo = 'gitlab.com/example/second';
  if (options.boundResources) {
    git(project, 'remote', 'add', 'origin', `https://${firstRepo}.git`);
    git(otherProject, 'remote', 'add', 'origin', `https://${secondRepo}.git`);
    await storage.createProject({
      id: randomUUID(),
      slug: 'station',
      name: 'Station',
      workingDirectory: project,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await manifests.ensureProjectManifest(storage.getProject('station'));
    const record = manifests.readRecord('station')!;
    await storage.projectRevision('station').replaceManifest!(record, {
      ...record,
      repos: [
        ...record.repos,
        {
          kind: 'git',
          id: secondRepo,
          canonicalRemote: secondRepo,
          role: 'secondary',
        },
      ],
      executionRoot: { repoId: firstRepo, path: '.' },
    });
    for (const [resourceId, path] of [
      [firstRepo, project],
      [secondRepo, otherProject],
    ])
      await bindings.upsertProjectBinding({
        projectId: record.id,
        resourceId,
        kind: 'git-checkout',
        path,
        remotes: [resourceId],
        verifiedAt: Date.now(),
        state: 'bound',
      });
  }
  const resolveDirectory = options.boundResources
    ? createProjectSessionDirectoryResolver(home, storage)
    : undefined;
  const projects = () =>
    options.boundResources
      ? storage
          .listProjects()
          .map((project) =>
            options.unqualifiedProject
              ? { ...project, id: undefined }
              : project,
          )
      : projectList;
  const selectSecond = async () => {
    const record = manifests.readRecord('station')!;
    await storage.projectRevision('station').replaceManifest!(record, {
      ...record,
      executionRoot: { repoId: secondRepo, path: '.' },
    });
  };
  /** The operator edits the Station's projects. */
  const setProjects = (next: typeof projectList) => {
    projectList = next;
  };
  installStationDiscovery(loader, security, projects, resolveDirectory);

  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const engines = {
    claude: new AdoptingEngine('claude', options.boundResources),
    codex: new AdoptingEngine('codex', options.boundResources),
  };
  const registry: IProviderAdapterRegistry = {
    register() {},
    get: (provider) => engines[provider as Engine],
    list: () => Object.values(engines),
  };
  const service = new OrchestrationService({
    adapterRegistry: registry,
    eventBus,
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    listProjects: projects,
    resolveProjectSessionDirectory: resolveDirectory,
    // The production session-agent resolver (`runtime-initialize.ts`) over
    // the real Agent store: a fresh engine start runs as an authored Agent.
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: (slug) => loader.loadAgent(slug).catch(() => null),
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
    // The production composition (`runtime-initialize.ts`).
    resolveAdoptedChildExecutionBinding:
      createAdoptedChildExecutionBindingResolver({
        configLoader: loader,
        readEnvironmentId: async () =>
          (await security.readExistingRecord()).environmentId,
      }),
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });

  const { continueExecutionTargetMessage, executeExecutionTargetMessage } =
    await import('../../../tools/station-control-delegation.js');
  const readAuthority = (userId: string) =>
    sessionReadAuthorityFromRequest(userId, undefined, undefined);

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'adopted-dock-test', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : undefined,
      resolveCredentialDeviceId: () => undefined,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'operator',
      resolveAgentDispatchActor: createAgentDispatchActorResolver(),
      executeForegroundMessage: (input: { userId: string }) =>
        executeExecutionTargetMessage(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
      continueForegroundMessage: (input: { userId: string }) =>
        continueExecutionTargetMessage(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
    } as never),
  );
  app.route(
    '/api/conversations',
    createGlobalConversationRoutes(
      new Map(),
      { getConversation: () => null },
      createLogger({ name: 'adopted-dock-test', level: 'error' }),
      undefined,
      service as never,
      () => 'operator',
      undefined,
      () => readAuthority('operator'),
    ),
  );

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${operator.credential}`,
  };
  const request = async (path: string, body?: unknown) => {
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as any };
  };

  let sources = 0;
  /** A followed conversation of `engine` whose recorded folder is `cwd`. */
  const attached = (engine: Engine, cwd = folder): string => {
    sources += 1;
    const threadId = `external:${engine}:dock-${sources}`;
    const createdAt = '2026-10-05T00:00:00.000Z';
    store.upsertSession({
      provider: engine,
      threadId,
      status: 'ready',
      cwd,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: engine === 'claude' ? 'claude-transcript' : 'codex-rollout',
        externalSessionId: `native-${sources}`,
        affinity: { kind: 'test', ref: 'fixture' },
      },
      createdAt,
      updatedAt: createdAt,
    });
    // The follow service records the local operator as the owner of a
    // conversation read from this host's engine homes.
    store.appendEvent({
      eventId: `${threadId}:attached`,
      provider: engine,
      threadId,
      createdAt,
      method: 'session.started',
      sessionId: threadId,
      metadata: { userId: 'operator' },
    } as never);
    // Codex continues only from a completed turn of the source.
    store.appendEvent({
      eventId: `${threadId}:turn-completed`,
      provider: engine,
      threadId,
      turnId: 'source-turn',
      createdAt,
      method: 'turn.completed',
      finishReason: 'stop',
    } as never);
    return threadId;
  };

  /** Continue in Station through the real command route. */
  const adopt = async (
    sourceThreadId: string,
    target?: { kind: 'own-folder' },
  ) => {
    const response = await request('/api/orchestration/commands', {
      type: 'adoptSession',
      sourceThreadId,
      ...(target ? { target } : {}),
    });
    expect(response.status, response.text).toBe(200);
    const childThreadId = response.body.data.threadId as string;
    // The child's start event is projected asynchronously, as in production.
    await vi.waitFor(() =>
      expect(
        store.latestEventByMethod(childThreadId, 'session.started'),
      ).toBeTruthy(),
    );
    return childThreadId;
  };

  return {
    root,
    storage,
    manifests,
    bindings,
    firstRepo,
    secondRepo,
    selectSecond,
    operator,
    security,
    loader,
    service,
    store,
    engines,
    project,
    folder,
    worktree,
    ownFolder,
    otherProject,
    setProjects,
    attached,
    adopt,
    request,
  };
}

describe('#3429: a continued attached conversation opens in the dock', () => {
  type Kind =
    | 'project folder'
    | 'folder inside the project'
    | 'worktree'
    | 'No project';
  test.each([
    ['claude', 'project folder'],
    ['codex', 'project folder'],
    ['claude', 'folder inside the project'],
    ['codex', 'worktree'],
    ['claude', 'No project'],
  ] as Array<[Engine, Kind]>)(
    '%s, %s: the dock opens the continuation and its follow-up reaches the engine in the conversation folder',
    async (engine, kind) => {
      const f = await fixture({ engineAgent: true });
      const cwd = {
        'project folder': f.project,
        'folder inside the project': f.folder,
        worktree: f.worktree,
        'No project': f.ownFolder,
      }[kind];
      const projectSlug = kind === 'No project' ? undefined : 'station';
      const child = await f.adopt(
        f.attached(engine, cwd),
        kind === 'No project' ? { kind: 'own-folder' } : undefined,
      );
      const environmentId = (await f.security.readExistingRecord())
        .environmentId;

      // Adoption kept its own confinement (the operator in person may grant
      // `host`, #2493), folder and project, and added the binding a
      // dock-started chat of the engine's own Agent records.
      const [adoption] = f.engines[engine].adoptions;
      expect(adoption!.cwd).toBe(cwd);
      expect(adoption!.confinement).toBe('host');
      expect(adoption!.metadata).toMatchObject({
        stationConfinement: 'host',
        dispatchCanonicalCwd: cwd,
        agentSlug: engine,
        targetKind: 'agent',
        targetId: engine,
        connectionId: engine,
        environmentId,
        conversationId: child,
        ...(projectSlug
          ? { projectSlug, workspaceIsolation: { mode: 'shared' } }
          : {}),
      });
      if (!projectSlug) {
        expect(adoption!.metadata).not.toHaveProperty('projectSlug');
        expect(adoption!.metadata).not.toHaveProperty('workspaceIsolation');
      }

      // The dock's open read (`GET /api/conversations/:id/open`).
      const opened = await f.request(
        `/api/conversations/${encodeURIComponent(child)}/open`,
      );
      expect(opened.status, opened.text).toBe(200);
      expect(opened.body.data).toMatchObject({
        status: 'resolved',
        currentSessionId: child,
        canContinue: true,
        conversation: { id: child, agentSlug: engine, environmentId },
        execution: {
          sessionId: child,
          agentId: engine,
          provider: engine,
          engineConnectionId: engine,
        },
      });
      // The tab takes its project from this read, and so does its follow-up.
      expect(opened.body.data.conversation.projectSlug).toBe(projectSlug);

      const followUp = await f.request(
        '/api/orchestration/chat',
        dockFollowUp(
          engine,
          child,
          opened.body.data.conversation.projectSlug,
          'keep going',
        ),
      );
      expect(followUp.status, followUp.text).toBe(200);
      expect(followUp.body.data).toMatchObject({
        conversationId: child,
        sessionId: child,
        resolution: {
          workspace: projectSlug
            ? {
                kind: 'project',
                projectSlug,
                cwd,
                workspaceIsolation: { mode: 'shared' },
              }
            : { kind: 'directory', cwd },
        },
      });
      // It reached the continuation's own engine session, which runs in the
      // conversation's folder: nothing was started anywhere else, and the
      // project root never became its folder.
      expect(f.engines[engine].turns).toEqual([
        { threadId: child, input: 'keep going' },
      ]);
      expect(f.engines[engine].starts).toEqual([{ threadId: child, cwd }]);
      const other = engine === 'claude' ? 'codex' : 'claude';
      expect(f.engines[other].turns).toEqual([]);
      expect(f.engines[other].starts).toEqual([]);
    },
  );

  test.each([
    ['retained', false],
    ['reclaimable', false],
    ['retained', true],
    ['reclaimable', true],
  ] as const)(
    '#3567: production continuation authorizes every materialized Session before staged proof (%s, readable=%s)',
    async (state, readable) => {
      const f = await fixture({ engineAgent: true });
      const root = await f.adopt(f.attached('claude', f.project));
      const authority = sessionReadAuthorityFromRequest(
        'operator',
        undefined,
        undefined,
      );
      const metadata = f.service.firstStartedMetadataOfThread(root);
      if (!metadata) throw new Error('Expected adopted root binding');
      let predecessor = root;
      const middle = `${root}:private-middle`;
      const current = `${root}:current`;
      for (const id of [middle, current]) {
        const now = new Date().toISOString();
        f.store.reserveNextConversationSession({
          conversationId: root,
          predecessorSessionId: predecessor,
          proposedSessionId: id,
          createdAt: now,
        });
        f.store.upsertSession({
          provider: 'claude',
          threadId: id,
          status: 'ready',
          cwd: f.project,
          createdAt: now,
          updatedAt: now,
        });
        f.store.appendEvent({
          eventId: `${id}:started`,
          provider: 'claude',
          threadId: id,
          sessionId: id,
          createdAt: now,
          method: 'session.started',
          metadata: {
            ...metadata,
            conversationId: root,
            userId: id === middle && !readable ? 'foreign-person' : 'operator',
          },
        });
        predecessor = id;
      }
      expect(await f.service.readSession(root, authority)).not.toBeNull();
      expect(await f.service.readSession(current, authority)).not.toBeNull();
      expect(Boolean(await f.service.readSession(middle, authority))).toBe(
        readable,
      );
      const peer =
        state === 'reclaimable'
          ? new EventStore(join(f.root, 'orchestration.sqlite'), 512, {
              exact: () => ({ pid: 2147483647, start: 'dead-private-owner' }),
              probe: () => ({ state: 'dead' as const }),
            })
          : undefined;
      const owner = (peer ?? f.store).createTurnDeduplicator().claim({
        threadId: middle,
        clientTurnId: 'private-staged-key',
        inputDigest: 'original-private-input',
      });
      if (owner.kind !== 'owner')
        throw new Error('Expected original private owner');
      if (state === 'retained') {
        owner.claim.beginInvocation();
        owner.claim.retain();
      }
      peer?.close();
      const staging = new AttachmentStagingService();
      try {
        const prepared = staging.prepare(
          { principalId: 'operator' },
          {
            clientAttachmentId: 'authority-stage',
            kind: 'file',
            name: 'note.txt',
            mimeType: 'text/plain',
            size: 2,
          },
        );
        const reference = staging.upload(
          prepared.stageId,
          prepared.uploadGrant,
          'data:text/plain;base64,aGk=',
        );
        const resolveAttachments = vi.fn(
          (
            binding: { threadId: string; clientTurnId: string },
            options?: { inspectOnly?: true },
          ) =>
            staging.bindAndHydrate(
              { principalId: 'operator' },
              [reference],
              binding,
              options,
            ),
        );
        const inspect = vi.spyOn(f.service, 'inspectTurnDelivery');
        const beforeStarts = f.engines.claude.starts.length;
        const { continueExecutionTargetMessage } = await import(
          '../../../tools/station-control-delegation.js'
        );
        let failure: unknown;
        await continueExecutionTargetMessage(
          {
            conversationId: root,
            clientTurnId: 'private-staged-key',
            message: 'different input',
            userId: 'operator',
            readAuthority: authority,
            resolveAttachments,
          },
          f.service,
        ).catch((error: unknown) => {
          failure = error;
        });
        if (readable)
          expect(resolveAttachments).toHaveBeenCalledWith(
            { threadId: middle, clientTurnId: 'private-staged-key' },
            { inspectOnly: true },
          );
        else {
          expect(resolveAttachments).not.toHaveBeenCalled();
          expect(inspect).not.toHaveBeenCalled();
        }
        expect(failure).toMatchObject(
          readable
            ? { code: 'client_turn_input_conflict' }
            : { message: 'The requested conversation is unavailable.' },
        );
        expect(f.engines.claude.starts).toHaveLength(beforeStarts);
        expect(f.engines.claude.turns).toEqual([]);
        expect(f.store.conversationSessions(root)).toHaveLength(3);
      } finally {
        staging.dispose();
      }
    },
  );

  test('#3567: continuation captures caller intent before its session authorization read', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await f.adopt(f.attached('claude', f.project));
    const { continueExecutionTargetMessage } = await import(
      '../../../tools/station-control-delegation.js'
    );
    const original = {
      conversationId: child,
      message: ' A ',
      clientTurnId: 'retained-K',
      userId: 'operator',
      readAuthority: sessionReadAuthorityFromRequest(
        'operator',
        undefined,
        undefined,
      ),
    };
    let entered!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const read = f.service.readSession.bind(f.service);
    const spy = vi
      .spyOn(f.service, 'readSession')
      .mockImplementationOnce(async (...args) => {
        entered();
        await held;
        return read(...args);
      });
    const pending = continueExecutionTargetMessage(original, f.service);
    await reached;
    original.message = 'B';
    release();
    const first = await pending;
    spy.mockRestore();
    expect(f.engines.claude.turns).toEqual([{ threadId: child, input: 'A' }]);
    expect(
      (
        await continueExecutionTargetMessage(
          { ...original, message: ' A ' },
          f.service,
        )
      ).providerTurnId,
    ).toBe(first.providerTurnId);
    await expect(
      continueExecutionTargetMessage(original, f.service),
    ).rejects.toMatchObject({ code: 'client_turn_input_conflict' });
    expect(f.engines.claude.turns).toHaveLength(1);
  });

  test.each(['chat', 'chat/background', 'continue'])(
    '#3567: the production %s executor preserves raw submission identity through auth and dispatch',
    async (route) => {
      const f = await fixture({ engineAgent: true });
      const child = await f.adopt(f.attached('claude', f.project));
      const path =
        route === 'continue'
          ? `/api/orchestration/chat/${encodeURIComponent(child)}/continue`
          : `/api/orchestration/${route}`;
      const body = (message: string) => ({
        ...(route === 'continue'
          ? {}
          : dockFollowUp('claude', child, 'station', message)),
        message,
        clientTurnId: 'key-3567',
      });
      const first = await f.request(path, body(' A '));
      expect(first.status, first.text).toBe(200);
      const changed = await f.request(path, body('A'));
      expect(changed.status, changed.text).toBe(409);
      expect(changed.body).toMatchObject({
        success: false,
        code: 'client_turn_input_conflict',
      });
      expect(f.engines.claude.turns).toHaveLength(1);
      const replay = await f.request(path, body(' A '));
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body.data.providerTurnId).toBe(
        first.body.data.providerTurnId,
      );
      expect(f.engines.claude.turns).toHaveLength(1);
    },
  );

  test('a project-only follow-up that names another project is refused', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await f.adopt(f.attached('claude', f.folder));
    const followUp = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', child, 'other', 'elsewhere'),
    );
    expect(followUp.status).not.toBe(200);
    expect(followUp.body).toMatchObject({
      code: 'continuation_workspace_different_project',
    });
    expect(f.engines.claude.turns).toEqual([]);
  });

  test('a follow-up after the folder was swapped for a link is refused', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await f.adopt(f.attached('claude', f.folder));
    // The recorded folder now leads somewhere else: the real folder moved
    // aside and a link took its name.
    renameSync(f.folder, `${f.folder}-moved`);
    symlinkSync(`${f.folder}-moved`, f.folder);
    const followUp = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', child, 'station', 'still there?'),
    );
    expect(followUp.status).not.toBe(200);
    expect(followUp.body).toMatchObject({
      code: 'continuation_workspace_direct_mismatch',
    });
    expect(f.engines.claude.turns).toEqual([]);
  });

  test.each([['worktree'], ['folder inside the project']] as const)(
    'a stopped %s child resumes in its own folder on the next dock follow-up',
    async (kind) => {
      const f = await fixture({ engineAgent: true });
      const cwd = kind === 'worktree' ? f.worktree : f.folder;
      const child = await f.adopt(f.attached('claude', cwd));
      const stopped = await f.request('/api/orchestration/commands', {
        type: 'stopSession',
        threadId: child,
      });
      expect(stopped.status, stopped.text).toBe(200);
      const followUp = await f.request(
        '/api/orchestration/chat',
        dockFollowUp('claude', child, 'station', 'pick it up'),
      );
      expect(followUp.status, followUp.text).toBe(200);
      // The same session's engine was started again, in the child's folder.
      expect(f.engines.claude.starts).toEqual([
        { threadId: child, cwd },
        { threadId: child, cwd },
      ]);
      expect(f.engines.claude.turns).toEqual([
        { threadId: child, input: 'pick it up' },
      ]);
    },
  );

  test.each([['worktree'], ['folder inside the project']] as const)(
    'a %s child whose engine exited continues in a successor in its own folder',
    async (kind) => {
      const f = await fixture({ engineAgent: true });
      const cwd = kind === 'worktree' ? f.worktree : f.folder;
      const child = await f.adopt(f.attached('claude', cwd));
      f.engines.claude.exit(child);
      await vi.waitFor(async () => {
        const read = await f.request(
          `/api/orchestration/sessions/${encodeURIComponent(child)}`,
        );
        expect(read.body.data.session.status).toBe('closed');
      });
      const followUp = await f.request(
        '/api/orchestration/chat',
        dockFollowUp('claude', child, 'station', 'pick it up'),
      );
      expect(followUp.status, followUp.text).toBe(200);
      const successor = f.engines.claude.starts.at(-1)!;
      expect(f.engines.claude.starts).toHaveLength(2);
      expect(successor.threadId).not.toBe(child);
      expect(successor.cwd).toBe(cwd);
      expect(f.engines.claude.turns).toEqual([
        { threadId: successor.threadId, input: 'pick it up' },
      ]);
    },
  );

  /** Adopt a worktree child, then let its engine exit so the next follow-up starts a successor. */
  async function exitedWorktreeChild(f: Awaited<ReturnType<typeof fixture>>) {
    const child = await f.adopt(f.attached('claude', f.worktree));
    f.engines.claude.exit(child);
    await vi.waitFor(async () => {
      const read = await f.request(
        `/api/orchestration/sessions/${encodeURIComponent(child)}`,
      );
      expect(read.body.data.session.status).toBe('closed');
    });
    return child;
  }

  test('a successor of a conversation adoption did not create is refused outside the project, even with the folder recorded', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await exitedWorktreeChild(f);
    // The same recorded start (the worktree as `dispatchCanonicalCwd`, the
    // project, the Agent binding), as a scoped dispatch records it, but the
    // conversation carries no adoption marker.
    const row = f.store.readSessionByThread(child)!;
    expect(row.continuationSourceThreadId).toBeDefined();
    f.store.upsertSession({ ...row, continuationSourceThreadId: undefined });
    expect(
      f.store.readSessionByThread(child)!.continuationSourceThreadId,
    ).toBeUndefined();
    const followUp = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', child, 'station', 'pick it up'),
    );
    expect(followUp.status).not.toBe(200);
    expect(followUp.text).toMatch(/outside project 'station'/);
    expect(f.engines.claude.starts).toHaveLength(1);
    expect(f.engines.claude.turns).toEqual([]);
  });

  test('a successor naming a project the worktree no longer belongs to is refused', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await exitedWorktreeChild(f);
    // `station` now names another repository; the worktree's repository is
    // configured as a different project. The conversation still names
    // `station`, which the worktree is not part of.
    f.setProjects([
      { slug: 'station', workingDirectory: f.otherProject },
      { slug: 'moved', workingDirectory: f.project },
    ]);
    const followUp = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', child, 'station', 'pick it up'),
    );
    expect(followUp.status).not.toBe(200);
    expect(followUp.text).toMatch(/outside project 'station'/);
    expect(f.engines.claude.starts).toHaveLength(1);
    expect(f.engines.claude.turns).toEqual([]);
  });

  test('a successor is refused once the worktree is no longer a checkout of the project', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await f.adopt(f.attached('claude', f.worktree));
    f.engines.claude.exit(child);
    await vi.waitFor(async () => {
      const read = await f.request(
        `/api/orchestration/sessions/${encodeURIComponent(child)}`,
      );
      expect(read.body.data.session.status).toBe('closed');
    });
    // The folder stays, but it no longer leads back to the project.
    rmSync(join(f.worktree, '.git'));
    const followUp = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', child, 'station', 'pick it up'),
    );
    expect(followUp.status).not.toBe(200);
    expect(followUp.text).toMatch(/outside project 'station'/);
    expect(f.engines.claude.starts).toHaveLength(1);
    expect(f.engines.claude.turns).toEqual([]);
  });

  test('a follow-up that names another folder of the project is still refused', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await f.adopt(f.attached('claude', f.folder));
    const followUp = await f.request('/api/orchestration/chat', {
      target: {
        agent: 'claude',
        workspace: { kind: 'project', projectSlug: 'station', cwd: f.project },
      },
      message: 'move',
      conversationId: child,
    });
    expect(followUp.status).not.toBe(200);
    expect(followUp.text).toMatch(/different workspace directory/);
    expect(f.engines.claude.turns).toEqual([]);
  });

  // #3429: the "Continue here?" dialog said Station was not responding when
  // the engine simply was not set up. The refusal is certain and says why.
  test('an engine that is not ready is refused with its reason, and nothing is created', async () => {
    const f = await fixture({ engineAgent: true });
    f.engines.claude.prerequisites = [
      {
        id: 'claude-login',
        name: 'Claude login',
        description: 'Sign in to Claude Code.',
        status: 'missing',
        category: 'required',
      },
    ];
    const source = f.attached('claude');
    const refused = await f.request('/api/orchestration/commands', {
      type: 'adoptSession',
      sourceThreadId: source,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      success: false,
      code: 'continuation_engine_not_ready',
      retryable: true,
    });
    expect(refused.body.error).toBe(
      "Claude Code isn't ready, so no continuation was created (claude prerequisites missing: Claude login). Set up Claude Code, then try again.",
    );
    expect(f.engines.claude.adoptions).toEqual([]);

    // Starter Work's continue-session owner (what the dialog launches) reads
    // that as a certain failure with Station's reason, safe to retry.
    const owner = createStarterSessionOwner(f.service as never);
    await expect(
      owner.continue({
        sourceSessionId: source,
        operationId: '5e3c8b9e-3f7a-4c1e-9d2b-7a6f0e4d1c22',
        fullAccessGrant: null,
        owner: { ownerUserId: 'operator' },
      }),
    ).resolves.toEqual({
      state: 'failed',
      reason: refused.body.error,
      retrySafe: true,
    });

    // Once the engine is set up, the same conversation continues.
    f.engines.claude.prerequisites = [];
    await f.adopt(source);
    expect(f.engines.claude.adoptions).toHaveLength(1);
  });

  test('a follow-up as a different Agent is refused by the binding', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await f.adopt(f.attached('claude'));
    const followUp = await f.request('/api/orchestration/chat', {
      target: { environment: { kind: 'current' }, agent: 'codex' },
      message: 'switch',
      conversationId: child,
    });
    expect(followUp.status).not.toBe(200);
    expect(followUp.text).toMatch(
      /different Environment, Agent, or Station user/,
    );
    expect(f.engines.claude.turns).toEqual([]);
    expect(f.engines.codex.turns).toEqual([]);
  });

  test('with no Agent for the engine, the continuation is still created, has no Agent, and the dock cannot open it', async () => {
    const f = await fixture({ engineAgent: false });
    const child = await f.adopt(f.attached('claude'));

    // Nothing was written to the Agent store.
    expect(await f.loader.listAgents()).toEqual([]);
    const [adoption] = f.engines.claude.adoptions;
    expect(adoption!.metadata).not.toHaveProperty('agentSlug');
    expect(adoption!.metadata).not.toHaveProperty('environmentId');
    expect(adoption!.metadata).toMatchObject({ stationConfinement: 'host' });

    // What the dock reads to say why (`ImportedConversationPane`).
    const summary = await f.request(
      `/api/orchestration/sessions/${encodeURIComponent(child)}`,
    );
    expect(summary.status, summary.text).toBe(200);
    expect(summary.body.data.session.threadId).toBe(child);
    expect(summary.body.data.session).not.toHaveProperty('assignedAgentSlug');
    const opened = await f.request(
      `/api/conversations/${encodeURIComponent(child)}/open`,
    );
    expect(opened.status).toBe(404);
  });
});

describe('#4074: attached repository selection preserves existing Sessions', () => {
  async function started() {
    const f = await fixture({ engineAgent: true, boundResources: true });
    const response = await f.request('/api/orchestration/chat', {
      ...dockFollowUp('claude', undefined, 'station', 'first turn'),
      clientTurnId: 'first-turn',
    });
    expect(response.status, response.text).toBe(200);
    const conversation = response.body.data.conversationId as string;
    await vi.waitFor(() =>
      expect(f.store.readSessionByThread(conversation)?.cwd).toBe(f.project),
    );
    await f.selectSecond();
    return { f, conversation, first: response.body.data };
  }

  test('old Session and cold successor execute in the original repository; a new Session executes in the selected repository', async () => {
    const { f, conversation, first } = await started();
    const firstRetry = await f.request('/api/orchestration/chat', {
      ...dockFollowUp('claude', conversation, 'station', 'first turn'),
      clientTurnId: 'first-turn',
    });
    expect(firstRetry.status, firstRetry.text).toBe(200);
    expect(firstRetry.body.data).toMatchObject({
      sessionId: first.sessionId,
      providerTurnId: first.providerTurnId,
      resolution: { workspace: first.resolution.workspace },
    });
    expect(first.resolution.workspace).toEqual({
      kind: 'project',
      projectSlug: 'station',
      cwd: f.project,
      workspaceIsolation: { mode: 'shared' },
    });
    const follow = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', conversation, 'station', 'old follow-up'),
    );
    expect(follow.status, follow.text).toBe(200);
    expect(follow.body.data.resolution.workspace).toEqual(
      first.resolution.workspace,
    );
    for (const workspace of [
      { kind: 'directory', cwd: f.otherProject },
      { kind: 'project', projectSlug: 'other' },
      { kind: 'project', projectSlug: 'station', cwd: f.ownFolder },
    ]) {
      const refused = await f.request('/api/orchestration/chat', {
        ...dockFollowUp(
          'claude',
          conversation,
          'station',
          'private wrong workspace',
        ),
        target: {
          environment: { kind: 'current' },
          agent: 'claude',
          workspace,
        },
      });
      expect(refused.status, refused.text).toBe(400);
    }
    const oldExecution = follow.body.data.sessionId as string;
    expect(
      f.engines.claude.starts.find((start) => start.threadId === oldExecution)
        ?.cwd,
    ).toBe(f.project);
    f.engines.claude.exit(oldExecution);
    await vi.waitFor(() =>
      expect(f.store.readSessionByThread(oldExecution)?.status).toBe('closed'),
    );
    const cold = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', conversation, undefined, 'cold follow-up'),
    );
    expect(cold.status, cold.text).toBe(200);
    expect(cold.body.data.resolution.workspace).toEqual(
      first.resolution.workspace,
    );
    expect(
      f.engines.claude.starts.find(
        (start) => start.threadId === cold.body.data.sessionId,
      )?.cwd,
    ).toBe(f.project);
    const fresh = await f.request(
      '/api/orchestration/chat',
      dockFollowUp('claude', undefined, 'station', 'new conversation'),
    );
    expect(fresh.status, fresh.text).toBe(200);
    expect(fresh.body.data.resolution.workspace).toEqual({
      kind: 'project',
      projectSlug: 'station',
      cwd: f.otherProject,
      workspaceIsolation: { mode: 'shared' },
    });
    expect(
      f.engines.claude.starts.find(
        (start) => start.threadId === fresh.body.data.sessionId,
      )?.cwd,
    ).toBe(f.otherProject);
    expect(f.engines.claude.turns.map((turn) => turn.input)).toEqual([
      'first turn',
      'old follow-up',
      expect.stringContaining('cold follow-up'),
      'new conversation',
    ]);
    expect(f.engines.claude.turnWorkingDirectories).toEqual([
      f.project,
      f.project,
      f.project,
      f.otherProject,
    ]);
    expect(f.store.readSessionByThread(conversation)?.cwd).toBe(f.project);
  });

  test('a Session whose start refused Project identity cannot acquire it on continuation', async () => {
    const f = await fixture({
      engineAgent: true,
      boundResources: true,
      unqualifiedProject: true,
    });
    const conversation = `conversation:${randomUUID()}`;
    const environmentId = (await f.security.readExistingRecord()).environmentId;
    await f.service.dispatch({
      type: 'startSession',
      input: {
        threadId: conversation,
        provider: 'claude',
        cwd: f.project,
        metadata: {
          projectSlug: 'station',
          userId: 'operator',
          agentSlug: 'claude',
          targetKind: 'agent',
          targetId: 'claude',
          connectionId: 'claude',
          environmentId,
          workspaceIsolation: { mode: 'shared' },
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        f.service.firstStartedMetadataOfThread(conversation)
          ?.localProjectIdRefused,
      ).toBe(true),
    );
    expect(
      f.service.firstStartedMetadataOfThread(conversation),
    ).not.toHaveProperty('localProjectId');
    await f.selectSecond();
    for (const projectSlug of ['station', undefined]) {
      const refused = await f.request(
        '/api/orchestration/chat',
        dockFollowUp(
          'claude',
          conversation,
          projectSlug,
          'private unqualified follow-up',
        ),
      );
      expect(refused.status, refused.text).toBe(400);
    }
    expect(f.engines.claude.turns).toEqual([]);
    expect(JSON.stringify(f.store.listEvents())).not.toContain(
      'private unqualified follow-up',
    );
  });

  test.each([
    'revoked',
    'unbound',
    'drifted',
    'symlink',
    'changed Project',
  ] as const)(
    '%s refuses before publishing private follow-up text',
    async (change) => {
      const { f, conversation } = await started();
      const record = f.manifests.readRecord('station')!;
      if (change === 'revoked')
        await f.storage.projectRevision('station').replaceManifest!(record, {
          ...record,
          repos: record.repos
            .filter((repo) => repo.id !== f.firstRepo)
            .map((repo) => ({ ...repo, role: 'primary' as const })),
        });
      if (change === 'unbound') {
        await f.storage.projectRevision('station').replace({
          ...f.storage.getProject('station'),
          workingDirectory: undefined,
        });
        const current = f.bindings.read();
        writeFileSync(
          f.bindings.path,
          JSON.stringify({
            ...current,
            bindings: current.bindings.filter(
              (binding) => binding.resourceId !== f.firstRepo,
            ),
          }),
        );
      }
      if (change === 'drifted')
        git(
          f.project,
          'remote',
          'set-url',
          'origin',
          'https://github.com/example/unknown.git',
        );
      if (change === 'symlink') {
        renameSync(f.project, `${f.project}-original`);
        symlinkSync(f.otherProject, f.project, 'dir');
      }
      if (change === 'changed Project') {
        const original = f.storage.getProject('station');
        await f.storage.deleteProject('station');
        await f.storage.createProjectWithIdentity(
          { ...original, id: randomUUID() },
          record,
        );
      }
      const starts = f.engines.claude.starts.length;
      for (const projectSlug of ['station', undefined]) {
        const refused = await f.request(
          '/api/orchestration/chat',
          dockFollowUp(
            'claude',
            conversation,
            projectSlug,
            'private denied follow-up',
          ),
        );
        expect(refused.status, refused.text).toBe(400);
      }
      expect(f.engines.claude.starts).toHaveLength(starts);
      expect(f.engines.claude.turns.map((turn) => turn.input)).toEqual([
        'first turn',
      ]);
      expect(JSON.stringify(f.store.listEvents())).not.toContain(
        'private denied follow-up',
      );
    },
  );
});
