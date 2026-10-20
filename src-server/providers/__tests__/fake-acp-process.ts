import type {
  Client,
  ContentBlock,
  PromptResponse,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { ACPProcessOptions } from '../../services/acp/acp-process.js';

/**
 * Stub ACPProcess substrate (injected via AcpAdapterOptions.processFactory —
 * the same constructor-level testing seam codex-adapter.test.ts uses). No
 * real process is spawned; `createClient` is invoked synchronously during
 * `start()` exactly as the real ACPProcess does, handing the test the live
 * `Client` object the adapter built (fs/terminal/ext handlers plus the
 * adapter's own canonical `requestPermission` override).
 */
export class FakeAcpProcess {
  client!: Client;
  /**
   * archive#1684: OPTIONAL, and mutable. The adapter's station-control gate
   * distinguishes "the engine answered no" from "there was no initialize
   * result to read", so the fake has to be able to represent the second —
   * `initResult` used to be a non-optional readonly field, which made that
   * case untestable and therefore unwritten.
   */
  initResult:
    | {
        protocolVersion: number;
        agentInfo?: { name: string; version?: string };
        agentCapabilities: {
          promptCapabilities: { image: boolean };
          loadSession?: boolean;
          mcpCapabilities?: { http?: boolean; sse?: boolean };
          sessionCapabilities?: { resume?: Record<string, never> | null };
        };
      }
    | undefined = {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true } },
  };
  sessionId: string | null = null;
  readonly extMethodCalls: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  extMethodError?: unknown;
  destroyed = false;
  destroyCalls = 0;
  cancelCalls = 0;
  cancelPromise?: Promise<void>;
  startError?: Error;
  destroyError?: Error;
  destroyPromise?: Promise<void>;
  private readonly pendingPrompts: Array<{
    resolve: (response: PromptResponse) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(readonly opts: ACPProcessOptions) {}

  async start() {
    if (this.startError) throw this.startError;
    this.client = this.opts.createClient(undefined as any);
    return this.initResult;
  }

  newSessionMcpServers: unknown[] | undefined;
  /** archive#1684: proves the fail-closed path does NOT retry session/new. */
  newSessionCalls = 0;
  /** archive#1182: overridable per-test to simulate an agent's own reported model config option. */
  newSessionConfigOptions: unknown[] = [];
  /** station#1945: older ACP `modes` catalog when no mode config option exists. */
  newSessionModes?: {
    availableModes: Array<{
      id: string;
      name: string;
      description?: string;
      _meta?: Record<string, unknown>;
    }>;
    currentModeId?: string;
  };
  readonly setModeCalls: string[] = [];

  async setMode(modeId: string): Promise<void> {
    this.setModeCalls.push(modeId);
  }

  /**
   * archive#1684: makes `session/new` REJECT, so the no-retry claim has
   * something to be true of. Without it `newSessionCalls === 1` only ever
   * observed the success path, and a `.catch(...)` retry was invisible.
   */
  newSessionError?: unknown;

  /** Holds `session/new` open, to land a Stop while it is in flight. */
  newSessionGate?: Promise<void>;

  async newSession(_cwd: string, mcpServers?: unknown[]) {
    this.newSessionCalls += 1;
    this.newSessionMcpServers = mcpServers;
    if (this.newSessionGate) await this.newSessionGate;
    if (this.newSessionError) throw this.newSessionError;
    this.sessionId = `native-${this.opts.command}`;
    return {
      sessionId: this.sessionId,
      modes: this.newSessionModes ?? {
        availableModes: [],
        currentModeId: 'default',
      },
      configOptions: this.newSessionConfigOptions,
    };
  }

  loadSessionArgs?: { sessionId: string; cwd: string; mcpServers?: unknown[] };
  loadSessionCalls = 0;
  loadSessionPromise?: Promise<void>;
  /** archive#1684 delta review (LOW-2): the resume branch needs the same
   * no-retry proof `newSessionError` gives `session/new`. */
  loadSessionError?: unknown;

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers?: unknown[],
  ): Promise<void> {
    this.loadSessionCalls += 1;
    this.loadSessionArgs = { sessionId, cwd, mcpServers };
    if (this.loadSessionError) throw this.loadSessionError;
    this.sessionId = sessionId;
    // ACP: the agent streams the conversation history as `session/update`
    // notifications before it answers `session/load`.
    this.loadSessionReplay?.(this.client);
    await this.loadSessionPromise;
  }
  loadSessionReplay?: (client: Client) => void;

  resumeSessionArgs?: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
  };
  resumeSessionCalls = 0;
  resumeSessionError?: unknown;

  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers?: unknown[],
  ): Promise<void> {
    this.resumeSessionCalls += 1;
    this.resumeSessionArgs = { sessionId, cwd, mcpServers };
    if (this.resumeSessionError) throw this.resumeSessionError;
    this.sessionId = sessionId;
  }

  readonly setConfigOptionCalls: Array<{ configId: string; value: string }> =
    [];
  setConfigOptionResponse?: unknown;
  setConfigOptionError?: unknown;

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    this.setConfigOptionCalls.push({ configId, value });
    if (this.setConfigOptionError) throw this.setConfigOptionError;
    if (this.setConfigOptionResponse !== undefined) {
      return this.setConfigOptionResponse;
    }
    return {
      configOptions: this.newSessionConfigOptions.map((option) =>
        option &&
        typeof option === 'object' &&
        (option as { id?: unknown }).id === configId
          ? { ...option, currentValue: value }
          : option,
      ),
    };
  }

  readonly promptContents: ContentBlock[][] = [];

  prompt(content: ContentBlock[]): Promise<PromptResponse> {
    this.promptContents.push(content);
    return new Promise((resolve, reject) => {
      this.pendingPrompts.push({ resolve, reject });
    });
  }

  resolvePrompt(stopReason: StopReason): void {
    this.pendingPrompts.shift()?.resolve({ stopReason });
  }

  rejectPrompt(error: unknown): void {
    this.pendingPrompts.shift()?.reject(error);
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    await this.cancelPromise;
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.extMethodCalls.push({ method, params });
    if (this.extMethodError) throw this.extMethodError;
    return {};
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    if (this.destroyError) throw this.destroyError;
    await this.destroyPromise;
    this.destroyed = true;
  }
}
