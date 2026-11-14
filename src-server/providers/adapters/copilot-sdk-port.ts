/**
 * The slice of `@github/copilot-sdk` the Copilot SDK adapter uses, as a port
 * the adapter can be driven through without a Copilot CLI.
 *
 * Every type here is the SDK's own (pinned in package.json), or is derived
 * from its RPC surface, so an SDK change that breaks this slice fails the
 * typecheck instead of drifting. The adapter's tests drive a fake through the
 * same callbacks the real SDK calls: `SessionConfig.onEvent`,
 * `onPermissionRequest` and `hooks.onPreToolUse`.
 *
 * How the runtime is reached (docs/decisions/copilot-sdk-engine.md): the SDK
 * spawns the given Copilot CLI as `<cli> --headless --no-auto-update --stdio`
 * and speaks JSON-RPC to it. Station always passes the path of the person's
 * own installed CLI. The SDK's per-platform runtime packages are never
 * installed (`ignoredOptionalDependencies` in pnpm-workspace.yaml), and the
 * experimental in-process (FFI) transport, the only code path that loads
 * `koffi`, is never used.
 */
import type {
  CopilotClient,
  CopilotSession,
  MessageOptions,
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';

export type CopilotHistoryRewindRequest = Parameters<
  CopilotSession['rpc']['history']['rewind']
>[0];
export type CopilotHistoryRewindResult = Awaited<
  ReturnType<CopilotSession['rpc']['history']['rewind']>
>;
/** `{ success, mode }`: whether the requested `permissionMode` applied. */
export type CopilotPermissionModeResult =
  CopilotSession['permissionModeResult'];

/** How often a live runtime's connection is checked with `ping()`. */
export const COPILOT_CONNECTION_CHECK_MS = 5_000;

/** One live Copilot session, as the adapter uses it. */
export interface CopilotSdkSessionPort {
  readonly sessionId: string;
  /**
   * The outcome of the `permissionMode` requested at create or resume, as
   * the runtime reported it; `undefined` when it reported none.
   */
  readonly permissionModeResult: CopilotPermissionModeResult;
  /** The session's persisted events (ephemeral ones such as usage excluded). */
  getEvents(): Promise<SessionEvent[]>;
  /** Resolves with the submitted user message's id once the runtime admits it. */
  send(options: MessageOptions): Promise<string>;
  abort(): Promise<void>;
  /** Releases the session in this client; the runtime keeps it for resume. */
  disconnect(): Promise<void>;
  /** `session.history.rewind` (experimental in the SDK). */
  rewind(
    request: CopilotHistoryRewindRequest,
  ): Promise<CopilotHistoryRewindResult>;
  /** `session.mcp.restartServer`: stop then start one MCP server. */
  restartMcpServer(serverName: string): Promise<void>;
}

/** One Copilot runtime process and the sessions on it. */
export interface CopilotSdkClientPort {
  createSession(config: SessionConfig): Promise<CopilotSdkSessionPort>;
  resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotSdkSessionPort>;
  listModels(): Promise<ModelInfo[]>;
  /**
   * Calls `onLost` once when the runtime connection stops answering (its
   * process died or its pipe closed). The SDK has no public disconnect
   * event, so this checks `ping()` every {@link COPILOT_CONNECTION_CHECK_MS}.
   * Returns a function that stops the watch.
   */
  watchConnection(onLost: (error: unknown) => void): () => void;
  /** Ends the runtime process. Never throws; errors are returned. */
  stop(): Promise<Error[]>;
}

/** How Station launches one Copilot runtime. */
export interface CopilotSdkLaunch {
  /** The CLI to spawn: an executable, or a `.js` entry the SDK runs with Node. */
  cliPath: string;
  /** Extra leading arguments (a managed policy's pinned ones); the SDK adds its own. */
  args: readonly string[];
  /** The whole child environment; the SDK does not merge `process.env` into it. */
  env: Record<string, string>;
  /** The runtime process's working directory. */
  cwd: string;
}

export type CopilotSdkClientFactory = (
  launch: CopilotSdkLaunch,
) => Promise<CopilotSdkClientPort>;

function sessionPort(session: CopilotSession): CopilotSdkSessionPort {
  return {
    get sessionId() {
      return session.sessionId;
    },
    get permissionModeResult() {
      return session.permissionModeResult;
    },
    getEvents: () => session.getEvents(),
    send: (options) => session.send(options),
    abort: () => session.abort(),
    disconnect: () => session.disconnect(),
    rewind: (request) => session.rpc.history.rewind(request),
    restartMcpServer: (serverName) =>
      session.rpc.mcp.restartServer({ serverName }),
  };
}

function clientPort(client: CopilotClient): CopilotSdkClientPort {
  return {
    createSession: async (config) =>
      sessionPort(await client.createSession(config)),
    resumeSession: async (sessionId, config) =>
      sessionPort(await client.resumeSession(sessionId, config)),
    listModels: () => client.listModels(),
    watchConnection: (onLost) => {
      let stopped = false;
      let checking = false;
      const timer = setInterval(() => {
        if (stopped || checking) return;
        checking = true;
        client.ping().then(
          () => {
            checking = false;
          },
          (error: unknown) => {
            checking = false;
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            onLost(error);
          },
        );
      }, COPILOT_CONNECTION_CHECK_MS);
      timer.unref?.();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
    stop: async () => {
      try {
        return await client.stop();
      } catch (error) {
        return [error instanceof Error ? error : new Error(String(error))];
      }
    },
  };
}

/**
 * Starts one Copilot runtime over stdio. The SDK is imported on first use, so
 * a Station that never starts a Copilot SDK session never loads it.
 *
 * `useLoggedInUser` keeps the engine's own sign-in (`copilot login`, the OS
 * keychain, or `gh`): Station holds no Copilot credential and never forwards
 * one of its own. `clientInfo` attributes the connection to Station.
 */
export const createCopilotSdkClient: CopilotSdkClientFactory = async (
  launch,
) => {
  const sdk = await import('@github/copilot-sdk');
  const client = new sdk.CopilotClient({
    connection: sdk.RuntimeConnection.forStdio({
      path: launch.cliPath,
      args: launch.args,
      env: launch.env,
    }),
    workingDirectory: launch.cwd,
    useLoggedInUser: true,
    clientInfo: { applicationName: 'station' },
  });
  try {
    await client.start();
  } catch (error) {
    await client.forceStop().catch(() => undefined);
    throw error;
  }
  return clientPort(client);
};
