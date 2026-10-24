/**
 * Engine material must reach the person, whatever its size, and survive a
 * reload.
 *
 * Production failure: Codex called `station-control/html_preview` with ~38 KB
 * of HTML. The app-server's MCP tool approval (`mcpServer/elicitation/request`)
 * embeds the tool arguments, the Codex adapter publishes the params verbatim,
 * and EventStore refused the `request.opened` at its 64 KiB ingress ceiling.
 * The approval never showed and Codex waited on it forever. The
 * `tool.started` carrying the same arguments was refused the same way.
 *
 * Composes the REAL `CodexAdapter` (only the app-server child is a stream
 * double) under the real `OrchestrationService` and `EventStore`, so each
 * event travels the production path: app-server line → adapter →
 * orchestration admission → EventStore → the conversation window read a
 * reload uses → `respondToRequest` → reply on the child's stdin.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { inputRequestFromRequestEvent } from '@kontourai/station-shared/input-request';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { CodexAdapter } from '../../../providers/adapters/codex-adapter.js';
import { codexInputRequest } from '../../../providers/adapters/harness-questions.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import {
  MAX_EVENT_STORE_INGRESS_BYTES,
  REQUEST_OPENED_SNAPSHOT_MAX_BYTES,
  SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES,
} from '../event-store-limits.js';
import {
  projectEventForIngress,
  REQUEST_OPENED_PROJECTION_BUDGET_BYTES,
  TOOL_STARTED_PROJECTION_THRESHOLD_BYTES,
} from '../ingress-event-projection.js';
import { OrchestrationService } from '../orchestration-service.js';

const THREAD = 'codex-ingress';
const CODEX_THREAD = 'codex-thread-ingress';

/**
 * A Codex app-server child that answers the adapter's own requests the way
 * the real one does, and keeps every line the adapter writes.
 */
class AnsweringCodexProcess extends EventEmitter {
  readonly lines: unknown[] = [];
  private turns = 0;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split('\n')) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          this.lines.push(message);
          if (typeof message.method === 'string' && 'id' in message)
            setImmediate(() => this.answer(message));
        }
        callback();
      },
    });
  }

  private answer(message: { id: unknown; method: string }) {
    const result =
      message.method === 'initialize'
        ? { userAgent: 'codex-test' }
        : message.method === 'thread/start'
          ? { thread: { id: CODEX_THREAD } }
          : message.method === 'turn/start'
            ? { turn: { id: `turn-${++this.turns}` } }
            : {};
    this.send({ id: message.id, result });
  }

  send(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  repliesTo(id: number) {
    return this.lines.filter(
      (line) =>
        (line as { id?: unknown }).id === id && !('method' in (line as object)),
    );
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

/**
 * HTML of at least `bytes` UTF-8 bytes, rich in characters JSON must escape
 * (quotes, backslashes, newlines, tabs) so raw length undercounts the
 * persisted size.
 */
function htmlDocument(bytes: number): string {
  const row =
    '<tr class="row" data-x="a\\b">\n\t<td>"quoted" café — cell</td>\n</tr>\n';
  return `<!doctype html>\n<html><body><table>\n${row.repeat(
    Math.ceil(bytes / Buffer.byteLength(row)),
  )}</table></body></html>`;
}

/**
 * The app-server's MCP tool-call approval, shaped as Codex 0.163 sends it:
 * an empty-schema form whose `_meta` names the approval kind and carries the
 * call's arguments (`tool_params`) and their display copy.
 */
function htmlPreviewElicitation(id: number, html: string) {
  return {
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'station-control',
      threadId: CODEX_THREAD,
      turnId: 'turn-1',
      mode: 'form',
      message:
        'Allow the station-control MCP server to run tool "html_preview"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_title: 'html_preview',
        tool_description: 'Render HTML in a preview pane.',
        tool_params: { title: 'Report', html },
        tool_params_display: [
          { name: 'title', value: 'Report' },
          { name: 'html', value: html },
        ],
      },
    },
  };
}

async function eventually<T>(
  read: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('oversized engine material through OrchestrationService', () => {
  const makeTempDir = trackTempDirs();
  let eventStore: EventStore;
  let service: OrchestrationService;
  let adapter: CodexAdapter;
  let child: AnsweringCodexProcess;
  let warn: Mock<(message: string, meta?: Record<string, unknown>) => void>;
  let eventBus: EventBus;
  let published: CanonicalRuntimeEvent[];

  beforeEach(async () => {
    eventStore = new EventStore(
      join(makeTempDir('ingress-event-projection-'), 'orchestration.sqlite'),
    );
    child = new AnsweringCodexProcess();
    adapter = new CodexAdapter({ processFactory: () => child as never });
    vi.spyOn(adapter, 'getPrerequisites').mockResolvedValue([]);
    warn = vi.fn();
    eventBus = new EventBus();
    published = [];
    eventBus.subscribe((frame) => {
      const event = frame.data?.event as CanonicalRuntimeEvent | undefined;
      if (event?.eventId) published.push(event);
    });
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'codex' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn },
    });
    await service.dispatch(
      { type: 'startSession', input: { threadId: THREAD, provider: 'codex' } },
      { userId: 'owner-user' },
    );
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: THREAD, input: 'preview the report' },
    });
  });

  afterEach(async () => {
    await adapter.stopAll().catch(() => undefined);
    eventStore.close();
  });

  function persisted(): CanonicalRuntimeEvent[] {
    return eventStore.listEvents(THREAD).map((row) => row.payload);
  }

  /**
   * The event as a reload reads it: the conversation window read behind
   * `fetchOrchestrationConversationEventWindow`, with the newest-turn options
   * `hydrateOpenApprovalToasts` sends, and the turn-ordered path beside it.
   * (The single-session turn path selects by `turnId`, which a Codex
   * request does not carry; it is covered below with one that does.)
   */
  function readBack(eventId: string) {
    const reads = [
      eventStore.listConversationEventWindowByTurn([THREAD], {
        turnLimit: 1,
        direction: 'newest',
      }),
      eventStore.listConversationEventWindowByTurn([THREAD], { turnLimit: 5 }),
    ].map((window) =>
      window.events.find((event) => event.payload.eventId === eventId),
    );
    for (const read of reads) {
      expect(read).toBeDefined();
      expect(read?.elided).toBeUndefined();
    }
    return reads.map((read) => read!.payload);
  }

  function expectStreamKeptRunning() {
    expect(warn).not.toHaveBeenCalledWith(
      'Provider adapter event stream stopped',
      expect.anything(),
    );
  }

  async function expectLaterEventPersisted() {
    child.send({
      method: 'turn/completed',
      params: {
        threadId: CODEX_THREAD,
        turn: { id: 'turn-1', status: 'completed', items: [], error: null },
      },
    });
    await eventually(() =>
      persisted().find((event) => event.method === 'turn.completed'),
    );
  }

  test('a Codex html_preview approval with ~40 KB of HTML is shown, survives a reload, is answered from the raw request, and the stream keeps going', async () => {
    const html = htmlDocument(40 * 1024);
    // The production shape exceeds the ceiling verbatim.
    expect(
      Buffer.byteLength(JSON.stringify(htmlPreviewElicitation(7, html))),
    ).toBeGreaterThan(MAX_EVENT_STORE_INGRESS_BYTES);

    child.send(htmlPreviewElicitation(7, html));
    const opened = await eventually(() =>
      persisted().find((event) => event.method === 'request.opened'),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');

    expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThanOrEqual(
      REQUEST_OPENED_SNAPSHOT_MAX_BYTES,
    );
    expect(opened.title).toBe('Allow station-control to run "html_preview"');
    const payload = opened.payload as Record<string, any>;
    // Decision-critical fields are exact.
    expect(payload).toMatchObject({
      serverName: 'station-control',
      threadId: CODEX_THREAD,
      turnId: 'turn-1',
      mode: 'form',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_title: 'html_preview',
        tool_params: { title: 'Report' },
      },
      stationTruncation: { truncated: true },
    });
    // The arguments are abbreviated visibly: the head of the real HTML, then
    // the marker.
    const shown = payload._meta.tool_params.html as string;
    expect(shown.length).toBeLessThan(html.length);
    expect(html.startsWith(shown.slice(0, shown.indexOf('\n…[')))).toBe(true);
    expect(shown).toMatch(
      /\n…\[Station shortened this value: \d+ more bytes not shown\]$/,
    );
    expect(payload._meta.tool_params_display[1].value).toMatch(
      /Station shortened this value/,
    );
    // A reload (or a second device) gets the whole stored request back.
    for (const read of readBack(opened.eventId)) expect(read).toEqual(opened);
    expectStreamKeptRunning();

    await service.dispatch({
      type: 'respondToRequest',
      threadId: THREAD,
      requestId: opened.requestId,
      expectedRequestEventId: opened.eventId,
      decision: 'accept',
    });
    // Built from the raw params (an empty schema accepts), on the wire id
    // Codex sent.
    expect(await eventually(() => child.repliesTo(7)[0])).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { action: 'accept' },
    });
    await eventually(() =>
      persisted().find(
        (event) =>
          event.method === 'request.resolved' &&
          event.requestId === opened.requestId,
      ),
    );
    await expectLaterEventPersisted();
  });

  test('a question whose request needs projection keeps its exact form, through a reload', async () => {
    // Two questions with long option descriptions: the form alone is ~25 KB,
    // and Codex's raw `questions` repeat it, so the request needs projection.
    const description = `Choose "this" option\n${'detail '.repeat(140)}`;
    const questions = [0, 1].map((index) => ({
      id: `q${index}`,
      header: `Question ${index}`,
      question: `Pick option ${index}`,
      isOther: false,
      isSecret: false,
      options: Array.from({ length: 12 }, (_, option) => ({
        label: `Option ${option}`,
        description,
      })),
    }));
    const params = {
      threadId: CODEX_THREAD,
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions,
    };
    const form = codexInputRequest(params);
    expect(form).not.toBeNull();
    child.send({ id: 13, method: 'item/tool/requestUserInput', params });

    const opened = await eventually(() =>
      persisted().find((event) => event.method === 'request.opened'),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');
    expect(opened.payload).toMatchObject({
      stationTruncation: { truncated: true },
    });
    expect(opened.payload?.inputRequest).toEqual(form);
    for (const read of readBack(opened.eventId)) {
      expect(read).toEqual(opened);
      expect(inputRequestFromRequestEvent(read as never)).toEqual(form);
    }
  });

  test('a request of many mid-sized strings is cut far enough to read back whole on reload', async () => {
    expect(REQUEST_OPENED_PROJECTION_BUDGET_BYTES).toBe(43_904);
    // 220 strings of ~900 bytes: at a 256-byte floor each, this would land
    // near 60 KB, stored but over the window read's 48,000-byte allowance.
    const rows = Array.from(
      { length: 220 },
      (_, index) => `row ${index}: ${'"cell"\t'.repeat(110)}`,
    );
    const elicitation = htmlPreviewElicitation(19, '<p>small</p>');
    (elicitation.params._meta.tool_params as Record<string, unknown>).rows =
      rows;
    child.send(elicitation);
    const opened = await eventually(() =>
      persisted().find((event) => event.method === 'request.opened'),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');
    expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThanOrEqual(
      REQUEST_OPENED_PROJECTION_BUDGET_BYTES,
    );
    const payload = opened.payload as Record<string, any>;
    // Short strings stay exact; every row is cut visibly, keeping its head.
    expect(payload).toMatchObject({
      serverName: 'station-control',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_title: 'html_preview',
        tool_params: { title: 'Report', html: '<p>small</p>' },
      },
    });
    const shown = payload._meta.tool_params.rows as string[];
    expect(shown).toHaveLength(220);
    shown.forEach((row, index) => {
      expect(row.startsWith(`row ${index}: `)).toBe(true);
      expect(row).toMatch(/Station shortened this value/);
    });
    for (const read of readBack(opened.eventId)) expect(read).toEqual(opened);
  });

  test('a request within budget is stored exactly as the engine sent it', async () => {
    const params = {
      threadId: CODEX_THREAD,
      turnId: 'turn-1',
      itemId: 'cmd-1',
      command: `printf '%s\\n' "${'a'.repeat(30_000)}"`,
      reason: 'Write the "probe"\nfile',
    };
    child.send({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params,
    });
    const opened = await eventually(() =>
      persisted().find((event) => event.method === 'request.opened'),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');
    expect(opened.payload).toEqual(params);
    expect(opened.description).toBe(params.reason);
    // Above the ordinary 24 KiB read ceiling, and still read back whole.
    expect(Buffer.byteLength(JSON.stringify(opened))).toBeGreaterThan(
      SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES,
    );
    for (const read of readBack(opened.eventId)) expect(read).toEqual(opened);
  });

  test('a tool call over the ingress ceiling is stored shortened instead of lost, and the stream keeps going', async () => {
    const html = htmlDocument(75 * 1024);
    child.send({
      method: 'item/started',
      params: {
        threadId: CODEX_THREAD,
        turnId: 'turn-1',
        item: {
          id: 'mcp-html',
          type: 'mcpToolCall',
          server: 'station-control',
          tool: 'html_preview',
          arguments: { title: 'Report', html },
        },
      },
    });
    const started = await eventually(() =>
      persisted().find((event) => event.method === 'tool.started'),
    );
    if (started.method !== 'tool.started') throw new Error('unreachable');
    expect(started).toMatchObject({
      toolCallId: 'mcp-html',
      toolName: 'station-control/html_preview',
      arguments: { title: 'Report' },
    });
    const shown = (started.arguments as { html: string }).html;
    expect(html.startsWith(shown.slice(0, shown.indexOf('\n…[')))).toBe(true);
    expect(shown).toMatch(/Station shortened this value: \d+ more bytes/);
    expect(Buffer.byteLength(JSON.stringify(started))).toBeLessThan(
      MAX_EVENT_STORE_INGRESS_BYTES,
    );
    // What was stored is what went live.
    expect(
      published.find((event) => event.eventId === started.eventId),
    ).toEqual(started);
    expectStreamKeptRunning();
    await expectLaterEventPersisted();
  });

  test('a storable tool call is stored and published byte-identical, however large', async () => {
    // ~30 KB: over the window read's ordinary ceiling, under the ingress one.
    // Transcript MCP Apps receive the live arguments as their tool input.
    const arguments_ = { title: 'Report', html: htmlDocument(30 * 1024) };
    child.send({
      method: 'item/started',
      params: {
        threadId: CODEX_THREAD,
        turnId: 'turn-1',
        item: {
          id: 'mcp-html-30',
          type: 'mcpToolCall',
          server: 'station-control',
          tool: 'html_preview',
          arguments: arguments_,
        },
      },
    });
    const started = await eventually(() =>
      persisted().find((event) => event.method === 'tool.started'),
    );
    if (started.method !== 'tool.started') throw new Error('unreachable');
    expect(Buffer.byteLength(JSON.stringify(started))).toBeGreaterThan(
      SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES,
    );
    expect(started.arguments).toEqual(arguments_);
    const live = await eventually(() =>
      published.find((event) => event.eventId === started.eventId),
    );
    expect(live).toEqual(started);
    expect((live as typeof started).arguments).toEqual(arguments_);
  });

  test('tool starts up to the threshold are byte-identical; just over it they are shortened before the ceiling', async () => {
    // Pinned beside the constants these sizes derive from.
    expect(MAX_EVENT_STORE_INGRESS_BYTES).toBe(65_536);
    expect(TOOL_STARTED_PROJECTION_THRESHOLD_BYTES).toBe(64_512);
    const start = async (id: string, html: string) => {
      child.send({
        method: 'item/started',
        params: {
          threadId: CODEX_THREAD,
          turnId: 'turn-1',
          item: {
            id,
            type: 'mcpToolCall',
            server: 'station-control',
            tool: 'html_preview',
            arguments: { html },
          },
        },
      });
      const stored = await eventually(() =>
        persisted().find(
          (event) => event.method === 'tool.started' && event.toolCallId === id,
        ),
      );
      const live = await eventually(() =>
        published.find((event) => event.eventId === stored.eventId),
      );
      expect(live).toEqual(stored);
      return stored as Extract<
        CanonicalRuntimeEvent,
        { method: 'tool.started' }
      >;
    };
    // Plain ASCII, so the argument's stored size is its length. Calibrate
    // everything else on the event with an id of the same length.
    const probe = await start('tool-cal', 'a'.repeat(1_000));
    const envelope = Buffer.byteLength(JSON.stringify(probe)) - 1_000;
    const sized = (target: number) => 'a'.repeat(target - envelope);
    const cases = [
      { id: 'tool-56k', target: 56 * 1024, whole: true },
      {
        id: 'tool-thr',
        target: TOOL_STARTED_PROJECTION_THRESHOLD_BYTES - 64,
        whole: true,
      },
      {
        id: 'tool-ovr',
        target: TOOL_STARTED_PROJECTION_THRESHOLD_BYTES + 256,
        whole: false,
      },
    ];
    for (const { id, target, whole } of cases) {
      const html = sized(target);
      const stored = await start(id, html);
      const bytes = Buffer.byteLength(JSON.stringify(stored));
      if (whole) {
        expect(Math.abs(bytes - target)).toBeLessThanOrEqual(64);
        expect(stored.arguments).toEqual({ html });
      } else {
        // Storable verbatim (under 65,536), but within the retry margin.
        expect(target).toBeLessThan(MAX_EVENT_STORE_INGRESS_BYTES);
        expect((stored.arguments as { html: string }).html).toMatch(
          /Station shortened this value/,
        );
        expect(bytes).toBeLessThan(TOOL_STARTED_PROJECTION_THRESHOLD_BYTES);
      }
    }
  });

  test('a large prompt and a large approval in one newest-turn window both come back whole', async () => {
    await expectLaterEventPersisted();
    const prompt = `Build this page:\n${'"spec" line\n'.repeat(1_550)}`;
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: THREAD, input: prompt },
    });
    const turnStarted = await eventually(() =>
      persisted().find(
        (event) => event.method === 'turn.started' && event.turnId === 'turn-2',
      ),
    );
    // Under the anchor's own per-event ceiling, so it is read whole.
    const promptBytes = Buffer.byteLength(JSON.stringify(turnStarted));
    expect(promptBytes).toBeGreaterThan(20_000);
    expect(promptBytes).toBeLessThan(SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES);

    // A small turn-scoped event between the prompt and the request, so the
    // oldest event the budget loop keeps names the turn and the page needs
    // the turn start appended as its anchor.
    child.send({
      method: 'item/started',
      params: {
        threadId: CODEX_THREAD,
        turnId: 'turn-2',
        item: {
          id: 'cmd-small',
          type: 'commandExecution',
          command: 'ls',
          cwd: '/tmp/project',
        },
      },
    });
    await eventually(() =>
      persisted().find(
        (event) => event.method === 'tool.started' && event.turnId === 'turn-2',
      ),
    );
    const elicitation = htmlPreviewElicitation(17, htmlDocument(40 * 1024));
    elicitation.params.turnId = 'turn-2';
    child.send(elicitation);
    const opened = await eventually(() =>
      persisted().find((event) => event.method === 'request.opened'),
    );
    if (opened.method !== 'request.opened') throw new Error('unreachable');

    // The session window read behind `/sessions/:id/event-window`, serialized
    // as that route sends it (`c.json({ success: true, data })`).
    const data = await service.readSessionEventWindow(THREAD, {
      direction: 'newest',
      turnLimit: 1,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });
    expect(data).not.toBeNull();
    const body = JSON.stringify({ success: true, data });
    // Not asserted: the body can exceed the 64,000-byte response budget
    // here. Nothing bounds the turn-start anchor appended after the page's
    // byte budget (an existing gap, also reachable with a long reply).
    const events = (
      JSON.parse(body) as {
        data: {
          events: Array<{ event: CanonicalRuntimeEvent; elided?: string }>;
        };
      }
    ).data.events;
    const readOpened = events.find(
      (entry) => entry.event.eventId === opened.eventId,
    );
    expect(readOpened?.elided).toBeUndefined();
    expect(readOpened?.event).toEqual(opened);
    // The page's turn-start anchor carries the prompt whole, as on main: a
    // client merging pages keeps the newer copy, so an elided anchor here
    // would hide the prompt.
    const anchor = events.find(
      (entry) => entry.event.eventId === turnStarted.eventId,
    );
    expect(anchor?.elided).toBeUndefined();
    expect(anchor?.event).toEqual(turnStarted);
  });

  test('a form too large to store even when projected is declined with the engine and surfaced, not left pending', async () => {
    // The form is shown to the person exactly as asked, so it is never cut;
    // this one is valid but larger than the ceiling on its own.
    const description = `${'"Line"\n'.repeat(200)}`.slice(0, 1_500);
    const questions = [0, 1, 2].map((index) => ({
      id: `q${index}`,
      header: `Question ${index}`,
      question: `Pick option ${index}`,
      isOther: false,
      isSecret: false,
      options: Array.from({ length: 30 }, (_, option) => ({
        label: `Option ${option}`,
        description,
      })),
    }));
    child.send({
      id: 9,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: CODEX_THREAD,
        turnId: 'turn-1',
        itemId: 'ask-1',
        questions,
      },
    });

    const warning = await eventually(() =>
      persisted().find(
        (event) =>
          event.method === 'runtime.warning' &&
          event.code === 'request-too-large-to-show',
      ),
    );
    expect(warning).toMatchObject({
      message: expect.stringMatching(/declined it for you.*can continue/),
    });
    // The engine's request was answered (a declined question carries no
    // answers) and recorded as a decline, so Codex is not left waiting.
    expect(await eventually(() => child.repliesTo(9)[0])).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { answers: {} },
    });
    expect(
      await eventually(() =>
        persisted().find((event) => event.method === 'request.resolved'),
      ),
    ).toMatchObject({ status: 'denied' });
    expect(persisted().some((event) => event.method === 'request.opened')).toBe(
      false,
    );
    // This is not a stream failure: no interruption, and later events persist.
    expectStreamKeptRunning();
    await expectLaterEventPersisted();
  });

  test('an approval EventStore refuses for its structure is declined on the wire, not cancelled', async () => {
    // Over EventStore's 512-item array limit: projection only shortens text.
    const elicitation = htmlPreviewElicitation(15, '<p>small</p>');
    (elicitation.params._meta.tool_params as Record<string, unknown>).rows =
      Array.from({ length: 600 }, (_, index) => index);
    child.send(elicitation);

    await eventually(() =>
      persisted().find(
        (event) =>
          event.method === 'runtime.warning' &&
          event.code === 'request-too-large-to-show',
      ),
    );
    expect(await eventually(() => child.repliesTo(15)[0])).toEqual({
      jsonrpc: '2.0',
      id: 15,
      result: { action: 'decline' },
    });
    expectStreamKeptRunning();
    await expectLaterEventPersisted();
  });
});

describe('projectEventForIngress', () => {
  const makeTempDir = trackTempDirs();

  const base = {
    eventId: 'event-1',
    provider: 'codex' as const,
    threadId: 'thread-1',
    createdAt: '2026-10-24T00:00:00.000Z',
    requestId: 'request-1',
    method: 'request.opened' as const,
    requestType: 'approval' as const,
    title: 'Approve command execution',
  };

  test('an event within budget is returned unchanged, as the same object', () => {
    const event = {
      ...base,
      payload: {
        command: 'ls "a b"\n',
        itemId: 'cmd-1',
        big: 'x'.repeat(30_000),
      },
    };
    const before = JSON.stringify(event);
    expect(projectEventForIngress(event)).toBe(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  test('a projected request read back through the single-session turn window is intact', () => {
    const store = new EventStore(
      join(makeTempDir('ingress-event-window-'), 'orchestration.sqlite'),
    );
    try {
      store.appendEvent({
        eventId: 'turn-start-1',
        provider: 'claude',
        threadId: 'thread-1',
        createdAt: '2026-10-24T00:00:00.000Z',
        turnId: 'turn-1',
        method: 'turn.started',
      } as CanonicalRuntimeEvent);
      const projected = projectEventForIngress({
        ...base,
        provider: 'claude',
        createdAt: '2026-10-24T00:00:01.000Z',
        turnId: 'turn-1',
        payload: {
          toolName: 'Write',
          toolCallId: 'toolu-1',
          toolInput: {
            file_path: '/tmp/page.html',
            content: htmlDocument(60 * 1024),
          },
        },
      });
      expect(
        projected.method === 'request.opened' && projected.payload,
      ).toMatchObject({ stationTruncation: { truncated: true } });
      store.appendEvent(projected);
      const window = store.listEventWindowByTurn('thread-1', { turnLimit: 5 });
      const read = window.events.find(
        (event) => event.payload.eventId === projected.eventId,
      );
      expect(read?.elided).toBeUndefined();
      expect(read?.payload).toEqual(projected);
    } finally {
      store.close();
    }
  });

  test('other event kinds are never projected', () => {
    const event = {
      ...base,
      method: 'runtime.warning' as const,
      severity: 'warning' as const,
      message: 'x'.repeat(100_000),
    };
    expect(projectEventForIngress(event as never)).toBe(event);
  });

  test('the receipt stays inside its reserve however many long paths are cut', () => {
    const key = 'k'.repeat(200);
    const payload: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1)
      payload[`${key}${index}`] = { [key]: 'v'.repeat(4_000) };
    const projected = projectEventForIngress({ ...base, payload });
    if (projected.method !== 'request.opened') throw new Error('unreachable');
    const receipt = projected.payload?.stationTruncation as {
      fields: string[];
    };
    expect(receipt.fields).toHaveLength(16);
    for (const field of receipt.fields)
      expect(field.length).toBeLessThanOrEqual(96);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(
      REQUEST_OPENED_SNAPSHOT_MAX_BYTES - 4 * 1024,
    );
  });
});
