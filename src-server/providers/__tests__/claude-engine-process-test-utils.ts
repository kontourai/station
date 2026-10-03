import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';

/**
 * #2932: test doubles for the Claude engine process. The adapter owns the
 * engine spawn and reads each permission ask off the engine's stdout, so a
 * test that calls `canUseTool` needs the ask's frame on that stdout first.
 *
 * A test file mocks `createClaudeEngineProcess` to pass
 * {@link fakeClaudeSpawn} to the real one ({@link fakeEngineProcessModule}).
 * The adapter's real spawn wrapper and tap then run over a
 * {@link FakeClaudeChild} whose stdout the test writes NDJSON frames to, and
 * no real process can start.
 */

/** The command {@link fakeClaudeSpawn} answers with a fake child. */
export const FAKE_CLAUDE_COMMAND = 'station-test-fake-claude';

export class FakeClaudeChild extends EventEmitter {
  /** The most recently spawned fake child. */
  static newest: FakeClaudeChild | undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly spawnArgs: {
    command: string;
    args: readonly string[];
    options: Record<string, unknown>;
  };

  constructor(
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) {
    super();
    this.spawnArgs = { command, args, options };
    FakeClaudeChild.newest = this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.signalCode = signal ?? 'SIGTERM';
    return true;
  }

  /** The process exits; stderr stays open until {@link closeStderr}. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  closeStderr(): void {
    this.stderr.end();
    this.stderr.destroy();
  }
}

/**
 * A `spawn` that returns a fake child for the fake command and refuses any
 * other, so a test can never launch a real engine.
 */
export function fakeClaudeSpawn() {
  return (
    command: string,
    args: readonly string[],
    options: unknown,
  ): never => {
    if (command !== FAKE_CLAUDE_COMMAND)
      throw new Error(`a test tried to spawn a real process: ${command}`);
    return new FakeClaudeChild(
      command,
      args,
      options as Record<string, unknown>,
    ) as never;
  };
}

/**
 * The `claude-code-spawn.js` module with `createClaudeEngineProcess` bound
 * to {@link fakeClaudeSpawn}; everything else is the real module.
 */
export function fakeEngineProcessModule<
  T extends {
    createClaudeEngineProcess: (spawnChild?: never) => unknown;
  },
>(actual: T): T {
  return {
    ...actual,
    createClaudeEngineProcess: () =>
      actual.createClaudeEngineProcess(fakeClaudeSpawn() as never),
  };
}

/** The body of a `can_use_tool` control request, in the CLI's field names. */
export type ClaudeCanUseToolRequest = {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  [field: string]: unknown;
};

/**
 * One NDJSON line as Claude Code 2.1.278 writes a permission ask:
 * `{type:'control_request', request_id, request:{subtype:'can_use_tool',…}}`.
 * Fields the engine leaves undefined are absent, as `JSON.stringify` drops
 * them.
 */
export function claudeCanUseToolFrame(
  requestId: string,
  request: ClaudeCanUseToolRequest,
): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', ...request },
  })}\n`;
}

/**
 * The options Agent SDK 0.3.278 hands `canUseTool` for a `can_use_tool`
 * frame: its `processControlRequest` mapping, field for field. It passes the
 * frame's `request_id` as `requestId` and nothing of
 * `decision_reason_type`, `classifier_approvable`, `decision_reason_code`
 * or `requires_user_interaction`.
 */
export function sdkCanUseToolOptions(
  requestId: string,
  request: ClaudeCanUseToolRequest,
): Record<string, unknown> {
  const mcpServer = request.mcp_server as
    | { name: string; source: string }
    | undefined;
  const askRule = request.matched_ask_rule as
    | { source: string; tool_name: string; rule_content?: string }
    | undefined;
  return {
    signal: new AbortController().signal,
    suggestions: request.permission_suggestions,
    blockedPath: request.blocked_path,
    ...(mcpServer
      ? { mcpServer: { name: mcpServer.name, source: mcpServer.source } }
      : {}),
    decisionReason: request.decision_reason,
    title: request.title,
    displayName: request.display_name,
    description: request.description,
    defaultToNo: request.default_to_no,
    suppressAlwaysAllowRule: request.suppress_always_allow_rule,
    toolUseID: request.tool_use_id,
    agentID: request.agent_id,
    requestId,
    ...(askRule
      ? {
          matchedAskRule: {
            source: askRule.source,
            toolName: askRule.tool_name,
            ...(askRule.rule_content !== undefined
              ? { ruleContent: askRule.rule_content }
              : {}),
          },
        }
      : {}),
  };
}

type SdkSpawnedProcess = {
  stdin: Writable;
  stdout: Readable;
  on(event: string, listener: (...args: never[]) => void): void;
};

type ClaudeQueryOptions = {
  spawnClaudeCodeProcess?: (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => SdkSpawnedProcess;
  canUseTool?: (...args: any[]) => any;
};

type FakeClaudeEngine = {
  child: FakeClaudeChild;
  /** What the adapter's spawner handed the SDK. */
  process: SdkSpawnedProcess;
  /** Every byte the SDK side has read from the process's stdout. */
  received: () => Buffer;
  /**
   * Writes bytes to the engine's stdout and resolves once the SDK side has
   * read all of them, so the tap has seen them.
   */
  write: (bytes: string | Buffer) => Promise<void>;
};

const engines = new WeakMap<object, FakeClaudeEngine>();

/**
 * Starts the fake engine for one `query()` call the way the SDK would: by
 * calling the adapter's `spawnClaudeCodeProcess`. One engine per options
 * object; later calls return the same one.
 */
export function startFakeClaudeEngine(
  options: ClaudeQueryOptions,
): FakeClaudeEngine {
  const existing = engines.get(options);
  if (existing) return existing;
  if (typeof options.spawnClaudeCodeProcess !== 'function')
    throw new Error(
      'the Claude adapter did not hand the SDK spawnClaudeCodeProcess',
    );
  const process = options.spawnClaudeCodeProcess({
    command: FAKE_CLAUDE_COMMAND,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  // The fake command makes the fake spawn return a FakeClaudeChild, and the
  // adapter's wrapper pipes that child's stdout into what it returns.
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let writtenBytes = 0;
  const waiters: Array<{ until: number; resolve: () => void }> = [];
  process.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    receivedBytes += chunk.length;
    for (const waiter of waiters.splice(0)) {
      if (receivedBytes >= waiter.until) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  const child = FakeClaudeChild.newest;
  if (!child) throw new Error('the fake Claude child was not spawned');
  const engine: FakeClaudeEngine = {
    child,
    process,
    received: () => Buffer.concat(chunks),
    write: (bytes) => {
      const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
      writtenBytes += buffer.length;
      const until = writtenBytes;
      child.stdout.write(buffer);
      return new Promise((resolve) => {
        if (receivedBytes >= until) resolve();
        else waiters.push({ until, resolve });
      });
    },
  };
  engines.set(options, engine);
  return engine;
}

/**
 * For tests written before #2932 that call `canUseTool` with no frame. Wraps
 * the callback on a `query()` argument so each call without a `requestId`
 * first puts a frame on the fake engine's stdout, built from the call's own
 * options. The frame carries no structured reason (`decision_reason_type`
 * absent), which the adapter reads as "recorded, no reason type" and leaves
 * the decision to the signals those tests exercise. A shell tool is the
 * exception, because a shell ask with no reason type escalates: it gets
 * type `other`, with the ordinary reason text when the test gave none, as
 * the engine sends an ordinary shell ask. Tests of the structured reason
 * write their own frames and pass their own `requestId`.
 */
export function withRecordedClaudeAsks<T extends { options?: unknown }>(
  queryArgs: T,
): T {
  const options = queryArgs?.options as ClaudeQueryOptions | undefined;
  const canUseTool = options?.canUseTool;
  if (!options || typeof canUseTool !== 'function') return queryArgs;
  let sequence = 0;
  options.canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    callOptions: Record<string, unknown> = {},
  ) => {
    if (callOptions.requestId !== undefined)
      return canUseTool(toolName, input, callOptions);
    const requestId = `legacy-ask-${++sequence}`;
    const engine = startFakeClaudeEngine(options);
    const shell = toolName === 'Bash' || toolName === 'PowerShell';
    const decisionReason =
      callOptions.decisionReason ??
      (shell ? 'This command requires approval' : undefined);
    // Written straight to the tap: a Transform runs its transform
    // synchronously on write, so the record exists before the callback runs
    // and these tests keep their synchronous shape.
    (engine.process.stdout as unknown as Writable).write(
      claudeCanUseToolFrame(requestId, {
        tool_name: toolName,
        input,
        permission_suggestions: callOptions.suggestions,
        blocked_path: callOptions.blockedPath,
        decision_reason: decisionReason,
        ...(shell ? { decision_reason_type: 'other' } : {}),
        tool_use_id: callOptions.toolUseID as string | undefined,
        agent_id: callOptions.agentID,
        suppress_always_allow_rule: callOptions.suppressAlwaysAllowRule,
        default_to_no: callOptions.defaultToNo,
      }),
    );
    return canUseTool(toolName, input, {
      ...callOptions,
      ...(decisionReason !== undefined ? { decisionReason } : {}),
      requestId,
    });
  };
  return queryArgs;
}
