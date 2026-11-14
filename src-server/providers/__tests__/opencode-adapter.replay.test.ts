/**
 * The native OpenCode transport, end to end through `OpenCodeAdapter`,
 * against the real 2.3.0 wire replayed from the captures
 * (`opencode-serve-replay.ts`).
 */
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import {
  evaluateOpenCodeRules,
  type OpenCodeNativeRule,
} from '../../services/acp/opencode-approval-native.js';
import {
  ApprovalGovernanceRefusedError,
  type ProviderAdapterShape,
  type ProviderSessionStartInput,
  ProviderTurnEndedError,
} from '../adapter-shape.js';
import type { AcpAdapterOptions } from '../adapters/acp-adapter.js';
import { nativeResumeBindingKey } from '../adapters/native-resume-binding.js';
import {
  isOpenCodeResumeCursor,
  OPENCODE_NATIVE_UNAVAILABLE,
  OPENCODE_NATIVE_UNVERIFIED,
  OpenCodeAdapter,
} from '../adapters/opencode-adapter.js';
import { OpenCodeRequestClosedError } from '../adapters/opencode-serve-session.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';
import {
  loadOpenCodeFixture,
  type OpenCodeReplayRecord,
  OpenCodeServeReplay,
  type OpenCodeServeReplayOptions,
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
) {
  const replay = await OpenCodeServeReplay.start(replayOptions);
  const leaser = replayLeaser(replay);
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
    ).toMatchObject({ promptTokens: 102, completionTokens: 20 });
    expect(h.replay.misses).toEqual([]);
  });

  test('tool calls complete with their output and the edit carries its patch', async () => {
    const h = await setup({ scenario: 'tools' });
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

  test('a steer the execution ended before reading is withdrawn and refused', async () => {
    const delivered = (record: OpenCodeReplayRecord) =>
      (record.kind === 'http' &&
        (JSON.stringify(record.body ?? null).includes('STEER-delivered') ||
          (record.method === 'GET' &&
            record.path?.endsWith('/inbox') === true))) ||
      (record.kind === 'sse' &&
        (record.event?.data?.inboxID === 'msg_1d71b024d001crEY1solwrshJq' ||
          record.event?.type === 'session.inbox.cancelled'));
    const h = await setup({
      scenario: 'steer',
      omit: delivered,
      ungated: (record) => record.method === 'DELETE',
    });
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
    expect(await outcome).toBeInstanceOf(ProviderTurnEndedError);
    expect(
      h.replay.made('DELETE', '/api/session/:id/inbox/:id').map((r) => r.path),
    ).toEqual([
      '/api/session/ses_e28e4fdf4ffet6a4RsosGDLmTS/inbox/msg_1d71b0245001rPumuccI4tfOcM',
    ]);
  });

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

  test('rewind stages a revert to the first dropped turn and commits it', async () => {
    const h = await setup({ scenario: 'revert' });
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
    expect(
      await h.adapter.rewindSession('thread-1', first.turnId),
    ).toMatchObject({ kind: 'answered', success: true });
    expect(
      h.replay.made('POST', '/api/session/:id/revert/stage')[0]?.body,
    ).toEqual({ messageID: 'msg_1d71b155b001aSHsV3kqKgeSj7', files: true });
    expect(
      h.replay.made('POST', '/api/session/:id/revert/commit'),
    ).toHaveLength(1);
    expect(h.replay.made('DELETE', '/api/session/:id/revert')).toHaveLength(0);
    expect(
      await h.waitFor((event) => event.code === 'acp.session-rewound'),
    ).toMatchObject({ details: { hiddenTurnIds: [second.turnId] } });
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
    ).toEqual(['upsert', 'settle']);
    expect(child[0]?.delta).toMatchObject({
      item: {
        producer: 'engine-subagent',
        childId: 'ses_e28e4e140ffemsWOeVxszItzHu',
        title: 'child probe',
        kindLabel: 'general',
        status: 'running',
      },
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
        { action: 'subagent', resource: '*', effect: 'deny' },
      ]),
    );
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
      permissions: OpenCodeNativeRule[];
    };
    expect(
      evaluateOpenCodeRules(
        { action: 'shell', resources: ['echo hi'] },
        [...build, ...created.permissions],
        [],
      ),
    ).toBe('allow');
    const full = await h.turn('DO_BASH full');
    await h.waitFor(completedFor(full.turnId));
    expect(opened(h.events)).toHaveLength(0);

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
      await h.waitFor((event) => event.method === 'session.configured'),
    ).toBeDefined();
    expect(
      h.events.filter((event) => event.method === 'session.configured').at(-1),
    ).toMatchObject({ metadata: { mode: 'plan' } });
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

  test('stopping a session with an ask pending rejects the ask and interrupts OpenCode before letting go', async () => {
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
    expect(methods.indexOf('POST reply')).toBeLessThan(
      methods.indexOf('POST interrupt'),
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

  test("the plan agent's deny survives Station's rules under Auto", async () => {
    const h = await setup({ scenario: 'plan-deny' });
    await h.start({ approvalMode: 'auto', mode: 'plan' });
    const plan = recordedAgentRules('plan-deny', 'plan');
    const body = h.replay.made('POST', '/api/session')[0]?.body as {
      agent: string;
      permissions: OpenCodeNativeRule[];
    };
    expect(body.agent).toBe('plan');
    expect(
      evaluateOpenCodeRules(
        { action: 'edit', resources: ['edit-me.txt'] },
        [...plan, ...body.permissions],
        [],
      ),
    ).toBe('deny');
    const { turnId } = await h.turn('DO_EDIT plan');
    await h.waitFor(completedFor(turnId));
    expect(opened(h.events)).toHaveLength(0);
    expect(
      h.replay.made('POST', '/api/session/:id/permission/:id/reply'),
    ).toHaveLength(0);
    expect(
      h.events.find((event) => event.method === 'tool.completed'),
    ).toMatchObject({ toolName: 'edit', status: 'error' });
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
      fallbacks: ['mode-switch', 'catalog', 'mcp'],
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
      fallbacks: ['mode-switch', 'catalog', 'mcp'],
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
