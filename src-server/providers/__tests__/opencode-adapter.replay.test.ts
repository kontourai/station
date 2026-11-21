/**
 * The native OpenCode transport, end to end through `OpenCodeAdapter`,
 * against the real 2.3.0 wire replayed from the captures
 * (`opencode-serve-replay.ts`).
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { ACP_APPROVAL_TAKEOVER_FAILED_CODE } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { PreToolPolicyDecision } from '../../runtime/agents/pre-tool-policy.js';
import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { installManagedEngineLimits } from '../../security/managed-engine-limits.js';
import {
  evaluateOpenCodeRules,
  type OpenCodeNativeRule,
} from '../../services/acp/opencode-approval-native.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import { resolveTurnCompletionOutcome } from '../../services/orchestration/turn-completion-notifications.js';
import {
  ApprovalGovernanceRefusedError,
  AttachmentInputUnsupportedError,
  type ProviderAdapterShape,
  type ProviderSessionStartInput,
  ProviderTurnEndedError,
  SendTurnRefusedError,
  SessionRewindingError,
} from '../adapter-shape.js';
import type { AcpAdapterOptions } from '../adapters/acp-adapter.js';
import { nativeResumeBindingKey } from '../adapters/native-resume-binding.js';
import {
  isOpenCodeResumeCursor,
  OPENCODE_NATIVE_UNAVAILABLE,
  OPENCODE_NATIVE_UNSUPPORTED_SETTING,
  OPENCODE_NATIVE_UNVERIFIED,
  OPENCODE_SESSION_MOVED_UNGOVERNABLE,
  OpenCodeAdapter,
} from '../adapters/opencode-adapter.js';
import { openCodeMcpDigest } from '../adapters/opencode-native-mcp.js';
import {
  OPENCODE_REFUSED_ASKS_OVERFLOW,
  OpenCodeRequestClosedError,
  openCodeAskFitsTool,
} from '../adapters/opencode-serve-session.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';
import {
  loadOpenCodeFixture,
  type OpenCodeReplayRecord,
  type OpenCodeReplayRequest,
  OpenCodeServeReplay,
  type OpenCodeServeReplayOptions,
  pageOpenCodeHistory,
  recordedPromptIds,
  replayLeaser,
} from './opencode-serve-replay.js';

const CONNECTION: ACPConnectionConfig = {
  id: 'opencode',
  name: 'OpenCode',
  command: '/opt/opencode/bin/opencode',
  args: ['acp'],
  enabled: true,
};

type Event = CanonicalRuntimeEvent & Record<string, unknown>;

// Created before the hook that stops what a test opened, so its directories
// are removed after (vitest runs after-hooks in reverse order).
const makeTempDir = trackTempDirs();
const open: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.stop();
});

function fakeInner(options: AcpAdapterOptions) {
  const events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  const starts: unknown[] = [];
  const inner = {
    provider: options.provider ?? 'acp',
    metadata: { displayName: 'inner', description: '', capabilities: [] },
    starts,
    filter: options.connectionFilter,
    resolvePreToolPolicy: options.resolvePreToolPolicy,
    async startSession(input: { threadId: string; resumeCursor?: unknown }) {
      starts.push(input);
      return {
        provider: options.provider ?? 'acp',
        threadId: input.threadId,
        status: 'ready' as const,
        cwd: '/replay/proj',
        resumeCursor: {
          acpSessionId: 'ses_acp',
          connectionId: 'opencode',
          connectionFingerprint: 'f00d',
        },
        createdAt: '',
        updatedAt: '',
      };
    },
    async sendTurn() {
      return { threadId: 't', turnId: 'x' };
    },
    async interruptTurn() {
      return { outcome: 'no-active-turn' as const };
    },
    async respondToRequest() {},
    async stopSession() {},
    async listSessions() {
      return [];
    },
    async hasSession() {
      return false;
    },
    async stopAll() {
      events.close();
    },
    streamEvents() {
      return events.iterable();
    },
  };
  return inner;
}

async function setup(
  replayOptions: OpenCodeServeReplayOptions,
  adapterOptions: Partial<
    ConstructorParameters<typeof OpenCodeAdapter>[0]
  > = {},
  /** The directory the replayed server runs in (default `/replay/proj`). */
  leaseCwd?: string,
) {
  const replay = await OpenCodeServeReplay.start(replayOptions);
  const leaser = replayLeaser(replay, leaseCwd);
  // Station names its prompts; the replay's engine knows the recorded names.
  const promptIds = recordedPromptIds(
    replayOptions.scenario,
    replayOptions.omit,
  );
  let inner: ReturnType<typeof fakeInner> | undefined;
  const adapter = new OpenCodeAdapter({
    getConnections: async () => [CONNECTION],
    createAcpAdapter: (options) => {
      inner = fakeInner(options);
      return inner as unknown as ProviderAdapterShape;
    },
    nativeEnabled: () => true,
    managedWorkspaceHomeDir: makeTempDir('opencode-replay-state-'),
    pool: leaser,
    versionProbe: {
      probe: async () => ({ major: 2, minor: 3, patch: 0, text: '2.3.0' }),
    },
    findBinary: async () => CONNECTION.command,
    binaryIdentity: async () => 'binary-identity',
    findProjectCode: async () => [],
    launchEnv: async () => ({
      TMPDIR: '/replay/tmp',
      XDG_DATA_HOME: '/replay/xdg',
    }),
    reconnectFirstMs: 5,
    // A turn stopped on a refused rejection that OpenCode never confirms
    // ends sooner than in production; tests of the wait set their own.
    failCloseSettleMs: 300,
    newMessageId: () => {
      const id = promptIds.shift();
      if (!id) throw new Error('the replay has no more recorded prompt ids');
      return id;
    },
    ...adapterOptions,
  });
  const events: Event[] = [];
  const waiters: Array<() => void> = [];
  const pump = (async () => {
    for await (const event of adapter.streamEvents()) {
      events.push(event as Event);
      for (const wake of waiters.splice(0)) wake();
    }
  })();
  async function waitFor(
    predicate: (event: Event) => boolean,
    timeoutMs = 5_000,
  ): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(
          `timed out; saw ${events.map((event) => event.method).join(', ')}`,
        );
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  open.push({
    stop: async () => {
      await adapter.stopAll();
      await pump;
      await replay.close();
    },
  });
  return {
    replay,
    leaser,
    adapter,
    events,
    waitFor,
    inner: () => inner,
    async start(
      modelOptions?: Record<string, unknown>,
      extra: Partial<ProviderSessionStartInput> = {},
    ) {
      return adapter.startSession({
        threadId: 'thread-1',
        provider: 'opencode',
        cwd: '/replay/proj',
        metadata: { connectionId: 'opencode' },
        ...(modelOptions ? { modelOptions } : {}),
        ...extra,
      });
    },
    /** A turn and its outcome event. */
    async turn(input: string, modelOptions?: Record<string, unknown>) {
      return adapter.sendTurn({
        threadId: 'thread-1',
        input,
        ...(modelOptions ? { modelOptions } : {}),
      });
    },
  };
}

/** The steer capture without its withdrawn steer. */
const withdrawnSteer = (record: OpenCodeReplayRecord) =>
  (record.kind === 'http' &&
    (JSON.stringify(record.body ?? null).includes('STEER-withdrawn') ||
      (record.method === 'GET' &&
        record.path?.endsWith('/inbox') === true &&
        record.t < 100) ||
      record.method === 'DELETE')) ||
  (record.kind === 'sse' &&
    record.event?.data?.inboxID === 'msg_1d71b0245001rPumuccI4tfOcM');

const turnText = (events: Event[], turnId: string) =>
  events
    .filter(
      (event) =>
        event.method === 'content.text-delta' && event.turnId === turnId,
    )
    .map((event) => event.delta)
    .join('');

const completedFor = (turnId: string) => (event: Event) =>
  event.method === 'turn.completed' && event.turnId === turnId;

/** The last recorded history's text of each assistant message. */
function finalAssistantText(scenario: string): string {
  const reads = loadOpenCodeFixture(scenario).filter(
    (record) =>
      record.kind === 'http' && record.path?.includes('/message?order=asc'),
  );
  const last = reads.at(-1)?.response as {
    data: Array<{
      type: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
  };
  return last.data
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

describe('OpenCodeAdapter over the native transport (2.3.0 replay)', () => {
  test('a basic turn streams its reply, usage and completion', async () => {
    const h = await setup({ scenario: 'basic' });
    const session = await h.start();
    expect(isOpenCodeResumeCursor(session.resumeCursor)).toBe(true);
    expect(session.resumeCursor).toMatchObject({
      kind: 'opencode',
      transport: 'native',
      sessionId: 'ses_e28e527caffe90iJBQHsJAidpr',
    });
    expect(h.replay.made('POST', '/api/session')[0]?.body).toEqual({
      location: { directory: '/replay/proj' },
    });
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'hello basic',
    });
    const completed = await h.waitFor(completedFor(turnId));
    expect(turnText(h.events, turnId)).toBe('mock reply: hello basic');
    expect(completed).toMatchObject({
      finishReason: 'stop',
      outputText: 'mock reply: hello basic',
    });
    expect(
      h.events.find(
        (event) => event.method === 'turn.started' && event.turnId === turnId,
      ),
    ).toMatchObject({ prompt: 'hello basic' });
    expect(
      h.events.find(
        (event) =>
          event.method === 'token-usage.updated' && event.turnId === turnId,
      ),
    ).toMatchObject({
      promptTokens: 102,
      completionTokens: 20,
      servedModelObservation: {
        source: 'opencode-step-started',
        providerId: 'mock',
        modelId: 'mock-1',
        assistantMessageId: 'msg_1d71adc1f001pAM06JQG2JhsQi',
      },
    });
    expect(h.replay.misses).toEqual([]);
  });

  test('tool calls complete with their output and the edit carries its patch', async () => {
    const h = await setup({
      scenario: 'tools',
      omit: (record) =>
        record.event?.type === 'session.step.started' &&
        record.event.data?.assistantMessageID ===
          'msg_1d71ae47d001ZdfbHR6imr6fWE',
    });
    await h.start();
    const first = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_WRITE now',
    });
    await h.waitFor(completedFor(first.turnId));
    const second = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_EDIT now',
    });
    await h.waitFor(completedFor(second.turnId));
    const continuationUsage = h.events.filter(
      (event) =>
        event.method === 'token-usage.updated' &&
        event.turnId === second.turnId,
    );
    expect(continuationUsage).toHaveLength(2);
    expect(continuationUsage[0]).not.toHaveProperty('servedModelObservation');
    expect(continuationUsage[1]).toHaveProperty(
      'servedModelObservation.assistantMessageId',
      'msg_1d71ae4f800160PtNAChRchfdq',
    );
    const tools = h.events.filter((event) => event.method === 'tool.completed');
    expect(tools.map((event) => [event.toolName, event.status])).toEqual([
      ['write', 'success'],
      ['edit', 'success'],
    ]);
    expect(tools[0]?.output).toBe('Created file successfully: created.txt');
    expect(String(tools[1]?.output)).toContain('Modified: edit-me.txt');
    expect(String(tools[1]?.output)).toContain('+line one EDITED');
    expect(
      h.events.find(
        (event) => event.method === 'tool.started' && event.toolName === 'edit',
      ),
    ).toMatchObject({
      turnId: second.turnId,
      arguments: { path: 'edit-me.txt' },
    });
  });

  test('allow for the session answers OpenCode `once`, never `always`, and the engine acknowledges it', async () => {
    const h = await setup({ scenario: 'permission-allow' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_BASH please',
    });
    const opened = await h.waitFor(
      (event) => event.method === 'request.opened',
    );
    expect(opened).toMatchObject({
      turnId,
      requestId: 'per_1d71aec3900105OtpYPrj5iSsU',
      payload: { toolName: 'shell' },
    });
    await h.adapter.respondToRequest(
      'thread-1',
      opened.requestId as string,
      'acceptForSession',
    );
    const replies = h.replay.made(
      'POST',
      '/api/session/:id/permission/:id/reply',
    );
    expect(replies.map((reply) => reply.body)).toEqual([{ decision: 'once' }]);
    expect(
      await h.waitFor((event) => event.method === 'request.resolved'),
    ).toMatchObject({ status: 'approved', acknowledgement: 'engine' });
    await h.waitFor(completedFor(turnId));
    expect(
      h.replay.requests.some((request) =>
        JSON.stringify(request.body ?? null).includes('always'),
      ),
    ).toBe(false);
  });

  test('a declined permission is rejected and the tool fails', async () => {
    const h = await setup({ scenario: 'permission-reject' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_BASH please',
    });
    const opened = await h.waitFor(
      (event) => event.method === 'request.opened',
    );
    await h.adapter.respondToRequest(
      'thread-1',
      opened.requestId as string,
      'decline',
    );
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'reject' }]);
    expect(
      await h.waitFor((event) => event.method === 'request.resolved'),
    ).toMatchObject({ status: 'denied' });
    await h.waitFor(completedFor(turnId));
    expect(
      h.events.find((event) => event.method === 'tool.completed'),
    ).toMatchObject({ toolName: 'shell', status: 'error', error: 'not now' });
  });

  test('a question opens a form input request and its answer goes back as OpenCode values', async () => {
    const h = await setup({ scenario: 'question' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_QUESTION now',
    });
    const opened = await h.waitFor(
      (event) => event.method === 'request.opened',
    );
    const form = (opened.payload as { inputRequest: unknown }).inputRequest;
    expect(form).toMatchObject({
      schema: 'station.input-request/v1',
      source: 'harness:opencode',
      body: {
        kind: 'form',
        fields: [
          {
            name: 'q0',
            kind: 'choice',
            header: 'Color',
            title: 'Pick a color?',
            allowCustom: true,
            options: [
              { value: 'Red', label: 'Red' },
              { value: 'Blue', label: 'Blue' },
            ],
          },
        ],
      },
    });
    await h.adapter.respondToRequest(
      'thread-1',
      opened.requestId as string,
      'accept',
      { inputContent: { q0: 'Red' }, expectedRequestEventId: opened.eventId },
    );
    expect(
      h.replay.made('POST', '/api/session/:id/form/:id/reply')[0]?.body,
    ).toEqual({ answer: { q0: 'Red' } });
    expect(
      await h.waitFor((event) => event.method === 'request.resolved'),
    ).toMatchObject({ status: 'approved', acknowledgement: 'engine' });
    await h.waitFor(completedFor(turnId));
  });

  const withdrawn = withdrawnSteer;

  test('a steer is acknowledged when OpenCode delivers it', async () => {
    const h = await setup({ scenario: 'steer', omit: withdrawn });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_BASH steer',
    });
    const opened = await h.waitFor(
      (event) => event.method === 'request.opened',
    );
    let steered = false;
    const steer = h.adapter
      .steerTurn('thread-1', 'STEER-delivered', turnId)
      .then(() => {
        steered = true;
      });
    await h.waitFor(
      () => h.replay.made('POST', '/api/session/:id/prompt').length === 2,
    );
    expect(h.replay.made('POST', '/api/session/:id/prompt')[1]?.body).toEqual({
      id: 'msg_1d71b024d001crEY1solwrshJq',
      text: 'STEER-delivered',
      delivery: 'steer',
    });
    expect(steered).toBe(false);
    await h.adapter.respondToRequest(
      'thread-1',
      opened.requestId as string,
      'accept',
    );
    await steer;
    expect(
      h.events.find(
        (event) =>
          event.method === 'turn.started' && event.inputKind === 'steer',
      ),
    ).toMatchObject({ turnId, prompt: 'STEER-delivered' });
    await h.waitFor(completedFor(turnId));
  });

  test.each([false, true])(
    'a failed steer POST and early DELETE 404 retain custody across stop and resume (managed=%s)',
    async (managed) => {
      const home = makeTempDir('opencode-custody-');
      if (managed) {
        const policy = parseManagedPolicyDocument({
          schemaVersion: 1,
          organization: 'Acme',
          limits: {
            engines: {
              allowed: ['acp'],
              instances: {
                acp: {
                  locked: true,
                  environment: { XDG_DATA_HOME: '/replay/pinned-xdg' },
                },
              },
            },
          },
        });
        if (!policy.ok) throw new Error(JSON.stringify(policy.problems));
        installManagedEngineLimits({
          document: policy.document,
          summary: summarizeManagedPolicy(policy.document),
        });
      }
      try {
        const h = await setup(
          {
            scenario: 'steer',
            omit: withdrawnSteer,
            respond: (r) => {
              if (
                r.method === 'POST' &&
                (r.body as { delivery?: string })?.delivery === 'steer'
              )
                return { status: 500 };
              if (r.method === 'DELETE' && r.path.includes('/inbox/'))
                return { status: 404 };
              return undefined;
            },
          },
          { managedWorkspaceHomeDir: home },
        );
        const session = await h.start();
        const { turnId } = await h.turn('DO_BASH steer');
        await h.waitFor((e) => e.method === 'request.opened');
        await expect(
          h.adapter.steerTurn('thread-1', 'STEER-delivered', turnId),
        ).rejects.toThrow('may still be queued');
        await h.adapter.stopSession('thread-1');
        const resumed = await setup(
          { scenario: 'basic' },
          { managedWorkspaceHomeDir: home },
        );
        await expect(
          resumed.start(undefined, { resumeCursor: session.resumeCursor }),
        ).rejects.toThrow('unconfirmed steering input');
        expect(
          resumed.replay.made('POST', '/api/session/:id/prompt'),
        ).toHaveLength(0);
        const fallback = await setup(
          { scenario: 'basic' },
          { managedWorkspaceHomeDir: home, nativeEnabled: () => false },
        );
        const cursor = session.resumeCursor as Record<string, unknown>;
        await expect(
          fallback.start(undefined, {
            resumeCursor: {
              ...cursor,
              bindingKey: managed
                ? nativeResumeBindingKey(
                    'opencode',
                    '/replay/xdg/opencode',
                    null,
                  )
                : 'forged-home',
            },
          }),
        ).rejects.toThrow('another OpenCode data home');
        await expect(
          fallback.start(undefined, { resumeCursor: cursor }),
        ).rejects.toThrow('unconfirmed steering input');
        expect(fallback.inner()?.starts ?? []).toEqual([]);
      } finally {
        installManagedEngineLimits(null);
      }
    },
  );

  test.each([204, 500])(
    'a late steer is withdrawn or blocks successor work when withdrawal fails (%s)',
    async (deleteStatus) => {
      const delivered = (record: OpenCodeReplayRecord) =>
        (record.kind === 'http' &&
          (JSON.stringify(record.body ?? null).includes('STEER-delivered') ||
            (record.method === 'GET' &&
              record.path?.endsWith('/inbox') === true))) ||
        (record.kind === 'sse' &&
          (record.event?.data?.inboxID === 'msg_1d71b024d001crEY1solwrshJq' ||
            record.event?.type === 'session.inbox.cancelled'));
      const ids = [
        ...recordedPromptIds('steer', delivered),
        'msg_additional_successor',
      ];
      const h = await setup(
        {
          scenario: 'steer',
          omit: delivered,
          ungated: (record) => record.method === 'DELETE',
          respond: (request) =>
            request.method === 'DELETE' && request.path.includes('/inbox/')
              ? { status: deleteStatus }
              : undefined,
        },
        { newMessageId: () => ids.shift()! },
      );
      await h.start();
      const { turnId } = await h.adapter.sendTurn({
        threadId: 'thread-1',
        input: 'DO_BASH steer',
      });
      const opened = await h.waitFor(
        (event) => event.method === 'request.opened',
      );
      const steer = h.adapter.steerTurn('thread-1', 'STEER-withdrawn', turnId);
      const outcome = steer.then(
        () => 'delivered',
        (error: unknown) => error,
      );
      await h.waitFor(
        () => h.replay.made('POST', '/api/session/:id/prompt').length === 2,
      );
      await h.adapter.respondToRequest(
        'thread-1',
        opened.requestId as string,
        'accept',
      );
      await h.waitFor(completedFor(turnId));
      if (deleteStatus === 204)
        expect(await outcome).toBeInstanceOf(ProviderTurnEndedError);
      else expect(String(await outcome)).toContain('withdrawal is unconfirmed');
      if (deleteStatus === 500) {
        await h.waitFor(
          (event) =>
            event.method === 'runtime.warning' &&
            String(event.message).includes('withdrawn'),
        );
        await expect(h.turn('next')).rejects.toThrow(
          'withdrawal is unconfirmed',
        );
        expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(
          2,
        );
      }
      expect(
        h.replay
          .made('DELETE', '/api/session/:id/inbox/:id')
          .map((r) => r.path),
      ).toEqual([
        '/api/session/ses_e28e4fdf4ffet6a4RsosGDLmTS/inbox/msg_1d71b0245001rPumuccI4tfOcM',
      ]);
    },
  );

  test('an interrupt aborts the running turn', async () => {
    const h = await setup({ scenario: 'interrupt' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_SLOW stream',
    });
    await h.waitFor(
      (event) =>
        event.method === 'content.text-delta' && event.turnId === turnId,
    );
    expect(await h.adapter.interruptTurn('thread-1', turnId)).toEqual({
      outcome: 'cancelled',
      turnId,
    });
    expect(
      await h.waitFor(
        (event) => event.method === 'turn.aborted' && event.turnId === turnId,
      ),
    ).toMatchObject({ reason: 'interrupted' });
    expect(h.events.some(completedFor(turnId))).toBe(false);
  });

  /** Two finished turns on the revert capture: a write, then an edit. */
  async function twoRevertTurns(
    overrides: Partial<OpenCodeServeReplayOptions> = {},
  ) {
    const h = await setup({ scenario: 'revert', ...overrides });
    await h.start();
    const first = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_WRITE first',
    });
    await h.waitFor(completedFor(first.turnId));
    const second = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_EDIT second',
    });
    await h.waitFor(completedFor(second.turnId));
    return { h, first, second };
  }

  test('rewindSession hides the named turn and later ones: a revert staged at its own message, then committed', async () => {
    const { h, second } = await twoRevertTurns();
    expect(await h.adapter.rewindSession('thread-1', second.turnId)).toEqual({
      kind: 'rewound',
      beforeTurnId: second.turnId,
      hiddenTurnIds: [second.turnId],
      affectedFiles: { count: 1, paths: ['edit-me.txt'] },
    });
    // The second turn's own prompt (the capture's staged message).
    expect(
      h.replay.made('POST', '/api/session/:id/revert/stage')[0]?.body,
    ).toEqual({ messageID: 'msg_1d71b155b001aSHsV3kqKgeSj7', files: true });
    expect(
      h.replay.made('POST', '/api/session/:id/revert/commit'),
    ).toHaveLength(1);
    expect(h.replay.made('DELETE', '/api/session/:id/revert')).toHaveLength(0);
    expect(
      await h.waitFor((event) => event.code === 'acp.session-rewound'),
    ).toMatchObject({
      details: {
        beforeTurnId: second.turnId,
        hiddenTurnIds: [second.turnId],
        affectedFileCount: 1,
      },
    });
    // The hidden turn is no longer a rewind point.
    expect(await h.adapter.rewindSession('thread-1', second.turnId)).toEqual({
      kind: 'refused',
      reason: 'unknown-turn',
    });
  });

  test('a failed revert commit clears the staged revert and reports the failure', async () => {
    const { h, second } = await twoRevertTurns({
      respond: (request) =>
        request.method === 'POST' && request.path.endsWith('/revert/commit')
          ? { status: 500, body: { error: 'commit broke' } }
          : undefined,
    });
    expect(
      await h.adapter.rewindSession('thread-1', second.turnId),
    ).toMatchObject({ kind: 'failed' });
    expect(h.replay.made('DELETE', '/api/session/:id/revert')).toHaveLength(1);
    expect(h.events.some((event) => event.code === 'acp.session-rewound')).toBe(
      false,
    );
  });

  test('rewindSession refuses, sending nothing, for an unknown turn, a running turn and a session not held', async () => {
    const h = await setup({ scenario: 'interrupt' });
    expect(await h.adapter.rewindSession('thread-1', 'nope')).toEqual({
      kind: 'refused',
      reason: 'not-live',
    });
    expect(h.adapter.sessionContinuity('thread-1')).toEqual({
      live: false,
      rewind: 'none',
      fork: 'none',
    });
    await h.start();
    expect(h.adapter.sessionContinuity('thread-1')).toEqual({
      live: true,
      rewind: 'in-place',
      fork: 'none',
    });
    expect(await h.adapter.rewindSession('thread-1', 'nope')).toEqual({
      kind: 'refused',
      reason: 'unknown-turn',
    });
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_SLOW stream',
    });
    await h.waitFor(
      (event) =>
        event.method === 'content.text-delta' && event.turnId === turnId,
    );
    expect(await h.adapter.rewindSession('thread-1', turnId)).toEqual({
      kind: 'refused',
      reason: 'turn-running',
    });
    expect(h.replay.made('POST', '/api/session/:id/revert/stage')).toHaveLength(
      0,
    );
  });

  test('a send while a rewind is with OpenCode is refused retryably, as on ACP', async () => {
    const { h, second } = await twoRevertTurns({
      // The stage is held until the replay closes: the rewind stays open.
      holdUntil: (request) =>
        request.path.endsWith('/revert/stage') ? () => false : undefined,
    });
    const rewinding = h.adapter.rewindSession('thread-1', second.turnId);
    await h.waitFor(() =>
      h.replay.requests.some((r) => r.path.endsWith('/revert/stage')),
    );
    await expect(
      h.adapter.sendTurn({ threadId: 'thread-1', input: 'too soon' }),
    ).rejects.toBeInstanceOf(SessionRewindingError);
    expect(await h.adapter.rewindSession('thread-1', second.turnId)).toEqual({
      kind: 'refused',
      reason: 'rewind-pending',
    });
    void rewinding.catch(() => undefined);
  });

  test('/rewind with no turn named takes back the last turn', async () => {
    const { h, second } = await twoRevertTurns();
    const command = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: '/rewind',
    });
    await h.waitFor(completedFor(command.turnId));
    expect(turnText(h.events, command.turnId)).toBe(
      'OpenCode rewound to before that turn.',
    );
    expect(
      h.events.find(
        (event) =>
          event.method === 'content.text-delta' &&
          event.turnId === command.turnId,
      ),
    ).toMatchObject({ itemId: expect.stringMatching(/^text:/) });
    expect(
      h.replay.made('POST', '/api/session/:id/revert/stage')[0]?.body,
    ).toEqual({ messageID: 'msg_1d71b155b001aSHsV3kqKgeSj7', files: true });
    expect(
      await h.waitFor((event) => event.code === 'acp.session-rewound'),
    ).toMatchObject({ details: { hiddenTurnIds: [second.turnId] } });
  });

  test('reconnectMcpServer disconnects then connects the server on OpenCode, and refuses a sign-in', async () => {
    const h = await setup({
      scenario: 'basic',
      respond: (request) =>
        request.method === 'POST' &&
        /\/api\/experimental\/mcp\/[^/]+\/(connect|disconnect)$/.test(
          request.path,
        )
          ? { status: 204 } // 2.3.0 answers both with 204 (live probe)
          : undefined,
    });
    await h.start();
    expect(
      await h.adapter.reconnectMcpServer('thread-1', 'station-echo', {
        startOAuth: true,
      }),
    ).toMatchObject({ kind: 'failed' });
    expect(
      h.replay.requests.filter((r) => r.path.includes('/experimental/mcp/')),
    ).toEqual([]);
    expect(
      await h.adapter.reconnectMcpServer('thread-1', 'station-echo', {
        startOAuth: false,
      }),
    ).toMatchObject({ kind: 'answered', success: true });
    expect(
      h.replay.requests
        .filter((r) => r.path.includes('/experimental/mcp/'))
        .map((r) => `${r.method} ${r.path}`),
    ).toEqual([
      'POST /api/experimental/mcp/station-echo/disconnect',
      'POST /api/experimental/mcp/station-echo/connect',
    ]);
    // The status a surface offers the action from says it can.
    expect(
      await h.waitFor((event) => event.method === 'engine-mcp.status'),
    ).toMatchObject({ reconnect: true });
  });

  test('an image goes to OpenCode as a prompt file, as a data URI, and reaches the model', async () => {
    const h = await setup({ scenario: 'attachment' });
    await h.start();
    const recorded = loadOpenCodeFixture('attachment').find(
      (line) => line.kind === 'http' && line.path?.endsWith('/prompt') === true,
    )?.body as { files: Array<{ uri: string; name: string }> };
    const dataUrl = recorded.files[0]?.uri as string;
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'What is in the picture?',
      attachments: [
        {
          kind: 'image',
          name: 'pixel.png',
          mimeType: 'image/png',
          size: Buffer.from(dataUrl.split(',')[1] as string, 'base64').length,
          dataUrl,
        },
      ],
    });
    await h.waitFor(completedFor(turnId));
    const prompt = h.replay.made('POST', '/api/session/:id/prompt')[0]
      ?.body as { files?: unknown };
    // The shape the real server took (2.3.0 attachment capture).
    expect(prompt.files).toEqual(recorded.files);
    expect(turnText(h.events, turnId)).toBe('IMAGE_SEEN by mock');
  });

  test('a non-image file is refused before anything reaches OpenCode', async () => {
    const h = await setup({ scenario: 'attachment' });
    await h.start();
    const text = Buffer.from('a,b\n').toString('base64');
    await expect(
      h.adapter.sendTurn({
        threadId: 'thread-1',
        input: 'read this',
        attachments: [
          {
            kind: 'file',
            name: 'data.csv',
            mimeType: 'text/csv',
            size: 4,
            dataUrl: `data:text/csv;base64,${text}`,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(AttachmentInputUnsupportedError);
    expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(0);
  });

  /** The capture added `station-echo`; Station's built-in is `station-control`. */
  const asStationControl = (record: OpenCodeReplayRecord) =>
    record.path === '/api/experimental/mcp/station-echo'
      ? { ...record, path: '/api/experimental/mcp/station-control' }
      : record;

  /** Station's tool servers for a thread: the built-in station-control, by HTTP. */
  function stationTools(tokens: Record<string, string>) {
    const revoked: string[] = [];
    return {
      revoked,
      options: {
        getConnections: async () => [
          { ...CONNECTION, provideToolServers: ['station-control'] },
        ],
        acp: {
          resolveToolServer: async (id: string) =>
            id === 'station-control'
              ? {
                  id: 'station-control',
                  kind: 'mcp' as const,
                  transport: 'stdio' as const,
                  command: 'node',
                  args: [builtinStationControlServerPath()],
                  env: { STATION_API_BASE: 'http://127.0.0.1:3141' },
                }
              : null,
          mintStationControlMcpAuth: (threadId: string) => ({
            url: 'http://127.0.0.1:47999/mcp/station-control',
            token: tokens[threadId] as string,
          }),
          revokeStationControlMcpAuth: (threadId: string) => {
            revoked.push(threadId);
          },
        },
      },
    };
  }

  test("a session's Station tool servers are added to its OpenCode server before the session, and their credentials go nowhere else", async () => {
    const tools = stationTools({ 'thread-1': 'tok-session-one' });
    const h = await setup(
      { scenario: 'mcp-add', rewrite: asStationControl },
      tools.options,
    );
    await h.start();
    const added = h.replay.made('PUT', '/api/experimental/mcp/station-control');
    expect(added.map((request) => request.body)).toEqual([
      {
        config: {
          type: 'remote',
          url: 'http://127.0.0.1:47999/mcp/station-control',
          headers: { Authorization: 'Bearer tok-session-one' },
          oauth: false,
        },
      },
    ]);
    // The shape the real server took (2.3.0 mcp-add capture).
    const recorded = loadOpenCodeFixture('mcp-add').find(
      (line) => line.method === 'PUT',
    )?.body as { config: Record<string, unknown> };
    expect(Object.keys(recorded.config).sort()).toEqual(
      Object.keys((added[0] as { body: typeof recorded }).body.config).sort(),
    );
    const writes = h.replay.requests.map(
      (request) => `${request.method} ${request.path}`,
    );
    expect(
      writes.indexOf('PUT /api/experimental/mcp/station-control'),
    ).toBeLessThan(writes.indexOf('POST /api/session'));
    // Its server is keyed by the session's tool servers.
    expect(h.leaser.acquired[0]?.mcpDigest).not.toBe(openCodeMcpDigest([]));
    const { turnId } = await h.turn('DO_MCP');
    await h.waitFor(completedFor(turnId));
    expect(
      h.events.filter((event) => event.method === 'runtime.warning'),
    ).toEqual([]);
    expect(JSON.stringify(h.events)).not.toContain('tok-session-one');
    // Its key carries this session's credential, so no other session can
    // share it: it stops with the session, not after idling.
    expect(h.leaser.discarded).toBe(0);
    await h.adapter.stopSession('thread-1');
    expect(tools.revoked).toContain('thread-1');
    expect(h.leaser.discarded).toBe(1);
    expect(h.leaser.released).toBe(0);
  });

  test('a server that exits under a session revokes its Station tool-server credentials', async () => {
    const tools = stationTools({ 'thread-1': 'tok-session-one' });
    const h = await setup(
      { scenario: 'mcp-add', rewrite: asStationControl },
      tools.options,
    );
    await h.start();
    expect(tools.revoked).toEqual([]);
    h.leaser.exit();
    expect(
      await h.waitFor((event) => event.method === 'session.exited'),
    ).toMatchObject({ reason: 'OpenCode server exited' });
    expect(tools.revoked).toEqual(['thread-1']);
  });

  test('a session without Station tool servers gives its shareable server back to idle at stop', async () => {
    const h = await setup({ scenario: 'basic' });
    await h.start();
    await h.adapter.stopSession('thread-1');
    expect(h.leaser.released).toBe(1);
    expect(h.leaser.discarded).toBe(0);
  });

  test("a governed start runs on the server its preflight checked, moved to the session's tool servers: one server, not two", async () => {
    const tools = stationTools({ 'thread-1': 'tok-session-one' });
    const h = await setup(
      { scenario: 'mcp-add', rewrite: asStationControl },
      tools.options,
    );
    await h.adapter.preflightStart({
      threadId: 'thread-1',
      provider: 'opencode',
      cwd: '/replay/proj',
      metadata: { connectionId: 'opencode' },
      modelOptions: { approvalMode: 'ask' },
    });
    expect(h.leaser.acquired.map((input) => input.mcpDigest)).toEqual([
      openCodeMcpDigest([]),
    ]);
    // Held for the start, not given back.
    expect(h.leaser.released).toBe(0);
    await h.start({ approvalMode: 'ask' });
    expect(h.leaser.acquired).toHaveLength(1);
    expect(h.leaser.rekeyed).toHaveLength(1);
    expect(h.leaser.rekeyed[0]).not.toBe(openCodeMcpDigest([]));
    expect(
      h.replay.made('PUT', '/api/experimental/mcp/station-control'),
    ).toHaveLength(1);
  });

  test('two sessions with different Station tool-server credentials ask for different servers', async () => {
    const digests: Array<string | undefined> = [];
    for (const token of ['tok-one', 'tok-two']) {
      const tools = stationTools({ 'thread-1': token });
      const h = await setup(
        { scenario: 'mcp-add', rewrite: asStationControl },
        tools.options,
      );
      await h.start();
      digests.push(h.leaser.acquired[0]?.mcpDigest);
    }
    expect(digests[0]).toBeDefined();
    expect(digests[0]).not.toBe(digests[1]);
  });

  test('a subagent is reported as child work only', async () => {
    const h = await setup({ scenario: 'subagent' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_TASK now',
    });
    await h.waitFor(completedFor(turnId));
    const child = h.events.filter(
      (event) => event.method === 'child-work.updated',
    );
    expect(
      child.map((event) => (event.delta as { kind: string }).kind),
    ).toEqual(['snapshot', 'settle']);
    // The child's start is the session's whole running set.
    expect(child[0]?.delta).toMatchObject({
      producer: 'engine-subagent',
      reporterThreadId: 'thread-1',
    });
    const running = (child[0]!.delta as { running: unknown[] }).running;
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      producer: 'engine-subagent',
      childId: 'ses_e28e4e140ffemsWOeVxszItzHu',
      title: 'child probe',
      kindLabel: 'general',
      status: 'running',
    });
    expect(child[1]?.delta).toMatchObject({ status: 'completed' });
    // The child's own reply is not this session's text.
    expect(
      h.events.some(
        (event) =>
          event.method === 'content.text-delta' &&
          event.delta === 'child-ok from subagent',
      ),
    ).toBe(false);
    expect(
      h.events.filter((event) => event.method === 'turn.started'),
    ).toHaveLength(1);
  });

  test('after a feed drop mid-turn the reply still equals what OpenCode kept', async () => {
    const h = await setup({ scenario: 'reconnect' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_SLOW stream',
    });
    await h.waitFor(completedFor(turnId), 10_000);
    expect(turnText(h.events, turnId)).toBe(finalAssistantText('reconnect'));
    expect(h.replay.made('GET', '/api/session/active')).toHaveLength(1);
  });

  test('a turn that ended while the feed was down is caught up from history', async () => {
    const h = await setup({
      scenario: 'reconnect',
      fallbacks: ['basic', 'catalog', 'mcp'],
      // Tap B shows nothing after it connects, and the reads Station makes
      // then find the turn finished (`basic`'s idle `session/active`).
      omit: (record) =>
        (record.tap === 'B' &&
          record.kind === 'sse' &&
          record.event?.type !== 'server.connected') ||
        (record.kind === 'http' &&
          record.method === 'GET' &&
          record.t < 6000 &&
          (record.path === '/api/session/active' ||
            record.path?.includes('/message?order=asc') === true)),
    });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_SLOW stream',
    });
    const completed = await h.waitFor(completedFor(turnId), 10_000);
    expect(turnText(h.events, turnId)).toBe(finalAssistantText('reconnect'));
    expect(completed).toMatchObject({ finishReason: 'stop' });
  });

  test('synthetic text, tool, text parts within one assistant message retain both text ordinals', async () => {
    const h = await setup({
      scenario: 'basic',
      omit: (record) =>
        record.event?.type === 'session.execution.succeeded' ||
        record.kind === 'sse-close',
    });
    await h.start();
    const { turnId } = await h.turn('hello basic');
    await h.waitFor((e) => e.method === 'token-usage.updated');
    const sessionID = recordedSessionId('basic');
    const assistantMessageID = 'msg_1d71adc1f001pAM06JQG2JhsQi';
    const data = { sessionID, assistantMessageID };
    h.replay.push({
      type: 'session.tool.input.started',
      data: { ...data, id: 'call_between', name: 'read' },
    });
    h.replay.push({
      type: 'session.tool.called',
      data: {
        ...data,
        id: 'call_between',
        input: { path: 'a.txt' },
        executed: false,
      },
    });
    h.replay.push({
      type: 'session.tool.success',
      data: { ...data, id: 'call_between', output: 'read result' },
    });
    h.replay.push({
      type: 'session.text.started',
      data: { ...data, ordinal: 1 },
    });
    h.replay.push({
      type: 'session.text.delta',
      data: { ...data, ordinal: 1, delta: ' after tool' },
    });
    h.replay.push({
      type: 'session.text.ended',
      data: { ...data, ordinal: 1, text: ' after tool' },
    });
    h.replay.push({ type: 'session.execution.succeeded', data: { sessionID } });
    await h.waitFor(completedFor(turnId));
    expect(turnText(h.events, turnId)).toBe(
      'mock reply: hello basic after tool',
    );
    expect(
      h.events.find(
        (e) => e.method === 'tool.completed' && e.toolCallId === 'call_between',
      ),
    ).toMatchObject({ status: 'success', toolName: 'read' });
    expect(
      new Set(
        h.events
          .filter(
            (e) => e.method === 'content.text-delta' && e.turnId === turnId,
          )
          .map((e) => e.itemId),
      ).size,
    ).toBe(2);
  });

  test('a reply after reasoning streams as text, beside its reasoning', async () => {
    const h = await setup({ scenario: 'reasoning' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_THINK now',
    });
    const completed = await h.waitFor(completedFor(turnId));
    // OpenCode numbers reasoning and text parts apart: both are ordinal 0.
    expect(finalAssistantText('reasoning')).toBe('thought reply');
    expect(turnText(h.events, turnId)).toBe('thought reply');
    expect(completed).toMatchObject({ outputText: 'thought reply' });
    const reasoning = h.events.filter(
      (event) =>
        event.method === 'content.reasoning-delta' && event.turnId === turnId,
    );
    expect(reasoning.map((event) => event.delta).join('')).toBe(
      'Thinking it over.',
    );
    const textItems = new Set(
      h.events
        .filter(
          (event) =>
            event.method === 'content.text-delta' && event.turnId === turnId,
        )
        .map((event) => event.itemId),
    );
    expect(textItems.size).toBe(1);
    expect(textItems.has(reasoning[0]?.itemId)).toBe(false);
    expect(h.replay.misses).toEqual([]);
  });

  test('after a feed drop, a reply that followed reasoning streams on to what OpenCode kept', async () => {
    const h = await setup({ scenario: 'reasoning-reconnect' });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_THINK_SLOW stream',
    });
    await h.waitFor(completedFor(turnId), 10_000);
    const kept = finalAssistantText('reasoning-reconnect');
    expect(kept).toMatch(/^t0 t1 .*t19 $/);
    expect(turnText(h.events, turnId)).toBe(kept);
  });

  test('a reply after reasoning that ended while the feed was down is caught up once', async () => {
    // The reads Station makes on reconnect were recorded before the turn
    // ended; the history read after it holds the finished reply.
    const ended =
      loadOpenCodeFixture('reasoning-reconnect').find(
        (record) => record.event?.type === 'session.execution.succeeded',
      )?.t ?? 0;
    expect(ended).toBeGreaterThan(0);
    const h = await setup({
      scenario: 'reasoning-reconnect',
      fallbacks: ['basic', 'catalog', 'mcp'],
      // As in `reconnect`: tap B shows nothing, and the reads on reconnect
      // find the turn finished, so its text comes from history alone.
      omit: (record) =>
        (record.tap === 'B' &&
          record.kind === 'sse' &&
          record.event?.type !== 'server.connected') ||
        (record.kind === 'http' &&
          record.method === 'GET' &&
          record.t < ended &&
          (record.path === '/api/session/active' ||
            record.path?.includes('/message?order=asc') === true)),
    });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_THINK_SLOW stream',
    });
    const completed = await h.waitFor(completedFor(turnId), 10_000);
    expect(turnText(h.events, turnId)).toBe(
      finalAssistantText('reasoning-reconnect'),
    );
    expect(completed).toMatchObject({ finishReason: 'stop' });
  });

  test.each(['unqualified', 'mock/missing'])(
    'an unavailable requested model %s refuses before creating a session',
    async (modelId) => {
      const h = await setup({ scenario: 'basic' });
      await expect(h.start(undefined, { modelId })).rejects.toThrow(
        /provider\/model|unavailable/,
      );
      expect(h.replay.made('POST', '/api/session')).toHaveLength(0);
    },
  );

  test('native and ACP resume bind to the effective custom home when XDG data home is absent', async () => {
    const h = await setup(
      { scenario: 'basic' },
      { launchEnv: async () => ({ HOME: '/replay/custom-home' }) },
    );
    const session = await h.start();
    expect(session.resumeCursor).toMatchObject({
      bindingKey: nativeResumeBindingKey(
        'opencode',
        '/replay/custom-home/.local/share/opencode',
        null,
      ),
    });
    const fallback = await setup(
      { scenario: 'basic' },
      {
        nativeEnabled: () => false,
        launchEnv: async () => ({ HOME: '/replay/custom-home' }),
      },
    );
    await expect(
      fallback.start(undefined, { resumeCursor: session.resumeCursor }),
    ).resolves.toBeDefined();
  });

  test('a catalog model is applied to a newly created session', async () => {
    const h = await setup({ scenario: 'basic' });
    await h.start(undefined, { modelId: 'mock/mock-1' });
    expect(h.replay.made('POST', '/api/session')[0]?.body).toMatchObject({
      model: { providerID: 'mock', id: 'mock-1' },
    });
  });

  test.each([204, 500])(
    'a per-turn model change must be accepted before the prompt (%s)',
    async (status) => {
      const h = await setup({
        scenario: 'basic',
        respond: (request) =>
          request.path.endsWith('/model') && request.method === 'POST'
            ? { status }
            : undefined,
      });
      await h.start(undefined, { modelId: 'mock/mock-1' });
      const sending = h.adapter.sendTurn({
        threadId: 'thread-1',
        input: 'hello basic',
        modelId: 'mock/mock-1',
      });
      if (status === 500) {
        await expect(sending).rejects.toThrow(
          'did not confirm the model change',
        );
        await expect(h.turn('hello basic')).rejects.toThrow(
          'Select a model again',
        );
        expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(
          0,
        );
      } else {
        const { turnId } = await sending;
        await h.waitFor(completedFor(turnId));
        expect(
          h.replay.made('POST', '/api/session/:id/model')[0]?.body,
        ).toEqual({ model: { providerID: 'mock', id: 'mock-1' } });
        const paths = h.replay.requests
          .filter((r) => r.method === 'POST')
          .map((r) => r.path);
        expect(paths.findIndex((p) => p.endsWith('/model'))).toBeLessThan(
          paths.findIndex((p) => p.endsWith('/prompt')),
        );
      }
    },
  );

  test.each(['catalog', 'model'])(
    'Stop wins while native %s preparation is held',
    async (heldOperation) => {
      let release = false;
      const h = await setup({
        scenario: 'basic',
        holdUntil: (r) =>
          (
            heldOperation === 'catalog'
              ? r.method === 'GET' && r.path === '/api/model'
              : r.method === 'POST' && r.path.endsWith('/model')
          )
            ? () => release
            : undefined,
        respond: (r) =>
          r.method === 'POST' && r.path.endsWith('/model')
            ? { status: 204 }
            : undefined,
      });
      await h.start();
      const sending = h.adapter.sendTurn({
        threadId: 'thread-1',
        input: 'must not run',
        modelId: 'mock/mock-1',
      });
      const outcome = sending.catch((e: unknown) => e);
      await h.waitFor(
        () =>
          h.replay.made(
            heldOperation === 'catalog' ? 'GET' : 'POST',
            heldOperation === 'catalog'
              ? '/api/model'
              : '/api/session/:id/model',
          ).length > 0,
      );
      await h.adapter.stopSession('thread-1');
      release = true;
      expect(String(await outcome)).toContain('has stopped');
      expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(0);
    },
  );

  test('an exact delivery receipt wins over a lost steer POST response', async () => {
    const home = makeTempDir('opencode-positive-receipt-');
    let deliveryObserved = false;
    const h = await setup(
      {
        scenario: 'steer',
        omit: withdrawnSteer,
        holdUntil: (r) =>
          (r.body as { delivery?: string })?.delivery === 'steer'
            ? (frame) =>
                deliveryObserved &&
                frame.event?.type === 'session.inbox.delivered' &&
                frame.event?.data?.inboxID === 'msg_1d71b024d001crEY1solwrshJq'
            : undefined,
        respond: (r) =>
          (r.body as { delivery?: string })?.delivery === 'steer'
            ? { status: 500 }
            : undefined,
      },
      { managedWorkspaceHomeDir: home },
    );
    const session = await h.start();
    const { turnId } = await h.turn('DO_BASH steer');
    const opened = await h.waitFor((e) => e.method === 'request.opened');
    const steering = h.adapter.steerTurn('thread-1', 'STEER-delivered', turnId);
    await h.waitFor(
      () => h.replay.made('POST', '/api/session/:id/prompt').length === 2,
    );
    await h.adapter.respondToRequest(
      'thread-1',
      opened.requestId as string,
      'accept',
    );
    await h.waitFor(
      (event) => event.method === 'turn.started' && event.inputKind === 'steer',
    );
    deliveryObserved = true;
    await expect(steering).resolves.toBeUndefined();
    await h.waitFor(completedFor(turnId));
    expect(h.replay.made('DELETE', '/api/session/:id/inbox/:id')).toHaveLength(
      0,
    );
    await h.adapter.stopSession('thread-1');
    const resumed = await setup(
      {
        scenario: 'basic',
        fallbacks: ['mode-switch', 'catalog', 'mcp', 'reconnect'],
        ungated: (r) => r.path === '/api/session',
      },
      { managedWorkspaceHomeDir: home },
    );
    await expect(
      resumed.start(undefined, { resumeCursor: session.resumeCursor }),
    ).resolves.toBeDefined();
  });

  test('/compact runs OpenCode compaction as the command turn', async () => {
    const h = await setup({ scenario: 'compact' });
    await h.start();
    const first = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'message one',
    });
    await h.waitFor(completedFor(first.turnId));
    const compact = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: '/compact',
    });
    await h.waitFor(completedFor(compact.turnId));
    expect(h.replay.made('POST', '/api/session/:id/compact')).toHaveLength(1);
    expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(1);
    expect(
      h.events.find(
        (event) =>
          event.method === 'runtime.warning' &&
          String(event.message).includes('compacted'),
      ),
    ).toMatchObject({ turnId: compact.turnId });
  });

  test('MCP server status is reported from the engine', async () => {
    const h = await setup({ scenario: 'basic' });
    await h.start();
    expect(
      await h.waitFor((event) => event.method === 'engine-mcp.status'),
    ).toMatchObject({
      complete: true,
      servers: [
        { name: 'broken', state: 'failed', scope: 'engine-config' },
        { name: 'echo', state: 'ready', scope: 'engine-config' },
      ],
    });
  });

  test('governed preflight and start inspect the project before acquiring a serve lease', async () => {
    const cwd = realpathSync(makeTempDir('opencode-governed-launch-'));
    mkdirSync(join(cwd, '.git'));
    const configDir = join(cwd, '.opencode');
    writeFileSync(configDir, 'ordinary text');
    const h = await setup(
      { scenario: 'basic' },
      { findProjectCode: undefined },
      cwd,
    );
    const modelOptions = { approvalMode: 'ask' };
    const input = {
      threadId: 'thread-1',
      provider: 'opencode' as const,
      cwd,
      metadata: { connectionId: 'opencode' },
      modelOptions,
    };
    const refusal = {
      code: 'acp_approval_governance_refused',
      message: expect.stringContaining(configDir),
    };

    await expect(h.adapter.preflightStart(input)).rejects.toMatchObject(
      refusal,
    );
    expect(h.leaser.acquired).toHaveLength(0);
    await expect(h.adapter.startSession(input)).rejects.toMatchObject(refusal);
    expect(h.leaser.acquired).toHaveLength(0);

    unlinkSync(configDir);
    writeFileSync(join(cwd, 'opencode.json'), '{"formatter":false}');
    await h.adapter.preflightStart(input);
    expect(h.leaser.acquired).toHaveLength(1);

    writeFileSync(configDir, 'ordinary text');
    await expect(h.adapter.startSession(input)).rejects.toMatchObject(refusal);
    expect(h.leaser.acquired).toHaveLength(1);
    expect(h.leaser.released).toBe(1);
    expect(h.replay.made('POST', '/api/session')).toHaveLength(0);

    unlinkSync(configDir);
    const session = await h.adapter.startSession(input);
    expect(session.resumeCursor).toMatchObject({ transport: 'native' });
    expect(h.leaser.acquired).toHaveLength(2);
  });

  test('cancelling a governed preflight releases its retained serve lease', async () => {
    const h = await setup({ scenario: 'basic' });
    const cancel = new AbortController();
    await h.adapter.preflightStart({
      threadId: 'thread-1',
      provider: 'opencode',
      cwd: '/replay/proj',
      metadata: { connectionId: 'opencode' },
      modelOptions: { approvalMode: 'ask' },
      signal: cancel.signal,
    });
    expect(h.leaser.acquired).toHaveLength(1);
    cancel.abort();
    expect(h.leaser.released).toBe(1);
    expect(h.replay.made('POST', '/api/session')).toHaveLength(0);
  });

  test('a governed start sends Station rules and pins a governed agent', async () => {
    const h = await setup({ scenario: 'basic' });
    await h.adapter.preflightStart({
      threadId: 'thread-1',
      provider: 'opencode',
      cwd: '/replay/proj',
      metadata: { connectionId: 'opencode' },
      modelOptions: { approvalMode: 'ask' },
    });
    await h.start({ approvalMode: 'ask' });
    const body = h.replay.made('POST', '/api/session')[0]?.body as {
      agent: string;
      permissions: Array<{ action: string; effect: string }>;
    };
    expect(body.agent).toBe('build');
    expect(body.permissions).toEqual(
      expect.arrayContaining([
        { action: 'shell', resource: '*', effect: 'ask' },
        { action: 'edit', resource: '*', effect: 'ask' },
        { action: 'subagent', resource: '*', effect: 'ask' },
      ]),
    );
    // Station only asks for what an agent's rules govern (an allow or a
    // deny of its own would change what they decide); its one deny is
    // Code Mode's session move, which no agent rule governs.
    expect(body.permissions.filter((rule) => rule.effect !== 'ask')).toEqual([
      { action: 'opencode_session_move', resource: '*', effect: 'deny' },
    ]);
    expect(
      h.replay.made('GET', '/api/permission/saved').length,
    ).toBeGreaterThan(0);
  });

  test('a saved OpenCode approval for a governed action refuses a governed start', async () => {
    const h = await setup({
      scenario: 'basic',
      fallbacks: ['permission-saved', 'catalog', 'mcp'],
    });
    const refused = h.start({ approvalMode: 'ask' });
    await expect(refused).rejects.toBeInstanceOf(
      ApprovalGovernanceRefusedError,
    );
    await expect(refused).rejects.toThrow('shell echo *');
    expect(h.replay.made('POST', '/api/session')).toHaveLength(0);
    // Without a Station mode, OpenCode's own approvals decide: no refusal.
    await h.start();
  });

  test('a server whose API differs from the verified one falls back to ACP', async () => {
    const h = await setup(
      { scenario: 'basic' },
      { verifiedFingerprints: { '2.3.0': 'sha256:not-this-one' } },
    );
    const session = await h.start();
    expect(h.leaser.discarded).toBe(1);
    expect(h.replay.made('POST', '/api/session')).toHaveLength(0);
    expect(
      h.events.find((event) => event.method === 'runtime.warning'),
    ).toMatchObject({ code: OPENCODE_NATIVE_UNVERIFIED, threadId: 'thread-1' });
    const inner = h.inner();
    expect(inner?.provider).toBe('opencode');
    expect(inner?.filter?.(CONNECTION)).toBe(true);
    expect(inner?.starts).toHaveLength(1);
    expect(session).toMatchObject({
      provider: 'opencode',
      resumeCursor: {
        kind: 'opencode',
        transport: 'acp',
        sessionId: 'ses_acp',
        acp: { acpSessionId: 'ses_acp' },
      },
    });
    // The verdict is kept: the next start does not spawn to ask again.
    await h.adapter.startSession({
      threadId: 'thread-2',
      provider: 'opencode',
      cwd: '/replay/proj',
      metadata: { connectionId: 'opencode' },
    });
    expect(h.leaser.acquired).toHaveLength(1);
  });

  test('with the native transport off every session runs over ACP', async () => {
    const h = await setup(
      { scenario: 'basic' },
      { nativeEnabled: () => false },
    );
    await h.start();
    expect(h.leaser.acquired).toHaveLength(0);
    expect(h.inner()?.starts).toHaveLength(1);
  });

  test('OpenCode sessions are not adoptable, and a foreign cursor is refused', async () => {
    const h = await setup({ scenario: 'basic' });
    const shape: ProviderAdapterShape = h.adapter;
    expect(shape.adoptSession).toBeUndefined();
    expect(shape.discardSession).toBeUndefined();
    await expect(
      h.adapter.startSession({
        threadId: 'thread-1',
        provider: 'opencode',
        metadata: { connectionId: 'opencode' },
        resumeCursor: { acpSessionId: 'ses_x', connectionId: 'opencode' },
      }),
    ).rejects.toThrow('not one Station wrote');
  });
});

/** The whole captured long history, oldest first (66 messages). */
function capturedLongHistory(): Array<Record<string, unknown>> {
  const pages = loadOpenCodeFixture('history').filter(
    (line) =>
      line.kind === 'http' &&
      line.status === 200 &&
      line.path?.includes('/message?') === true &&
      !line.path.includes('order=asc'),
  );
  return pages
    .flatMap(
      (page) =>
        (page.response as { data: Array<Record<string, unknown>> }).data,
    )
    .reverse();
}

/** `count` earlier messages of the captured shape, each with its own id. */
function olderMessages(count: number): Array<Record<string, unknown>> {
  const source = capturedLongHistory();
  return Array.from({ length: count }, (_, index) => {
    const message = source[index % source.length] as Record<string, unknown>;
    return { ...message, id: `${message.id as string}o${index}` };
  });
}

/** `count` captured assistant messages with no content: steps with no text. */
function silentSteps(count: number): Array<Record<string, unknown>> {
  const assistant = capturedLongHistory().find(
    (message) => message.type === 'assistant',
  ) as Record<string, unknown>;
  return Array.from({ length: count }, (_, index) => ({
    ...assistant,
    id: `${assistant.id as string}s${index}`,
    content: [],
  }));
}

/** The rules a fixture's `GET /api/agent/<id>` answered with. */
function recordedAgentRules(scenario: string, agent: string) {
  const record = loadOpenCodeFixture(scenario).find(
    (line) =>
      line.kind === 'http' &&
      line.method === 'GET' &&
      line.path === `/api/agent/${agent}` &&
      line.status === 200,
  );
  if (!record) throw new Error(`${scenario} recorded no ${agent} agent`);
  return (record.response as { data: { permissions: OpenCodeNativeRule[] } })
    .data.permissions;
}

function recordedSessionId(scenario: string): string {
  const record = loadOpenCodeFixture(scenario).find(
    (line) =>
      line.kind === 'http' &&
      line.method === 'POST' &&
      line.path === '/api/session',
  );
  if (!record) throw new Error(`${scenario} created no session`);
  return (record.response as { data: { id: string } }).data.id;
}

const opened = (events: Event[]) =>
  events.filter((event) => event.method === 'request.opened');

describe('OpenCodeAdapter native governance and lifecycle (2.3.0 replay)', () => {
  test("a turn that moves to Ask puts Ask's rules on the live session before its prompt; an agent switch follows the turn", async () => {
    const h = await setup({ scenario: 'mode-switch' });
    await h.start({ approvalMode: 'never' }, { confinement: 'host' });
    const build = recordedAgentRules('mode-switch', 'build');
    const created = h.replay.made('POST', '/api/session')[0]?.body as {
      permissions?: OpenCodeNativeRule[];
    };
    // Full access sends no rules: the agent's own decide, and this one asks
    // for shell, which Station answers `once` without a person.
    expect(created.permissions).toBeUndefined();
    expect(
      evaluateOpenCodeRules(
        { action: 'shell', resources: ['echo hi'] },
        build,
        [],
      ),
    ).toBe('ask');
    const full = await h.turn('DO_BASH full');
    await h.waitFor(completedFor(full.turnId));
    expect(opened(h.events)).toHaveLength(0);
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'once' }]);

    const ask = await h.turn('DO_BASH ask', { approvalMode: 'ask' });
    const patches = h.replay.made('PATCH', '/api/session/:id');
    expect(patches).toHaveLength(1);
    const asked = patches[0]?.body as { permissions: OpenCodeNativeRule[] };
    expect(
      evaluateOpenCodeRules(
        { action: 'shell', resources: ['echo hi'] },
        [...build, ...asked.permissions],
        [],
      ),
    ).toBe('ask');
    // The rules went to OpenCode before the prompt did.
    const order = h.replay.requests.map((request) =>
      request.method === 'POST' && request.path.endsWith('/prompt')
        ? 'prompt'
        : request.method,
    );
    expect(order.lastIndexOf('PATCH')).toBeLessThan(
      order.lastIndexOf('prompt'),
    );
    expect(order.lastIndexOf('PATCH')).toBeGreaterThan(order.indexOf('prompt'));
    const request = await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === ask.turnId,
    );
    expect(request).toMatchObject({ payload: { toolName: 'shell' } });
    await h.adapter.respondToRequest(
      'thread-1',
      request.requestId as string,
      'accept',
    );
    await h.waitFor(completedFor(ask.turnId));

    const plan = await h.turn('hello plan', {
      approvalMode: 'ask',
      mode: 'plan',
    });
    expect(h.replay.made('POST', '/api/session/:id/agent')[0]?.body).toEqual({
      agent: 'plan',
    });
    await h.waitFor(completedFor(plan.turnId));
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'session.engine-mode-observed' &&
          event.modeId === 'plan',
      ),
    ).toBeDefined();
    expect(
      h.events.filter((event) => event.method === 'session.configured').at(-1),
    ).toMatchObject({ cwd: '/replay/proj', model: 'mock/mock-1' });
  });

  /** Fails the first `count` requests `match` names with a 500. */
  const failFirst = (
    match: (request: { method: string; path: string }) => boolean,
    count = 1,
  ) => {
    let left = count;
    return (request: { method: string; path: string }) => {
      if (!match(request) || left <= 0) return undefined;
      left -= 1;
      return { status: 500, body: { _tag: 'UnknownError', message: 'boom' } };
    };
  };
  /** The writes that reached OpenCode, as `METHOD last-segment`, from `from` on. */
  const wire = (h: { replay: OpenCodeServeReplay }, from = 0) =>
    h.replay.requests
      .slice(from)
      .filter((request) => request.method !== 'GET')
      .map(
        (request) =>
          `${request.method} ${request.path.split('?')[0]?.split('/').at(-1)}`,
      );

  test('a failed agent switch refuses the turn, and the next turn switches again before its prompt', async () => {
    const h = await setup({
      scenario: 'mode-switch',
      respond: failFirst(
        (request) =>
          request.method === 'POST' && request.path.endsWith('/agent'),
      ),
    });
    await h.start({ approvalMode: 'ask' });
    const refused = h.turn('hello plan', { approvalMode: 'ask', mode: 'plan' });
    await expect(refused).rejects.toBeInstanceOf(SendTurnRefusedError);
    await expect(refused).rejects.toThrow('did not switch to the plan agent');
    expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(0);
    // OpenCode may have switched anyway: the next turn, naming nothing,
    // applies the agent and the rules again before its prompt.
    const from = h.replay.requests.length;
    await h.turn('DO_BASH full');
    expect(wire(h, from).slice(0, 3)).toEqual([
      'POST agent',
      expect.stringMatching(/^PATCH /),
      'POST prompt',
    ]);
    expect(
      h.replay.made('POST', '/api/session/:id/agent').at(-1)?.body,
    ).toEqual({ agent: 'build' });
  });

  test('an agent switch whose rules then fail to apply refuses the turn with what failed, and the next turn applies both again', async () => {
    const h = await setup({
      scenario: 'mode-switch',
      respond: failFirst(
        (request) =>
          request.method === 'PATCH' &&
          /^\/api\/session\/[^/]+$/.test(request.path),
      ),
    });
    await h.start({ approvalMode: 'never' }, { confinement: 'host' });
    const refused = h.turn('hello plan', { approvalMode: 'ask', mode: 'plan' });
    await expect(refused).rejects.toBeInstanceOf(
      ApprovalGovernanceRefusedError,
    );
    await expect(refused).rejects.toThrow(
      /^Couldn't switch OpenCode to Station's approval rules; it is still running with full access, so this message was not sent/,
    );
    expect(h.replay.made('POST', '/api/session/:id/agent')).toHaveLength(1);
    expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(0);
    // The agent did switch; the rules did not. The next turn, naming
    // nothing, does not take that as settled: it applies both again.
    const from = h.replay.requests.length;
    await h.turn('DO_BASH full');
    expect(wire(h, from).slice(0, 3)).toEqual([
      'POST agent',
      expect.stringMatching(/^PATCH /),
      'POST prompt',
    ]);
  });

  test('two turns sent at once: the second is refused as busy before it applies anything', async () => {
    const h = await setup({ scenario: 'mode-switch' });
    await h.start({ approvalMode: 'never' }, { confinement: 'host' });
    const from = h.replay.requests.length;
    const first = h.turn('DO_BASH ask', { approvalMode: 'ask' });
    const second = h.turn('DO_BASH ask', { approvalMode: 'ask' });
    await expect(second).rejects.toMatchObject({
      name: 'SendTurnRefusedError',
      kind: 'busy',
    });
    await first;
    // The second read nothing: refused before its settings were looked at
    // (the moment its busy mark is set, before any await).
    expect(
      h.replay.requests
        .slice(from)
        .filter((request) => request.path === '/api/agent/build'),
    ).toHaveLength(1);
    expect(h.replay.made('PATCH', '/api/session/:id')).toHaveLength(1);
    expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(1);
  });

  test('a turn that names an agent the modes do not cover is refused before anything is sent', async () => {
    const h = await setup({ scenario: 'mode-switch' });
    await h.start({ approvalMode: 'ask' });
    await expect(
      h.turn('DO_BASH ask', { approvalMode: 'ask', mode: 'explore' }),
    ).rejects.toBeInstanceOf(ApprovalGovernanceRefusedError);
    expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(0);
    expect(h.replay.made('POST', '/api/session/:id/agent')).toHaveLength(0);
  });

  test('the agent lookup asks again while a just-started server still answers 404', async () => {
    const h = await setup({
      scenario: 'basic',
      fallbacks: ['boot', 'catalog', 'mcp'],
    });
    await h.start({ approvalMode: 'ask' });
    const lookups = h.replay.made('GET', '/api/agent/build');
    expect(lookups).toHaveLength(2);
    expect(
      loadOpenCodeFixture('boot').find(
        (line) => line.path === '/api/agent/build',
      ),
    ).toMatchObject({ status: 404, response: { _tag: 'AgentNotFoundError' } });
  });

  test('Auto answers an edit; a session grant answers the same command again, and only that command', async () => {
    const h = await setup({ scenario: 'governed' });
    await h.start({ approvalMode: 'auto' });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    // Station's mode answered it: nobody was asked.
    expect(opened(h.events)).toHaveLength(0);
    expect(
      h.events.find(
        (event) =>
          event.method === 'tool.completed' && event.turnId === edit.turnId,
      ),
    ).toMatchObject({ toolName: 'edit', status: 'success' });

    const first = await h.turn('DO_BASH two');
    const shell = await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === first.turnId,
    );
    await h.adapter.respondToRequest(
      'thread-1',
      shell.requestId as string,
      'acceptForSession',
    );
    await h.waitFor(completedFor(first.turnId));

    const again = await h.turn('DO_BASH three');
    await h.waitFor(completedFor(again.turnId));
    expect(opened(h.events)).toHaveLength(1);

    // `ls -a` is not `echo *`: the grant does not cover it.
    const other = await h.turn('DO_LS four');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === other.turnId,
      ),
    ).toMatchObject({ payload: { rawInput: { resources: ['ls -a'] } } });
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([
      { decision: 'once' },
      { decision: 'once' },
      { decision: 'once' },
    ]);
  });

  /** The governed capture with one ask's action and resources replaced. */
  const askRewrite =
    (
      matches: (data: Record<string, unknown>) => boolean,
      replace: { action: string; resources: string[]; save: string[] },
    ) =>
    (record: OpenCodeReplayRecord): OpenCodeReplayRecord =>
      record.kind === 'sse' &&
      record.event?.type === 'permission.asked' &&
      record.event.data &&
      matches(record.event.data)
        ? {
            ...record,
            event: {
              ...record.event,
              data: { ...record.event.data, ...replace, metadata: undefined },
            },
          }
        : record;

  test('Auto does not answer an edit of OpenCode configuration: the person is asked, nothing is answered for them', async () => {
    const h = await setup({
      scenario: 'governed',
      rewrite: askRewrite((data) => data.action === 'edit', {
        action: 'edit',
        resources: ['opencode.json'],
        save: ['*'],
      }),
    });
    await h.start({ approvalMode: 'auto' });
    const edit = await h.turn('DO_EDIT one');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === edit.turnId,
      ),
    ).toMatchObject({
      payload: {
        toolName: 'edit',
        rawInput: { action: 'edit', resources: ['opencode.json'] },
      },
    });
    expect(
      h.replay.made('POST', '/api/session/:id/permission/:id/reply'),
    ).toEqual([]);
  });

  test('a session grant for edit does not answer a later edit of `.opencode/`', async () => {
    const h = await setup({
      scenario: 'governed',
      // The first shell ask, made an edit of a plugin file.
      rewrite: askRewrite(
        (data) => data.id === 'per_1d83ac1d0001O6wuCIGs0aAEtz',
        {
          action: 'edit',
          resources: ['.opencode/plugin/pwn.ts'],
          save: ['*'],
        },
      ),
    });
    await h.start({ approvalMode: 'ask' });
    const edit = await h.turn('DO_EDIT one');
    const editAsk = await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === edit.turnId,
    );
    // Its save pattern is `*`: the grant covers every edit.
    await h.adapter.respondToRequest(
      'thread-1',
      editAsk.requestId as string,
      'acceptForSession',
    );
    await h.waitFor(completedFor(edit.turnId));
    const plugin = await h.turn('DO_BASH two');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === plugin.turnId,
      ),
    ).toMatchObject({
      requestId: 'per_1d83ac1d0001O6wuCIGs0aAEtz',
      payload: { rawInput: { resources: ['.opencode/plugin/pwn.ts'] } },
    });
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'once' }]);
  });

  test('an automatic answer OpenCode refuses is put to the person instead of leaving the ask hidden', async () => {
    const h = await setup({
      scenario: 'governed',
      respond: (request) =>
        request.method === 'POST' && request.path.endsWith('/reply')
          ? { status: 500, body: { error: 'reply broke' } }
          : undefined,
    });
    await h.start({ approvalMode: 'auto' });
    const edit = await h.turn('DO_EDIT one');
    const ask = await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === edit.turnId,
    );
    expect(ask).toMatchObject({
      requestId: 'per_1d83abafd001dDBOpF7qGF2ora',
      payload: { toolName: 'edit' },
    });
    expect(ask.description).toMatch(
      /Station could not allow this automatically/,
    );
    // Station tried once itself.
    expect(
      h.replay.made('POST', '/api/session/:id/permission/:id/reply'),
    ).toHaveLength(1);
  });

  test('an automatic answer to an ask OpenCode already dropped (404) opens nothing', async () => {
    const h = await setup({
      scenario: 'governed',
      respond: (request) =>
        request.method === 'POST' && request.path.endsWith('/reply')
          ? { status: 404, body: { error: 'gone' } }
          : undefined,
    });
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_EDIT one');
    await h.waitFor(
      () =>
        h.replay.made('POST', '/api/session/:id/permission/:id/reply')
          .length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened(h.events)).toEqual([]);
  });

  const CHILD = 'ses_e28e4e140ffemsWOeVxszItzHu';
  /**
   * The subagent capture with an ask from its child (agent `general`) in
   * place of the child's first text frame. A child inherits its parent's
   * session rules (`core/src/session.ts` create), so it asks what they ask.
   */
  const childAsk =
    (action: string, resources: string[]) =>
    (record: OpenCodeReplayRecord): OpenCodeReplayRecord =>
      record.kind === 'sse' &&
      record.event?.type === 'session.text.started' &&
      record.event.data?.sessionID === CHILD
        ? {
            ...record,
            event: {
              ...record.event,
              type: 'permission.asked',
              data: {
                id: 'per_child',
                sessionID: CHILD,
                action,
                resources,
                save: ['*'],
              },
            },
          }
        : record;
  /** The subagent capture with its child created in `directory`. */
  const childIn =
    (directory: string) =>
    (record: OpenCodeReplayRecord): OpenCodeReplayRecord =>
      record.kind === 'sse' &&
      record.event?.type === 'session.created' &&
      record.event.data?.sessionID === CHILD
        ? {
            ...record,
            event: {
              ...record.event,
              data: { ...record.event.data, location: { directory } },
            },
          }
        : record;
  /** Agent rules by name, an empty saved list, and 204 for every reply. */
  const childGovernance =
    (rules: Record<string, OpenCodeNativeRule[] | 'fail'>) =>
    (request: { method: string; path: string }) => {
      if (request.method === 'POST' && request.path.endsWith('/reply'))
        return { status: 204 };
      if (request.method === 'GET' && request.path === '/api/permission/saved')
        return { status: 200, body: { data: [] } };
      const agent = /^\/api\/agent\/([^/]+)$/.exec(request.path)?.[1];
      if (request.method !== 'GET' || !agent) return undefined;
      const found = rules[agent];
      if (found === 'fail') return { status: 500, body: { error: 'no' } };
      return {
        status: 200,
        body: { data: { name: agent, permissions: found ?? [] } },
      };
    };
  const repliesTo = (h: { replay: OpenCodeServeReplay }, session: string) =>
    h.replay.requests
      .filter(
        (request) =>
          request.method === 'POST' &&
          request.path.startsWith(`/api/session/${session}/permission/`),
      )
      .map((request) => request.body);

  test("a governed child's ask is decided on the child's own agent's rules: its deny is kept though Auto answers edits", async () => {
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('edit', ['notes.txt']),
      respond: childGovernance({
        build: [],
        general: [{ action: 'edit', resource: '*', effect: 'deny' }],
      }),
    });
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    expect(repliesTo(h, CHILD)).toEqual([{ decision: 'reject' }]);
    expect(
      h.replay.requests.map((request) => `${request.method} ${request.path}`),
    ).toContain('GET /api/agent/general');
    expect(opened(h.events)).toEqual([]);
  });

  test("a governed child whose agent denies nothing gets the session's answer: Auto answers its edit `once`", async () => {
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('edit', ['notes.txt']),
      respond: childGovernance({ build: [], general: [] }),
    });
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    expect(repliesTo(h, CHILD)).toEqual([{ decision: 'once' }]);
  });

  test("a governed child's ask goes to the person when its agent's rules cannot be read", async () => {
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('edit', ['notes.txt']),
      respond: childGovernance({ build: [], general: 'fail' }),
    });
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    expect(
      await h.waitFor((event) => event.method === 'request.opened'),
    ).toMatchObject({
      requestId: 'per_child',
      payload: { childWork: { childId: CHILD } },
    });
    expect(repliesTo(h, CHILD)).toEqual([]);
  });

  test("under full access a child's ask is answered `once`, as the session's own", async () => {
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('shell', ['echo child']),
      respond: childGovernance({}),
    });
    await h.start({ approvalMode: 'never' }, { confinement: 'host' });
    const { turnId } = await h.turn('DO_TASK now');
    await h.waitFor(completedFor(turnId));
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    expect(repliesTo(h, CHILD)).toEqual([{ decision: 'once' }]);
    expect(opened(h.events)).toEqual([]);
  });

  test("a failed move to full access after an agent switch keeps the new agent's denies under the rules that still govern", async () => {
    const h = await setup({
      scenario: 'plan-deny',
      respond: (request) => {
        if (request.method === 'POST' && request.path.endsWith('/agent'))
          return { status: 204 };
        if (
          request.method === 'PATCH' &&
          /^\/api\/session\/[^/]+$/.test(request.path)
        )
          return { status: 500, body: { error: 'patch broke' } };
        return undefined;
      },
    });
    // Auto on the build agent, which denies nothing here.
    await h.start({ approvalMode: 'auto' });
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_EDIT plan',
      modelOptions: { approvalMode: 'never', mode: 'plan' },
      confinement: 'host',
    });
    // The switch to plan happened; the rules did not change, so Auto's
    // still govern, and the warning says so.
    expect(
      await h.waitFor(
        (event) => event.code === ACP_APPROVAL_TAKEOVER_FAILED_CODE,
      ),
    ).toMatchObject({ details: { appliedApprovalMode: 'auto' } });
    await h.waitFor(completedFor(turnId));
    // Auto answers edits, but plan denies them: Station rejects on plan's
    // rules, not build's.
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'reject' }]);
    expect(opened(h.events)).toEqual([]);
  });

  test('a session grant ends when the approval mode changes', async () => {
    const h = await setup({ scenario: 'governed' });
    await h.start({ approvalMode: 'ask' });
    const edit = await h.turn('DO_EDIT one');
    const editAsk = await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === edit.turnId,
    );
    await h.adapter.respondToRequest(
      'thread-1',
      editAsk.requestId as string,
      'accept',
    );
    await h.waitFor(completedFor(edit.turnId));
    const first = await h.turn('DO_BASH two');
    const shell = await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === first.turnId,
    );
    await h.adapter.respondToRequest(
      'thread-1',
      shell.requestId as string,
      'acceptForSession',
    );
    await h.waitFor(completedFor(first.turnId));
    // Same floor, so no new rules; but the grant made under Ask is gone.
    const again = await h.turn('DO_BASH three', { approvalMode: 'auto' });
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === again.turnId,
      ),
    ).toMatchObject({ payload: { toolName: 'shell' } });
    expect(h.replay.made('PATCH', '/api/session/:id')).toHaveLength(0);
  });

  test('an interrupt with an ask pending closes the ask, and a late answer is refused without reaching OpenCode', async () => {
    const h = await setup({ scenario: 'interrupt-pending' });
    await h.start({ approvalMode: 'ask' });
    const { turnId } = await h.turn('DO_BASH wait');
    const ask = await h.waitFor((event) => event.method === 'request.opened');
    expect(await h.adapter.interruptTurn('thread-1', turnId)).toEqual({
      outcome: 'cancelled',
      turnId,
    });
    await h.waitFor(
      (event) => event.method === 'turn.aborted' && event.turnId === turnId,
    );
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.resolved' &&
          event.requestId === ask.requestId,
      ),
    ).toMatchObject({ status: 'cancelled', turnId });
    await expect(
      h.adapter.respondToRequest('thread-1', ask.requestId as string, 'accept'),
    ).rejects.toBeInstanceOf(OpenCodeRequestClosedError);
    expect(
      h.replay.made('POST', '/api/session/:id/permission/:id/reply'),
    ).toHaveLength(0);
  });

  test('stopping a session with an ask pending interrupts OpenCode, then rejects the ask, before letting go', async () => {
    const h = await setup({ scenario: 'stop-pending' });
    await h.start({ approvalMode: 'ask' });
    const { turnId } = await h.turn('DO_BASH stop');
    const ask = await h.waitFor((event) => event.method === 'request.opened');
    await h.adapter.stopSession('thread-1');
    const replies = h.replay.made(
      'POST',
      '/api/session/:id/permission/:id/reply',
    );
    expect(replies.map((reply) => reply.body)).toEqual([
      { decision: 'reject' },
    ]);
    expect(h.replay.made('POST', '/api/session/:id/interrupt')).toHaveLength(1);
    const methods = h.replay.requests.map(
      (request) => `${request.method} ${request.path.split('/').at(-1)}`,
    );
    expect(methods.indexOf('POST interrupt')).toBeLessThan(
      methods.indexOf('POST reply'),
    );
    expect(h.leaser.released).toBe(1);
    expect(
      await h.waitFor(
        (event) => event.method === 'turn.aborted' && event.turnId === turnId,
      ),
    ).toMatchObject({ reason: 'session-stopped' });
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.resolved' &&
          event.requestId === ask.requestId,
      ),
    ).toMatchObject({ status: 'cancelled' });
  });

  test('a reply OpenCode never answers does not hold back the interrupt when a session stops', async () => {
    const h = await setup({
      scenario: 'stop-pending',
      // The ask's reply hangs until the replay closes.
      holdUntil: (request) =>
        request.path.endsWith('/reply') ? () => false : undefined,
    });
    await h.start({ approvalMode: 'ask' });
    await h.turn('DO_BASH stop');
    await h.waitFor((event) => event.method === 'request.opened');
    const started = Date.now();
    await h.adapter.stopSession('thread-1');
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(h.replay.made('POST', '/api/session/:id/interrupt')).toHaveLength(1);
    expect(
      h.replay.made('POST', '/api/session/:id/permission/:id/reply'),
    ).toHaveLength(1);
    expect(h.leaser.released).toBe(1);
  });

  test('stopping a session withdraws its queued steer from the inbox', async () => {
    const steerId = 'msg_1d71b024d001crEY1solwrshJq';
    const h = await setup({ scenario: 'steer', omit: withdrawnSteer });
    await h.start();
    const { turnId } = await h.turn('DO_BASH steer');
    await h.waitFor((event) => event.method === 'request.opened');
    const steer = h.adapter.steerTurn('thread-1', 'STEER-delivered', turnId);
    await h.waitFor(
      () => h.replay.made('POST', '/api/session/:id/prompt').length === 2,
    );
    // Let its prompt's answer reach the session before it stops.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.adapter.stopSession('thread-1');
    await expect(steer).rejects.toBeInstanceOf(ProviderTurnEndedError);
    expect(
      h.replay
        .made('DELETE', '/api/session/:id/inbox/:id')
        .map((request) => request.path.split('/').at(-1)),
    ).toEqual([steerId]);
  });

  test.each([204, 500])(
    'a stopped in-flight steer keeps resume custody until withdrawal (%s)',
    async (deleteStatus) => {
      const home = makeTempDir('opencode-held-custody-');
      let released = false;
      const h = await setup(
        {
          scenario: 'steer',
          omit: withdrawnSteer,
          respond: (r) =>
            r.method === 'DELETE' && r.path.includes('/inbox/')
              ? { status: deleteStatus }
              : undefined,
          holdUntil: (r) =>
            JSON.stringify(r.body ?? null).includes('STEER-delivered')
              ? () => released
              : undefined,
        },
        { managedWorkspaceHomeDir: home },
      );
      const session = await h.start();
      const { turnId } = await h.turn('DO_BASH steer');
      await h.waitFor((e) => e.method === 'request.opened');
      const steering = h.adapter.steerTurn(
        'thread-1',
        'STEER-delivered',
        turnId,
      );
      const outcome = steering.then(
        () => 'delivered',
        (error: unknown) => error,
      );
      await h.waitFor(
        () => h.replay.made('POST', '/api/session/:id/prompt').length === 2,
      );
      await h.adapter.stopSession('thread-1');
      const resumed = await setup(
        {
          scenario: 'basic',
          fallbacks: ['mode-switch', 'catalog', 'mcp', 'reconnect'],
          ungated: (r) => r.path === '/api/session',
        },
        { managedWorkspaceHomeDir: home },
      );
      await expect(
        resumed.start(undefined, { resumeCursor: session.resumeCursor }),
      ).rejects.toThrow('unconfirmed steering input');
      released = true;
      if (deleteStatus === 500) {
        expect(String(await outcome)).toContain('withdrawal is unconfirmed');
        await expect(
          resumed.start(undefined, { resumeCursor: session.resumeCursor }),
        ).rejects.toThrow('unconfirmed steering input');
      } else {
        expect(await outcome).toBeInstanceOf(ProviderTurnEndedError);
        await expect(
          resumed.start(undefined, { resumeCursor: session.resumeCursor }),
        ).resolves.toBeDefined();
      }
    },
  );

  test("the plan agent's deny survives Station's rules under Auto: OpenCode asks and Station rejects", async () => {
    const h = await setup({ scenario: 'plan-deny' });
    await h.start({ approvalMode: 'auto', mode: 'plan' });
    const plan = recordedAgentRules('plan-deny', 'plan');
    const body = h.replay.made('POST', '/api/session')[0]?.body as {
      agent: string;
      permissions: OpenCodeNativeRule[];
    };
    expect(body.agent).toBe('plan');
    // With Station's asks after them the agent's deny no longer decides in
    // OpenCode, so the edit is asked...
    expect(
      evaluateOpenCodeRules(
        { action: 'edit', resources: ['edit-me.txt'] },
        [...plan, ...body.permissions],
        [],
      ),
    ).toBe('ask');
    const { turnId } = await h.turn('DO_EDIT plan');
    await h.waitFor(completedFor(turnId));
    // ...and Station rejects it on the agent's rules alone, though Auto
    // answers edits: nobody is asked.
    expect(opened(h.events)).toHaveLength(0);
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'reject' }]);
    expect(
      h.events.find((event) => event.method === 'tool.completed'),
    ).toMatchObject({ toolName: 'edit', status: 'error' });
  });

  /** Answers `GET /api/agent/build` with the captured agent and `rules`. */
  const withBuildRules = (rules: OpenCodeNativeRule[]) => {
    const record = loadOpenCodeFixture('catalog').find(
      (line) =>
        line.kind === 'http' &&
        line.method === 'GET' &&
        line.path === '/api/agent/build' &&
        line.status === 200,
    );
    if (!record) throw new Error('catalog recorded no build agent');
    const data = (record.response as { data: Record<string, unknown> }).data;
    return (request: { method: string; path: string }) =>
      request.method === 'GET' && request.path === '/api/agent/build'
        ? { status: 200, body: { data: { ...data, permissions: rules } } }
        : undefined;
  };

  test('a lockdown agent (deny all but shell and read) keeps its edit deny under Ask, and its shell is still asked', async () => {
    const h = await setup({
      scenario: 'governed',
      respond: withBuildRules([
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*', effect: 'allow' },
      ]),
    });
    await h.start({ approvalMode: 'ask' });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    expect(opened(h.events)).toHaveLength(0);
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'reject' }]);
    // The agent allows shell; Ask still asks the person, as Station's rule says.
    const shell = await h.turn('DO_BASH two');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === shell.turnId,
      ),
    ).toMatchObject({ payload: { toolName: 'shell' } });
  });

  test('a narrower allow after a deny (`edit * deny, edit ? allow`) does not let Auto answer an edit the deny covers', async () => {
    const h = await setup({
      scenario: 'governed',
      respond: withBuildRules([
        { action: '*', resource: '*', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'edit', resource: '?', effect: 'allow' },
      ]),
    });
    await h.start({ approvalMode: 'auto' });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    expect(opened(h.events)).toHaveLength(0);
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'reject' }]);
  });

  test('a feed drop between the prompt and its execution start does not wedge the turn', async () => {
    const promptAt = loadOpenCodeFixture('reconnect').find(
      (line) => line.kind === 'http' && line.path?.endsWith('/prompt') === true,
    )?.t as number;
    const h = await setup({
      scenario: 'reconnect',
      // Tap A shows nothing after the prompt: the start was in the gap.
      omit: (record) =>
        record.tap === 'A' && record.kind === 'sse' && record.t >= promptAt,
    });
    await h.start();
    const { turnId } = await h.turn('DO_SLOW stream');
    const completed = await h.waitFor(completedFor(turnId), 10_000);
    expect(completed).toMatchObject({ finishReason: 'stop' });
    expect(turnText(h.events, turnId)).toBe(finalAssistantText('reconnect'));
  });

  test('the replay pages history exactly as the captured 2.3.0 handler did', () => {
    const reads = loadOpenCodeFixture('history').filter(
      (line) => line.kind === 'http' && line.path?.includes('/message?'),
    );
    const all = capturedLongHistory();
    expect(all.length).toBeGreaterThan(50);
    for (const read of reads) {
      const page = pageOpenCodeHistory(
        all,
        new URL(read.path as string, 'http://replay').searchParams,
      );
      expect(page.status).toBe(read.status);
      if (read.status === 200) expect(page.body).toEqual(read.response);
    }
  });

  test('past 50 messages, a turn that ended while the feed was down is caught up and settled from history', async () => {
    const h = await setup({
      scenario: 'reconnect',
      fallbacks: ['basic', 'catalog', 'mcp'],
      omit: (record) =>
        (record.tap === 'B' &&
          record.kind === 'sse' &&
          record.event?.type !== 'server.connected') ||
        (record.kind === 'http' &&
          record.method === 'GET' &&
          record.t < 6000 &&
          (record.path === '/api/session/active' ||
            record.path?.includes('/message?order=asc') === true)),
      historyRewrite: (recorded) => [...olderMessages(132), ...recorded],
    });
    await h.start();
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_SLOW stream',
    });
    const completed = await h.waitFor(completedFor(turnId), 10_000);
    expect(turnText(h.events, turnId)).toBe(finalAssistantText('reconnect'));
    expect(completed).toMatchObject({ finishReason: 'stop' });
  });

  test('a native execution displaced during a feed gap keeps its observed completion', async () => {
    const h = await setup({ scenario: 'basic' });
    await h.start();
    const session = (await h.adapter.listSessions())[0]!;
    const native = Reflect.get(h.adapter, 'native').get(
      session.threadId,
    ).native;
    // Arrange the two live slots at the reconnect boundary. The production
    // reconciliation and emitter below supply the actual terminal identity.
    const createTurn = Reflect.get(native, 'createTurn').bind(native);
    Reflect.set(native, 'turn', createTurn('older-execution', 'provider'));
    Reflect.set(native, 'pendingStart', {
      ...createTurn('delivered-prompt', 'station'),
      messageId: 'delivered-message',
    });
    try {
      Reflect.get(native, 'adoptStartedDuringGap').call(native, [
        { id: 'delivered-message' },
      ]);
      const terminal = await h.waitFor(completedFor('older-execution'));
      expect(terminal).toMatchObject({
        provider: 'opencode',
        finishReason: 'other',
      });
      expect(terminal).not.toHaveProperty('stopReason');
      expect(
        projectSessionLifecycle({ session, events: h.events }),
      ).toMatchObject({ lifecycleState: 'idle' });
      expect(resolveTurnCompletionOutcome(terminal)).toBe('done');
      expect(
        projectRuntimeEventsToMessages(h.events).flatMap((row) => row.parts),
      ).not.toContainEqual(
        expect.objectContaining({
          text: expect.stringContaining('Result unconfirmed'),
        }),
      );
      expect(native.activeTurnId).toBe('delivered-prompt');
    } finally {
      Reflect.set(native, 'turn', undefined);
    }
  });

  test('past 50 messages, a prompt whose execution started in a feed gap is adopted', async () => {
    const promptAt = loadOpenCodeFixture('reconnect').find(
      (line) => line.kind === 'http' && line.path?.endsWith('/prompt') === true,
    )?.t as number;
    const h = await setup({
      scenario: 'reconnect',
      omit: (record) =>
        record.tap === 'A' && record.kind === 'sse' && record.t >= promptAt,
      historyRewrite: (recorded) => [...olderMessages(132), ...recorded],
    });
    await h.start();
    const { turnId } = await h.turn('DO_SLOW stream');
    const completed = await h.waitFor(completedFor(turnId), 10_000);
    expect(completed).toMatchObject({ finishReason: 'stop' });
    expect(turnText(h.events, turnId)).toBe(finalAssistantText('reconnect'));
  });

  test('a turn longer than a history page is read back to its own message through the page cursor', async () => {
    const promptId = recordedPromptIds('reconnect')[0] as string;
    const h = await setup({
      scenario: 'reconnect',
      fallbacks: ['basic', 'catalog', 'mcp'],
      omit: (record) =>
        (record.tap === 'B' &&
          record.kind === 'sse' &&
          record.event?.type !== 'server.connected') ||
        (record.kind === 'http' &&
          record.method === 'GET' &&
          record.t < 6000 &&
          (record.path === '/api/session/active' ||
            record.path?.includes('/message?order=asc') === true)),
      // 150 steps of the turn's own, with no text, after its prompt.
      historyRewrite: (recorded) => {
        const at = recorded.findIndex(
          (message) => (message as { id?: string }).id === promptId,
        );
        return [
          ...olderMessages(60),
          ...recorded.slice(0, at + 1),
          ...silentSteps(150),
          ...recorded.slice(at + 1),
        ];
      },
    });
    await h.start();
    const { turnId } = await h.turn('DO_SLOW stream');
    const completed = await h.waitFor(completedFor(turnId), 10_000);
    expect(completed).toMatchObject({ finishReason: 'stop' });
    expect(turnText(h.events, turnId)).toBe(finalAssistantText('reconnect'));
    const reads = h.replay
      .made('GET', '/api/session/:id/message')
      .map((read) => new URL(read.path, 'http://replay').searchParams);
    expect(reads[0]?.get('order')).toBe('desc');
    expect(reads.some((query) => query.has('cursor'))).toBe(true);
  });

  test('a steer delivered before its prompt returns is acknowledged', async () => {
    const steerId = 'msg_1d71b024d001crEY1solwrshJq';
    const h = await setup({
      scenario: 'steer',
      omit: withdrawnSteer,
      holdUntil: (request) =>
        JSON.stringify(request.body ?? null).includes('STEER-delivered')
          ? (record) =>
              record.event?.type === 'session.inbox.delivered' &&
              record.event.data?.inboxID === steerId
          : undefined,
    });
    await h.start();
    const { turnId } = await h.turn('DO_BASH steer');
    const ask = await h.waitFor((event) => event.method === 'request.opened');
    const steer = h.adapter.steerTurn('thread-1', 'STEER-delivered', turnId);
    await h.waitFor(
      () => h.replay.made('POST', '/api/session/:id/prompt').length === 2,
    );
    await h.adapter.respondToRequest(
      'thread-1',
      ask.requestId as string,
      'accept',
    );
    await steer;
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'turn.started' && event.inputKind === 'steer',
      ),
    ).toMatchObject({ turnId, prompt: 'STEER-delivered' });
    await h.waitFor(completedFor(turnId));
    expect(h.replay.made('DELETE', '/api/session/:id/inbox/:id')).toHaveLength(
      0,
    );
  });

  test("a turn with no message of its own is not given an earlier turn's text on reconnect", async () => {
    const h = await setup({
      scenario: 'reconnect',
      // OpenCode runs on its own: Station sent no prompt, so the execution
      // is the engine's turn and has no message Station knows.
      omit: (record) =>
        record.kind === 'http' && record.path?.endsWith('/prompt') === true,
      // History also holds an earlier turn's reply.
      rewrite: (record) => {
        if (!record.path?.includes('/message?order=asc')) return record;
        const response = record.response as { data: unknown[] };
        return {
          ...record,
          response: {
            ...response,
            data: [
              {
                id: 'msg_0000000000001earlierUser',
                time: { created: 1 },
                type: 'user',
                text: 'earlier',
              },
              {
                id: 'msg_0000000000002earlierReply',
                time: { created: 2, completed: 3 },
                type: 'assistant',
                content: [{ type: 'text', text: 'EARLIER TURN TEXT' }],
              },
              ...response.data,
            ],
          },
        };
      },
    });
    await h.start();
    const completed = await h.waitFor(
      (event) => event.method === 'turn.completed',
      10_000,
    );
    expect(completed).toMatchObject({ metadata: { trigger: 'provider' } });
    expect(turnText(h.events, completed.turnId as string)).toBe(
      finalAssistantText('reconnect'),
    );
    expect(JSON.stringify(h.events)).not.toContain('EARLIER TURN TEXT');
  });

  const nativeCursor = (sessionId: string, transport: 'native' | 'acp') => ({
    kind: 'opencode' as const,
    connectionId: 'opencode',
    sessionId,
    cwd: '/replay/proj',
    bindingKey: nativeResumeBindingKey(
      'opencode',
      '/replay/xdg/opencode',
      null,
    ),
    transport,
  });

  test('a native session resumes natively, and without a Station mode its old rules are cleared with []', async () => {
    const sessionId = recordedSessionId('basic');
    const h = await setup({
      scenario: 'basic',
      fallbacks: ['mode-switch', 'catalog', 'mcp', 'reconnect'],
      // Resuming creates no session: the feed does not wait for one.
      ungated: (record) => record.path === '/api/session',
    });
    const session = await h.start(undefined, {
      resumeCursor: nativeCursor(sessionId, 'native'),
    });
    expect(session.resumeCursor).toMatchObject({
      transport: 'native',
      sessionId,
    });
    expect(h.replay.made('POST', '/api/session')).toHaveLength(0);
    expect(h.replay.made('GET', '/api/session/:id')[0]?.path).toBe(
      `/api/session/${sessionId}`,
    );
    expect(h.replay.made('PATCH', '/api/session/:id')[0]?.body).toEqual({
      permissions: [],
    });
    const { turnId } = await h.turn('hello basic');
    await h.waitFor(completedFor(turnId));
    expect(turnText(h.events, turnId)).toBe('mock reply: hello basic');
  });

  test('a session that ran over ACP resumes natively under the same id', async () => {
    const sessionId = recordedSessionId('basic');
    const h = await setup({
      scenario: 'basic',
      fallbacks: ['mode-switch', 'catalog', 'mcp', 'reconnect'],
      // Resuming creates no session: the feed does not wait for one.
      ungated: (record) => record.path === '/api/session',
    });
    const session = await h.start(undefined, {
      resumeCursor: {
        ...nativeCursor(sessionId, 'acp'),
        acp: {
          acpSessionId: sessionId,
          connectionId: 'opencode',
          connectionFingerprint: 'f00d',
        },
      },
    });
    expect(session.resumeCursor).toMatchObject({
      transport: 'native',
      sessionId,
    });
    expect(h.inner()?.starts).toHaveLength(0);
    expect(h.replay.made('POST', '/api/session')).toHaveLength(0);
  });

  test('a native session resumes over ACP under the same id when the native transport is off', async () => {
    const sessionId = recordedSessionId('basic');
    const h = await setup(
      { scenario: 'basic' },
      { nativeEnabled: () => false },
    );
    const session = await h.start(undefined, {
      resumeCursor: nativeCursor(sessionId, 'native'),
    });
    expect(h.leaser.acquired).toHaveLength(0);
    expect(h.inner()?.starts).toHaveLength(1);
    expect(h.inner()?.starts[0]).toMatchObject({
      resumeCursor: { acpSessionId: sessionId },
    });
    expect(session.resumeCursor).toMatchObject({
      kind: 'opencode',
      transport: 'acp',
    });
  });

  test('an effort setting runs the session over ACP with a warning', async () => {
    const h = await setup({ scenario: 'basic' });
    const session = await h.start({ effort: 'high' });
    expect(h.leaser.acquired).toHaveLength(0);
    expect(h.replay.made('POST', '/api/session')).toHaveLength(0);
    expect(
      h.events.find((event) => event.method === 'runtime.warning'),
    ).toMatchObject({
      code: OPENCODE_NATIVE_UNSUPPORTED_SETTING,
      threadId: 'thread-1',
    });
    expect(h.inner()?.starts).toEqual([
      expect.objectContaining({ modelOptions: { effort: 'high' } }),
    ]);
    expect(session.resumeCursor).toMatchObject({ transport: 'acp' });
  });

  test('a server that does not start falls back to ACP with a warning', async () => {
    const h = await setup(
      { scenario: 'basic' },
      {
        pool: {
          acquire: async () => {
            throw new Error('spawn opencode ENOENT');
          },
          stopAll: async () => {},
        },
      },
    );
    const session = await h.start();
    expect(
      h.events.find((event) => event.method === 'runtime.warning'),
    ).toMatchObject({
      code: OPENCODE_NATIVE_UNAVAILABLE,
      threadId: 'thread-1',
    });
    expect(h.inner()?.starts).toHaveLength(1);
    expect(session.resumeCursor).toMatchObject({ transport: 'acp' });
  });

  // --- Fix round 6 ---------------------------------------------------------

  const MOVED_TO = '{PROJ}/sub';

  test("Code Mode's session move is not offered to a governed session: Station's rules deny it and OpenCode leaves it out", async () => {
    const h = await setup({
      scenario: 'move-denied',
      respond: childGovernance({ build: [] }),
    });
    await h.start({ approvalMode: 'ask' });
    const body = h.replay.made('POST', '/api/session')[0]?.body as {
      permissions: OpenCodeNativeRule[];
    };
    expect(body.permissions.at(-1)).toEqual({
      action: 'opencode_session_move',
      resource: '*',
      effect: 'deny',
    });
    const { turnId } = await h.turn('DO_MOVE sub-denied');
    await h.waitFor(completedFor(turnId));
    // The engine, under that rule (`move-denied` capture): the tool is unknown.
    expect(
      h.events.find(
        (event) => event.method === 'tool.completed' && event.turnId === turnId,
      )?.output,
    ).toEqual(expect.stringContaining("Unknown tool 'opencode.session_move'"));
    expect(
      h.events.some(
        (event) => event.code === OPENCODE_SESSION_MOVED_UNGOVERNABLE,
      ),
    ).toBe(false);
  });

  test('a governed session OpenCode moves into a directory whose configuration runs code is stopped, with a warning that says why', async () => {
    const scanned: string[] = [];
    const h = await setup(
      { scenario: 'move', respond: childGovernance({ build: [] }) },
      {
        findProjectCode: async (cwd) => {
          scanned.push(cwd);
          return cwd === MOVED_TO ? [`${MOVED_TO}/.opencode/plugin`] : [];
        },
      },
    );
    await h.start({ approvalMode: 'ask' });
    await h.turn('DO_MOVE sub');
    const warning = await h.waitFor(
      (event) => event.code === OPENCODE_SESSION_MOVED_UNGOVERNABLE,
    );
    expect(warning).toMatchObject({
      method: 'runtime.warning',
      threadId: 'thread-1',
      details: { directory: MOVED_TO },
    });
    expect(warning.message).toContain(`${MOVED_TO}/.opencode/plugin`);
    await h.waitFor(
      (event) =>
        event.method === 'session.exited' && event.reason === 'stopped',
    );
    expect(scanned).toContain(MOVED_TO);
    expect(await h.adapter.hasSession('thread-1')).toBe(false);
    expect(h.leaser.released).toBe(1);
  });

  test('a session moved to a directory without such code follows it: the resume cursor and later checks use the new directory', async () => {
    const scanned: string[] = [];
    const h = await setup(
      { scenario: 'move', respond: childGovernance({ build: [] }) },
      {
        findProjectCode: async (cwd) => {
          scanned.push(cwd);
          return [];
        },
      },
    );
    await h.start({ approvalMode: 'ask' });
    const { turnId } = await h.turn('DO_MOVE sub');
    await h.waitFor(completedFor(turnId));
    await h.waitFor(() => scanned.includes(MOVED_TO));
    const [session] = await h.adapter.listSessions();
    expect(session?.cwd).toBe(MOVED_TO);
    expect(session?.resumeCursor).toMatchObject({
      transport: 'native',
      cwd: MOVED_TO,
    });
    expect(await h.adapter.hasSession('thread-1')).toBe(true);
    // A later governed check (a mode change) scans where the session is now.
    scanned.splice(0);
    await h.adapter
      .sendTurn({
        threadId: 'thread-1',
        input: 'after the move',
        modelOptions: { approvalMode: 'auto' },
      })
      .catch(() => undefined);
    expect(scanned).toEqual([MOVED_TO]);
  });

  test("a feed gap that hid a child and the child's own child: the reconnect finds both and puts the grandchild's pending ask to the person", async () => {
    const h = await setup({ scenario: 'subagent-gap' });
    await h.start();
    const { turnId } = await h.turn('DO_TASK_DEEP now');
    const asked = await h.waitFor(
      (event) => event.method === 'request.opened',
      10_000,
    );
    const listed = loadOpenCodeFixture('subagent-gap').filter(
      (record) =>
        record.kind === 'http' &&
        record.method === 'GET' &&
        record.path?.startsWith('/api/session?parentID=') === true,
    );
    const firstListed = (index: number) =>
      (listed[index]!.response as { data: Array<{ id: string }> }).data[0]!.id;
    const child = firstListed(0);
    const grandchild = firstListed(1);
    expect(asked).toMatchObject({
      requestId: expect.stringMatching(/^per_/),
      payload: {
        toolName: 'shell',
        rawInput: { action: 'shell', resources: ['echo grandchild'] },
        childWork: { childId: grandchild },
      },
    });
    // Found by `parentID`, from this session down, and listed from the
    // location's pending asks (not one session's).
    expect(
      h.replay
        .made('GET', '/api/session')
        .map((request) =>
          new URL(request.path, 'http://x').searchParams.get('parentID'),
        ),
    ).toEqual([expect.stringMatching(/^ses_/), child, grandchild]);
    expect(h.replay.made('GET', '/api/permission/request')).toHaveLength(1);
    // The grandchild runs: it is this session's child work.
    const running = h.events.find(
      (event) =>
        event.method === 'child-work.updated' &&
        (event.delta as { kind: string }).kind === 'snapshot',
    )?.delta as { running: Array<{ childId: string }> };
    expect(running.running.map((item) => item.childId)).toEqual([grandchild]);
    // The parent's turn ended in the gap: it is settled from history.
    await h.waitFor(completedFor(turnId));
    await h.adapter.respondToRequest(
      'thread-1',
      asked.requestId as string,
      'accept',
    );
    await h.waitFor(
      (event) =>
        event.method === 'request.resolved' &&
        event.requestId === asked.requestId &&
        event.status === 'approved',
    );
    // Its end, the child's next run and its end are reported as they happen.
    await h.waitFor(
      (event) =>
        event.method === 'child-work.updated' &&
        (event.delta as { kind: string; childId?: string }).kind === 'settle' &&
        (event.delta as { childId?: string }).childId === child,
      10_000,
    );
    expect(
      h.events
        .filter(
          (event) =>
            event.method === 'child-work.updated' &&
            (event.delta as { kind: string }).kind === 'settle',
        )
        .map((event) => (event.delta as { childId: string }).childId),
    ).toEqual([grandchild, child]);
  });

  test("a child's own child, created while the feed is live, is tracked: its ask is decided on its agent's rules", async () => {
    const GRANDCHILD = 'ses_grandchild';
    const h = await setup({
      scenario: 'subagent',
      rewrite: (record) => {
        if (record.kind !== 'sse' || record.event?.data?.sessionID !== CHILD)
          return record;
        if (record.event.type === 'session.step.started')
          return {
            ...record,
            event: {
              ...record.event,
              type: 'session.created',
              data: {
                sessionID: GRANDCHILD,
                parentID: CHILD,
                agent: 'plan',
                title: 'grandchild',
              },
            },
          };
        if (record.event.type === 'session.text.started')
          return {
            ...record,
            event: {
              ...record.event,
              type: 'permission.asked',
              data: {
                id: 'per_grandchild',
                sessionID: GRANDCHILD,
                action: 'edit',
                resources: ['notes.txt'],
                save: ['*'],
              },
            },
          };
        return record;
      },
      respond: childGovernance({
        build: [],
        general: [],
        plan: [{ action: 'edit', resource: '*', effect: 'deny' }],
      }),
    });
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    await h.waitFor(() => repliesTo(h, GRANDCHILD).length === 1);
    expect(repliesTo(h, GRANDCHILD)).toEqual([{ decision: 'reject' }]);
    expect(h.replay.made('GET', '/api/agent/plan')).toHaveLength(1);
  });

  test("a child that switches agent has its asks decided on the new agent's rules", async () => {
    const h = await setup({
      scenario: 'subagent',
      rewrite: (record) => {
        const asked = childAsk('edit', ['notes.txt'])(record);
        if (asked !== record) return asked;
        // The child's first step reports the agent it now runs.
        return record.kind === 'sse' &&
          record.event?.type === 'session.step.started' &&
          record.event.data?.sessionID === CHILD
          ? {
              ...record,
              event: {
                ...record.event,
                type: 'session.agent.selected',
                data: { sessionID: CHILD, agent: 'plan', previous: 'general' },
              },
            }
          : record;
      },
      respond: childGovernance({
        build: [],
        general: [],
        plan: [{ action: 'edit', resource: '*', effect: 'deny' }],
      }),
    });
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    // `general` would let Auto answer it; `plan` denies edits.
    expect(repliesTo(h, CHILD)).toEqual([{ decision: 'reject' }]);
    expect(h.replay.made('GET', '/api/agent/plan')).toHaveLength(1);
    expect(h.replay.made('GET', '/api/agent/general')).toHaveLength(0);
  });

  test('a rewind while a send is being prepared is refused, sending nothing', async () => {
    const h = await setup({ scenario: 'revert' });
    await h.start();
    const first = await h.turn('DO_WRITE first');
    await h.waitFor(completedFor(first.turnId));
    const second = await h.turn('DO_EDIT second');
    await h.waitFor(completedFor(second.turnId));
    const stagedBefore = h.replay.made(
      'POST',
      '/api/session/:id/revert/stage',
    ).length;
    // Busy from the moment the send starts, before it awaits anything.
    const sending = h.adapter
      .sendTurn({ threadId: 'thread-1', input: 'a third turn' })
      .catch(() => undefined);
    expect(await h.adapter.rewindSession('thread-1', first.turnId)).toEqual({
      kind: 'refused',
      reason: 'send-preparing',
    });
    await sending;
    expect(h.replay.made('POST', '/api/session/:id/revert/stage')).toHaveLength(
      stagedBefore,
    );
  });

  /** A ledger stand-in: which conversations read untrusted content. */
  function ledger(read: string[]) {
    const asked: string[][] = [];
    return {
      asked,
      ledger: {
        conversationHasRead: async (...ids: (string | undefined)[]) => {
          const known = ids.filter((id): id is string => !!id);
          asked.push(known);
          return known.some((id) => read.includes(id));
        },
      } as unknown as NonNullable<AcpAdapterOptions['untrustedContentLedger']>,
    };
  }
  const editOf = (file: string) =>
    askRewrite((data) => data.action === 'edit', {
      action: 'edit',
      resources: [file],
      save: ['*'],
    });

  test('after an untrusted read, an edit of an agent-instruction file is rejected before the mode answers it (#4828)', async () => {
    const read = ledger(['parent-conversation']);
    const h = await setup(
      { scenario: 'governed', rewrite: editOf('AGENTS.md') },
      { acp: { untrustedContentLedger: read.ledger } },
    );
    await h.start(
      { approvalMode: 'never' },
      {
        confinement: 'host',
        metadata: {
          connectionId: 'opencode',
          delegation: { parentConversationId: 'parent-conversation' },
        },
      },
    );
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    // Full access would answer it `once`; the decline comes first.
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'reject' }]);
    expect(opened(h.events)).toEqual([]);
    // The ancestry the ACP path asks: this conversation and its delegator.
    expect(read.asked[0]).toEqual(['thread-1', 'parent-conversation']);
  });

  test('without an untrusted read, the same edit is the mode’s to answer', async () => {
    const read = ledger([]);
    const h = await setup(
      { scenario: 'governed', rewrite: editOf('AGENTS.md') },
      { acp: { untrustedContentLedger: read.ledger } },
    );
    await h.start({ approvalMode: 'auto' });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    expect(
      h.replay
        .made('POST', '/api/session/:id/permission/:id/reply')
        .map((reply) => reply.body),
    ).toEqual([{ decision: 'once' }]);
    expect(read.asked).toHaveLength(1);
  });

  /** A git repository whose hooks live in `.hooks-custom` (`core.hooksPath`). */
  function customHooksRepo(): string {
    const dir = realpathSync(makeTempDir('oc-hooks-'));
    execFileSync('git', ['init', '-q', dir], { windowsHide: true });
    execFileSync(
      'git',
      ['-C', dir, 'config', 'core.hooksPath', '.hooks-custom'],
      { windowsHide: true },
    );
    return dir;
  }

  test('after an untrusted read, an edit of a hook in a custom `core.hooksPath`, named relative to the session, is rejected (#4828)', async () => {
    const repo = customHooksRepo();
    const read = ledger(['thread-1']);
    const h = await setup(
      { scenario: 'governed', rewrite: editOf('.hooks-custom/pre-commit') },
      { acp: { untrustedContentLedger: read.ledger } },
      repo,
    );
    await h.start({ approvalMode: 'auto' });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    expect(replies(h)).toEqual([{ decision: 'reject' }]);
  });

  test("after an untrusted read, a child's edit of a hook in a custom `core.hooksPath` is named against the child's own directory (#4828)", async () => {
    const repo = customHooksRepo();
    const read = ledger(['thread-1']);
    const ask = childAsk('edit', ['.hooks-custom/pre-commit']);
    const h = await setup(
      {
        scenario: 'subagent',
        rewrite: (record) => ask(childIn(repo)(record)),
        respond: childGovernance({ build: [], general: [] }),
      },
      { acp: { untrustedContentLedger: read.ledger } },
    );
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    expect(repliesTo(h, CHILD)).toEqual([{ decision: 'reject' }]);
  });

  test("the configuration-edit guard reads a child's write against the child's own directory", async () => {
    const childDir = '/replay/child-dir';
    const ask = childAsk('edit', [`${childDir}/notes.txt`]);
    const h = await setup({
      scenario: 'subagent',
      rewrite: (record) => ask(childIn(childDir)(record)),
      respond: childGovernance({ build: [], general: [] }),
    });
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    // Inside the child's directory: Auto answers it. Read against the
    // parent's (`/replay/proj`) it would be outside, and a person's.
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    expect(repliesTo(h, CHILD)).toEqual([{ decision: 'once' }]);
    expect(opened(h.events)).toEqual([]);
  });

  test("after an untrusted read, a child's edit of a git hook is rejected before a session grant or the mode (#4828)", async () => {
    const read = ledger(['thread-1']);
    const h = await setup(
      {
        scenario: 'subagent',
        rewrite: childAsk('edit', ['.git/hooks/pre-commit']),
        respond: childGovernance({ build: [], general: [] }),
      },
      { acp: { untrustedContentLedger: read.ledger } },
    );
    await h.start({ approvalMode: 'auto' });
    await h.turn('DO_TASK now');
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    expect(repliesTo(h, CHILD)).toEqual([{ decision: 'reject' }]);
    expect(opened(h.events)).toEqual([]);
  });

  /**
   * Station's staged pre-tool policy as the runtime resolves it for an
   * Agent (`resolvePreToolPolicy`), answering each call with `decide`, and
   * every call it was asked.
   */
  function stagedPolicy(
    decide: (tool: { toolName: string }) => PreToolPolicyDecision,
  ) {
    const calls: Array<{
      tool: Record<string, unknown>;
      invocation: Record<string, unknown>;
      options: Record<string, unknown>;
    }> = [];
    const resolvePreToolPolicy: NonNullable<
      AcpAdapterOptions['resolvePreToolPolicy']
    > = async () => async (tool, invocation, options) => {
      calls.push({
        tool: tool as unknown as Record<string, unknown>,
        invocation: invocation as unknown as Record<string, unknown>,
        options: options as unknown as Record<string, unknown>,
      });
      return decide(tool);
    };
    return { calls, resolvePreToolPolicy };
  }
  const AGENT = { slug: 'reviewer' } as ProviderSessionStartInput['agent'];
  const replies = (h: { replay: OpenCodeServeReplay }) =>
    h.replay
      .made('POST', '/api/session/:id/permission/:id/reply')
      .map((reply) => reply.body);
  /** The session ran natively: nothing went to ACP, and nothing said so. */
  const ranNatively = (
    h: Awaited<ReturnType<typeof setup>>,
    session: { resumeCursor?: unknown },
  ) => {
    expect(session.resumeCursor).toMatchObject({ transport: 'native' });
    expect(h.inner()?.starts ?? []).toEqual([]);
    expect(
      h.events.filter((event) => event.method === 'runtime.warning'),
    ).toEqual([]);
  };

  test("a session started as an Agent runs natively, and its Station tool policy's deny rejects a shell ask with the reason as OpenCode's feedback", async () => {
    const policy = stagedPolicy(() => ({
      behavior: 'deny',
      denial: { allowed: false, reason: 'shell is not for reviewers' },
    }));
    const h = await setup(
      { scenario: 'permission-allow' },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    const session = await h.start(undefined, {
      agent: AGENT,
      metadata: {
        connectionId: 'opencode',
        delegation: { parentConversationId: 'parent-conversation' },
      },
    });
    ranNatively(h, session);
    await h.turn('DO_BASH please');
    await h.waitFor(() => replies(h).length === 1);
    expect(replies(h)).toEqual([
      { decision: 'reject', message: 'shell is not for reviewers' },
    ]);
    expect(opened(h.events)).toEqual([]);
    // Asked as the ACP adapter asks it: OpenCode's tool name (what its ACP
    // layer reports as `toolCall.name`), the call's input, the Agent, the
    // conversation and its delegation, an external interaction.
    expect(policy.calls).toEqual([
      {
        tool: {
          toolName: 'shell',
          toolCallId: 'call_6',
          toolArgs: {
            command: 'echo hello-from-bash',
            description: 'echo test',
          },
        },
        invocation: {
          agentSlug: 'reviewer',
          conversationId: 'thread-1',
          delegation: { parentConversationId: 'parent-conversation' },
        },
        options: {
          interaction: 'external',
          identity: {
            delegationToolName: 'shell',
            configProtectionToolName: 'shell',
          },
        },
      },
    ]);
  });

  test("an Agent's Station tool policy that allows a shell ask Auto would put to the person answers it `once`", async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    const h = await setup(
      { scenario: 'governed' },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    const session = await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    ranNatively(h, session);
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    const shell = await h.turn('DO_BASH two');
    await h.waitFor(completedFor(shell.turnId));
    expect(replies(h)).toEqual([{ decision: 'once' }, { decision: 'once' }]);
    expect(opened(h.events)).toEqual([]);
    expect(policy.calls.map((call) => call.tool.toolName)).toEqual([
      'edit',
      'shell',
    ]);
  });

  test("an Agent's Station tool policy that requires a person puts an edit Auto would answer to the person", async () => {
    const policy = stagedPolicy(() => ({
      behavior: 'ask',
      required: true,
      guardianReason: 'The only-if-asked rule requires a person.',
    }));
    const h = await setup(
      { scenario: 'governed' },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    const edit = await h.turn('DO_EDIT one');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === edit.turnId,
      ),
    ).toMatchObject({
      guardianReason: 'The only-if-asked rule requires a person.',
      payload: { toolName: 'edit' },
    });
    expect(replies(h)).toEqual([]);
    expect(policy.calls).toHaveLength(1);
  });

  test("a child's ask goes through its parent Agent's Station tool policy: its deny rejects an edit Auto would answer", async () => {
    const policy = stagedPolicy(() => ({
      behavior: 'deny',
      denial: { allowed: false, reason: 'no child edits' },
    }));
    // The child names its tool (`session.tool.input.started`, in place of
    // its first step's start) and asks from it (`source`).
    const ask = childAsk('edit', ['notes.txt']);
    const h = await setup(
      {
        scenario: 'subagent',
        rewrite: (record) => {
          if (
            record.kind === 'sse' &&
            record.event?.type === 'session.step.started' &&
            record.event.data?.sessionID === CHILD
          )
            return {
              ...record,
              event: {
                ...record.event,
                type: 'session.tool.input.started',
                data: { sessionID: CHILD, id: 'call_child', name: 'edit' },
              },
            };
          const rewritten = ask(record);
          return rewritten.event?.type === 'permission.asked' &&
            rewritten !== record
            ? {
                ...rewritten,
                event: {
                  ...rewritten.event,
                  data: {
                    ...rewritten.event.data,
                    source: { type: 'tool', id: 'call_child' },
                  },
                },
              }
            : rewritten;
        },
        respond: childGovernance({ build: [], general: [] }),
      },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    await h.turn('DO_TASK now');
    await h.waitFor(() => repliesTo(h, CHILD).length === 1);
    expect(repliesTo(h, CHILD)).toEqual([
      { decision: 'reject', message: 'no child edits' },
    ]);
    expect(policy.calls).toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({
          toolName: 'edit',
          toolCallId: 'call_child',
        }),
        invocation: expect.objectContaining({ conversationId: 'thread-1' }),
      }),
    ]);
  });

  test('an Agent whose Station tool policy cannot be prepared has every ask rejected, with the reason ACP gives', async () => {
    const h = await setup(
      { scenario: 'permission-allow' },
      {
        acp: {
          resolvePreToolPolicy: async () => {
            throw new Error('agent file unreadable');
          },
        },
      },
    );
    ranNatively(h, await h.start(undefined, { agent: AGENT }));
    await h.turn('DO_BASH please');
    await h.waitFor(() => replies(h).length === 1);
    expect(replies(h)).toEqual([
      {
        decision: 'reject',
        message:
          'Station pre-tool policy could not be prepared; tool execution was denied: agent file unreadable',
      },
    ]);
  });

  test("after an untrusted read, an edit of an agent-instruction file is rejected before the Agent's Station tool policy is asked (#4828)", async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    const read = ledger(['thread-1']);
    const h = await setup(
      { scenario: 'governed', rewrite: editOf('AGENTS.md') },
      {
        acp: {
          untrustedContentLedger: read.ledger,
          resolvePreToolPolicy: policy.resolvePreToolPolicy,
        },
      },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    expect(replies(h)).toEqual([{ decision: 'reject' }]);
    expect(policy.calls).toEqual([]);
  });

  test("an Agent's Station tool policy allow does not answer an edit of OpenCode configuration: the person is asked", async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    const h = await setup(
      { scenario: 'governed', rewrite: editOf('opencode.json') },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    const edit = await h.turn('DO_EDIT one');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === edit.turnId,
      ),
    ).toMatchObject({
      payload: { rawInput: { resources: ['opencode.json'] } },
    });
    expect(policy.calls).toHaveLength(1);
    expect(replies(h)).toEqual([]);
  });

  test("an ask whose tool OpenCode did not name cannot be put to an Agent's Station tool policy: the person answers it, not the mode", async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    const h = await setup(
      {
        scenario: 'governed',
        rewrite: (record) =>
          record.kind === 'sse' &&
          record.event?.type === 'permission.asked' &&
          record.event.data?.action === 'edit'
            ? {
                ...record,
                event: {
                  ...record.event,
                  data: { ...record.event.data, source: undefined },
                },
              }
            : record,
      },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === edit.turnId,
    );
    expect(policy.calls).toEqual([]);
    expect(replies(h)).toEqual([]);
  });

  /** The governed capture with its shell calls (`call_8`, ...) renamed and re-asked. */
  const shellCallAs =
    (name: string, ask: Partial<{ action: string; messageID: string }> = {}) =>
    (record: OpenCodeReplayRecord): OpenCodeReplayRecord => {
      if (record.kind !== 'sse' || !record.event?.data) return record;
      const data = record.event.data;
      if (
        record.event.type === 'session.tool.input.started' &&
        data.id === 'call_8'
      )
        return {
          ...record,
          event: { ...record.event, data: { ...data, name } },
        };
      if (record.event.type === 'permission.asked' && data.action === 'shell') {
        const source = data.source as Record<string, unknown>;
        return {
          ...record,
          event: {
            ...record.event,
            data: {
              ...data,
              ...(ask.action
                ? { action: ask.action, resources: ['*'], save: ['*'] }
                : {}),
              source: {
                ...source,
                ...(ask.messageID ? { messageID: ask.messageID } : {}),
              },
            },
          },
        };
      }
      return record;
    };

  test("an Agent's Station tool policy that throws while evaluating denies the ask, with the reason", async () => {
    const policy = stagedPolicy(() => {
      throw new Error('evaluator broke');
    });
    const h = await setup(
      { scenario: 'permission-allow' },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start(undefined, { agent: AGENT });
    await h.turn('DO_BASH please');
    await h.waitFor(() => replies(h).length === 1);
    expect(replies(h)).toEqual([
      {
        decision: 'reject',
        message:
          'Station pre-tool policy failed; tool execution was denied: evaluator broke',
      },
    ]);
    expect(policy.calls).toHaveLength(1);
    expect(opened(h.events)).toEqual([]);
  });

  test("an Agent's Station tool policy that throws before returning a promise denies the ask too", async () => {
    const h = await setup(
      { scenario: 'permission-allow' },
      {
        acp: {
          // Not an async function: it throws where it is called.
          resolvePreToolPolicy: async () =>
            (() => {
              throw new Error('thrown at once');
            }) as unknown as Awaited<
              ReturnType<NonNullable<AcpAdapterOptions['resolvePreToolPolicy']>>
            >,
        },
      },
    );
    await h.start(undefined, { agent: AGENT });
    await h.turn('DO_BASH please');
    await h.waitFor(() => replies(h).length === 1);
    expect(replies(h)).toEqual([
      {
        decision: 'reject',
        message:
          'Station pre-tool policy failed; tool execution was denied: thrown at once',
      },
    ]);
  });

  test("an Agent's Station tool policy allow does not answer a tool named as a person's request (an MCP tool `exit_plan_mode`): the person is asked", async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    // An MCP tool's action is its `<server>_<tool>` name (2.3.0 `tool/mcp.ts`).
    const h = await setup(
      {
        scenario: 'governed',
        rewrite: shellCallAs('exit_plan_mode', { action: 'exit_plan_mode' }),
      },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    const call = await h.turn('DO_BASH two');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === call.turnId,
      ),
    ).toMatchObject({ payload: { toolName: 'exit_plan_mode' } });
    expect(policy.calls.map((entry) => entry.tool.toolName)).toEqual([
      'edit',
      'exit_plan_mode',
    ]);
    // Only the edit was answered.
    expect(replies(h)).toEqual([{ decision: 'once' }]);
  });

  test("a Code Mode call's nested shell ask, which names the `execute` call's id, is not decided as `execute`: the person answers it", async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    // Code Mode runs a nested call under the `execute` call's own id and
    // message (2.3.0 `codemode/tool.ts`): the shell ask names `call_8`.
    const h = await setup(
      { scenario: 'governed', rewrite: shellCallAs('execute') },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    const call = await h.turn('DO_BASH two');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.turnId === call.turnId,
      ),
    ).toMatchObject({ payload: { toolName: 'shell', toolCallId: 'call_8' } });
    expect(policy.calls.map((entry) => entry.tool.toolName)).toEqual(['edit']);
    expect(replies(h)).toEqual([{ decision: 'once' }]);
  });

  test("an ask whose message is not its tool call's is not decided as that tool: the person answers it", async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    const h = await setup(
      {
        scenario: 'governed',
        rewrite: shellCallAs('shell', {
          messageID: 'msg_1d83abad8001vg1Gj6Mam1e54u',
        }),
      },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start({ approvalMode: 'auto' }, { agent: AGENT });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    const call = await h.turn('DO_BASH two');
    await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.turnId === call.turnId,
    );
    expect(policy.calls.map((entry) => entry.tool.toolName)).toEqual(['edit']);
  });

  /**
   * Every reply POST fails with 500 `times` times, then succeeds; an
   * interrupt is taken (204), as OpenCode takes one for a running session.
   */
  const repliesFail = (times: number) => {
    let failed = 0;
    return (request: { method: string; path: string }) => {
      if (request.method === 'POST' && request.path.endsWith('/interrupt'))
        return { status: 204 };
      if (request.method !== 'POST' || !request.path.endsWith('/reply'))
        return undefined;
      if (failed >= times) return { status: 204 };
      failed += 1;
      return { status: 500, body: { error: 'reply broke' } };
    };
  };
  const interrupts = (h: { replay: OpenCodeServeReplay }) =>
    h.replay.made('POST', '/api/session/:id/interrupt');
  /**
   * The scenario's feed from its first ask on left out: OpenCode holds an
   * ask it was not answered (the replay would otherwise go on once the
   * failed reply was counted).
   */
  const heldAtFirstAsk = (scenario: string) => {
    const ask = loadOpenCodeFixture(scenario).find(
      (record) =>
        record.kind === 'sse' && record.event?.type === 'permission.asked',
    );
    if (!ask) throw new Error(`${scenario} recorded no ask`);
    return (record: OpenCodeReplayRecord) =>
      record.kind === 'sse' && record.t > ask.t;
  };

  test("a policy deny OpenCode will not take, twice, stops the turn with the policy's reason and puts nothing to the person", async () => {
    const policy = stagedPolicy(() => ({
      behavior: 'deny',
      denial: { allowed: false, reason: 'shell is not for reviewers' },
    }));
    const h = await setup(
      {
        scenario: 'permission-allow',
        omit: heldAtFirstAsk('permission-allow'),
        respond: repliesFail(2),
      },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start(undefined, { agent: AGENT });
    const { turnId } = await h.turn('DO_BASH please');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain('shell is not for reviewers');
    expect(String(failure.message)).toContain('stopped the turn');
    // Sent, then once more.
    expect(replies(h)).toEqual([
      { decision: 'reject', message: 'shell is not for reviewers' },
      { decision: 'reject', message: 'shell is not for reviewers' },
    ]);
    await h.waitFor(() => interrupts(h).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened(h.events)).toEqual([]);
  });

  test('a rejection OpenCode refuses once is sent once more, and the turn goes on', async () => {
    const policy = stagedPolicy(() => ({
      behavior: 'deny',
      denial: { allowed: false, reason: 'shell is not for reviewers' },
    }));
    const h = await setup(
      { scenario: 'permission-allow', respond: repliesFail(1) },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start(undefined, { agent: AGENT });
    const { turnId } = await h.turn('DO_BASH please');
    await h.waitFor(completedFor(turnId));
    expect(replies(h)).toHaveLength(2);
    expect(
      h.events.filter((event) => event.method === 'runtime.error'),
    ).toEqual([]);
    expect(interrupts(h)).toEqual([]);
    expect(opened(h.events)).toEqual([]);
  });

  test("an agent's kept deny OpenCode will not take stops the turn instead of asking the person", async () => {
    const h = await setup({
      scenario: 'plan-deny',
      omit: heldAtFirstAsk('plan-deny'),
      respond: repliesFail(2),
    });
    await h.start({ approvalMode: 'auto', mode: 'plan' });
    const { turnId } = await h.turn('DO_EDIT plan');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain("agent's own rules deny it");
    await h.waitFor(() => interrupts(h).length > 0);
    expect(opened(h.events)).toEqual([]);
  });

  test('a #4828 rejection OpenCode will not take stops the turn instead of asking the person', async () => {
    const read = ledger(['thread-1']);
    const h = await setup(
      {
        scenario: 'governed',
        rewrite: editOf('AGENTS.md'),
        omit: heldAtFirstAsk('governed'),
        respond: repliesFail(2),
      },
      { acp: { untrustedContentLedger: read.ledger } },
    );
    await h.start({ approvalMode: 'auto' });
    const edit = await h.turn('DO_EDIT one');
    const failure = await h.waitFor(
      (event) =>
        event.method === 'runtime.error' && event.turnId === edit.turnId,
    );
    expect(String(failure.message)).toContain('untrusted content');
    expect(opened(h.events)).toEqual([]);
  });

  const DENY_APPROVALS = {
    connectionId: 'opencode',
    delegation: {
      parentConversationId: 'parent-conversation',
      denyApprovals: true,
    },
  };
  const DELEGATED_DENIAL =
    'requires approval, and delegated child sessions cannot grant approvals.';

  test('a delegated session that may not grant approvals rejects an ask the person would answer, with the delegated denial', async () => {
    const h = await setup({ scenario: 'governed' });
    await h.start({ approvalMode: 'auto' }, { metadata: DENY_APPROVALS });
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    const shell = await h.turn('DO_BASH two');
    await h.waitFor(completedFor(shell.turnId));
    // Auto answered the edit (the mode comes first, as on ACP); the shell
    // ask, a person's under Auto, is rejected: nobody may answer it.
    const answered = replies(h) as Array<{
      decision: string;
      message?: string;
    }>;
    expect(answered[0]).toEqual({ decision: 'once' });
    expect(answered[1]).toMatchObject({ decision: 'reject' });
    expect(answered[1]?.message).toContain(DELEGATED_DENIAL);
    expect(opened(h.events)).toEqual([]);
  });

  test('in a delegated session that may not grant approvals, an ask whose tool OpenCode did not name is rejected, not left waiting', async () => {
    const policy = stagedPolicy(() => ({ behavior: 'allow' }));
    const h = await setup(
      {
        scenario: 'governed',
        rewrite: (record) =>
          record.kind === 'sse' &&
          record.event?.type === 'permission.asked' &&
          record.event.data?.action === 'edit'
            ? {
                ...record,
                event: {
                  ...record.event,
                  data: { ...record.event.data, source: undefined },
                },
              }
            : record,
      },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start(
      { approvalMode: 'auto' },
      { agent: AGENT, metadata: DENY_APPROVALS },
    );
    const edit = await h.turn('DO_EDIT one');
    await h.waitFor(completedFor(edit.turnId));
    expect(policy.calls).toEqual([]);
    expect(replies(h)).toEqual([
      {
        decision: 'reject',
        message: expect.stringContaining(DELEGATED_DENIAL),
      },
    ]);
    expect(opened(h.events)).toEqual([]);
  });

  test('a delegated session that may not grant approvals cancels a question instead of showing it', async () => {
    const h = await setup({ scenario: 'question' });
    await h.start(undefined, { metadata: DENY_APPROVALS });
    await h.turn('DO_QUESTION now');
    await h.waitFor(
      () => h.replay.made('DELETE', '/api/session/:id/form/:id').length === 1,
    );
    expect(opened(h.events)).toEqual([]);
    expect(
      h.events.find((event) => event.method === 'runtime.warning'),
    ).toMatchObject({ message: expect.stringContaining('delegated session') });
  });

  // --- A rejection OpenCode will not take: round 9 --------------------------

  const SUBAGENT_ROOT = 'ses_e28e4e161ffeTvcyrSzodqSP8U';
  /** The child's rejection is refused (500, every time); its agent denies edits. */
  const childRejectionRefused = () => {
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    const governance = childGovernance({
      build: [],
      general: [{ action: 'edit', resource: '*', effect: 'deny' }],
    });
    return (request: OpenCodeReplayRequest) =>
      fail(request) ?? governance(request);
  };
  const interruptPaths = (h: { replay: OpenCodeServeReplay }) =>
    interrupts(h).map((request) => request.path);

  test("a child's rejection OpenCode will not take interrupts the child's own session as well as this one's (a 2.3.0 subagent is a job of its own)", async () => {
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('edit', ['notes.txt']),
      respond: childRejectionRefused(),
    });
    await h.start({ approvalMode: 'auto' });
    const { turnId } = await h.turn('DO_TASK now');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain(`from subagent session ${CHILD}`);
    expect(String(failure.message)).toContain('so Station stopped the turn.');
    await h.waitFor(() => interrupts(h).length === 2);
    expect(interruptPaths(h).sort()).toEqual(
      [
        `/api/session/${CHILD}/interrupt`,
        `/api/session/${SUBAGENT_ROOT}/interrupt`,
      ].sort(),
    );
    expect(opened(h.events)).toEqual([]);
  });

  test("a background child's rejection OpenCode will not take, while a later turn runs, interrupts only that child and warns: the later turn goes on", async () => {
    // The subagent capture, made a background child outliving its turn:
    // the root's first execution ends while the child runs, the engine
    // starts another root execution (its own turn), and then the child
    // asks.
    const asRoot = (record: OpenCodeReplayRecord, type: string) => ({
      ...record,
      event: { type, data: { sessionID: SUBAGENT_ROOT } },
    });
    const h = await setup({
      scenario: 'subagent',
      rewrite: (record) => {
        if (record.kind === 'sse' && record.event?.data?.sessionID === CHILD) {
          if (record.event.type === 'session.step.started')
            return asRoot(record, 'session.execution.succeeded');
          if (record.event.type === 'session.step.first-token')
            return asRoot(record, 'session.execution.started');
        }
        return childAsk('edit', ['notes.txt'])(record);
      },
      respond: childRejectionRefused(),
    });
    await h.start({ approvalMode: 'auto' });
    const first = await h.turn('DO_TASK now');
    await h.waitFor(completedFor(first.turnId));
    const warning = await h.waitFor(
      (event) =>
        event.method === 'runtime.warning' &&
        String(event.message).includes(`from subagent session ${CHILD}`),
    );
    expect(String(warning.message)).toContain(
      'so Station stopped that subagent.',
    );
    // The engine's own later turn completes as OpenCode ran it.
    const later = await h.waitFor(
      (event) =>
        event.method === 'turn.completed' && event.turnId !== first.turnId,
    );
    expect(later).toMatchObject({
      finishReason: 'stop',
      metadata: { trigger: 'provider' },
    });
    expect(interruptPaths(h)).toEqual([`/api/session/${CHILD}/interrupt`]);
    expect(
      h.events.filter((event) => event.method === 'runtime.error'),
    ).toEqual([]);
  });

  test('a turn stopped on a rejection OpenCode will not take ends only when OpenCode says its execution ended; meanwhile a next turn is refused as busy and a steer as too late', async () => {
    let released = false;
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        respond: repliesFail(Number.POSITIVE_INFINITY),
        holdFrame: (record) =>
          record.kind === 'sse' &&
          record.event?.type === 'session.execution.interrupted'
            ? () => released
            : undefined,
      },
      { failCloseSettleMs: 10_000 },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const { turnId } = await h.turn('DO_BASH wait');
    await h.waitFor(() => interrupts(h).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const ended = () =>
      h.events.filter(
        (event) =>
          event.turnId === turnId &&
          ['runtime.error', 'turn.completed', 'turn.aborted'].includes(
            event.method,
          ),
      );
    expect(ended()).toEqual([]);
    await expect(h.turn('DO_BASH next')).rejects.toMatchObject({
      name: 'SendTurnRefusedError',
      kind: 'busy',
    });
    await expect(
      h.adapter.steerTurn('thread-1', 'one more thing', turnId),
    ).rejects.toBeInstanceOf(ProviderTurnEndedError);
    expect(h.replay.made('POST', '/api/session/:id/prompt')).toHaveLength(1);
    released = true;
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain('so Station stopped the turn.');
    expect(ended()).toHaveLength(1);
    expect(opened(h.events)).toEqual([]);
  });

  test('a turn stopped on a rejection OpenCode will not take, whose end OpenCode never reports, ends when the wait runs out and says so', async () => {
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        respond: repliesFail(Number.POSITIVE_INFINITY),
        holdFrame: (record) =>
          record.kind === 'sse' &&
          record.event?.type === 'session.execution.interrupted'
            ? () => false
            : undefined,
      },
      { failCloseSettleMs: 600 },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const { turnId } = await h.turn('DO_BASH wait');
    await h.waitFor(() => interrupts(h).length === 1);
    await expect(h.turn('DO_BASH next')).rejects.toMatchObject({
      kind: 'busy',
    });
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain(
      'OpenCode had not confirmed its execution ended.',
    );
  });

  test('a rejection OpenCode will not take whose interrupt fails too warns, says the turn may still run, and stopping the session rejects and interrupts again', async () => {
    const policy = stagedPolicy(() => ({
      behavior: 'deny',
      denial: { allowed: false, reason: 'shell is not for reviewers' },
    }));
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    const h = await setup(
      {
        scenario: 'permission-allow',
        omit: heldAtFirstAsk('permission-allow'),
        respond: (request) =>
          request.method === 'POST' && request.path.endsWith('/interrupt')
            ? { status: 500, body: { error: 'interrupt broke' } }
            : fail(request),
      },
      { acp: { resolvePreToolPolicy: policy.resolvePreToolPolicy } },
    );
    await h.start(undefined, { agent: AGENT });
    const { turnId } = await h.turn('DO_BASH please');
    const warning = await h.waitFor(
      (event) =>
        event.method === 'runtime.warning' &&
        String(event.message).includes('could not interrupt'),
    );
    expect(String(warning.message)).toContain('interrupt with 500');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain(
      'Station could not stop the turn in OpenCode',
    );
    expect(String(failure.message)).toContain('may still be running it');
    expect(replies(h)).toHaveLength(2);
    expect(interrupts(h)).toHaveLength(1);
    // Nothing runs as far as Station's turn goes, but OpenCode may still
    // hold the ask: stopping interrupts and rejects it once more.
    await h.adapter.stopSession('thread-1');
    expect(interrupts(h)).toHaveLength(2);
    expect(replies(h)).toEqual([
      { decision: 'reject', message: 'shell is not for reviewers' },
      { decision: 'reject', message: 'shell is not for reviewers' },
      { decision: 'reject' },
    ]);
  });

  test('a rejection OpenCode would not take is not reopened by a later re-list, though the mode would now allow it', async () => {
    const ROOT = 'ses_e2457ce8dffe98Zg4A032fhyKD';
    const ASK = 'per_1dba838220010FF9zDMVk4Pzat';
    const edit = {
      id: ASK,
      sessionID: ROOT,
      action: 'edit',
      resources: ['/replay/proj/notes.txt'],
      save: ['*'],
    };
    let refused = 0;
    const h = await setup(
      {
        scenario: 'move-gap',
        rewrite: (record) => {
          // Live on the first feed, during the first turn: OpenCode asks.
          if (
            record.kind === 'sse' &&
            record.tap === 'A' &&
            record.event?.type === 'session.tool.progress'
          )
            return {
              ...record,
              event: { type: 'permission.asked', data: edit },
            };
          // Still pending when the second feed's re-list reads it.
          if (
            record.kind === 'http' &&
            record.method === 'GET' &&
            record.path === `/api/session/${ROOT}/permission`
          )
            return { ...record, response: { data: [edit] } };
          return record;
        },
        respond: (request) => {
          if (request.method === 'POST' && request.path.endsWith('/reply')) {
            refused += 1;
            return refused <= 2
              ? { status: 500, body: { error: 'reply broke' } }
              : { status: 204 };
          }
          if (
            request.method === 'POST' &&
            (request.path.endsWith('/interrupt') ||
              request.path.endsWith('/agent'))
          )
            return { status: 204 };
          if (request.method === 'PATCH') return { status: 204 };
          if (
            request.method === 'GET' &&
            request.path === '/api/permission/saved'
          )
            return { status: 200, body: { data: [] } };
          const agent = /^\/api\/agent\/([^/]+)$/.exec(request.path)?.[1];
          if (request.method === 'GET' && agent)
            return {
              status: 200,
              body: {
                data: {
                  name: agent,
                  permissions:
                    agent === 'plan'
                      ? [{ action: 'edit', resource: '*', effect: 'deny' }]
                      : [],
                },
              },
            };
          return undefined;
        },
      },
      { findProjectCode: async () => [] },
    );
    // Plan's own rules deny the edit: Station rejects it, and OpenCode
    // will not take the rejection.
    await h.start({ approvalMode: 'ask', mode: 'plan' });
    const first = await h.turn('DO_MOVE sub-gap');
    const failure = await h.waitFor(
      (event) =>
        event.method === 'runtime.error' && event.turnId === first.turnId,
    );
    expect(String(failure.message)).toContain('request to edit');
    // Under full access on build the same ask would be answered `once`.
    await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_BASH moved',
      modelOptions: { approvalMode: 'never', mode: 'build' },
      confinement: 'host',
    });
    await h.waitFor(
      () => h.replay.made('GET', '/api/session/:id/inbox').length > 0,
      10_000,
    );
    expect(
      h.replay.made('GET', '/api/session/:id/permission').length,
    ).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(replies(h)).toEqual([
      { decision: 'reject' },
      { decision: 'reject' },
    ]);
    expect(opened(h.events).filter((event) => event.requestId === ASK)).toEqual(
      [],
    );
  });

  // --- A rejection OpenCode will not take: round 10 -------------------------

  const PENDING_ROOT = 'ses_e27c529baffeFpf9G6OQE3JiGp';
  const PENDING_ASK = 'per_1d83ad6780014FVNv2y9PTAy9R';
  const isFrame = (type: string) => (record: OpenCodeReplayRecord) =>
    record.kind === 'sse' && record.event?.type === type;
  const isChildFrame = (type: string) => (record: OpenCodeReplayRecord) =>
    isFrame(type)(record) && record.event?.data?.sessionID === CHILD;
  const isRootEnd = (record: OpenCodeReplayRecord) =>
    isFrame('session.execution.succeeded')(record) &&
    record.event?.data?.sessionID === SUBAGENT_ROOT;
  /** `record` (a frame of the interrupt-pending capture) made another ask of its session. */
  const pendingAsk =
    (id: string, action: string) =>
    (record: OpenCodeReplayRecord): OpenCodeReplayRecord => ({
      ...record,
      event: {
        type: 'permission.asked',
        data: {
          id,
          sessionID: PENDING_ROOT,
          action,
          resources: ['notes.txt'],
          save: ['*'],
        },
      },
    });
  const replyPaths = (h: { replay: OpenCodeServeReplay }) =>
    h.replay
      .made('POST', '/api/session/:id/permission/:id/reply')
      .map((request) => request.path);
  const replyPath = (session: string, ask: string) =>
    `/api/session/${session}/permission/${ask}/reply`;
  /** The capture's prompt ids, then more for turns it never had. */
  const morePromptIds = (scenario: string) => {
    const ids = recordedPromptIds(scenario);
    let extra = 0;
    return () => ids.shift() ?? `msg_extra${extra++}`;
  };
  const isInterrupt = (request: OpenCodeReplayRequest) =>
    request.method === 'POST' && request.path.endsWith('/interrupt');
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test('stopping the session while a subagent may still hold an ask Station refused interrupts that subagent again, with this session, and rejects the ask again', async () => {
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('edit', ['notes.txt']),
      respond: childRejectionRefused(),
      // The child never ends: OpenCode may still hold its ask.
      holdFrame: (record) =>
        isChildFrame('session.execution.succeeded')(record)
          ? () => false
          : undefined,
    });
    await h.start({ approvalMode: 'auto' });
    const { turnId } = await h.turn('DO_TASK now');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain(
      'had not confirmed its execution ended',
    );
    const childInterrupts = () =>
      interruptPaths(h).filter(
        (path) => path === `/api/session/${CHILD}/interrupt`,
      );
    expect(childInterrupts()).toHaveLength(1);
    const rejected = repliesTo(h, CHILD).length;
    await h.adapter.stopSession('thread-1');
    expect(childInterrupts()).toHaveLength(2);
    expect(
      interruptPaths(h).filter(
        (path) => path === `/api/session/${SUBAGENT_ROOT}/interrupt`,
      ),
    ).toHaveLength(2);
    expect(repliesTo(h, CHILD)).toHaveLength(rejected + 1);
  });

  test("once OpenCode reports this session's execution ended, stopping the session neither interrupts it nor rejects the refused ask again", async () => {
    const h = await setup({
      scenario: 'interrupt-pending',
      respond: repliesFail(Number.POSITIVE_INFINITY),
    });
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const { turnId } = await h.turn('DO_BASH wait');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain('so Station stopped the turn.');
    expect(interrupts(h)).toHaveLength(1);
    expect(replies(h)).toHaveLength(2);
    await h.adapter.stopSession('thread-1');
    expect(interrupts(h)).toHaveLength(1);
    expect(replies(h)).toHaveLength(2);
  });

  test("once OpenCode reports the asking subagent's execution ended, stopping the session neither interrupts it nor rejects its refused ask again", async () => {
    let interrupted = 0;
    const refused = childRejectionRefused();
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('edit', ['notes.txt']),
      respond: (request) => {
        if (isInterrupt(request)) interrupted += 1;
        return refused(request);
      },
      // The child ends only after Station has refused its ask.
      holdFrame: (record) =>
        isChildFrame('session.execution.succeeded')(record)
          ? () => interrupted >= 2
          : undefined,
    });
    await h.start({ approvalMode: 'auto' });
    const { turnId } = await h.turn('DO_TASK now');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain('so Station stopped the turn.');
    await h.waitFor(
      (event) =>
        event.method === 'child-work.updated' &&
        (event.delta as { kind?: string }).kind === 'settle',
    );
    const rejected = repliesTo(h, CHILD).length;
    expect(interrupts(h)).toHaveLength(2);
    await h.adapter.stopSession('thread-1');
    expect(interrupts(h)).toHaveLength(2);
    expect(repliesTo(h, CHILD)).toHaveLength(rejected);
  });

  test('a reconnect that finds the stopped session running nothing ends the turn as stopped, and stopping the session then neither interrupts nor rejects again', async () => {
    let interrupted = false;
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    const h = await setup(
      {
        scenario: 'reconnect',
        fallbacks: ['basic', 'catalog', 'mcp'],
        // An ask in place of the reply's first token; tap B shows nothing,
        // and the reads after it find the session idle (`basic`'s).
        rewrite: (record) =>
          isFrame('session.step.first-token')(record) && record.tap === 'A'
            ? {
                ...record,
                event: {
                  type: 'permission.asked',
                  data: {
                    id: 'per_gap',
                    sessionID: 'ses_e28b1fc17fferh6a5WrnQhzEcF',
                    action: 'shell',
                    resources: ['echo hi'],
                    save: ['*'],
                  },
                },
              }
            : record,
        omit: (record) =>
          (record.tap === 'B' &&
            record.kind === 'sse' &&
            record.event?.type !== 'server.connected') ||
          (record.kind === 'http' &&
            record.method === 'GET' &&
            record.t < 6000 &&
            (record.path === '/api/session/active' ||
              record.path?.includes('/message?order=asc') === true)),
        respond: (request) => {
          if (isInterrupt(request)) interrupted = true;
          return fail(request);
        },
        // The feed drops only once Station has stopped the turn.
        holdFrame: (record) =>
          record.kind === 'sse-close' && record.tap === 'A'
            ? () => interrupted
            : undefined,
      },
      { failCloseSettleMs: 5_000 },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const { turnId } = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'DO_SLOW stream',
    });
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
      10_000,
    );
    expect(h.replay.made('GET', '/api/session/active')).toHaveLength(1);
    expect(String(failure.message)).toContain('so Station stopped the turn.');
    expect(interrupts(h)).toHaveLength(1);
    expect(replies(h)).toHaveLength(2);
    await h.adapter.stopSession('thread-1');
    expect(interrupts(h)).toHaveLength(1);
    expect(replies(h)).toHaveLength(2);
  });

  test('a turn stopped on a refused rejection whose end OpenCode never reports withdraws its queued steer and closes its open tool when the wait runs out', async () => {
    let steered = false;
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        respond: (request) =>
          request.method === 'DELETE' ? { status: 204 } : fail(request),
        holdFrame: (record) =>
          isFrame('permission.asked')(record)
            ? () => steered
            : // Neither the tool's end nor the execution's is reported.
              isFrame('session.tool.failed')(record)
              ? () => false
              : undefined,
      },
      {
        failCloseSettleMs: 400,
        newMessageId: morePromptIds('interrupt-pending'),
      },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const { turnId } = await h.turn('DO_BASH wait');
    await h.waitFor(
      (event) => event.method === 'tool.started' && event.turnId === turnId,
    );
    // Queued before Station has to refuse anything.
    const steer = h.adapter
      .steerTurn('thread-1', 'one more thing', turnId)
      .then(
        () => 'delivered',
        (error: unknown) => error,
      );
    await h.waitFor(
      () => h.replay.made('POST', '/api/session/:id/prompt').length === 2,
    );
    steered = true;
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain(
      'had not confirmed its execution ended',
    );
    expect(
      h.events.filter(
        (event) =>
          event.method === 'tool.completed' &&
          event.turnId === turnId &&
          event.toolCallId === 'call_14',
      ),
    ).toEqual([expect.objectContaining({ status: 'unresolved' })]);
    await h.waitFor(
      () =>
        h.replay
          .made('DELETE', '/api/session/:id/inbox/:id')
          .some(
            (request) =>
              request.path === `/api/session/${PENDING_ROOT}/inbox/msg_extra0`,
          ),
      1_000,
    );
    expect(await steer).toBeInstanceOf(ProviderTurnEndedError);
  });

  test("this session's ask refused after its turn's execution ended, while a later turn runs, interrupts nothing and says so", async () => {
    let next = false;
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        respond: repliesFail(Number.POSITIVE_INFINITY),
        // The rejection answers only once a later turn is live; the
        // execution's end flows without Station's interrupt.
        holdUntil: (request) =>
          request.method === 'POST' && request.path.endsWith('/reply')
            ? () => next
            : undefined,
        ungated: (record) =>
          record.kind === 'http' &&
          record.path?.endsWith('/interrupt') === true,
      },
      { newMessageId: morePromptIds('interrupt-pending') },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const first = await h.turn('DO_BASH wait');
    await h.waitFor(completedFor(first.turnId));
    next = true;
    const second = await h.turn('DO_BASH next');
    const warning = await h.waitFor(
      (event) =>
        event.method === 'runtime.warning' &&
        String(event.message).includes('The turn that asked had ended'),
    );
    expect(String(warning.message)).toContain(
      'no longer holds the request, so Station interrupted nothing',
    );
    // OpenCode dropped the ask with its execution: an interrupt now would
    // stop only the later turn.
    await pause(150);
    expect(interrupts(h)).toEqual([]);
    expect(
      h.events.filter(
        (event) =>
          event.turnId === second.turnId &&
          ['runtime.error', 'turn.aborted', 'turn.completed'].includes(
            event.method,
          ),
      ),
    ).toEqual([]);
    expect(h.replay.made('DELETE', '/api/session/:id/inbox/:id')).toEqual([]);
    // Its execution ended before the refusal: nothing holds the ask.
    await h.adapter.stopSession('thread-1');
    expect(replyPaths(h)).toEqual([
      replyPath(PENDING_ROOT, PENDING_ASK),
      replyPath(PENDING_ROOT, PENDING_ASK),
    ]);
  });

  test('a turn stopped on a refused rejection before anything ran it takes its prompt back out of the inbox, once its POST lands, and says so', async () => {
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    const [promptId] = recordedPromptIds('interrupt-pending');
    // The prompt's answer is held past Station's interrupt, until the test
    // lets it go: a withdrawal sent before it would reach an inbox the
    // prompt is not in yet.
    let answered = false;
    let deletedBeforeAnswer = false;
    const h = await setup({
      scenario: 'interrupt-pending',
      // The execution's start is never seen.
      omit: isFrame('session.execution.started'),
      holdUntil: (request) =>
        request.method === 'POST' && request.path.endsWith('/prompt')
          ? () => answered
          : undefined,
      respond: (request) => {
        if (request.method !== 'DELETE') return fail(request);
        if (!answered) deletedBeforeAnswer = true;
        return { status: 204 };
      },
    });
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const sent = h.turn('DO_BASH wait');
    await h.waitFor(() => interrupts(h).length > 0);
    await pause(150);
    answered = true;
    const { turnId } = await sent;
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain(
      "took its prompt back out of OpenCode's queue before OpenCode ran it",
    );
    expect(String(failure.message)).not.toContain(
      'so Station stopped the turn.',
    );
    expect(
      h.replay.made('DELETE', '/api/session/:id/inbox/:id').map((r) => r.path),
    ).toEqual([`/api/session/${PENDING_ROOT}/inbox/${promptId}`]);
    expect(deletedBeforeAnswer).toBe(false);
  });

  test('a stopped turn whose prompt Station could not take back, started by OpenCode after all, is interrupted with a warning, even after a next prompt OpenCode refused', async () => {
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    let ended = false;
    let prompts = 0;
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        // The execution is seen to start only after Station ended the turn:
        // the capture's end frame stands in for that late start.
        omit: isFrame('session.execution.started'),
        rewrite: (record) =>
          isFrame('session.execution.interrupted')(record)
            ? {
                ...record,
                event: { ...record.event!, type: 'session.execution.started' },
              }
            : record,
        holdFrame: (record) =>
          isFrame('session.execution.started')(record)
            ? () => ended
            : undefined,
        respond: (request) => {
          if (request.method === 'DELETE')
            return { status: 500, body: { error: 'inbox broke' } };
          // The next prompt is refused: OpenCode took nothing that could be
          // the execution starting later.
          if (
            request.method === 'POST' &&
            request.path.endsWith('/prompt') &&
            ++prompts === 2
          )
            return { status: 400, body: { error: 'no' } };
          return fail(request);
        },
      },
      { newMessageId: morePromptIds('interrupt-pending') },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const { turnId } = await h.turn('DO_BASH wait');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain('may still run it');
    expect(interrupts(h)).toHaveLength(1);
    await expect(h.turn('next')).rejects.toThrow('OpenCode refused the prompt');
    ended = true;
    const warning = await h.waitFor(
      (event) =>
        event.method === 'runtime.warning' &&
        String(event.message).includes(`started the prompt of turn ${turnId}`),
    );
    expect(String(warning.message)).toContain('so Station interrupted it.');
    expect(interrupts(h)).toHaveLength(2);
  });

  test('a next turn OpenCode took, then stopped and taken back out before it ran, leaves the earlier unwithdrawn prompt still to be stopped', async () => {
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    let secondPosted = false;
    let ended = false;
    let deletes = 0;
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        omit: isFrame('session.execution.started'),
        rewrite: (record) => {
          // After the first turn's stop, OpenCode asks again, in the second
          // turn; then the late start of the first turn's prompt.
          if (isFrame('session.usage.updated')(record))
            return pendingAsk('per_second', 'bash')(record);
          if (isFrame('session.execution.interrupted')(record))
            return {
              ...record,
              event: { ...record.event!, type: 'session.execution.started' },
            };
          return record;
        },
        holdFrame: (record) =>
          isFrame('permission.asked')(record) &&
          record.event?.data?.id === 'per_second'
            ? () => secondPosted
            : isFrame('session.execution.started')(record)
              ? () => ended
              : undefined,
        respond: (request) => {
          if (request.method === 'DELETE')
            // The first turn's prompt cannot be taken back; the second's can.
            return ++deletes === 1
              ? { status: 500, body: { error: 'inbox broke' } }
              : { status: 204 };
          return fail(request);
        },
      },
      { newMessageId: morePromptIds('interrupt-pending') },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const first = await h.turn('DO_BASH wait');
    await h.waitFor(
      (event) =>
        event.method === 'runtime.error' && event.turnId === first.turnId,
    );
    const second = await h.turn('DO_BASH next');
    secondPosted = true;
    const failure = await h.waitFor(
      (event) =>
        event.method === 'runtime.error' && event.turnId === second.turnId,
    );
    expect(String(failure.message)).toContain(
      "took its prompt back out of OpenCode's queue before OpenCode ran it",
    );
    expect(interrupts(h)).toHaveLength(2);
    ended = true;
    const warning = await h.waitFor(
      (event) =>
        event.method === 'runtime.warning' &&
        String(event.message).includes(
          `started the prompt of turn ${first.turnId}`,
        ),
    );
    expect(String(warning.message)).toContain('so Station interrupted it.');
    expect(interrupts(h)).toHaveLength(3);
  });

  test('an ask whose automatic rejection is still in flight when the session stops is rejected again by the stop', async () => {
    let replied = 0;
    const h = await setup({
      scenario: 'interrupt-pending',
      // The first rejection never answers.
      holdUntil: (request) =>
        request.method === 'POST' &&
        request.path.endsWith('/reply') &&
        ++replied === 1
          ? () => false
          : undefined,
      respond: (request) =>
        isInterrupt(request) || request.path.endsWith('/reply')
          ? { status: 204 }
          : undefined,
    });
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    await h.turn('DO_BASH wait');
    await h.waitFor(() => replyPaths(h).length === 1);
    await h.adapter.stopSession('thread-1');
    expect(replyPaths(h)).toEqual([
      replyPath(PENDING_ROOT, PENDING_ASK),
      replyPath(PENDING_ROOT, PENDING_ASK),
    ]);
  });

  test("a subagent's refused ask whose interrupt fails, still running when this session's execution ends, ends the turn saying OpenCode may still run it", async () => {
    let interrupted = 0;
    const refused = childRejectionRefused();
    const h = await setup({
      scenario: 'subagent',
      rewrite: childAsk('edit', ['notes.txt']),
      // The child is never seen to end.
      omit: isChildFrame('session.execution.succeeded'),
      respond: (request) => {
        if (isInterrupt(request)) {
          interrupted += 1;
          if (request.path === `/api/session/${CHILD}/interrupt`)
            return { status: 500, body: { error: 'child interrupt broke' } };
        }
        return refused(request);
      },
      holdFrame: (record) =>
        isRootEnd(record) ? () => interrupted >= 2 : undefined,
    });
    await h.start({ approvalMode: 'auto' });
    const { turnId } = await h.turn('DO_TASK now');
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(String(failure.message)).toContain(
      `could not stop subagent session ${CHILD} in OpenCode`,
    );
    expect(String(failure.message)).toContain('may still be running it');
  });

  test('a second refused rejection in the same turn keeps the first reason and the first interrupt failure', async () => {
    let interrupted = 0;
    const fail = repliesFail(Number.POSITIVE_INFINITY);
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        // After Station's first interrupt, OpenCode asks again.
        rewrite: (record) =>
          isFrame('session.tool.failed')(record)
            ? pendingAsk('per_second', 'edit')(record)
            : record,
        respond: (request) => {
          if (isInterrupt(request)) {
            interrupted += 1;
            return interrupted === 1
              ? { status: 500, body: { error: 'interrupt broke' } }
              : { status: 204 };
          }
          return fail(request);
        },
        holdFrame: (record) =>
          isFrame('session.execution.interrupted')(record)
            ? () => false
            : undefined,
      },
      { failCloseSettleMs: 800 },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const { turnId } = await h.turn('DO_BASH wait');
    await h.waitFor(() => interrupts(h).length === 2);
    const failure = await h.waitFor(
      (event) => event.method === 'runtime.error' && event.turnId === turnId,
    );
    expect(replies(h)).toHaveLength(4);
    expect(String(failure.message)).toContain('request to shell');
    expect(String(failure.message)).not.toContain('request to edit');
    expect(String(failure.message)).toContain(
      'Station could not stop the turn in OpenCode',
    );
    await pause(100);
    expect(
      h.events.filter(
        (event) => event.method === 'runtime.error' && event.turnId === turnId,
      ),
    ).toHaveLength(1);
  });

  test("this session's ask refused with no turn live refuses a next turn as busy until the interrupt answers or the wait runs out", async () => {
    let releaseInterrupt = false;
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        respond: repliesFail(Number.POSITIVE_INFINITY),
        // The rejection answers once the execution has ended (so no turn is
        // live), and the interrupt only when released.
        holdUntil: (request) =>
          request.method === 'POST' && request.path.endsWith('/reply')
            ? isFrame('session.execution.interrupted')
            : isInterrupt(request)
              ? () => releaseInterrupt
              : undefined,
        ungated: (record) =>
          record.kind === 'http' &&
          record.path?.endsWith('/interrupt') === true,
      },
      {
        failCloseSettleMs: 400,
        newMessageId: morePromptIds('interrupt-pending'),
      },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    const first = await h.turn('DO_BASH wait');
    await h.waitFor(completedFor(first.turnId));
    await h.waitFor(() => interrupts(h).length === 1);
    await expect(h.turn('DO_BASH next')).rejects.toMatchObject({
      name: 'SendTurnRefusedError',
      kind: 'busy',
    });
    await pause(600);
    // The wait ran out with the interrupt still unanswered.
    releaseInterrupt = true;
    await expect(h.turn('DO_BASH later')).resolves.toMatchObject({
      threadId: 'thread-1',
    });
    const failure = await h.waitFor(
      (event) =>
        event.method === 'runtime.error' &&
        String(event.message).includes('so Station interrupted it.'),
    );
    expect(failure.turnId).toBeUndefined();
  });

  test('a refused ask OpenCode may still hold is never forgotten to make room: stopping the session rejects every one again', async () => {
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        rewrite: (record) =>
          isFrame('session.tool.failed')(record)
            ? pendingAsk('per_second', 'edit')(record)
            : record,
        respond: repliesFail(Number.POSITIVE_INFINITY),
        holdFrame: (record) =>
          isFrame('session.execution.interrupted')(record)
            ? () => false
            : undefined,
      },
      {
        failCloseSettleMs: 5_000,
        refusedAsksBounds: { evictAbove: 1, stopAbove: 10 },
      },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    await h.turn('DO_BASH wait');
    await h.waitFor(() => interrupts(h).length === 2);
    expect(replies(h)).toHaveLength(4);
    await h.adapter.stopSession('thread-1');
    expect(replyPaths(h).slice(4).sort()).toEqual(
      [
        replyPath(PENDING_ROOT, PENDING_ASK),
        replyPath(PENDING_ROOT, 'per_second'),
      ].sort(),
    );
  });

  test('past the bound on refused asks OpenCode may still hold, the session is stopped with a warning, and every one is rejected again', async () => {
    const h = await setup(
      {
        scenario: 'interrupt-pending',
        rewrite: (record) =>
          isFrame('session.tool.failed')(record)
            ? pendingAsk('per_second', 'edit')(record)
            : isFrame('session.step.failed')(record)
              ? pendingAsk('per_third', 'edit')(record)
              : record,
        respond: repliesFail(Number.POSITIVE_INFINITY),
        holdFrame: (record) =>
          isFrame('session.execution.interrupted')(record)
            ? () => false
            : undefined,
      },
      {
        failCloseSettleMs: 5_000,
        refusedAsksBounds: { evictAbove: 1, stopAbove: 2 },
      },
    );
    await h.start({ approvalMode: 'ask' }, { metadata: DENY_APPROVALS });
    await h.turn('DO_BASH wait');
    const warning = await h.waitFor(
      (event) =>
        event.method === 'runtime.warning' &&
        event.code === OPENCODE_REFUSED_ASKS_OVERFLOW,
    );
    expect(String(warning.message)).toContain(
      'Station stopped this OpenCode chat',
    );
    await h.waitFor(
      (event) =>
        event.method === 'session.exited' && event.reason === 'stopped',
    );
    expect(replyPaths(h).slice(6).sort()).toEqual(
      [
        replyPath(PENDING_ROOT, PENDING_ASK),
        replyPath(PENDING_ROOT, 'per_second'),
        replyPath(PENDING_ROOT, 'per_third'),
      ].sort(),
    );
  });
});

describe('OpenCodeAdapter native reconnect re-reads (2.3.0 replay)', () => {
  const replies = (h: { replay: OpenCodeServeReplay }) =>
    h.replay
      .made('POST', '/api/session/:id/permission/:id/reply')
      .map((reply) => reply.body);
  const MOVE_GAP_ASK = 'per_1dba838220010FF9zDMVk4Pzat';
  /** The agent and saved-approval reads a governed start makes. */
  const governance = (request: { method: string; path: string }) => {
    if (request.method === 'GET' && request.path === '/api/permission/saved')
      return { status: 200, body: { data: [] } };
    const agent = /^\/api\/agent\/([^/]+)$/.exec(request.path)?.[1];
    if (request.method === 'GET' && agent)
      return {
        status: 200,
        body: { data: { name: agent, permissions: [] } },
      };
    return undefined;
  };

  test('a session that moved has its ask from a feed gap reopened from its own list, which follows it (the server-wide list does not hold it)', async () => {
    const h = await setup(
      { scenario: 'move-gap', respond: governance },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'ask' });
    const moved = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(moved.turnId));
    await h.turn('DO_BASH moved');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.requestId === MOVE_GAP_ASK,
        10_000,
      ),
    ).toMatchObject({
      payload: {
        rawInput: { action: 'shell', resources: ['echo hello-from-bash'] },
      },
    });
    await h.waitFor(
      () => h.replay.made('GET', '/api/session/:id/form').length === 1,
    );
    expect(h.replay.made('GET', '/api/session/:id/permission')).toHaveLength(1);
  });

  /** The move-gap capture with the session moved to `directory`. */
  const movedTo =
    (directory: string) =>
    (record: OpenCodeReplayRecord): OpenCodeReplayRecord =>
      record.kind === 'sse' && record.event?.type === 'session.moved'
        ? {
            ...record,
            event: {
              ...record.event,
              data: { ...record.event.data, location: { directory } },
            },
          }
        : record;

  test("the configuration-edit guard follows the session's own move: a write inside its new directory is Auto's to answer", async () => {
    const moved = '/replay/moved';
    const h = await setup(
      {
        scenario: 'move-gap',
        respond: governance,
        // The ask the gap hid, made an edit inside the new directory.
        rewrite: (record) => {
          const next = movedTo(moved)(record);
          if (
            next.kind !== 'http' ||
            next.method !== 'GET' ||
            !/^\/api\/session\/ses_[^/]+\/permission$/.test(next.path ?? '')
          )
            return next;
          const listed = next.response as {
            data: Array<Record<string, unknown>>;
          };
          return {
            ...next,
            response: {
              ...listed,
              data: listed.data.map((ask) => ({
                ...ask,
                action: 'edit',
                resources: [`${moved}/notes.txt`],
                save: ['*'],
              })),
            },
          };
        },
      },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'auto' });
    const first = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(first.turnId));
    await h.turn('DO_BASH moved');
    // Read against the server's directory (`/replay/proj`) it would be
    // outside the project, and a person's.
    await h.waitFor(() => replies(h).length === 1, 10_000);
    expect(replies(h)).toEqual([{ decision: 'once' }]);
    expect(opened(h.events)).toEqual([]);
  });

  /** Frames of the move-gap capture's first feed, made a child's. */
  const KNOWN_CHILD = 'ses_e2457cknownchildKnownChild';
  const childOnFirstFeed =
    (types: Record<string, string>) =>
    (record: OpenCodeReplayRecord): OpenCodeReplayRecord => {
      const type =
        record.kind === 'sse' && record.tap === 'A'
          ? types[record.event?.type ?? '']
          : undefined;
      if (!type) return record;
      return {
        ...record,
        event: {
          type,
          data: {
            sessionID: KNOWN_CHILD,
            parentID: 'ses_e2457ce8dffe98Zg4A032fhyKD',
            agent: 'general',
            location: { directory: '{PROJ}' },
          },
        },
      };
    };
  const listsChild =
    (outcome?: string) => (request: { method: string; path: string }) =>
      request.method === 'GET' &&
      request.path.startsWith(
        '/api/session?parentID=ses_e2457ce8dffe98Zg4A032fhyKD',
      )
        ? {
            status: 200,
            body: {
              data: [
                {
                  id: KNOWN_CHILD,
                  parentID: 'ses_e2457ce8dffe98Zg4A032fhyKD',
                  agent: 'general',
                  ...(outcome ? { outcome } : {}),
                },
              ],
            },
          }
        : request.method === 'GET' &&
            request.path.startsWith('/api/session?parentID=')
          ? { status: 200, body: { data: [] } }
          : governance(request);

  test('a child that was running when the feed dropped and ended during the gap is settled on reconnect', async () => {
    const h = await setup(
      {
        scenario: 'move-gap',
        respond: listsChild('failed'),
        rewrite: childOnFirstFeed({
          'vcs.branch.updated': 'session.created',
          'agent.updated': 'session.execution.started',
        }),
      },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'ask' });
    const first = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(first.turnId));
    await h.turn('DO_BASH moved');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'child-work.updated' &&
          (event.delta as { kind: string }).kind === 'settle',
        10_000,
      ),
    ).toMatchObject({
      delta: { kind: 'settle', childId: KNOWN_CHILD, status: 'failed' },
    });
  });

  test('a known child idle before and after the gap, resumed by its parent during it, is searched: the grandchild it started has its ask put to the person', async () => {
    // 2.3.0's subagent tool continues an existing child (`sessionID`,
    // `tool/plugin/subagent.ts`): during the gap the root resumed the idle
    // child, which started a grandchild and went idle again. The shapes are
    // the subagent-gap capture's session list and server-wide ask list.
    const ROOT = 'ses_e2457ce8dffe98Zg4A032fhyKD';
    const GRANDCHILD = 'ses_e2457grandchildResumedGap1';
    const recordedRead = (path: string) =>
      loadOpenCodeFixture('subagent-gap').find(
        (record) =>
          record.kind === 'http' &&
          record.method === 'GET' &&
          record.path === path,
      )?.response as { data: Array<Record<string, unknown>> } & Record<
        string,
        unknown
      >;
    const childList = recordedRead(
      '/api/session?parentID=ses_e2457d93fffePapS74J3pyI8Op',
    );
    const grandchildList = recordedRead(
      '/api/session?parentID=ses_e2457d6cbffeKPErxR4cV0kdaq',
    );
    const asks = recordedRead('/api/permission/request');
    const ask = { ...asks.data[0]!, sessionID: GRANDCHILD } as {
      id: string;
      sessionID: string;
    };
    const location = { directory: '/replay/proj' };
    const h = await setup(
      {
        scenario: 'move-gap',
        rewrite: childOnFirstFeed({
          'vcs.branch.updated': 'session.created',
          'agent.updated': 'session.execution.started',
          'command.updated': 'session.execution.succeeded',
        }),
        respond: (request) => {
          if (request.method !== 'GET') return governance(request);
          const parent = new URL(request.path, 'http://x').searchParams.get(
            'parentID',
          );
          if (request.path.startsWith('/api/session?')) {
            const data =
              parent === ROOT
                ? [
                    {
                      ...childList.data[0]!,
                      id: KNOWN_CHILD,
                      parentID: ROOT,
                      location,
                    },
                  ]
                : parent === KNOWN_CHILD
                  ? [
                      {
                        ...grandchildList.data[0]!,
                        id: GRANDCHILD,
                        parentID: KNOWN_CHILD,
                        location,
                      },
                    ]
                  : [];
            return {
              status: 200,
              body: { data, cursor: { previous: null, next: null } },
            };
          }
          if (request.path === '/api/session/active')
            return {
              status: 200,
              body: {
                data: {
                  [ROOT]: { type: 'running' },
                  [GRANDCHILD]: { type: 'running' },
                },
              },
            };
          if (request.path === '/api/permission/request')
            return { status: 200, body: { ...asks, data: [ask] } };
          return governance(request);
        },
      },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'ask' });
    const first = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(first.turnId));
    await h.turn('DO_BASH moved');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'request.opened' && event.requestId === ask.id,
        10_000,
      ),
    ).toMatchObject({
      payload: {
        rawInput: { action: 'shell', resources: ['echo grandchild'] },
        childWork: { childId: GRANDCHILD },
      },
    });
    expect(
      h.replay
        .made('GET', '/api/session')
        .map((request) =>
          new URL(request.path, 'http://x').searchParams.get('parentID'),
        ),
    ).toEqual([ROOT, KNOWN_CHILD, GRANDCHILD]);
  });

  test('a descendant walk past its bound stops there and says so', async () => {
    const many = Array.from({ length: 205 }, (_, index) => ({
      id: `ses_e2457manychild${String(index).padStart(10, '0')}`,
      parentID: 'ses_e2457ce8dffe98Zg4A032fhyKD',
    }));
    const h = await setup(
      {
        scenario: 'move-gap',
        respond: (request) =>
          request.method === 'GET' &&
          request.path.startsWith(
            '/api/session?parentID=ses_e2457ce8dffe98Zg4A032fhyKD',
          )
            ? { status: 200, body: { data: many } }
            : request.method === 'GET' &&
                request.path.startsWith('/api/session?parentID=')
              ? { status: 200, body: { data: [] } }
              : governance(request),
      },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'ask' });
    const first = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(first.turnId));
    await h.turn('DO_BASH moved');
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'runtime.warning' &&
          String(event.message).includes('first 200 subagent sessions'),
        10_000,
      ),
    ).toBeDefined();
    // Full once the root's children are read: nothing more is looked up,
    // and only the first 200 are kept as child work.
    expect(h.replay.made('GET', '/api/session')).toHaveLength(1);
    const reported = new Set(
      h.events
        .filter((event) => event.method === 'child-work.updated')
        .flatMap((event) => {
          const delta = event.delta as {
            running?: Array<{ childId: string }>;
            childId?: string;
          };
          return [
            ...(delta.running ?? []).map((item) => item.childId),
            ...(delta.childId ? [delta.childId] : []),
          ];
        }),
    );
    expect(reported.has(many[200]!.id)).toBe(false);
  });

  test("a session's own list is trusted only for that session: another session's ask in it is not reopened", async () => {
    const recorded = loadOpenCodeFixture('move-gap').find(
      (record) =>
        record.kind === 'http' &&
        record.method === 'GET' &&
        /^\/api\/session\/ses_[^/]+\/permission$/.test(record.path ?? ''),
    )?.response as { data: unknown[] };
    const h = await setup(
      {
        scenario: 'move-gap',
        respond: (request) =>
          request.method === 'GET' &&
          /^\/api\/session\/ses_[^/]+\/permission$/.test(request.path)
            ? {
                status: 200,
                body: {
                  data: [
                    {
                      id: 'per_foreignAsk',
                      sessionID: 'ses_foreignfoForeignForeign1',
                      action: 'shell',
                      resources: ['echo other chat'],
                      save: ['echo *'],
                    },
                    ...recorded.data,
                  ],
                },
              }
            : governance(request),
      },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'ask' });
    const first = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(first.turnId));
    await h.turn('DO_BASH moved');
    await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.requestId === MOVE_GAP_ASK,
      10_000,
    );
    expect(opened(h.events).map((event) => event.requestId)).toEqual([
      MOVE_GAP_ASK,
    ]);
  });

  /** A directory, and a path to it through a symbolic link (as `/tmp` is `/private/tmp` on macOS). */
  function aliasedDirectory(): { named: string; real: string } {
    const base = realpathSync(makeTempDir('oc-moved-'));
    const real = join(base, 'real');
    mkdirSync(real);
    symlinkSync(real, join(base, 'alias'));
    return { named: join(base, 'alias'), real };
  }

  test('a move OpenCode names by an aliased path is followed at its real path', async () => {
    const dir = aliasedDirectory();
    const h = await setup(
      {
        scenario: 'move-gap',
        respond: governance,
        rewrite: movedTo(dir.named),
      },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'ask' });
    const first = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(first.turnId));
    const [session] = await h.adapter.listSessions();
    expect(session?.resumeCursor).toMatchObject({ cwd: dir.real });
  });

  /** The subagent-gap capture's reconnect reads, with its descendants in `directory`. */
  function gapDescendantsIn(directory: string) {
    const listsDescendants = (record: OpenCodeReplayRecord) =>
      record.kind === 'http' &&
      record.method === 'GET' &&
      record.path?.startsWith('/api/session?parentID=') === true;
    const recorded = loadOpenCodeFixture('subagent-gap').find(
      (record) =>
        record.kind === 'http' && record.path === '/api/permission/request',
    );
    if (!recorded) throw new Error('subagent-gap recorded no ask list');
    const ask = (
      recorded.response as { data: Array<{ id: string; sessionID: string }> }
    ).data[0]!;
    const rewrite = (record: OpenCodeReplayRecord): OpenCodeReplayRecord => {
      if (!listsDescendants(record)) return record;
      const answer = record.response as {
        data: Array<Record<string, unknown>>;
      };
      return {
        ...record,
        response: {
          ...answer,
          data: answer.data.map((item) => ({
            ...item,
            location: { directory },
          })),
        },
      };
    };
    return { rewrite, ask };
  }

  test('a descendant in another directory has its ask from a feed gap read from its own list, which the server-wide one does not hold', async () => {
    const { rewrite, ask } = gapDescendantsIn('/replay/elsewhere');
    const h = await setup({
      scenario: 'subagent-gap',
      rewrite,
      respond: (request) => {
        if (request.method !== 'GET') return undefined;
        if (request.path === '/api/permission/request')
          return { status: 200, body: { data: [] } };
        if (request.path === `/api/session/${ask.sessionID}/permission`)
          return { status: 200, body: { data: [ask] } };
        return undefined;
      },
    });
    await h.start();
    await h.turn('DO_TASK_DEEP now');
    expect(
      await h.waitFor((event) => event.method === 'request.opened', 10_000),
    ).toMatchObject({ requestId: ask.id });
  });

  test("a descendant in the server's directory, named by an aliased path, is read from the server-wide list only", async () => {
    const dir = aliasedDirectory();
    const { rewrite, ask } = gapDescendantsIn(dir.named);
    const h = await setup({ scenario: 'subagent-gap', rewrite }, {}, dir.real);
    await h.start();
    await h.turn('DO_TASK_DEEP now');
    await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.requestId === ask.id,
      10_000,
    );
    // The reconnect's re-reads are done once it reads the inbox.
    await h.waitFor(
      () => h.replay.made('GET', '/api/session/:id/inbox').length > 0,
    );
    expect(
      h.replay.requests
        .filter((request) => /\/permission$/.test(request.path))
        .map((request) => request.path),
    ).toEqual([expect.not.stringContaining(ask.sessionID)]);
  });

  test("a failed descendant lookup is reported and the session's own ask is still reopened", async () => {
    const h = await setup(
      {
        scenario: 'move-gap',
        respond: (request) =>
          request.method === 'GET' &&
          request.path.startsWith('/api/session?parentID=')
            ? { status: 500, body: { error: 'unavailable' } }
            : governance(request),
      },
      { findProjectCode: async () => [] },
    );
    await h.start({ approvalMode: 'ask' });
    const moved = await h.turn('DO_MOVE sub-gap');
    await h.waitFor(completedFor(moved.turnId));
    await h.turn('DO_BASH moved');
    await h.waitFor(
      (event) =>
        event.method === 'request.opened' && event.requestId === MOVE_GAP_ASK,
      10_000,
    );
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'runtime.warning' &&
          String(event.message).includes('could not re-read'),
      ),
    ).toBeDefined();
  });

  test("a failed read of the session's own ask list is reported on its own, and its descendants' asks are still reopened", async () => {
    const h = await setup({
      scenario: 'subagent-gap',
      respond: (request) =>
        request.method === 'GET' &&
        /^\/api\/session\/ses_[^/]+\/permission$/.test(request.path)
          ? { status: 500, body: { error: 'unavailable' } }
          : undefined,
    });
    await h.start();
    await h.turn('DO_TASK_DEEP now');
    expect(
      await h.waitFor((event) => event.method === 'request.opened', 10_000),
    ).toMatchObject({ requestId: 'per_1dba8297f001zUwv37vXdrSGqE' });
    const warnings = h.events.filter(
      (event) =>
        event.method === 'runtime.warning' &&
        String(event.message).includes('could not re-read'),
    );
    expect(warnings.map((event) => event.message)).toEqual([
      expect.stringContaining(
        'the pending permission requests of this session',
      ),
    ]);
  });

  test("a failed lookup of one child's children is reported, and its sibling's grandchild still has its ask reopened", async () => {
    // The capture's lookups by parent; the replay matches them on the path
    // alone (no query), so each is answered here.
    const lookups = new Map(
      loadOpenCodeFixture('subagent-gap').flatMap((record) =>
        record.kind === 'http' &&
        record.method === 'GET' &&
        record.path?.startsWith('/api/session?parentID=')
          ? [
              [
                new URL(record.path, 'http://x').searchParams.get('parentID'),
                record.response as { data: Array<Record<string, unknown>> },
              ] as const,
            ]
          : [],
      ),
    );
    const ROOT = 'ses_e2457d93fffePapS74J3pyI8Op';
    const SIBLING = 'ses_e2457siblingSiblingSibling';
    const h = await setup({
      scenario: 'subagent-gap',
      respond: (request) => {
        if (
          request.method !== 'GET' ||
          !request.path.startsWith('/api/session?')
        )
          return undefined;
        const parent = new URL(request.path, 'http://x').searchParams.get(
          'parentID',
        );
        if (parent === SIBLING)
          return { status: 500, body: { error: 'unavailable' } };
        const recorded = lookups.get(parent) ?? { data: [] };
        if (parent !== ROOT) return { status: 200, body: recorded };
        return {
          status: 200,
          body: {
            ...recorded,
            data: [
              { ...recorded.data[0]!, id: SIBLING, title: 'sibling' },
              ...recorded.data,
            ],
          },
        };
      },
    });
    await h.start();
    await h.turn('DO_TASK_DEEP now');
    expect(
      await h.waitFor((event) => event.method === 'request.opened', 10_000),
    ).toMatchObject({ requestId: 'per_1dba8297f001zUwv37vXdrSGqE' });
    expect(
      h.events.find(
        (event) =>
          event.method === 'runtime.warning' &&
          String(event.message).includes(`the subagent sessions of ${SIBLING}`),
      ),
    ).toBeDefined();
  });

  test("a failed read of one descendant's own ask list is reported, and the next descendant's own list is still read", async () => {
    const { rewrite, ask } = gapDescendantsIn('/replay/elsewhere');
    const CHILD_OF_ROOT = 'ses_e2457d6cbffeKPErxR4cV0kdaq';
    const h = await setup({
      scenario: 'subagent-gap',
      rewrite,
      respond: (request) => {
        if (request.method !== 'GET') return undefined;
        if (request.path === '/api/permission/request')
          return { status: 200, body: { data: [] } };
        if (request.path === `/api/session/${CHILD_OF_ROOT}/permission`)
          return { status: 500, body: { error: 'unavailable' } };
        if (request.path === `/api/session/${ask.sessionID}/permission`)
          return { status: 200, body: { data: [ask] } };
        return undefined;
      },
    });
    await h.start();
    await h.turn('DO_TASK_DEEP now');
    expect(
      await h.waitFor((event) => event.method === 'request.opened', 10_000),
    ).toMatchObject({ requestId: ask.id });
    expect(
      h.events.find(
        (event) =>
          event.method === 'runtime.warning' &&
          String(event.message).includes(
            `the pending permission requests of subagent session ${CHILD_OF_ROOT}`,
          ),
      ),
    ).toBeDefined();
  });

  test("an ask or form of a session outside this chat's tree, listed server-wide, is neither shown nor answered", async () => {
    const recordedList = (path: string) =>
      loadOpenCodeFixture('subagent-gap').find(
        (record) =>
          record.kind === 'http' &&
          record.method === 'GET' &&
          record.path === path,
      )?.response as { data: unknown[] };
    const FOREIGN = 'ses_foreignfoForeignForeign1';
    const h = await setup({
      scenario: 'subagent-gap',
      respond: (request) => {
        if (request.method !== 'GET') return undefined;
        if (request.path === '/api/permission/request')
          return {
            status: 200,
            body: {
              ...recordedList('/api/permission/request'),
              data: [
                {
                  id: 'per_foreignAsk',
                  sessionID: FOREIGN,
                  action: 'shell',
                  resources: ['echo other chat'],
                  save: ['echo *'],
                },
                ...recordedList('/api/permission/request').data,
              ],
            },
          };
        if (request.path === '/api/form')
          return {
            status: 200,
            body: {
              ...recordedList('/api/form'),
              data: [
                {
                  id: 'frm_foreignForm',
                  sessionID: FOREIGN,
                  title: 'Other chat',
                  fields: [],
                },
                ...recordedList('/api/form').data,
              ],
            },
          };
        return undefined;
      },
    });
    // Full access answers every ask of this tree `once` without a person:
    // a foreign ask adopted would be answered for another chat.
    await h.start({ approvalMode: 'never' }, { confinement: 'host' });
    const { turnId } = await h.turn('DO_TASK_DEEP now');
    await h.waitFor(completedFor(turnId), 10_000);
    expect(
      h.events.filter(
        (event) =>
          event.method === 'request.opened' &&
          String(event.requestId).includes('foreign'),
      ),
    ).toEqual([]);
    expect(
      h.replay.requests.filter((request) => request.path.includes(FOREIGN)),
    ).toEqual([]);
    // This tree's own ask from the same list was answered.
    expect(
      h.replay.made('POST', '/api/session/:id/permission/:id/reply'),
    ).toHaveLength(1);
  });

  // --- Round 9 -------------------------------------------------------------

  const RECONNECT_ROOT = 'ses_e28b1fc17fferh6a5WrnQhzEcF';
  const KID = 'ses_e28b1kidRunningAcrossGap01';
  /** Tap B shows nothing after it connects: only the re-reads tell. */
  const quietSecondFeed = (record: OpenCodeReplayRecord) =>
    record.tap === 'B' &&
    record.kind === 'sse' &&
    record.event?.type !== 'server.connected';
  /** Answers for the descendant reads of the reconnect capture. */
  const descendantReads =
    (children: (parentId: string) => Array<Record<string, unknown>>) =>
    (request: { method: string; path: string }) => {
      if (request.method !== 'GET') return undefined;
      const parent = /^\/api\/session\?parentID=([^&]+)/.exec(
        request.path,
      )?.[1];
      if (parent)
        return {
          status: 200,
          body: { data: children(decodeURIComponent(parent)) },
        };
      if (
        request.path === '/api/permission/request' ||
        request.path === '/api/form'
      )
        return { status: 200, body: { data: [] } };
      return undefined;
    };
  const warnings = (events: Event[]) =>
    events.filter((event) => event.method === 'runtime.warning');

  test.each([
    { delivered: false, running: true, posting: false },
    { delivered: true, running: false, posting: false },
    { delivered: false, running: true, posting: true },
  ])(
    'reconnect proves steer delivery by exact history id ($delivered, running=$running, posting=$posting)',
    async ({ delivered, running, posting }) => {
      const steerId = 'msg_1e28b1steerHistoryProof01';
      const ids = [...recordedPromptIds('reconnect'), steerId];
      let replay: OpenCodeServeReplay | undefined;
      let releasePost = !posting;
      const h = await setup(
        {
          scenario: 'reconnect',
          omit: (record) =>
            record.tap === 'B' &&
            record.kind === 'sse' &&
            record.event?.type !== 'server.connected' &&
            record.event?.type !== 'session.execution.succeeded',
          rewrite: (record) =>
            record.tap === 'B' &&
            record.event?.type === 'session.execution.succeeded'
              ? {
                  ...record,
                  event: {
                    type: 'session.model.selected',
                    data: {
                      sessionID: RECONNECT_ROOT,
                      model: { providerID: 'barrier', id: 'done' },
                    },
                  },
                }
              : record,
          historyRewrite: (history) =>
            delivered
              ? [
                  ...history,
                  {
                    id: steerId,
                    role: 'user',
                    content: [{ type: 'text', text: 'STEER history proof' }],
                  },
                ]
              : history,
          holdFrame: (record) =>
            record.kind === 'sse-close' && record.tap === 'A'
              ? () =>
                  (replay?.made('POST', '/api/session/:id/prompt').length ??
                    0) >= 2
              : undefined,
          holdUntil: (request) =>
            request.method === 'POST' &&
            (request.body as { delivery?: string })?.delivery === 'steer'
              ? () => releasePost
              : undefined,
          respond: (request) => {
            if (
              request.method === 'GET' &&
              request.path === '/api/session/active'
            )
              return {
                status: 200,
                body: { data: running ? { [RECONNECT_ROOT]: {} } : {} },
              };
            if (request.method === 'GET' && request.path.endsWith('/inbox'))
              return { status: 200, body: { data: [] } };
            return undefined;
          },
        },
        { newMessageId: () => ids.shift()! },
      );
      replay = h.replay;
      await h.start();
      const { turnId } = await h.turn('DO_SLOW stream');
      await h.waitFor((e) => e.method === 'content.text-delta');
      let outcome = 'pending';
      const steering = h.adapter
        .steerTurn('thread-1', 'STEER history proof', turnId)
        .then(
          () => {
            outcome = 'delivered';
          },
          () => {
            outcome = 'refused';
          },
        );
      await h.waitFor(
        (e) => e.method === 'session.configured' && e.model === 'barrier/done',
      );
      expect(outcome).toBe(delivered ? 'delivered' : 'pending');
      releasePost = true;
      await h.adapter.stopSession('thread-1');
      await steering;
    },
  );

  test('a reconnect that cannot read which sessions run settles nothing: the live turn, a running child and a queued steer all stay as they were', async () => {
    const STEER = 'msg_1e28b1steerKeptAcrossGap01';
    const promptIds = [
      ...recordedPromptIds('reconnect', quietSecondFeed),
      STEER,
    ];
    let replay: OpenCodeServeReplay | undefined;
    let deltas = 0;
    const reads = descendantReads((parent) =>
      parent === RECONNECT_ROOT ? [{ id: KID, parentID: RECONNECT_ROOT }] : [],
    );
    const h = await setup(
      {
        scenario: 'reconnect',
        omit: quietSecondFeed,
        // The first feed's first two text deltas, made a child that starts.
        rewrite: (record) => {
          if (
            record.kind !== 'sse' ||
            record.tap !== 'A' ||
            record.event?.type !== 'session.text.delta' ||
            deltas >= 2
          )
            return record;
          deltas += 1;
          return {
            ...record,
            event:
              deltas === 1
                ? {
                    type: 'session.created',
                    data: { sessionID: KID, parentID: RECONNECT_ROOT },
                  }
                : {
                    type: 'session.execution.started',
                    data: { sessionID: KID },
                  },
          };
        },
        // The first feed drops only once the steer is queued.
        holdFrame: (record) =>
          record.kind === 'sse-close' && record.tap === 'A'
            ? () =>
                (replay?.made('POST', '/api/session/:id/prompt').length ?? 0) >=
                2
            : undefined,
        respond: (request) =>
          request.method === 'GET' && request.path === '/api/session/active'
            ? { status: 500, body: { error: 'active broke' } }
            : reads(request),
      },
      {
        newMessageId: () => {
          const id = promptIds.shift();
          if (!id) throw new Error('no more prompt ids');
          return id;
        },
      },
    );
    replay = h.replay;
    await h.start();
    const { turnId } = await h.turn('DO_SLOW stream');
    await h.waitFor(
      (event) =>
        event.method === 'child-work.updated' &&
        (event.delta as { kind: string }).kind === 'snapshot',
    );
    let steerOutcome = 'pending';
    h.adapter.steerTurn('thread-1', 'STEER kept', turnId).then(
      () => {
        steerOutcome = 'delivered';
      },
      () => {
        steerOutcome = 'refused';
      },
    );
    await h.waitFor(
      () => h.replay.made('GET', '/api/session/:id/inbox').length > 0,
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    // One warning, the failed read's: nothing else in the re-read failed.
    expect(warnings(h.events).map((event) => event.message)).toEqual([
      expect.stringContaining('could not re-read which sessions are running'),
    ]);
    expect(
      h.events.filter(
        (event) =>
          event.turnId === turnId &&
          ['turn.completed', 'turn.aborted', 'runtime.error'].includes(
            event.method,
          ),
      ),
    ).toEqual([]);
    expect(
      h.events.filter(
        (event) =>
          event.method === 'child-work.updated' &&
          (event.delta as { kind: string }).kind === 'settle',
      ),
    ).toEqual([]);
    expect(h.replay.made('DELETE', '/api/session/:id/inbox/:id')).toEqual([]);
    expect(steerOutcome).toBe('pending');
  });

  test('a reconnect looks descendants up a few at a time: four lookups in flight, never more', async () => {
    const kids = Array.from({ length: 6 }, (_, index) => ({
      id: `ses_e28b1kidParallelLookup0${index}`,
      parentID: RECONNECT_ROOT,
    }));
    let released = false;
    const reads = descendantReads((parent) =>
      parent === RECONNECT_ROOT ? kids : [],
    );
    const h = await setup({
      scenario: 'reconnect',
      respond: reads,
      holdUntil: (request) =>
        request.method === 'GET' &&
        request.path.startsWith('/api/session?parentID=') &&
        !request.path.includes(RECONNECT_ROOT)
          ? () => released
          : undefined,
    });
    await h.start();
    await h.turn('DO_SLOW stream');
    const kidLookups = () =>
      h.replay.requests.filter(
        (request) =>
          request.path.startsWith('/api/session?parentID=') &&
          !request.path.includes(RECONNECT_ROOT),
      );
    await h.waitFor(() => kidLookups().length === 4, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(kidLookups()).toHaveLength(4);
    released = true;
    // Any request wakes the held answers.
    await h.replay
      .client()
      .request('GET', '/api/info')
      .catch(() => undefined);
    await h.waitFor(() => kidLookups().length === 6);
    await h.waitFor(
      () => h.replay.made('GET', '/api/session/:id/inbox').length > 0,
    );
  });

  /** The live native session behind `thread-1`, to make one of its steps throw. */
  const liveSession = (h: Awaited<ReturnType<typeof setup>>) =>
    (
      h.adapter as unknown as {
        native: Map<string, { native: Record<string, unknown> }>;
      }
    ).native.get('thread-1')?.native as Record<string, unknown>;

  test("a reconnect's bookkeeping that throws is reported, and the re-reads after it still run", async () => {
    const h = await setup({ scenario: 'reconnect' });
    await h.start();
    const { turnId } = await h.turn('DO_SLOW stream');
    liveSession(h).reconcileTree = async () => {
      throw new Error('bookkeeping broke');
    };
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'runtime.warning' &&
          String(event.message).includes('bookkeeping broke'),
        10_000,
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        'could not re-read its subagents and pending requests',
      ),
    });
    await h.waitFor(
      () => h.replay.made('GET', '/api/session/:id/inbox').length === 1,
    );
    await h.waitFor(completedFor(turnId), 10_000);
  });

  test('a reconnect that throws outside any one re-read is reported, and the feed it opened goes on: no reconnect loop', async () => {
    const h = await setup({ scenario: 'reconnect' });
    await h.start();
    const { turnId } = await h.turn('DO_SLOW stream');
    liveSession(h).reconcile = async () => {
      throw new Error('reconcile broke');
    };
    expect(
      await h.waitFor(
        (event) =>
          event.method === 'runtime.warning' &&
          String(event.message).includes('reconcile broke'),
        10_000,
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        'could not re-read what the feed gap hid',
      ),
    });
    // The second feed (the replay's last) carries the turn to its end.
    await h.waitFor(completedFor(turnId), 10_000);
  });
});

describe('OpenCodeResumeCursor shape guard', () => {
  const valid = {
    kind: 'opencode',
    connectionId: 'opencode',
    sessionId: 'ses_1',
    cwd: '/p',
    bindingKey: 'k',
    transport: 'native',
  };
  test('accepts the cursors Station writes, native and ACP', () => {
    expect(isOpenCodeResumeCursor(valid)).toBe(true);
    expect(
      isOpenCodeResumeCursor({
        ...valid,
        transport: 'acp',
        acp: {
          acpSessionId: 'ses_1',
          connectionId: 'opencode',
          connectionFingerprint: 'f00d',
        },
      }),
    ).toBe(true);
  });
  test.each([
    ['another kind', { ...valid, kind: 'acp' }],
    ['an empty session id', { ...valid, sessionId: '' }],
    ['an unknown transport', { ...valid, transport: 'serve' }],
    ['no binding key', { ...valid, bindingKey: undefined }],
    ['a malformed ACP cursor', { ...valid, transport: 'acp', acp: { x: 1 } }],
    ['an ACP cursor itself', { acpSessionId: 'ses_1', connectionId: 'o' }],
  ])('refuses %s', (_label, value) => {
    expect(isOpenCodeResumeCursor(value)).toBe(false);
  });
});

describe('openCodeAskFitsTool', () => {
  test("Code Mode's session move asks `external_directory`; its worktree removal asks `edit` only", () => {
    expect(
      openCodeAskFitsTool('opencode_session_move', 'external_directory'),
    ).toBe(true);
    expect(openCodeAskFitsTool('opencode_session_move', 'edit')).toBe(false);
    expect(openCodeAskFitsTool('opencode_worktree_remove', 'edit')).toBe(true);
    expect(
      openCodeAskFitsTool('opencode_worktree_remove', 'external_directory'),
    ).toBe(false);
  });
});
