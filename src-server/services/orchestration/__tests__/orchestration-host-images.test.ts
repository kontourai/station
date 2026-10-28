import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { CHAT_HOST_IMAGES_PREVIEW_ID } from '@kontourai/station-contracts/chat-host-images';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { createAttachmentRoutes } from '../../../routes/orchestration/attachments.js';
import {
  FeaturePreviewRegistry,
  type FeaturePreviewSelector,
} from '../../feature-previews/feature-preview-registry.js';
import { receiptBus } from '../../infra/receipt-bus.js';
import {
  commitEngineLaunch,
  engineSessionTmpDir,
  installSessionTmpDirPolicy,
  sessionTempRoot,
} from '../../infra/session-tmpdir.js';
import { workloadBudgetEngineContext } from '../../infra/workload-budget.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { hostImageAgentInstruction } from '../host-image-turn-capture.js';
import { OrchestrationService } from '../orchestration-service.js';

/**
 * chat-host-images through the real service and store: a settled reply's
 * host image becomes a blob bound to its own thread, the attachment route
 * serves it only to a reader of that thread, and with the preview off
 * nothing is read, stored or told to the agent.
 */

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'host-images', 'chromium.png'),
);

class FakeAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'codex Runtime',
    description: 'codex adapter for tests',
    capabilities: ['agent-runtime'],
    engineId: engineId('codex'),
    builtin: true,
  };
  readonly provider = 'codex' as const;
  readonly sessions = new Map<string, ProviderSession>();
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly turns: ProviderSendTurnInput[] = [];

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    // As every spawning adapter does at its session start: prepare, then
    // commit once the session is registered.
    const dir = engineSessionTmpDir(input.threadId);
    commitEngineLaunch(input.threadId, dir ? { own: dir } : undefined);
    const now = new Date().toISOString();
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
  }
  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.turns.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.turns.length}` };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }
  async stopAll(): Promise<void> {
    this.sessions.clear();
  }
  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
  async getPrerequisites() {
    return [];
  }
}

const registryOf = (
  adapter: ProviderAdapterShape,
): IProviderAdapterRegistry => ({
  register() {},
  get: (provider) => (provider === adapter.provider ? adapter : undefined),
  list: () => [adapter],
});

async function waitUntil<T>(
  read: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const makeTempDir = trackTempDirs();

describe('chat-host-images through OrchestrationService', () => {
  let base: string;
  let workspace: string;
  let store: EventStore;
  let service: OrchestrationService;
  let adapter: FakeAdapter;
  let previews: FeaturePreviewRegistry;
  let selector: FeaturePreviewSelector;

  beforeEach(() => {
    base = realpathSync(makeTempDir('orchestration-host-images-'));
    workspace = join(base, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'comparison.png'), FIXTURE);
    store = new EventStore(join(base, 'orchestration.sqlite'));
    previews = new FeaturePreviewRegistry(join(base, 'home'), {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as never);
    const hostImagesPreview = (selector = previews.bind({
      id: CHAT_HOST_IMAGES_PREVIEW_ID,
      label: 'Chat images from the host',
      description: 'test binding',
    }));
    adapter = new FakeAdapter();
    service = new OrchestrationService({
      adapterRegistry: registryOf(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
      hostImagesPreview,
    });
  });

  afterEach(async () => {
    await service.shutdown();
    store.close();
    receiptBus.resetForTest();
  });

  /** One turn whose reply names `markdown`, emitted the way an engine does. */
  async function replyTurn(
    threadId: string,
    markdown: string | (() => string),
    cwd: string = workspace,
  ): Promise<string> {
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'codex', cwd },
    });
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'show me' },
    });
    const turnId = `turn-${adapter.turns.length}`;
    const at = () => new Date().toISOString();
    const base = { provider: 'codex' as const, threadId, turnId };
    adapter.events.push({
      ...base,
      eventId: `${threadId}-start`,
      createdAt: at(),
      method: 'turn.started',
    });
    adapter.events.push({
      ...base,
      eventId: `${threadId}-delta`,
      createdAt: at(),
      method: 'content.text-delta',
      itemId: `${threadId}-item`,
      delta: typeof markdown === 'function' ? markdown() : markdown,
    });
    adapter.events.push({
      ...base,
      eventId: `${threadId}-done`,
      createdAt: at(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await waitUntil(() =>
      store.latestEventByMethod(threadId, 'turn.completed'),
    );
    await service['hostImages'].settled();
    return turnId;
  }

  test('preview on: the agent is told, the image is stored, bound and served to readers of that thread only', async () => {
    await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, true);
    const path = join(workspace, 'comparison.png');
    await replyTurn(
      'thread-a',
      `Before and after: ![sizing](${path}) and ![x](/etc/passwd.png)`,
    );
    // No temp root was launched (no TMPDIR policy here): only the folder.
    expect(adapter.turns[0].ambientContext).toContain(
      hostImageAgentInstruction({ workingDirectory: true, tmpdir: false }),
    );
    expect(adapter.turns[0].ambientContext).not.toContain('$TMPDIR');

    const stored = store.latestEventByMethod(
      'thread-a',
      'content.host-images',
    )?.payload;
    if (stored?.method !== 'content.host-images')
      throw new Error('no host images event');
    expect(stored.sources).toEqual([
      { path, attachmentIndex: 0 },
      { path: '/etc/passwd.png', refused: 'outside-allowed-roots' },
    ]);
    const ref = stored.attachments?.[0].blobRef;
    expect(ref).toMatch(/^sha256-[0-9a-f]{64}$/);
    // Persisted by reference, never by bytes.
    expect(stored.attachments?.[0].dataUrl).toBeUndefined();
    expect(store.listAttachmentThreads(ref!)).toEqual(['thread-a']);

    // Another session on the same Station, whose reader is someone else.
    await replyTurn('thread-b', 'no images here');
    const readable: Record<string, string[]> = {
      alice: ['thread-a'],
      bob: ['thread-b'],
    };
    const principalOf = (request: Request) =>
      request.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const app = new Hono().route(
      '/api/attachments',
      createAttachmentRoutes({
        readAttachment: (candidate) => store.readAttachmentBlob(candidate),
        threadsForAttachment: (candidate, request) =>
          store.listAttachmentCandidateThreads(candidate, principalOf(request)),
        canReadSession: (threadId, request) =>
          (readable[principalOf(request)] ?? []).includes(threadId),
      }),
    );
    const owner = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(owner.status).toBe(200);
    expect(Buffer.from(await owner.arrayBuffer()).equals(FIXTURE)).toBe(true);
    const stranger = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer bob' },
    });
    expect(stranger.status).toBe(404);

    // The durable projection hands the client the turn's map.
    const messages = projectRuntimeEventsToMessages(
      store.listEvents('thread-a').map((event) => event.payload),
    );
    const reply = messages.find((message) => message.role === 'assistant');
    expect(reply?.metadata?.hostImages).toEqual({
      images: {
        [path]: { blobRef: ref, mimeType: 'image/png', name: 'comparison.png' },
      },
      refused: { '/etc/passwd.png': 'outside-allowed-roots' },
    });
  });

  test('a session launched with its own temp folder is told about $TMPDIR, and an image saved there is kept', async () => {
    await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, true);
    const previous = process.env.STATION_HOME;
    process.env.STATION_HOME = join(base, 'station-home');
    const uninstall = installSessionTmpDirPolicy(() =>
      selector.select({ enabled: () => true, disabled: () => false }),
    );
    try {
      let saved = '';
      await replyTurn('thread-tmp', () => {
        const tmp = sessionTempRoot('thread-tmp');
        if (!tmp) throw new Error('no temp root was launched');
        saved = join(tmp, 'shot.png');
        writeFileSync(saved, FIXTURE);
        return `![shot](${saved})`;
      });
      expect(adapter.turns[0].ambientContext).toContain(
        hostImageAgentInstruction({ workingDirectory: true, tmpdir: true }),
      );
      const stored = store.latestEventByMethod(
        'thread-tmp',
        'content.host-images',
      )?.payload;
      if (stored?.method !== 'content.host-images') throw new Error('none');
      expect(stored.sources).toEqual([{ path: saved, attachmentIndex: 0 }]);
    } finally {
      uninstall();
      if (previous === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previous;
    }
  });

  test('a chat with no admissible folder but its own temp folder is told only about $TMPDIR', async () => {
    await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, true);
    const previous = process.env.STATION_HOME;
    process.env.STATION_HOME = join(base, 'station-home');
    const uninstall = installSessionTmpDirPolicy(() =>
      selector.select({ enabled: () => true, disabled: () => false }),
    );
    try {
      await replyTurn('thread-tmp-only', 'nothing', homedir());
      expect(adapter.turns[0].ambientContext).toContain(
        hostImageAgentInstruction({ workingDirectory: false, tmpdir: true }),
      );
      expect(adapter.turns[0].ambientContext).not.toContain(
        'working directory',
      );
    } finally {
      uninstall();
      if (previous === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previous;
    }
  });

  test('a chat with no admissible folder and no temp folder is not told at all', async () => {
    await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, true);
    await replyTurn('thread-home', 'nothing', homedir());
    expect(adapter.turns[0].ambientContext ?? '').not.toContain(
      'Station chat images',
    );
  });

  test('a first turn carries both the workload budget and the host-image instruction', async () => {
    await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, true);
    const limits = {
      memoryMaxBytes: 2 * 1024 ** 3,
      swapMaxBytes: 0,
      tasksMax: 512,
    };
    Object.assign(adapter.metadata, { workloadScope: 'engine-process' });
    await service.shutdown();
    service = new OrchestrationService({
      adapterRegistry: registryOf(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
      hostImagesPreview: selector,
      workloadEngineLimits: () => limits,
    });
    await replyTurn('thread-both', 'nothing');
    const context = adapter.turns[0].ambientContext ?? '';
    expect(context).toContain(workloadBudgetEngineContext(limits));
    expect(context).toContain(
      hostImageAgentInstruction({ workingDirectory: true, tmpdir: false }),
    );
  });

  test('preview off: nothing is read or stored, and the agent is not told', async () => {
    const path = join(workspace, 'comparison.png');
    await replyTurn('thread-off', `![sizing](${path})`);
    expect(adapter.turns[0].ambientContext ?? '').not.toContain(
      'Station chat images',
    );
    expect(
      store.latestEventByMethod('thread-off', 'content.host-images'),
    ).toBeUndefined();
  });

  test('an engine cannot supply host images itself', async () => {
    await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, true);
    await replyTurn('thread-forged', 'plain reply');
    adapter.events.push({
      eventId: 'forged',
      provider: 'codex',
      threadId: 'thread-forged',
      turnId: 'turn-1',
      createdAt: new Date().toISOString(),
      method: 'content.host-images',
      attachments: [
        {
          kind: 'image',
          name: 'x.png',
          mimeType: 'image/png',
          size: FIXTURE.length,
          dataUrl: `data:image/png;base64,${FIXTURE.toString('base64')}`,
        },
      ],
      sources: [{ path: '/etc/shadow.png', attachmentIndex: 0 }],
    } as never);
    // A later ordinary event proves the forged one was consumed and skipped.
    adapter.events.push({
      eventId: 'after-forged',
      provider: 'codex',
      threadId: 'thread-forged',
      createdAt: new Date().toISOString(),
      method: 'runtime.warning',
      message: 'marker',
    } as never);
    await waitUntil(() =>
      store.latestEventByMethod('thread-forged', 'runtime.warning'),
    );
    expect(
      store.latestEventByMethod('thread-forged', 'content.host-images'),
    ).toBeUndefined();
  });

  test('turning the preview off between settle and publish publishes nothing', async () => {
    await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, true);
    const capture = service['hostImages'] as unknown as {
      deps: { hooks?: unknown };
    };
    capture.deps.hooks = {
      beforeOpen: async () => {
        await previews.setEnabled(CHAT_HOST_IMAGES_PREVIEW_ID, false);
      },
    };
    await replyTurn(
      'thread-toggle',
      `![sizing](${join(workspace, 'comparison.png')})`,
    );
    expect(
      store.latestEventByMethod('thread-toggle', 'content.host-images'),
    ).toBeUndefined();
  });
});
