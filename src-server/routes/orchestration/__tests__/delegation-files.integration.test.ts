import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
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
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
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
    const app = new Hono();
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
        delegateTask: (input) => delegateTask(input, service),
        hydrateStagedAttachments: (owner, refs, binding) =>
          staging.bindAndHydrate({ principalId: owner.id }, refs, binding),
        acceptStagedAttachments: (owner, refs, binding) =>
          staging.acceptBinding({ principalId: owner.id }, refs, binding),
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
    expect(await response.json()).not.toHaveProperty('uploadGrant');
    expect(turns).toHaveLength(0);
  });
});
