import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  agentId,
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { saveAgentConfig } from '../../../domain/config-loader-agents.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { PLUGIN_AGENT_OWNER_FILE } from '../../../domain/plugin-agent-ownership.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import type { ForegroundInvocationAdmission } from '../../orchestration/foreground-invocation-admission.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../orchestration/session-agent-resolution.js';
import { withPluginContentLock } from '../plugin-content-integrity.js';
import { createWorkspacePaneHostAdmission } from '../workspace-pane-host-admission.js';

const pluginId = 'admission-proof';
const slug = agentId('admission-assistant');
const projectSlug = 'project-a';
const spec: AgentSpec = {
  name: 'Captured Assistant',
  prompt: 'The exact authored Agent instructions.',
  execution: { agentConnectionId: engineConnectionId('claude') },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForEntry(signal: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    signal,
    pending.then(() => {
      throw new Error(
        'Invocation settled before reaching the controlled boundary',
      );
    }),
  ]);
}

describe('Workspace Pane host invocation admission', () => {
  let home: string;
  let pluginDir: string;
  let storage: FileStorageAdapter;
  let store: EventStore;
  let service: OrchestrationService;
  let authority: ReturnType<typeof createWorkspacePaneHostAdmission>;
  let adapter: ProviderAdapterShape;
  let start: ReturnType<
    typeof vi.fn<(input: ProviderSessionStartInput) => Promise<ProviderSession>>
  >;
  let send: ReturnType<
    typeof vi.fn<
      (
        input: ProviderSendTurnInput,
      ) => Promise<{ threadId: string; turnId: string }>
    >
  >;
  let beforeReady: (() => Promise<void>) | undefined;
  let beforeTurn: (() => Promise<void>) | undefined;
  let counter = 0;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'station-pane-admission-'));
    pluginDir = join(home, 'plugins', pluginId);
    const agentDir = join(home, 'agents', slug);
    mkdirSync(join(pluginDir, 'agents', slug), { recursive: true });
    mkdirSync(join(pluginDir, 'prompts'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(spec));
    writeFileSync(
      join(pluginDir, 'agents', slug, 'agent.json'),
      JSON.stringify(spec),
    );
    writeFileSync(
      join(agentDir, PLUGIN_AGENT_OWNER_FILE),
      JSON.stringify({ plugin: pluginId }),
    );
    writeFileSync(
      join(pluginDir, 'prompts', 'registered.md'),
      '---\nid: registered\nlabel: Registered label is not the body\n---\nExact registered body.',
    );
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: pluginId,
        version: '1.0.0',
        agents: [{ slug, source: `./agents/${slug}/agent.json` }],
        prompts: { source: './prompts' },
        workspacePaneHost: {
          version: WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
          agentSelection: {
            availableAgents: [{ kind: 'own-plugin-agent', agentId: slug }],
            defaultAgent: { kind: 'own-plugin-agent', agentId: slug },
          },
          actions: [
            {
              id: 'literal',
              label: 'Different literal label',
              presentation: 'action',
              intent: { kind: 'prompt', prompt: `${pluginId}:registered` },
            },
            {
              id: 'registered',
              label: 'Different registered label',
              presentation: 'action',
              intent: { kind: 'plugin-prompt', promptId: 'registered' },
            },
          ],
        },
      }),
    );
    storage = new FileStorageAdapter(home);
    await storage.createProject({
      id: 'project-id-a',
      slug: projectSlug,
      name: 'Project A',
      agents: [slug],
      workingDirectory: home,
      createdAt: '2026-09-04T00:00:00Z',
      updatedAt: '2026-09-04T00:00:00Z',
    });
    authority = createWorkspacePaneHostAdmission({
      projectHomeDir: home,
      projects: storage,
    });
    store = new EventStore(join(home, 'orchestration.sqlite'));
    const sessions = new Map<string, ProviderSession>();
    const events = new AsyncEventQueue<CanonicalRuntimeEvent>();
    start = vi.fn(async (input) => {
      const now = new Date().toISOString();
      events.push({
        eventId: `${input.threadId}:started`,
        provider: 'claude',
        threadId: input.threadId,
        method: 'session.started',
        sessionId: input.threadId,
        createdAt: now,
        metadata: input.metadata,
      });
      const session: ProviderSession = {
        provider: 'claude',
        threadId: input.threadId,
        cwd: input.cwd,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    });
    send = vi.fn(async (input) => {
      const turnId = `turn-${++counter}`;
      events.push({
        eventId: `${turnId}:start`,
        provider: 'claude',
        threadId: input.threadId,
        turnId,
        method: 'turn.started',
        createdAt: new Date().toISOString(),
        prompt: input.displayInput ?? input.input,
      });
      return { threadId: input.threadId, turnId };
    });
    adapter = {
      provider: 'claude',
      metadata: {
        engineId: engineId('claude'),
        displayName: 'Controlled provider',
        description: 'No live account',
        builtin: true,
        capabilities: ['agent-runtime'],
        modelLaunch: {
          defaultAtStart: 'engine-selected',
          omissionAtResume: 'engine-selected',
          omissionPerTurn: 'engine-selected',
          overrideAtStart: false,
          overrideAtResume: false,
          overridePerTurn: false,
        },
      },
      startSession: start,
      sendTurn: send,
      stopSession: async (id) => {
        sessions.delete(id);
      },
      stopAll: async () => {
        sessions.clear();
      },
      hasSession: async (id) => sessions.has(id),
      listSessions: async () => [...sessions.values()],
      streamEvents: (options) => events.iterable(options),
      getPrerequisites: async () => {
        await beforeReady?.();
        return [];
      },
      interruptTurn: async () => ({ outcome: 'no-active-turn' }),
      steerTurn: async () => {},
      respondToRequest: async () => {},
    };
    service = new OrchestrationService({
      adapterRegistry: {
        register: () => {},
        get: (id) => (id === 'claude' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus: new EventBus(),
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async () => {
          throw new Error('Must consume captured Agent, not reread');
        },
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      loadAgentExecutionConfig: async () => {
        throw new Error('Must consume captured execution, not reread');
      },
      loadAgentPresentation: async () => {
        throw new Error('Must consume captured presentation, not reread');
      },
      listProjects: () => [{ slug: projectSlug, workingDirectory: home }],
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    beforeReady = undefined;
    beforeTurn = undefined;
  });

  afterEach(async () => {
    await service?.shutdown();
    store?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function dispatch(admission: ForegroundInvocationAdmission) {
    const threadId = `pane-thread-${++counter}`;
    const started = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          provider: 'claude',
          threadId,
          cwd: home,
          metadata: {
            agentSlug: admission.agentId,
            projectSlug: admission.project.slug,
            userId: 'owner',
          },
        },
      },
      { userId: 'owner' },
      { foregroundInvocationAdmission: admission },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    await beforeTurn?.();
    const turn = await service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: {
          threadId,
          input: admission.message,
          clientTurnId: `client-${threadId}`,
        },
      },
      { userId: 'owner' },
      { foregroundInvocationAdmission: admission },
    );
    return { threadId, started, turn };
  }

  async function prepare(actionId = 'literal') {
    return authority.prepare({ pluginId, projectSlug, actionId });
  }

  test.each([
    ['literal', `${pluginId}:registered`],
    ['registered', 'Exact registered body.'],
  ])(
    'dispatches %s exact body through real Session and turn owners',
    async (actionId, body) => {
      const result = await (await prepare(actionId)).run(dispatch);
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]![0]).toMatchObject({
        metadata: { agentSlug: slug, projectSlug },
        agent: { slug, systemPrompt: spec.prompt },
      });
      expect(send).toHaveBeenCalledOnce();
      expect(
        send.mock.calls[0]![0].displayInput ?? send.mock.calls[0]![0].input,
      ).toBe(body);
      expect(
        store.readCommandReceipt(result.started.receipt.commandId)?.status,
      ).toBe('accepted');
      expect(
        store.readCommandReceipt(result.turn.receipt.commandId)?.status,
      ).toBe('accepted');
      await expect
        .poll(async () =>
          (
            await service.readSession(
              result.threadId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.events.some(
            (event) => event.method === 'turn.started' && event.prompt === body,
          ),
        )
        .toBe(true);
    },
  );

  test('refuses changed Project policy after pending start resolution, before provider invocation', async () => {
    const entered = deferred();
    const release = deferred();
    beforeReady = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = (await prepare()).run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    await expect(pending).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses an Agent edit between preparation and actual start', async () => {
    const prepared = await prepare();
    await saveAgentConfig(home, slug, {
      ...spec,
      prompt: 'Changed instructions',
    });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  test('refuses policy loss after accepted Session start but before the first turn', async () => {
    beforeTurn = async () => {
      const revision = storage.projectRevision(projectSlug);
      await revision.replace({ ...revision.value, agents: [] });
    };
    await expect((await prepare()).run(dispatch)).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses a reentrant installed-body mutation between start and turn despite the outer content lease', async () => {
    beforeTurn = async () =>
      withPluginContentLock(join(home, 'plugins'), pluginId, async () => {
        writeFileSync(
          join(pluginDir, 'prompts', 'registered.md'),
          'New registered body',
        );
      });
    await expect((await prepare('registered')).run(dispatch)).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test('does not let consumers mutate captured Agent or Project inputs', async () => {
    await (await prepare()).run(async (admission) => {
      admission.agentSpec.prompt = 'Caller replacement';
      admission.project.agents = [];
      return dispatch(admission);
    });
    expect(start.mock.calls[0]![0].agent?.systemPrompt).toBe(spec.prompt);
  });

  test('Project revision admission does not trust the mutable value handed to its caller', async () => {
    const revision = storage.projectRevision(projectSlug);
    revision.value.agents = [];
    await revision.withCurrentRead!(async (current) => {
      expect(current.agents).toEqual([slug]);
    });
  });

  test('refuses changed installed body and a foreign Agent owner', async () => {
    const prepared = await prepare('registered');
    await withPluginContentLock(join(home, 'plugins'), pluginId, async () => {
      writeFileSync(
        join(pluginDir, 'prompts', 'registered.md'),
        'Replacement body',
      );
    });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    writeFileSync(
      join(home, 'agents', slug, PLUGIN_AGENT_OWNER_FILE),
      JSON.stringify({ plugin: 'another-plugin' }),
    );
    await expect(prepare()).rejects.toThrow();
  });

  test('retains an already-invoked turn when policy changes during provider settlement and never replays', async () => {
    const entered = deferred();
    const release = deferred();
    send.mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return {
        threadId: input.threadId,
        turnId: 'accepted-after-policy-change',
      };
    });
    const prepared = await prepare();
    const pending = prepared.run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    // Must not wait for provider settlement: the short Project/Agent guards
    // release once invocation begins, not when the remote Promise resolves.
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    const result = await pending;
    expect(result.turn.result).toMatchObject({
      turnId: 'accepted-after-policy-change',
    });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  test('retains unknown provider effect instead of relabeling policy change as cancellation', async () => {
    const entered = deferred();
    const release = deferred();
    send.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('Provider response lost after invocation');
    });
    const prepared = await prepare();
    const pending = prepared.run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    await expect(pending).rejects.toThrow();
    const threadId = send.mock.calls[0]![0].threadId;
    expect(
      store.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
    ).toEqual({ kind: 'available', active: true });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  test('rejects policy mutation during the final coordinated pre-invocation read', async () => {
    const entered = deferred();
    const release = deferred();
    const read = service.readSession.bind(service);
    let turnReads = 0;
    vi.spyOn(service, 'readSession').mockImplementation(async (...args) => {
      const result = await read(...args);
      if (++turnReads === 2) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const pending = (await prepare()).run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    await expect(pending).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test('never mutates persisted declarations or substitutes first required/ambient Agents', async () => {
    const path = join(pluginDir, 'plugin.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.workspacePaneHost.agentSelection.defaultAgent;
    writeFileSync(path, JSON.stringify(manifest));
    await expect(prepare()).rejects.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(manifest);
    expect(start).not.toHaveBeenCalled();
  });
});
