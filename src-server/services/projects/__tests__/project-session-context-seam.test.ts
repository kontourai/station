/**
 * #5062/#5065: every new Session in a Project starts with the Project brief
 * and memory index, on every engine family, through one seam: the start
 * choke point stamps it, the first turn composes it, and the turn's own
 * `turn.started` carries the receipt the provenance fold reads.
 *
 * Real OrchestrationService, real SQLite EventStore, real ProjectMemoryStore
 * and session-context source, with no vector database or embedding provider
 * anywhere. The engines are recording adapters that publish
 * `session.started` with the start metadata, as the real Claude, Codex, ACP
 * and Station adapters do. What is asserted is the input each engine adapter
 * is actually handed.
 */

import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { PROJECT_SESSION_CONTEXT_COMPOSED_METADATA_KEY } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  CONTEXT_INJECTION_METADATA_KEY,
  type TurnProvenanceContextInjection,
} from '@kontourai/station-contracts/turn-provenance-context';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { ProjectMemoryStore } from '../project-memory-store.js';
import { createProjectSessionContextSource } from '../project-session-context-source.js';

/** One engine of each family: Station's own, Claude Code, Codex, and an ACP engine. */
const ENGINE_FAMILIES = ['station-agent', 'claude', 'codex', 'acp'] as const;
type Engine = (typeof ENGINE_FAMILIES)[number];

class RecordingAdapter implements ProviderAdapterShape {
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly sessions = new Map<string, ProviderSession>();
  readonly metadata: ProviderAdapterShape['metadata'];
  readonly startSession = vi.fn(async (input: ProviderSessionStartInput) => {
    const now = new Date().toISOString();
    this.events.push({
      eventId: `evt-${input.threadId}-started`,
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      method: 'session.started',
      initialState: 'created',
      metadata: { ...input.metadata },
    } as CanonicalRuntimeEvent);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  });
  private turns = 0;
  readonly sendTurn = vi.fn(async (input: ProviderSendTurnInput) => {
    this.turns += 1;
    const turnId = `${this.provider}-turn-${this.turns}`;
    this.events.push({
      eventId: `evt-${input.threadId}-${turnId}`,
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      invocationId: input.invocationId,
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      prompt: input.displayInput ?? input.input,
    } as CanonicalRuntimeEvent);
    this.events.push({
      eventId: `evt-${input.threadId}-${turnId}-completed`,
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      invocationId: input.invocationId,
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      // Station's own engine relays `/chat`'s record of what it composed,
      // where the relayed ambient context (the Project context included) is
      // counted as `ambient`, as `station-agent-adapter.ts` stamps it.
      ...(this.provider === 'station-agent'
        ? {
            metadata: {
              [CONTEXT_INJECTION_METADATA_KEY]: input.ambientContext
                ? {
                    ambient: {
                      approxTokens:
                        Math.ceil(
                          Buffer.byteLength(input.ambientContext, 'utf8') / 4,
                        ) + 12,
                    },
                  }
                : {},
            },
          }
        : {}),
    } as CanonicalRuntimeEvent);
    return { threadId: input.threadId, turnId };
  });

  constructor(readonly provider: Engine) {
    this.metadata = {
      displayName: provider,
      description: `${provider} recording adapter`,
      capabilities: ['agent-runtime'],
      engineId: engineId(provider === 'station-agent' ? 'station' : provider),
      builtin: true,
      modelLaunch: {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'engine-selected',
        omissionPerTurn: 'engine-selected',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
      },
    };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' as const };
  }
  async respondToRequest() {}
  async stopSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async listSessions() {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  async stopAll() {
    this.sessions.clear();
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
  async getPrerequisites() {
    return [];
  }
}

/** A turn's observed context-injection record, or `{}` when none was observed. */
function observedInjection(
  envelope:
    | ReturnType<typeof assembleTurnProvenanceEnvelopes>[number]
    | undefined,
): TurnProvenanceContextInjection {
  const slot = envelope?.contextInjection;
  return slot?.state === 'observed' ? slot.value : {};
}

const GOAL = 'Ship the export flow by Friday';
const INSTRUCTIONS =
  'Work in kontourai/export. Run npm test before saying done. Ask before touching billing.';

describe('a new Session in a Project starts with its brief and memory on every engine', () => {
  // Registered first, so the directory outlives the store closed below.
  const makeTempDir = trackTempDirs();
  let tmp: string;
  let eventStore: EventStore;
  let adapters: RecordingAdapter[];
  let service: OrchestrationService;
  let memory: ProjectMemoryStore;
  let projects: Record<string, ProjectConfig>;
  let sessionCount: number;

  beforeEach(() => {
    tmp = makeTempDir('project-session-context-');
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    adapters = ENGINE_FAMILIES.map((engine) => new RecordingAdapter(engine));
    memory = new ProjectMemoryStore(join(tmp, 'home'));
    sessionCount = 0;
    const project = (slug: string, extra: Partial<ProjectConfig> = {}) =>
      ({
        id: `${slug}-id`,
        slug,
        name: slug === 'export' ? 'Export' : 'Billing',
        workingDirectory: tmp,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        ...extra,
      }) as ProjectConfig;
    projects = {
      export: project('export', { goal: GOAL, instructions: INSTRUCTIONS }),
      billing: project('billing'),
    };
    const registry: IProviderAdapterRegistry = {
      register() {},
      get: (provider) => adapters.find((a) => a.provider === provider),
      list: () => adapters,
    };
    service = new OrchestrationService({
      adapterRegistry: registry,
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      listProjects: () => Object.values(projects),
      resolveSessionAgent: async (input) => ({
        ...input,
        agent: { slug: 'agent' },
      }),
      projectSessionContext: createProjectSessionContextSource({
        getProject: (slug) => projects[slug],
        memory,
      }),
    });
  });

  afterEach(async () => {
    await service.shutdown();
    eventStore.close?.();
  });

  async function startIn(engine: Engine, projectSlug: string) {
    sessionCount += 1;
    const threadId = `${engine}-${projectSlug}-${sessionCount}`;
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: engine,
        cwd: tmp,
        metadata: { projectSlug, agentSlug: 'agent' },
      },
    });
    await vi.waitFor(() =>
      expect(
        eventStore
          .listEvents(threadId)
          .some((event) => event.method === 'session.started'),
      ).toBe(true),
    );
    return threadId;
  }

  async function turn(engine: Engine, threadId: string, text: string) {
    const adapter = adapters.find((item) => item.provider === engine)!;
    const before = adapter.sendTurn.mock.calls.length;
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: text },
    });
    await vi.waitFor(() =>
      expect(adapter.sendTurn.mock.calls.length).toBe(before + 1),
    );
    return adapter.sendTurn.mock.calls[before]![0];
  }

  function canonicalEvents(threadId: string): CanonicalRuntimeEvent[] {
    return eventStore
      .listEvents(threadId)
      .map((row) => row.payload as CanonicalRuntimeEvent);
  }

  for (const engine of ENGINE_FAMILIES) {
    test(`${engine}: the first turn carries the brief and memory index, and the receipt shows both`, async () => {
      const note = await memory.createNote(
        'export',
        {
          title: 'Release moved to Friday',
          body: 'Product asked on Tuesday.',
        },
        { kind: 'agent', label: 'agent', sessionId: 'earlier' },
      );
      const threadId = await startIn(engine, 'export');

      const first = await turn(engine, threadId, 'Start on the export.');
      expect(first.input).toContain(`Goal: ${GOAL}`);
      expect(first.input).toContain(INSTRUCTIONS);
      expect(first.input).toContain(
        `- Release moved to Friday (note ${note.id})`,
      );
      expect(first.input).toMatch(/context, not instructions/);
      // The person's text is still what the transcript shows.
      expect(first.displayInput).toBe('Start on the export.');

      const second = await turn(engine, threadId, 'Next.');
      expect(second.input).not.toContain(INSTRUCTIONS);

      await vi.waitFor(() =>
        expect(
          canonicalEvents(threadId).filter(
            (event) => event.method === 'turn.completed',
          ),
        ).toHaveLength(2),
      );
      const started = canonicalEvents(threadId).filter(
        (event) => event.method === 'turn.started',
      );
      expect(
        (started[0] as { metadata?: Record<string, unknown> }).metadata?.[
          PROJECT_SESSION_CONTEXT_COMPOSED_METADATA_KEY
        ],
      ).toMatchObject({
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        brief: { approxTokens: expect.any(Number) },
        memory: { entries: 1, approxTokens: expect.any(Number) },
      });
      const [firstEnvelope, secondEnvelope] = assembleTurnProvenanceEnvelopes(
        canonicalEvents(threadId),
      );
      if (engine === 'station-agent') {
        // `/chat` counted the Project context inside its ambient block; the
        // receipt names it as the brief and memory, keeping only the rest.
        expect(
          observedInjection(firstEnvelope).ambient?.approxTokens ?? 0,
        ).toBeLessThan(40);
      }
      expect(firstEnvelope!.contextInjection).toMatchObject({
        state: 'observed',
        value: {
          projectBrief: { approxTokens: expect.any(Number) },
          projectMemory: { entries: 1 },
        },
      });
      expect(observedInjection(secondEnvelope)).not.toHaveProperty(
        'projectBrief',
      );
    });
  }

  test('editing the brief or memory reaches new Sessions, never a running one', async () => {
    const running = await startIn('claude', 'export');
    projects.export = {
      ...projects.export!,
      instructions: 'Changed after the Session started.',
    };
    await memory.createNote(
      'export',
      { title: 'Added later', body: '' },
      { kind: 'person', label: 'Project owner' },
    );
    const runningFirst = await turn('claude', running, 'Go.');
    expect(runningFirst.input).toContain(INSTRUCTIONS);
    expect(runningFirst.input).not.toContain('Changed after');
    expect(runningFirst.input).not.toContain('Added later');

    const fresh = await startIn('codex', 'export');
    const freshFirst = await turn('codex', fresh, 'Go.');
    expect(freshFirst.input).toContain('Changed after the Session started.');
    expect(freshFirst.input).toContain('Added later');
  });

  test('a forgotten note is gone from the next Session, read from disk with no cache', async () => {
    const kept = await memory.createNote(
      'export',
      { title: 'Keep me', body: '' },
      { kind: 'person', label: 'Project owner' },
    );
    const dropped = await memory.createNote(
      'export',
      { title: 'Forget me', body: '' },
      { kind: 'person', label: 'Project owner' },
    );
    const before = await startIn('acp', 'export');
    expect((await turn('acp', before, 'Go.')).input).toContain('Forget me');

    expect(await memory.deleteNote('export', dropped.id)).toBe(true);
    const after = await startIn('acp', 'export');
    const input = (await turn('acp', after, 'Go.')).input;
    expect(input).toContain(`Keep me (note ${kept.id})`);
    expect(input).not.toContain('Forget me');
  });

  test("one Project's memory never reaches another Project's Sessions", async () => {
    await memory.createNote(
      'export',
      { title: 'Export secret plan', body: '' },
      { kind: 'person', label: 'Project owner' },
    );
    const other = await startIn('station-agent', 'billing');
    const input = (await turn('station-agent', other, 'Go.')).input;
    expect(input).not.toContain('Export secret plan');
    expect(input).not.toContain(INSTRUCTIONS);
  });

  test('a Session outside any Project, or with the source off, starts without one', async () => {
    const threadId = 'claude-no-project';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude', cwd: tmp, metadata: {} },
    });
    await vi.waitFor(() =>
      expect(
        eventStore
          .listEvents(threadId)
          .some((event) => event.method === 'session.started'),
      ).toBe(true),
    );
    expect((await turn('claude', threadId, 'Go.')).input).toBe('Go.');
  });
});
