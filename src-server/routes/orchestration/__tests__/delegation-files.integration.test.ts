import { closeSync, constants, openSync } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
} from '@kontourai/station-contracts/chat-attachment';
import type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseCoreArgs } from '../../../../packages/cli/src/commands/core-api.js';
import { runDelegateCommand } from '../../../../packages/cli/src/commands/delegate.js';
import { execFileSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  SendTurnRefusedError,
  SessionStartRefusedError,
} from '../../../providers/adapter-shape.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { createRemoteStationForwarder } from '../../../services/remote-stations/remote-station-forwarder.js';
import { delegateTask } from '../../../tools/station-control-delegation.js';
import { createAttachmentStagingRoutes } from '../attachment-staging.js';
import { createOrchestrationRoutes } from '../orchestration.js';

class DelegateAdapter extends GateTestAdapter {
  readonly sessions = new Map<string, ProviderSession>();
  override async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const session = { ...(await super.startSession(input)), cwd: input.cwd };
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: input.metadata,
    });
    return session;
  }
  override async hasSession(threadId?: string) {
    return threadId !== undefined && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
}

const makeTempDir = trackTempDirs();
const principal = {
  id: 'human:local:operator',
  kind: 'human' as const,
  display: 'Operator',
};
const exact = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
);

describe('CLI delegation files through staging, route and real orchestration', () => {
  let root: string;
  let workspace: string;
  let apiBase: string;
  let server: ReturnType<typeof serve>;
  let service: OrchestrationService;
  let store: EventStore;
  let staging: AttachmentStagingService;
  let adapter: DelegateAdapter;
  let actor = principal;
  let worktree = false;
  let posted: { attachmentRefs?: unknown[] };
  const turns: ProviderSendTurnInput[] = [];
  let dispatchDelegate: ReturnType<typeof vi.fn<typeof delegateTask>>;
  let remote: ReturnType<typeof createRemoteStationForwarder>;
  let remoteResolve: ReturnType<typeof vi.spyOn>;
  let remotePosts: ReturnType<typeof vi.fn<() => void>>;
  let continueTask: ReturnType<
    typeof vi.fn<() => Promise<{ taskId: string; status: string }>>
  >;
  let portableAdmission: ReturnType<typeof vi.fn<() => Promise<never>>>;

  beforeEach(async () => {
    root = await realpath(makeTempDir('delegate-files-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    staging = new AttachmentStagingService();
    actor = principal;
    worktree = false;
    turns.length = 0;
    adapter = new DelegateAdapter();
    vi.spyOn(adapter, 'sendTurn').mockImplementation(async (input) => {
      turns.push(input);
      return { threadId: input.threadId, turnId: 'fake-turn' };
    });
    store = new EventStore(join(root, 'events.sqlite'));
    const bus = new EventBus();
    service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: bus,
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) =>
          slug === 'reviewer'
            ? { name: 'Reviewer', prompt: 'Read the attached files.' }
            : null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    remote = createRemoteStationForwarder({
      ssh: {
        list: () => [],
        connect: async () => {
          throw new Error('Unexpected SSH connection');
        },
      },
      peers: {
        get: (id) =>
          id === 'other-host'
            ? {
                environmentId: id,
                apiBase: `${apiBase}/receiver`,
                credential: 'fixture-peer',
                label: 'Receiver',
                scope: 'orchestration:read orchestration:operate',
                createdAt: 0,
                updatedAt: 0,
              }
            : null,
      },
    });
    remoteResolve = vi.spyOn(remote, 'resolve');
    dispatchDelegate = vi.fn((input: Parameters<typeof delegateTask>[0]) =>
      delegateTask(input, service, remote),
    );
    continueTask = vi.fn(async () => ({
      taskId: 'continued',
      status: 'dispatched',
    }));
    portableAdmission = vi.fn(async () => {
      throw new Error('Unexpected portable admission');
    });
    remotePosts = vi.fn();
    const app = new Hono();
    app.get('/receiver/.well-known/station/v1', (c) =>
      c.json({ environmentId: 'other-host' }),
    );
    app.post('/receiver/api/orchestration/delegations', (c) => {
      remotePosts();
      return c.json({
        success: true,
        data: {
          taskId: 'remote-task',
          conversationId: 'remote-task',
          sessionId: 'remote-task',
          currentSessionId: 'remote-task',
          status: 'dispatched',
          environment: { id: 'other-host', name: 'Receiver', kind: 'peer' },
          target: { kind: 'agent', id: 'reviewer' },
        },
      });
    });
    app.get('/.well-known/station/v1', (c) =>
      c.json({ environmentId: 'delegate-file-host' }),
    );
    app.get('/api/agents/reviewer', (c) =>
      c.json({
        success: true,
        data: {
          slug: 'reviewer',
          name: 'Reviewer',
          available: true,
          execution: { agentConnectionId: 'claude' },
        },
      }),
    );
    app.get('/api/projects/workspace', (c) =>
      c.json({
        success: true,
        data: {
          workingDirectory: workspace,
          ...(worktree ? { defaultWorkspaceIsolation: 'worktree' } : {}),
        },
      }),
    );
    app.get('/api/connections/claude', (c) =>
      c.json({
        success: true,
        data: {
          id: 'claude',
          kind: 'agent',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          config: { provider: 'claude' },
        },
      }),
    );
    app.route(
      '/api/orchestration/attachment-staging',
      createAttachmentStagingRoutes({
        service: staging,
        currentOwner: () => ({ principalId: actor.id }),
      }),
    );
    app.use('/api/orchestration/delegations', async (c, next) => {
      posted = (await c.req.raw.clone().json()) as {
        attachmentRefs?: unknown[];
      };
      await next();
    });
    app.route(
      '/api/orchestration',
      createOrchestrationRoutes(service, {
        eventBus: bus,
        logger: { debug: vi.fn() },
        resolvePrincipal: () => actor,
        delegateTask: dispatchDelegate,
        continueDelegatedTask: continueTask,
        respondToDelegatedTaskRequest: vi.fn(async () => ({})),
        interruptDelegatedTask: vi.fn(async () => {
          throw new Error('Unexpected task interruption');
        }),
        discoverDelegationOptions: vi.fn(async () => ({})),
        authorizeReceiverExecution: portableAdmission,
        hydrateStagedAttachments: (owner, refs, binding) =>
          staging.bindAndHydrate({ principalId: owner.id }, refs, binding),
        acceptStagedAttachments: (owner, refs, binding) =>
          staging.acceptBinding({ principalId: owner.id }, refs, binding),
        releaseStagedAttachments: (owner, refs, binding) =>
          staging.releaseBinding({ principalId: owner.id }, refs, binding),
      }),
    );
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    if (!server.listening)
      await new Promise<void>((resolve) => server.once('listening', resolve));
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv('STATION_API_BASE', apiBase);
    vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'delegate-file-test');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await service?.shutdown();
    store?.close();
    staging?.dispose();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const run = (paths: string[], extra: string[] = []) =>
    runDelegateCommand(
      apiBase,
      parseCoreArgs([
        '--agent=reviewer',
        '--project=workspace',
        '--json',
        ...paths.map((path) => `--attach=${path}`),
        ...extra,
        'Read the attached exact values.',
      ]),
    );

  // Windows has no POSIX mkfifo; symlink privileges are also platform-dependent.
  test.skipIf(process.platform === 'win32').each(['fifo', 'symlink'] as const)(
    'the CLI promptly refuses %s input pointing to a FIFO with a coded invalid-data error',
    async (kind) => {
      const fifo = join(root, 'input.fifo');
      execFileSyncBounded('mkfifo', [fifo], {
        windowsHide: true,
        timeout: 2000,
      });
      const path = kind === 'fifo' ? fifo : join(root, 'link.txt');
      if (kind === 'symlink') await symlink(fifo, path);
      const prepare = vi.spyOn(staging, 'prepare');
      const pending = run([path]).then(
        () => ({ code: 'unexpected_success' }),
        (error: unknown) => error,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = { code: 'refusal_deadline_exceeded' };
      let observed: unknown;
      try {
        observed = await Promise.race([
          pending,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(deadline), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (observed === deadline) {
          // Unblock a regressed open so the assertion fails without stranding a worker.
          const writer = openSync(
            fifo,
            constants.O_RDWR | constants.O_NONBLOCK,
          );
          try {
            await pending;
          } finally {
            closeSync(writer);
          }
        }
      }
      expect(observed).toMatchObject({ code: 'delegation_files_invalid_data' });
      expect(prepare).not.toHaveBeenCalled();
      expect(dispatchDelegate).not.toHaveBeenCalled();
    },
    5000,
  );

  test.each(['project-portable', 'project-portable-prepared'] as const)(
    'the executor directly refuses staged files for %s before writing',
    async (kind) => {
      const ref = stage();
      const owner = { principalId: principal.id };
      const stagedFiles = {
        resolve: vi.fn((binding: { threadId: string; clientTurnId: string }) =>
          staging.bindAndHydrate(owner, [ref], binding),
        ),
        accept: vi.fn(),
        release: vi.fn(),
      };
      await expect(
        delegateTask(
          {
            prompt: 'Read the attached values',
            target: {
              environment: { kind: 'current' },
              agent: agentId('reviewer'),
              workspace:
                kind === 'project-portable'
                  ? {
                      kind,
                      portableProjectId: 'portable-project',
                      resourceId: 'git:repo',
                    }
                  : {
                      kind,
                      portableProjectId: 'portable-project',
                      resourceId: 'git:repo',
                      preparation: {
                        protocol: 'station.execution-preparation/v1',
                        mode: 'existing-realization',
                        version: {
                          scheme: 'git-commit',
                          value: 'a'.repeat(40),
                        },
                        guarantees: ['version-matched-when-checked'],
                      },
                    },
            },
            stagedFiles,
            authorizeReceiverExecution: portableAdmission,
          },
          service,
          remote,
        ),
      ).rejects.toMatchObject({ code: 'delegation_files_unsupported' });
      expect(stagedFiles.resolve).not.toHaveBeenCalled();
      expect(stagedFiles.accept).not.toHaveBeenCalled();
      expect(stagedFiles.release).not.toHaveBeenCalled();
      expect(portableAdmission).not.toHaveBeenCalled();
      expect(adapter.sessions.size).toBe(0);
      expect(turns).toHaveLength(0);
      expect(await readdir(workspace)).toEqual([]);
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith('.station-delegate-'),
        ),
      ).toEqual([]);
    },
  );

  test('places a 64-character hex file byte for byte in the delegate workspace under its own name', async () => {
    const path = join(root, 'revision.txt');
    const other = join(root, 'other.txt');
    await writeFile(path, exact);
    await writeFile(other, Buffer.from([0, 13, 10, 255]));
    await writeFile(join(workspace, 'revision.txt'), 'existing project file');
    await run([path, other]);
    expect(turns).toHaveLength(1);
    const directories = (await readdir(workspace)).filter((name) =>
      name.startsWith('.station-delegate-'),
    );
    expect(directories).toHaveLength(1);
    const delivered = join(workspace, directories[0]);
    expect(await readFile(join(delivered, 'revision.txt'))).toEqual(exact);
    expect(await readFile(join(delivered, 'other.txt'))).toEqual(
      Buffer.from([0, 13, 10, 255]),
    );
    expect(await readFile(join(workspace, 'revision.txt'), 'utf8')).toBe(
      'existing project file',
    );
    expect(turns[0].input).toContain(
      JSON.stringify(join(delivered, 'revision.txt')),
    );
    expect(turns[0].input).not.toContain(exact.toString());
    expect(posted.attachmentRefs).toHaveLength(2);
    expect(JSON.stringify(posted)).not.toContain('dataUrl');
  });

  test('accepts the maximum count and refuses count max+1 without dispatch', async () => {
    const paths = await Promise.all(
      Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT + 1 }, async (_, i) => {
        const path = join(root, `value-${i}.txt`);
        await writeFile(path, exact);
        return path;
      }),
    );
    await expect(run(paths)).rejects.toThrow('at most 5');
    expect(turns).toHaveLength(0);
    await run(paths.slice(0, CHAT_ATTACHMENT_MAX_COUNT));
    expect(turns).toHaveLength(1);
    const directories = (await readdir(workspace)).filter((name) =>
      name.startsWith('.station-delegate-'),
    );
    expect(await readdir(join(workspace, directories[0]))).toHaveLength(
      CHAT_ATTACHMENT_MAX_COUNT,
    );
  });

  test('accepts a maximum-size file and refuses size max+1 without dispatch', async () => {
    const path = join(root, 'large.txt');
    await writeFile(path, Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES + 1, 97));
    await expect(run([path])).rejects.toThrow('byte limit');
    expect(turns).toHaveLength(0);
    await writeFile(path, Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES, 97));
    await run([path]);
    const directories = (await readdir(workspace)).filter((name) =>
      name.startsWith('.station-delegate-'),
    );
    expect(
      await readFile(join(workspace, directories[0], 'large.txt')),
    ).toEqual(Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES, 97));
  });

  test('refuses combined size max+1 without uploading or dispatching', async () => {
    const prepare = vi.spyOn(staging, 'prepare');
    const paths: string[] = [];
    for (let i = 0; i < 4; i++) {
      const path = join(root, `large-${i}.txt`);
      await writeFile(
        path,
        Buffer.alloc(i === 3 ? 1 : CHAT_ATTACHMENT_MAX_TOTAL_BYTES / 3, 97),
      );
      paths.push(path);
    }
    await expect(run(paths)).rejects.toThrow('combined limit');
    expect(prepare).not.toHaveBeenCalled();
    expect(turns).toHaveLength(0);
  });
  const stage = (name = 'revision.txt') => {
    const preparation = staging.prepare(
      { principalId: principal.id },
      {
        clientAttachmentId: crypto.randomUUID(),
        kind: 'file',
        name,
        mimeType: 'text/plain',
        size: exact.length,
      },
    );
    return staging.upload(
      preparation.stageId,
      preparation.uploadGrant,
      `data:text/plain;base64,${exact.toString('base64')}`,
    );
  };
  const post = (body: object) =>
    fetch(`${apiBase}/api/orchestration/delegations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Read the attached values',
        target: {
          environment: { kind: 'current' },
          agent: 'reviewer',
          workspace: { kind: 'project', projectSlug: 'workspace' },
        },
        ...body,
      }),
    });

  test.each([
    'owner',
    'portable',
    'portable-prepared',
    'case-duplicate',
    'duplicate',
    'portable-name',
    'worktree',
    'digest',
    'name',
    'missing',
    'replay',
    'count',
    'remote',
    'attempt',
    'inline',
  ] as const)(
    'refuses %s attachments at the server without a provider turn',
    async (fault) => {
      const ref = stage();
      const body: Record<string, unknown> = { attachmentRefs: [ref] };
      if (fault === 'duplicate') body.attachmentRefs = [ref, stage()];
      if (fault === 'case-duplicate')
        body.attachmentRefs = [stage('A.txt'), stage('a.txt')];
      if (fault === 'portable' || fault === 'portable-prepared')
        body.target = {
          environment: { kind: 'current' },
          agent: 'reviewer',
          workspace: {
            kind: 'project-portable',
            portableProjectId: 'portable-project',
            resourceId: 'git:repo',
            ...(fault === 'portable-prepared'
              ? {
                  kind: 'project-portable-prepared',
                  preparation: {
                    protocol: 'station.execution-preparation/v1',
                    mode: 'existing-realization',
                    version: { scheme: 'git-commit', value: 'a'.repeat(40) },
                    guarantees: ['version-matched-when-checked'],
                  },
                }
              : {}),
          },
        };
      if (fault === 'portable-name')
        body.attachmentRefs = [stage('value:hash.txt')];
      if (fault === 'worktree') worktree = true;
      if (fault === 'owner') actor = { ...principal, id: 'human:other' };
      if (fault === 'digest')
        body.attachmentRefs = [{ ...ref, digest: `sha256-${'0'.repeat(64)}` }];
      if (fault === 'name')
        body.attachmentRefs = [{ ...ref, name: '../outside.txt' }];
      if (fault === 'missing')
        body.attachmentRefs = [{ ...ref, stageId: 'stage_missing' }];
      if (fault === 'count')
        body.attachmentRefs = Array(CHAT_ATTACHMENT_MAX_COUNT + 1).fill(ref);
      if (fault === 'remote')
        body.target = {
          environment: { kind: 'saved', id: 'other-host' },
          agent: 'reviewer',
        };
      if (fault === 'attempt') body.attemptId = 'attempt-1';
      if (fault === 'inline') body.attachments = [];
      if (fault === 'replay') {
        const first = await post(body);
        expect(first.status).toBe(200);
        turns.length = 0;
      }
      const response = await post(body);
      expect(response.status).toBe(400);
      const codes: Record<typeof fault, string> = {
        owner: 'stage_forbidden',
        duplicate: 'delegation_files_duplicate_name',
        'case-duplicate': 'delegation_files_duplicate_name',
        'portable-name': 'delegation_files_invalid_name',
        worktree: 'delegation_files_unsupported',
        digest: 'stage_forbidden',
        name: 'stage_forbidden',
        missing: 'stage_not_found',
        replay: 'stage_incomplete',
        count: 'delegation_files_count',
        remote: 'delegation_files_unsupported',
        attempt: 'delegation_files_unsupported',
        inline: 'delegation_files_unsupported',
        portable: 'delegation_files_unsupported',
        'portable-prepared': 'delegation_files_unsupported',
      };
      const result = (await response.json()) as {
        code?: string;
        error?: string;
      };
      expect(result.code).toBe(codes[fault]);
      expect(result.error).not.toContain(workspace);
      expect(result.error).not.toContain('EEXIST');
      if (
        ['remote', 'count', 'portable', 'portable-prepared', 'inline'].includes(
          fault,
        )
      )
        expect(dispatchDelegate).not.toHaveBeenCalled();
      expect(remoteResolve).not.toHaveBeenCalled();
      expect(remotePosts).not.toHaveBeenCalled();
      expect(portableAdmission).not.toHaveBeenCalled();
      expect(turns).toHaveLength(0);
      if (fault !== 'replay') expect(await readdir(workspace)).toEqual([]);
    },
  );

  test('staging refuses a declared size max+1 before issuing upload authority', async () => {
    const response = await fetch(
      `${apiBase}/api/orchestration/attachment-staging/prepare`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientAttachmentId: 'large',
          kind: 'file',
          name: 'large.txt',
          mimeType: 'text/plain',
          size: CHAT_ATTACHMENT_MAX_BYTES + 1,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'stage_invalid_upload',
    });
    expect(turns).toHaveLength(0);
  });
  test.each([
    ['continue', { message: 'continue' }],
    ['respond', { requestId: 'request-1', decision: 'accept' }],
    ['interrupt', {}],
  ] as const)(
    'the %s route refuses refs rather than stripping them from a successful request',
    async (action, body) => {
      const response = await fetch(
        `${apiBase}/api/orchestration/delegations/task-1/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, attachmentRefs: [stage()] }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'delegation_files_unsupported',
      });
      expect(continueTask).not.toHaveBeenCalled();
    },
  );

  test('discovery refuses attached refs instead of accepting a stripped body', async () => {
    const response = await fetch(
      `${apiBase}/api/orchestration/delegations/options`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachmentRefs: [stage()] }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'delegation_files_unsupported',
    });
  });

  test.each([
    'duplicate',
    'materialization-failed',
    'start-refused',
    'turn-refused',
  ] as const)(
    'a %s pre-effect refusal releases refs for a successful resend and removes workspace files',
    async (failure) => {
      const reference = stage();
      const hydrate = vi.spyOn(staging, 'bindAndHydrate');
      if (failure === 'materialization-failed') {
        await rm(workspace, { recursive: true });
        await writeFile(workspace, 'not a directory');
      }
      const other = failure === 'duplicate' ? stage() : undefined;
      if (failure === 'start-refused')
        vi.spyOn(adapter, 'startSession').mockRejectedValueOnce(
          new SessionStartRefusedError(
            'Refused before start',
            'fixture_start_refused',
          ),
        );
      if (failure === 'turn-refused')
        vi.mocked(adapter.sendTurn).mockRejectedValueOnce(
          new SendTurnRefusedError('Refused before turn'),
        );
      const response = await post({
        attachmentRefs: other ? [reference, other] : [reference],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code:
          failure === 'materialization-failed'
            ? 'delegation_files_unavailable'
            : failure === 'duplicate'
              ? 'delegation_files_duplicate_name'
              : `delegation_files_${failure === 'start-refused' ? 'start' : 'turn'}_refused`,
      });
      expect(hydrate).toHaveBeenCalledTimes(1);
      if (failure === 'materialization-failed') {
        await rm(workspace);
        await mkdir(workspace);
      }
      expect(await readdir(workspace)).toEqual([]);
      expect(turns).toHaveLength(0);
      const retry = await post({ attachmentRefs: [reference] });
      expect(retry.status).toBe(200);
      expect(turns).toHaveLength(1);
      const [directory] = await readdir(workspace);
      expect(
        await readFile(join(workspace, directory, 'revision.txt')),
      ).toEqual(exact);
    },
  );

  test.each(['start', 'turn'] as const)(
    'an uncertain %s retains files and the staged binding',
    async (phase) => {
      const reference = stage();
      if (phase === 'start')
        vi.spyOn(adapter, 'startSession').mockRejectedValueOnce(
          new Error('Synthetic uncertain start'),
        );
      else
        vi.mocked(adapter.sendTurn).mockRejectedValueOnce(
          new Error('Synthetic uncertain turn'),
        );
      const response = await post({ attachmentRefs: [reference] });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'delegation_files_outcome_unknown',
      });
      const directories = await readdir(workspace);
      expect(directories).toHaveLength(1);
      expect(
        await readFile(join(workspace, directories[0], 'revision.txt')),
      ).toEqual(exact);
      const retry = await post({ attachmentRefs: [reference] });
      expect(retry.status).toBe(400);
      expect(await retry.json()).toMatchObject({ code: 'stage_forbidden' });
    },
  );

  test('the server refuses combined declared size max+1 before delegation or staged hydration', async () => {
    const reference = stage();
    const hydrate = vi.spyOn(staging, 'bindAndHydrate');
    const refs = [
      CHAT_ATTACHMENT_MAX_BYTES,
      CHAT_ATTACHMENT_MAX_BYTES,
      CHAT_ATTACHMENT_MAX_BYTES,
      1,
    ].map((size, i) => ({ ...reference, size, name: `large-${i}.txt` }));
    const response = await post({ attachmentRefs: refs });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'delegation_files_size',
    });
    expect(dispatchDelegate).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(turns).toHaveLength(0);
    expect(await readdir(workspace)).toEqual([]);
  });

  test('the CLI cancels successfully uploaded stages when dispatch is refused', async () => {
    const path = join(root, 'value.txt');
    await writeFile(path, exact);
    worktree = true;
    const cancel = vi.spyOn(staging, 'cancel');
    // Vitest turns process.exit into a thrown error; the CLI has already emitted its refusal.
    await expect(run([path])).rejects.toThrow('process.exit');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(
      staging.reconcile({ principalId: principal.id }, [
        cancel.mock.calls[0][1],
      ]),
    ).toMatchObject([{ state: 'cancelled' }]);
  });

  test('the CLI refuses case-insensitive duplicate basenames before preparing uploads', async () => {
    const left = join(root, 'left');
    const right = join(root, 'right');
    await mkdir(left);
    await mkdir(right);
    await writeFile(join(left, 'A.txt'), exact);
    await writeFile(join(right, 'a.txt'), exact);
    const prepare = vi.spyOn(staging, 'prepare');
    await expect(
      run([join(left, 'A.txt'), join(right, 'a.txt')]),
    ).rejects.toMatchObject({ code: 'delegation_files_duplicate_name' });
    expect(prepare).not.toHaveBeenCalled();
    expect(dispatchDelegate).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === 'win32')(
    'a CLI symlink to a regular file delivers target bytes under the link basename',
    async () => {
      const target = join(root, 'target.txt');
      const link = join(root, 'link.txt');
      await writeFile(target, exact);
      await symlink(target, link);
      await run([link]);
      const [directory] = await readdir(workspace);
      expect(await readdir(join(workspace, directory))).toEqual(['link.txt']);
      expect(await readFile(join(workspace, directory, 'link.txt'))).toEqual(
        exact,
      );
    },
  );
});
