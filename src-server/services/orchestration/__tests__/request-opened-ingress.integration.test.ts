/**
 * An engine's approval request must reach the person, whatever its size.
 *
 * Production failure: Codex called `station-control/html_preview` with ~38 KB
 * of HTML. The app-server's MCP tool approval (`mcpServer/elicitation/request`)
 * embeds the tool arguments, the Codex adapter publishes the params verbatim,
 * and EventStore refused the `request.opened` at its 64 KiB ingress ceiling.
 * The approval never showed and Codex waited on it forever.
 *
 * Composes the REAL `CodexAdapter` (only the app-server child is a stream
 * double) under the real `OrchestrationService` and `EventStore`, so the
 * request travels the production path: app-server line → adapter →
 * orchestration admission → EventStore → `respondToRequest` → reply on the
 * child's stdin.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
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
import { EventBus } from '../event-bus.js';
import { EventStore, MAX_EVENT_STORE_INGRESS_BYTES } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import {
  projectRequestOpenedForIngress,
  REQUEST_OPENED_INGRESS_BUDGET_BYTES,
} from '../request-opened-projection.js';

const THREAD = 'codex-ingress';
const CODEX_THREAD = 'codex-thread-ingress';

/**
 * A Codex app-server child that answers the adapter's own requests the way
 * the real one does, and keeps every line the adapter writes.
 */
class AnsweringCodexProcess extends EventEmitter {
  readonly lines: unknown[] = [];
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
            ? { turn: { id: 'turn-1' } }
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

describe('an oversized engine request through OrchestrationService', () => {
  const makeTempDir = trackTempDirs();
  let eventStore: EventStore;
  let service: OrchestrationService;
  let adapter: CodexAdapter;
  let child: AnsweringCodexProcess;
  let warn: Mock<(message: string, meta?: Record<string, unknown>) => void>;

  beforeEach(async () => {
    eventStore = new EventStore(
      join(makeTempDir('request-opened-ingress-'), 'orchestration.sqlite'),
    );
    child = new AnsweringCodexProcess();
    adapter = new CodexAdapter({ processFactory: () => child as never });
    vi.spyOn(adapter, 'getPrerequisites').mockResolvedValue([]);
    warn = vi.fn();
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'codex' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus: new EventBus(),
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

  function storedBytes(event: CanonicalRuntimeEvent): number {
    return Buffer.byteLength(JSON.stringify(event));
  }

  test('a Codex html_preview approval with ~40 KB of HTML is shown, answered from the raw request, and the stream keeps going', async () => {
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

    expect(storedBytes(opened)).toBeLessThanOrEqual(
      REQUEST_OPENED_INGRESS_BUDGET_BYTES + 1024,
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
    expect(warn).not.toHaveBeenCalledWith(
      'Provider adapter event stream stopped',
      expect.anything(),
    );

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

    // A later event on the same thread is still persisted.
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
  });

  test('a request within budget is stored exactly as the engine sent it', async () => {
    const params = {
      threadId: CODEX_THREAD,
      turnId: 'turn-1',
      itemId: 'cmd-1',
      command: `printf '%s\\n' "${'a'.repeat(20_000)}"`,
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
  });

  test('a request that cannot fit even when projected is cancelled with the engine and surfaced, not left pending', async () => {
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
      message: expect.stringMatching(/too large.*cancelled/),
    });
    // The engine's request was answered (a cancelled question carries no
    // answers), so Codex is not left waiting.
    expect(await eventually(() => child.repliesTo(9)[0])).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { answers: {} },
    });
    expect(persisted().some((event) => event.method === 'request.opened')).toBe(
      false,
    );
    // This is not a stream failure: no interruption, and later events persist.
    expect(warn).not.toHaveBeenCalledWith(
      'Provider adapter event stream stopped',
      expect.anything(),
    );
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
  });
});

describe('projectRequestOpenedForIngress', () => {
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
    expect(projectRequestOpenedForIngress(event)).toBe(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  test('other event kinds are never projected', () => {
    const event = {
      ...base,
      method: 'runtime.warning' as const,
      severity: 'warning' as const,
      message: 'x'.repeat(100_000),
    };
    expect(projectRequestOpenedForIngress(event as never)).toBe(event);
  });
});
