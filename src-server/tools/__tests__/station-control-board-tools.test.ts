import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.STATION_API_BASE = 'http://control-board-test.local';
delete process.env.STATION_PORT;

const API_BASE = 'http://control-board-test.local';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

async function registerTools(): Promise<Record<string, ToolHandler>> {
  const { registerBoardTools } = await import(
    '../station-control-board-tools.js'
  );
  const { StationControlToolRegistry } = await import(
    '../station-control-mcp-server.js'
  );
  const server = new McpServer({
    name: 'board-tools-characterization',
    version: '0.0.0',
  });
  registerBoardTools(new StationControlToolRegistry(server));
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>;
    }
  )._registeredTools;
  const handlers: Record<string, ToolHandler> = {};
  for (const [name, tool] of Object.entries(registry)) {
    handlers[name] = tool.handler;
  }
  return handlers;
}

function toolPayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('station-control board tools', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('registers board_pin, board_unpin, board_move, board_read', async () => {
    const tools = await registerTools();
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        'board_pin',
        'board_unpin',
        'board_move',
        'board_read',
      ]),
    );
  });

  test('board_pin POSTs to /api/board/pin and forwards the block payload', async () => {
    const board = { schemaVersion: 1, tabs: [], widgets: [] };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: board }),
    );
    const tools = await registerTools();
    const result = await tools.board_pin({
      reference: { kind: 'session', id: 's-1' },
      name: 'status',
      block: { type: 'card', body: 'text' },
    });
    expect(toolPayload(result)).toEqual({ success: true, data: board });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/api/board/pin`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: 'status',
      block: { type: 'card', body: 'text' },
    });
  });

  test('board_pin surfaces a provenance refusal as a tool-level failure, not a thrown crash', async () => {
    // Fix round C6: the real route now names `board_pin`, not
    // `render_component` — the mocked wire response reflects that.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          code: 'board_provenance_refused',
          error:
            "board_pin: a 'card' block claiming data values requires 'derivedFrom' source references; emission without them is refused.",
        },
        422,
      ),
    );
    const tools = await registerTools();
    const result = await tools.board_pin({
      reference: { kind: 'session', id: 's-1' },
      name: 'status',
      block: {
        type: 'card',
        body: 'text',
        fields: [{ label: 'l', value: 'v' }],
      },
    });
    const payload = toolPayload(result) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('derivedFrom');
    expect(payload.error).toContain('board_pin:');
  });

  /**
   * Fix round B1 (independent review, BLOCKING): the reviewer's exact
   * traversal reproduction, relayed through the MCP tool boundary — the
   * route refuses with 400 `board_reference_invalid` before any store I/O,
   * and the tool must surface that as a clean tool-level failure rather
   * than crash or silently succeed.
   */
  test('board_pin relays the route\'s traversal refusal (".." reference) as a tool-level failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          code: 'board_reference_invalid',
          error: 'Invalid board reference.',
        },
        400,
      ),
    );
    const tools = await registerTools();
    const result = await tools.board_pin({
      reference: { kind: 'session', id: '..' },
      name: 'x',
      block: { type: 'card', body: 'x' },
    });
    const payload = toolPayload(result) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Invalid board reference');
  });

  /**
   * Fix round B2 (independent review, BLOCKING): investigated how sibling
   * station-control tools scope session/task references — none of them
   * (`get_conversation_messages`, `delete_conversation`, etc.,
   * `station-control-agent-tools.ts`) implement any per-tool authorization
   * of their own; they are thin `@kontourai/station-sdk/client` proxies to
   * routes that derive authority from the REQUEST via
   * `getCachedUser()`/`getTenantRequestContext()` (see
   * `station-control-shared.ts#controlRequestOptions`/`api()`). There is no
   * "implicit current-session scoping" layer at the tool boundary — the
   * reviewer's suspicion does not match what this codebase does. The board
   * tools follow the exact same shape: no tool-level scoping is added here,
   * because `routes/board.ts`'s new `canReadSession`/`taskExists` gate
   * (wired in `runtime-routes.ts`) already applies to every request the
   * tool makes, station-control's included — this test proves the relay.
   */
  test("board_read relays the route's unresolvable-reference refusal (cross-session/nonexistent) as a tool-level failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          code: 'board_reference_unresolvable',
          error: 'This board reference does not resolve for the caller.',
        },
        404,
      ),
    );
    const tools = await registerTools();
    const result = await tools.board_read({
      reference: { kind: 'session', id: 'someone-elses-session' },
    });
    const payload = toolPayload(result) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('does not resolve');
  });

  test('board_unpin POSTs to /api/board/unpin', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { schemaVersion: 1, tabs: [], widgets: [] },
      }),
    );
    const tools = await registerTools();
    await tools.board_unpin({
      reference: { kind: 'session', id: 's-1' },
      name: 'status',
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/api/board/unpin`);
  });

  test('board_move POSTs to /api/board/move', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { schemaVersion: 1, tabs: [], widgets: [] },
      }),
    );
    const tools = await registerTools();
    await tools.board_move({
      reference: { kind: 'session', id: 's-1' },
      name: 'status',
      after: 'other',
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/api/board/move`);
  });

  test('board_read issues a GET carrying the reference', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { schemaVersion: 1, tabs: [], widgets: [] },
      }),
    );
    const tools = await registerTools();
    await tools.board_read({ reference: { kind: 'session', id: 's-1' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/board?kind=session&id=s-1');
    expect(init.method).toBe('GET');
  });
});
