import type {
  ClientRequestHandlersByMethod,
  ClientRequestMethod,
  ClientRequestParamsByMethod,
  CreateTerminalRequest,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk/unstable';

export interface ManagedTerminal {
  process: import('node:child_process').ChildProcess;
  output: string;
  /**
   * `null` until the child exits AND whenever it was terminated by a signal —
   * ACP models exactly this (`exitCode?: number | null` with a sibling
   * `signal?: string | null`, "may be null if terminated by signal").
   * Collapsing a signal death into a number invents an exit status the OS
   * never produced.
   */
  exitCode: number | null;
  /** The signal that terminated the child, or `null` if it exited normally. */
  signal: string | null;
  /** True once the child has exited, whichever way it went. */
  exited: boolean;
  /**
   * Set when the child never started — the spawn itself failed. The failure
   * is reported through the shell's failure channel (`output` plus the
   * conventional 127/126 `exitCode`); this flag lets a waiter distinguish
   * that terminal death from a live child's post-spawn `error` event (a
   * kill or send failure), which must not be read as an exit.
   */
  spawnFailed?: boolean;
}

export interface ToolCall {
  title?: string | null;
  rawInput?: any;
}

export interface ExtendedRequestPermissionRequest
  extends Omit<RequestPermissionRequest, 'toolCall'> {
  toolCall?: ToolCall;
}

export interface EnvironmentVariable {
  name: string;
  value: string;
}

export interface ExtendedCreateTerminalRequest extends CreateTerminalRequest {
  env?: EnvironmentVariable[];
}

/** Station's filesystem, terminal, approval and vendor-extension callbacks. */
type ClientRequestCallback<Method extends ClientRequestMethod> = (
  params: ClientRequestParamsByMethod[Method],
) => ReturnType<ClientRequestHandlersByMethod[Method]>;

export interface ACPClientCallbacks {
  sessionUpdate: (params: SessionNotification) => Promise<void>;
  requestPermission: ClientRequestCallback<'session/request_permission'>;
  readTextFile: ClientRequestCallback<'fs/read_text_file'>;
  writeTextFile: ClientRequestCallback<'fs/write_text_file'>;
  createTerminal: ClientRequestCallback<'terminal/create'>;
  terminalOutput: ClientRequestCallback<'terminal/output'>;
  releaseTerminal: ClientRequestCallback<'terminal/release'>;
  waitForTerminalExit: ClientRequestCallback<'terminal/wait_for_exit'>;
  killTerminal: ClientRequestCallback<'terminal/kill'>;
  extMethod: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  extNotification: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<void>;
}
