import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#3567 fix round FIX 1: before this fix, `send_message`'s and
 * `delegate_task`'s `navigate: true` path called `navigateTo(...)` and
 * discarded its result, so a navigation that `/events` denies (hosted
 * multi-tenant mode — the `ui:navigate` payload carries no destination
 * identity to route it to one tenant) was reported as an unqualified tool
 * success. These tests pin the fix: the tool's JSON result now carries
 * `navigateTo`'s real outcome under `navigation` whenever `navigate`/
 * `shouldNavigate` was requested, and carries nothing extra when it wasn't.
 *
 * `navigateTo` and the two heavy delegation entrypoints
 * (`executeExecutionTargetMessage`, `delegateTask`) are mocked at the module
 * boundary rather than driven end-to-end (both resolve real environments,
 * providers, and orchestration services this file has no reason to stand
 * up) — this file's job is pinning the forwarding behavior at the tool
 * handler, not re-testing those functions' own internals.
 */

const executeExecutionTargetMessage = vi.fn();
const delegateTask = vi.fn();
const navigateTo = vi.fn();

vi.mock('../station-control-delegation.js', async () => {
  const actual = await vi.importActual<
    typeof import('../station-control-delegation.js')
  >('../station-control-delegation.js');
  return {
    ...actual,
    executeExecutionTargetMessage: (...args: unknown[]) =>
      executeExecutionTargetMessage(...args),
    delegateTask: (...args: unknown[]) => delegateTask(...args),
  };
});

vi.mock('../station-control-shared.js', async () => {
  const actual = await vi.importActual<
    typeof import('../station-control-shared.js')
  >('../station-control-shared.js');
  return {
    ...actual,
    navigateTo: (...args: unknown[]) => navigateTo(...args),
  };
});

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

async function registerTools(): Promise<Record<string, ToolHandler>> {
  const { registerOperationsTools } = await import(
    '../station-control-operations-tools.js'
  );
  const { StationControlToolRegistry } = await import(
    '../station-control-mcp-server.js'
  );
  const server = new McpServer({
    name: 'operations-tools-navigate-forwarding',
    version: '0.0.0',
  });
  registerOperationsTools(new StationControlToolRegistry(server));
  // station#3567 second fix round FIX 5: `_registeredTools` is an MCP SDK
  // internal, not a public accessor — this file (and the pre-existing
  // `station-control-operations-tools.test.ts`, which established the
  // pattern) reaches into it because `@modelcontextprotocol/server` exposes
  // no supported way to invoke a registered tool's handler directly outside
  // a live transport. This breaks silently on an SDK internals change; keep
  // it only until a public accessor exists.
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

describe('navigate result forwarding (station#3567 fix round FIX 1)', () => {
  beforeEach(() => {
    executeExecutionTargetMessage.mockReset();
    delegateTask.mockReset();
    navigateTo.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('send_message', () => {
    test('surfaces a denied navigation instead of silently reporting success', async () => {
      executeExecutionTargetMessage.mockResolvedValue({
        conversationId: 'conv-1',
        sessionId: 'sess-1',
        providerTurnId: 'turn-1',
        target: { kind: 'agent', id: 'my-agent' },
        resolution: { kind: 'exact' },
      });
      navigateTo.mockResolvedValue({
        success: false,
        error: 'Navigation commands are not delivered in hosted mode',
      });

      const tools = await registerTools();
      const result = await tools.send_message({
        agent: 'my-agent',
        message: 'hello',
        navigate: true,
      });
      const body = parseResult(result) as {
        sessionId: string;
        navigation?: { success: boolean; error?: string };
      };

      expect(navigateTo).toHaveBeenCalledWith('/agents/my-agent');
      expect(body.sessionId).toBe('sess-1');
      expect(body.navigation).toEqual({
        success: false,
        error: 'Navigation commands are not delivered in hosted mode',
      });
    });

    test('surfaces a delivered navigation', async () => {
      executeExecutionTargetMessage.mockResolvedValue({
        conversationId: 'conv-1',
        sessionId: 'sess-1',
        providerTurnId: 'turn-1',
        target: { kind: 'agent', id: 'my-agent' },
        resolution: { kind: 'exact' },
      });
      navigateTo.mockResolvedValue({ success: true });

      const tools = await registerTools();
      const result = await tools.send_message({
        agent: 'my-agent',
        message: 'hello',
        navigate: true,
      });
      const body = parseResult(result) as { navigation?: { success: boolean } };

      expect(body.navigation).toEqual({ success: true });
    });

    test('does not call navigateTo or attach a navigation field when navigate is not requested', async () => {
      executeExecutionTargetMessage.mockResolvedValue({
        conversationId: 'conv-1',
        sessionId: 'sess-1',
        providerTurnId: 'turn-1',
        target: { kind: 'agent', id: 'my-agent' },
        resolution: { kind: 'exact' },
      });

      const tools = await registerTools();
      const result = await tools.send_message({
        agent: 'my-agent',
        message: 'hello',
      });
      const body = parseResult(result) as { navigation?: unknown };

      expect(navigateTo).not.toHaveBeenCalled();
      expect(body.navigation).toBeUndefined();
    });
  });

  describe('delegate_task', () => {
    test('surfaces a denied navigation instead of silently reporting success', async () => {
      delegateTask.mockResolvedValue({
        taskId: 'task-1',
        sessionId: 'sess-1',
        status: 'dispatched',
        environment: { id: 'env-1', name: 'current', kind: 'current' },
        target: { kind: 'agent', id: 'my-agent' },
        resolution: { kind: 'exact' },
        resumable: true,
      });
      navigateTo.mockResolvedValue({
        success: false,
        error: 'Navigation commands are not delivered in hosted mode',
      });

      const tools = await registerTools();
      const result = await tools.delegate_task({
        prompt: 'do the thing',
        agent: 'my-agent',
        navigate: true,
      });
      const body = parseResult(result) as {
        taskId: string;
        navigation?: { success: boolean; error?: string };
      };

      expect(navigateTo).toHaveBeenCalledWith('/agents/my-agent');
      expect(body.taskId).toBe('task-1');
      expect(body.navigation).toEqual({
        success: false,
        error: 'Navigation commands are not delivered in hosted mode',
      });
    });

    // station#3567 second fix round FIX 5: mirrors `send_message`'s
    // "surfaces a delivered navigation" test — the success direction had
    // coverage only on one of the two call sites.
    test('surfaces a delivered navigation', async () => {
      delegateTask.mockResolvedValue({
        taskId: 'task-1',
        sessionId: 'sess-1',
        status: 'dispatched',
        environment: { id: 'env-1', name: 'current', kind: 'current' },
        target: { kind: 'agent', id: 'my-agent' },
        resolution: { kind: 'exact' },
        resumable: true,
      });
      navigateTo.mockResolvedValue({ success: true });

      const tools = await registerTools();
      const result = await tools.delegate_task({
        prompt: 'do the thing',
        agent: 'my-agent',
        navigate: true,
      });
      const body = parseResult(result) as { navigation?: { success: boolean } };

      expect(navigateTo).toHaveBeenCalledWith('/agents/my-agent');
      expect(body.navigation).toEqual({ success: true });
    });

    test('does not call navigateTo or attach a navigation field when navigate is not requested', async () => {
      delegateTask.mockResolvedValue({
        taskId: 'task-1',
        sessionId: 'sess-1',
        status: 'dispatched',
        environment: { id: 'env-1', name: 'current', kind: 'current' },
        target: { kind: 'agent', id: 'my-agent' },
        resolution: { kind: 'exact' },
        resumable: true,
      });

      const tools = await registerTools();
      const result = await tools.delegate_task({
        prompt: 'do the thing',
        agent: 'my-agent',
      });
      const body = parseResult(result) as { navigation?: unknown };

      expect(navigateTo).not.toHaveBeenCalled();
      expect(body.navigation).toBeUndefined();
    });
  });
});
