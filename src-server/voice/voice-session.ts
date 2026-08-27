import { randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import {
  denialReason,
  toolNameForDenialMessage,
} from '../runtime/agents/denial-message.js';
import type { IAgentHooks, ToolCallDenial } from '../runtime/types.js';
import type {
  VoiceTurnHandle,
  VoiceTurnRuns,
  VoiceTurnTransition,
} from '../services/orchestration/voice-turn-runs.js';
import {
  toolDenials,
  voiceOps,
  voiceSessionLifecycle,
} from '../telemetry/metrics.js';
import { createLogger } from '../utils/logger.js';
import {
  outwardTransportFailure,
  sanitizedTransportError,
} from '../utils/outward-error.js';
import {
  S2SSessionAdapter,
  type VoiceLifecycleReason,
} from './s2s-session-adapter.js';
import type {
  IS2SProvider,
  S2SCorrelatedToolUseEvent,
  S2SCorrelatedTurn,
  S2SCorrelatedTurnEnd,
  S2SSessionConfig,
  S2SToolDefinition,
} from './s2s-types.js';
import { supportsS2SCorrelatedTurnsV1 } from './s2s-types.js';

export type S2SProviderFactory = (config?: any) => IS2SProvider;

const VOICE_PROMPT_PREFIX =
  'You are in voice mode. Be concise — short sentences. Confirm before creating or modifying anything. When you use tools, summarize the result in one or two sentences — never read raw JSON or full tool output aloud.\n\n';
const logger = createLogger({ name: 'voice-session' });

function observeVoiceMetric(record: () => void): void {
  try {
    record();
  } catch {
    // Telemetry is an observer, never voice execution authority.
  }
}

type ActiveVoiceTurn = {
  handle: VoiceTurnHandle;
  pendingTools: number;
  admittedTools: Set<string>;
  endStopReason?: string;
  toolUncertain?: string;
  terminalSubmitted?: boolean;
};

type VoiceTerminalAttempt = () => VoiceTurnTransition;
type SubmitVoiceTerminalCleanup = (
  key: string,
  attempt: VoiceTerminalAttempt,
  onSettled: () => void,
) => void;

function voiceTurnKey(
  providerSessionId: string,
  providerPromptId: string,
  providerTurnId: string,
): string {
  return JSON.stringify([providerSessionId, providerPromptId, providerTurnId]);
}

async function waitForVoiceTerminalRetry(
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, 10);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class VoiceTerminalCleanupRegistry {
  private readonly entries = new Map<
    string,
    { controller: AbortController; operation: Promise<void> }
  >();
  private stopping = false;

  submit(
    key: string,
    attempt: VoiceTerminalAttempt,
    onSettled: () => void,
  ): void {
    if (this.entries.has(key) || this.stopping) return;
    const controller = new AbortController();
    const operation = (async () => {
      while (!controller.signal.aborted) {
        try {
          const outcome = attempt();
          if (outcome.kind === 'applied' || outcome.kind === 'stale') {
            onSettled();
            return;
          }
        } catch (error) {
          logger.warn('Voice turn terminal settlement failed', {
            key,
            error: sanitizedTransportError(error),
          });
        }
        if (!(await waitForVoiceTerminalRetry(controller.signal))) return;
      }
    })();
    const entry = { controller, operation };
    this.entries.set(key, entry);
    void operation.finally(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const entries = Array.from(this.entries.values());
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map((entry) => entry.operation));
  }
}

/** Translate an agent's MCP tool to S2S tool definition */
function toS2STool(tool: {
  name: string;
  description?: string;
  parameters?: any;
}): S2SToolDefinition | null {
  let inputSchema = tool.parameters;
  if (!inputSchema || typeof inputSchema !== 'object') {
    inputSchema = { type: 'object', properties: {} };
  } else if (
    '_def' in inputSchema ||
    '_type' in inputSchema ||
    typeof inputSchema.parse === 'function'
  ) {
    // Zod schema — can't serialize directly, use empty schema
    inputSchema = { type: 'object', properties: {} };
  } else {
    // Ensure it's a plain JSON-serializable object
    try {
      inputSchema = JSON.parse(JSON.stringify(inputSchema));
    } catch {
      inputSchema = { type: 'object', properties: {} };
    }
  }
  if (!tool.description) return null; // Skip tools without descriptions — S2S models need them
  return { name: tool.name, description: tool.description, inputSchema };
}

export interface VoiceSessionOptions {
  providerFactory: S2SProviderFactory;
  /** Live reference to the runtime's agent tools map */
  agentTools: Map<string, any[]>;
  /** Live reference to the runtime's agent specs map */
  agentSpecs: Map<string, { systemPrompt?: string; [k: string]: any }>;
  /** Live reference to the runtime's shared per-agent policy hooks. */
  agentHooks: Map<string, IAgentHooks>;
  /** Which agent to use for voice. Default: 'station-voice' */
  voiceAgentSlug?: string;
  /** Called once on first session to bootstrap the voice agent and load tools */
  onFirstSession?: () => Promise<void>;
  /** Private EventStore-owned run authority; absent custom providers remain compatible but unattributed. */
  voiceTurnRuns?: VoiceTurnRuns;
}

class VoiceSession {
  private provider: IS2SProvider;
  private adapter: S2SSessionAdapter;
  private tools: any[]; // The agent's tool objects (with .execute)
  private destroyPromise: Promise<void> | undefined;
  private destroying = false;
  private stopReason: VoiceLifecycleReason = 'explicit';
  private readonly onWsMessage: (raw: RawData) => void;
  private readonly onWsClose: () => void;
  private readonly onWsError: () => void;
  private readonly unsubscribeAdapter: () => void;
  private readonly correlatedTurns: boolean;
  private readonly correlatedProviderId: string | undefined;
  private readonly activeVoiceTurns = new Map<string, ActiveVoiceTurn>();

  constructor(
    readonly id: string,
    private ws: WebSocket,
    providerFactory: S2SProviderFactory,
    tools: any[],
    private readonly hooks: IAgentHooks | undefined,
    private readonly agentSlug: string,
    private readonly hasResolvedAgentSpec: boolean,
    config: S2SSessionConfig,
    private readonly voiceTurnRuns: VoiceTurnRuns | undefined,
    private readonly onTerminate: (
      id: string,
      reason: VoiceLifecycleReason,
    ) => void,
    private readonly submitTerminalCleanup: SubmitVoiceTerminalCleanup,
  ) {
    this.provider = providerFactory();
    const correlatedProvider = supportsS2SCorrelatedTurnsV1(this.provider)
      ? this.provider
      : undefined;
    this.correlatedTurns = correlatedProvider !== undefined;
    this.correlatedProviderId =
      correlatedProvider?.correlatedTurnsProviderId.trim();
    this.tools = tools;
    this.adapter = new S2SSessionAdapter(this.provider, config, {
      onAudio: (chunk) =>
        this.send({ type: 'audio_out', data: chunk.toString('base64') }),
      onTranscript: (transcript) =>
        this.send({ type: 'transcript', ...transcript }),
      onToolUse: (event) => this.handleToolUse(event),
      onCorrelatedTurnStart: (turn) => this.handleCorrelatedTurnStart(turn),
      onCorrelatedTurnEnd: (turn) => this.handleCorrelatedTurnEnd(turn),
      onCorrelatedToolUse: (event) => this.handleCorrelatedToolUse(event),
      onError: (error) => {
        const failure = outwardTransportFailure('voiceWebSocket');
        logger.error('Voice provider session failed', {
          correlationId: failure.correlationId,
          sessionId: this.id,
          error: sanitizedTransportError(error),
        });
        this.send({
          type: 'error',
          ...failure,
        });
        this.markVoiceTurnsIndeterminate(
          'The voice provider session ended before the completion was observed.',
        );
        this.onTerminate(this.id, 'provider_failed');
      },
      recordLifecycle: (record) => {
        const reason =
          record.operation === 'stop'
            ? (record.reason ?? this.stopReason)
            : record.reason;
        observeVoiceMetric(() =>
          voiceSessionLifecycle.add(1, {
            layer: 'server',
            adapter: this.correlatedProviderId ?? this.adapter.descriptor.id,
            operation: record.operation,
            outcome: record.outcome,
            ...(reason ? { reason } : {}),
          }),
        );
      },
    });
    this.unsubscribeAdapter = this.adapter.subscribe(() => {
      const snapshot = this.adapter.getSnapshot();
      this.send({ type: 'state', state: snapshot.state });
    });

    this.onWsMessage = (raw) => {
      if (this.destroying) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'audio_in')
          this.provider.sendAudio(Buffer.from(msg.data, 'base64'));
      } catch (err) {
        logger.warn('Voice client WebSocket message rejected', {
          sessionId: this.id,
          error: sanitizedTransportError(err),
        });
      }
    };
    this.onWsClose = () => {
      observeVoiceMetric(() => voiceOps.add(1, { op: 'ws.disconnect' }));
      this.onTerminate(this.id, 'socket_close');
    };
    this.onWsError = () => this.onTerminate(this.id, 'socket_error');
    ws.on('message', this.onWsMessage);
    ws.on('close', this.onWsClose);
    ws.on('error', this.onWsError);
  }

  async start(): Promise<void> {
    const result = await this.adapter.start({
      controlSessionId: this.id,
    });
    if (!result.ok) throw result.error;
    const inputAudioFormat = this.adapter.inputAudioFormat;
    if (!inputAudioFormat) {
      throw new Error('Voice provider did not supply an input audio format');
    }
    this.send({
      type: 'session_ready',
      inputAudioFormat,
      outputAudioFormat: this.adapter.outputAudioFormat,
    });
  }

  destroy(reason: VoiceLifecycleReason = 'explicit'): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroying = true;
    this.stopReason = reason;
    this.markVoiceTurnsIndeterminate(
      'The voice session ended before the provider completion was observed.',
    );
    this.ws.off('message', this.onWsMessage);
    this.ws.off('close', this.onWsClose);
    this.ws.off('error', this.onWsError);
    this.unsubscribeAdapter();
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.close(1000, 'Voice session ended');
    }
    const operation = this.stopAdapter();
    this.destroyPromise = operation;
    void operation.catch(() => {
      // A failed provider disconnect is retriable. Keep the session object and
      // reopen only the teardown operation, never the content callbacks.
      if (this.destroyPromise === operation) this.destroyPromise = undefined;
    });
    return operation;
  }

  private async stopAdapter(): Promise<void> {
    const result = await this.adapter.stop();
    if (!result.ok) throw result.error;
  }

  private sendToolResultSafely(toolUseId: string, result: string): boolean {
    if (this.destroying) return false;
    try {
      this.provider.sendToolResult(toolUseId, result);
      return true;
    } catch (error) {
      logger.warn('Voice tool result delivery failed', {
        sessionId: this.id,
        error: sanitizedTransportError(error),
      });
      return false;
    }
  }

  private async handleToolUse(event: {
    toolName: string;
    toolUseId: string;
    parameters: Record<string, unknown>;
  }): Promise<void> {
    if (this.correlatedTurns) return;
    try {
      await this.handleToolUseUnchecked(event);
    } catch (error) {
      logger.warn('Correlated voice tool dispatch failed closed', {
        sessionId: this.id,
        error: sanitizedTransportError(error),
      });
      this.sendToolResultSafely(
        event.toolUseId,
        'Tool execution was not performed because the voice turn could not be verified.',
      );
    }
  }

  private async handleToolUseUnchecked(
    event: {
      toolName: string;
      toolUseId: string;
      parameters: Record<string, unknown>;
    },
    isStillLive: () => boolean = () => !this.destroying,
  ): Promise<{ toolUncertain: boolean }> {
    if (this.destroying) return { toolUncertain: false };
    observeVoiceMetric(() => voiceOps.add(1, { op: 'tool.call' }));
    const tool = this.tools.find(
      (candidate) => candidate.name === event.toolName,
    );
    // The fail-closed default, and load-bearing: the `catch` below leaves it
    // in place rather than assigning the same sentence a second time, so this
    // IS the text a caller gets when the approval gate throws. Every other
    // path replaces it.
    let result = denialReason({
      toolName: event.toolName,
      predicate: 'was blocked because the authorization gate failed.',
    });
    let toolUncertain = false;
    if (tool) {
      let approval: true | ToolCallDenial | undefined;
      try {
        approval = await this.beforeToolCall(tool, event);
      } catch (error) {
        const reason = 'gate_error';
        observeVoiceMetric(() => toolDenials.add(1, { reason }));
        logger.warn('Voice tool approval gate failed closed', {
          sessionId: this.id,
          toolName: event.toolName,
          reason,
          error: sanitizedTransportError(error),
        });
        // No assignment here on purpose: `result` still holds the identical
        // fail-closed default above, and writing the sentence twice is how a
        // sanitizer gets reverted at one of its copies without anything
        // noticing.
      }
      if (approval === true) {
        if (!isStillLive()) {
          result = denialReason({
            toolName: event.toolName,
            predicate:
              'was blocked because the voice turn is no longer active.',
          });
        } else {
          try {
            const raw = await tool.execute(event.parameters);
            result = typeof raw === 'string' ? raw : JSON.stringify(raw);
          } catch (error) {
            toolUncertain = true;
            const failure = outwardTransportFailure('voiceTool');
            logger.error('Voice tool execution failed', {
              correlationId: failure.correlationId,
              sessionId: this.id,
              toolName: event.toolName,
              error: sanitizedTransportError(error),
            });
            result = failure.message;
          }
        }
      } else if (approval) {
        result = approval.reason;
      }
    } else {
      result = `Tool not found: ${toolNameForDenialMessage(event.toolName)}`;
    }
    if (!this.sendToolResultSafely(event.toolUseId, result)) {
      // The tool may already have crossed its own effect boundary. A failed
      // provider acknowledgement cannot turn that into a definite failure.
      toolUncertain = true;
    }
    return { toolUncertain };
  }

  private handleCorrelatedTurnStart(turn: S2SCorrelatedTurn): void {
    if (!this.voiceTurnRuns || this.destroying) return;
    try {
      const observed = this.voiceTurnRuns.observeStart({
        voiceSessionId: this.id,
        providerSessionId: turn.providerSessionId,
        providerTurnId: turn.providerTurnId,
        providerPromptId: turn.providerPromptId,
        providerId: this.correlatedProviderId!,
        sourceId: this.agentSlug,
        now: new Date().toISOString(),
      });
      if (observed.kind === 'started') {
        this.activeVoiceTurns.set(
          voiceTurnKey(
            turn.providerSessionId,
            turn.providerPromptId,
            turn.providerTurnId,
          ),
          {
            handle: observed.handle,
            pendingTools: 0,
            admittedTools: new Set(),
          },
        );
      } else if (observed.kind === 'unavailable') {
        logger.warn('Voice turn run could not be observed', {
          sessionId: this.id,
        });
        const now = new Date().toISOString();
        this.submitTerminalCleanup(
          `${this.id}:${voiceTurnKey(
            turn.providerSessionId,
            turn.providerPromptId,
            turn.providerTurnId,
          )}:untracked`,
          () =>
            observed.indeterminate({
              now,
              reason:
                'The provider turn could not be durably observed before execution continued.',
            }),
          () => undefined,
        );
      }
    } catch (error) {
      logger.warn('Voice turn observation failed', {
        sessionId: this.id,
        error: sanitizedTransportError(error),
      });
    }
  }

  private handleCorrelatedTurnEnd(turn: S2SCorrelatedTurnEnd): void {
    const key = voiceTurnKey(
      turn.providerSessionId,
      turn.providerPromptId,
      turn.providerTurnId,
    );
    const active = this.activeVoiceTurns.get(key);
    if (
      !active ||
      active.handle.providerSessionId !== turn.providerSessionId ||
      active.handle.providerPromptId !== turn.providerPromptId
    ) {
      return;
    }
    // End-before-start/late/mismatched events settle nothing.
    try {
      // EventEmitter listeners are not awaited. A matching completionEnd is
      // only terminal after every exact tool effect that it preceded settles.
      if (active.endStopReason && active.endStopReason !== turn.stopReason) {
        return;
      }
      active.endStopReason ??= turn.stopReason;
      this.settleEndedVoiceTurn(key, active);
    } catch (error) {
      logger.warn('Voice turn terminal settlement failed', {
        sessionId: this.id,
        error: sanitizedTransportError(error),
      });
    }
  }

  private async handleCorrelatedToolUse(
    event: S2SCorrelatedToolUseEvent,
  ): Promise<void> {
    if (this.destroying) return;
    // A tool is an external effect. It may execute only after the exact
    // provider-issued completion identity has an observed, still-live run.
    const key = voiceTurnKey(
      event.providerSessionId,
      event.providerPromptId,
      event.providerTurnId,
    );
    const active = this.activeVoiceTurns.get(key);
    if (
      !active ||
      active.handle.providerSessionId !== event.providerSessionId ||
      active.handle.providerPromptId !== event.providerPromptId ||
      active.endStopReason
    ) {
      this.sendToolResultSafely(
        event.toolUseId,
        'Tool execution was not performed because this voice turn could not be verified.',
      );
      return;
    }
    const toolIdentity = JSON.stringify([
      event.providerContentId,
      event.toolUseId,
    ]);
    if (active.admittedTools.has(toolIdentity)) {
      // The admitted callback owns the one provider response. Duplicate raw
      // delivery joins that work and must not race it with a second result.
      return;
    }
    // Admission happens before the first await, fencing concurrent duplicates.
    active.admittedTools.add(toolIdentity);
    active.pendingTools += 1;
    try {
      const result = await this.handleToolUseUnchecked(
        event,
        () => !this.destroying && this.activeVoiceTurns.get(key) === active,
      );
      if (result.toolUncertain) {
        active.toolUncertain =
          'A tool operation may have crossed an effect boundary before its result was observed.';
      }
    } catch (error) {
      // A correlation/control failure must not let a late completion claim
      // success for an effect that we cannot account for.
      active.toolUncertain =
        'A tool operation could not be accounted for after the provider issued this voice completion.';
      logger.warn('Correlated voice tool dispatch failed closed', {
        sessionId: this.id,
        error: sanitizedTransportError(error),
      });
      this.sendToolResultSafely(
        event.toolUseId,
        'Tool execution was not performed because the voice turn could not be verified.',
      );
    } finally {
      active.pendingTools -= 1;
      this.settleEndedVoiceTurn(key, active);
    }
  }

  private settleEndedVoiceTurn(key: string, active: ActiveVoiceTurn): void {
    if (
      !active.endStopReason ||
      active.pendingTools !== 0 ||
      this.activeVoiceTurns.get(key) !== active ||
      active.terminalSubmitted
    ) {
      return;
    }
    active.terminalSubmitted = true;
    const now = new Date().toISOString();
    const attempt: VoiceTerminalAttempt = active.toolUncertain
      ? () =>
          active.handle.indeterminate({
            now,
            reason: active.toolUncertain!,
          })
      : () =>
          active.handle.complete({
            now,
            stopReason: active.endStopReason!,
          });
    this.submitTerminalCleanup(`${this.id}:${key}`, attempt, () => {
      if (this.activeVoiceTurns.get(key) === active) {
        this.activeVoiceTurns.delete(key);
      }
    });
  }

  private markVoiceTurnsIndeterminate(reason: string): void {
    for (const [key, turn] of this.activeVoiceTurns) {
      try {
        if (turn.endStopReason) {
          // A provider terminal was already observed. Keep its exact durable
          // intent alive for duplicate-end/tool-completion retry; do not
          // overwrite it with a different teardown transition.
          this.settleEndedVoiceTurn(key, turn);
          continue;
        }
        if (turn.terminalSubmitted) continue;
        turn.terminalSubmitted = true;
        const now = new Date().toISOString();
        this.submitTerminalCleanup(
          `${this.id}:${key}`,
          () => turn.handle.indeterminate({ now, reason }),
          () => {
            if (this.activeVoiceTurns.get(key) === turn) {
              this.activeVoiceTurns.delete(key);
            }
          },
        );
      } catch (error) {
        // Every observed completion is independent: a storage/observer fault
        // for one must never prevent the remaining exact handles being fenced.
        logger.warn('Voice turn indeterminate settlement failed', {
          sessionId: this.id,
          providerTurnId: turn.handle.providerTurnId,
          error: sanitizedTransportError(error),
        });
      }
    }
  }

  /**
   * Reuse the runtime-built hook so a voice invocation receives the IDENTICAL
   * policy and approval chain as every other managed agent invocation —
   * auto-approve list, config-protection policy, guardian, and #1834's
   * fail-closed default when no approval channel exists. Voice gets no
   * special-case restriction: it is no less attended than the scheduler or
   * `/invoke`, which run through this same chain.
   */
  private async beforeToolCall(
    tool: { name: string; description?: string },
    event: { toolUseId: string; parameters: Record<string, unknown> },
  ): Promise<true | ToolCallDenial> {
    if (this.hooks?.beforeToolCall) {
      const result = await this.hooks.beforeToolCall(
        {
          toolName: tool.name,
          toolCallId: event.toolUseId,
          toolArgs: event.parameters,
          toolDescription: tool.description,
        },
        {
          agentSlug: this.agentSlug,
          conversationId: this.id,
          ...(this.hasResolvedAgentSpec
            ? {
                unattendedPrincipal: {
                  kind: 'voice' as const,
                  agentSlug: this.agentSlug,
                  sessionId: this.id,
                },
              }
            : {}),
        },
      );
      if (result === true) return true;
      return {
        allowed: false,
        reason:
          typeof result === 'object' && result?.allowed === false
            ? result.reason
            : denialReason({
                toolName: tool.name,
                predicate: 'was denied by the approval gate.',
              }),
      };
    }

    // This should only be reachable during a broken runtime bootstrap. It is
    // deliberately a denial, never a compatibility path to raw execution.
    const reason = 'no_approval_channel';
    observeVoiceMetric(() => toolDenials.add(1, { reason }));
    logger.warn('No approval channel; denied tool execution', {
      toolName: tool.name,
      agentSlug: this.agentSlug,
      conversationId: this.id,
      reason,
    });
    return {
      allowed: false,
      reason: denialReason({
        toolName: tool.name,
        predicate:
          'requires approval, but this voice session has no approval channel to ask.',
      }),
    };
  }

  private send(msg: object): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (error) {
      // Client delivery is an observer. Provider/run cleanup remains the
      // authority even when the socket fails synchronously.
      logger.warn('Voice client WebSocket delivery failed', {
        sessionId: this.id,
        error: sanitizedTransportError(error),
      });
    }
  }
}

export class VoiceSessionService {
  private sessions = new Map<string, VoiceSession>();
  private slug: string;
  private bootstrapped = false;
  private readonly terminalCleanup = new VoiceTerminalCleanupRegistry();

  constructor(private opts: VoiceSessionOptions) {
    this.slug = opts.voiceAgentSlug ?? 'station-voice';
  }

  createSession(
    ws: WebSocket,
    config?: Partial<S2SSessionConfig> & { agentSlug?: string },
  ): string {
    const id = randomUUID();
    const agentSlug = config?.agentSlug ?? this.slug;

    const startSession = () => {
      // The authenticated socket can close while first-session bootstrap is
      // still loading tools. Never allocate provider resources for a dead
      // control connection.
      if (ws.readyState !== ws.OPEN) return;
      const tools = this.opts.agentTools.get(agentSlug) ?? [];
      const spec = this.opts.agentSpecs.get(agentSlug);
      const hooks = this.opts.agentHooks.get(agentSlug);
      const s2sTools = tools
        .map(toS2STool)
        .filter((tool): tool is S2SToolDefinition => tool !== null);
      const systemPrompt = VOICE_PROMPT_PREFIX + (spec?.systemPrompt ?? '');
      const fullConfig: S2SSessionConfig = {
        systemPrompt,
        tools: s2sTools,
        ...config,
      };

      const session = new VoiceSession(
        id,
        ws,
        this.opts.providerFactory,
        tools,
        hooks,
        agentSlug,
        spec !== undefined,
        fullConfig,
        this.opts.voiceTurnRuns,
        (sessionId, reason) => {
          void this.destroySession(sessionId, reason).catch(() => undefined);
        },
        (key, attempt, onSettled) =>
          this.terminalCleanup.submit(key, attempt, onSettled),
      );
      this.sessions.set(id, session);
      observeVoiceMetric(() => voiceOps.add(1, { op: 'ws.connect' }));

      session.start().catch((err) => {
        const failure = outwardTransportFailure('voiceWebSocket');
        logger.error('Voice session start failed', {
          correlationId: failure.correlationId,
          sessionId: id,
          error: sanitizedTransportError(err),
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'error',
              ...failure,
            }),
          );
        }
        void this.destroySession(id, 'provider_failed').catch(() => undefined);
      });
    };

    if (!this.bootstrapped && this.opts.onFirstSession) {
      this.bootstrapped = true;
      this.opts
        .onFirstSession()
        .then(startSession)
        .catch((err) => {
          const failure = outwardTransportFailure('voiceWebSocket');
          logger.error('Voice session bootstrap failed', {
            correlationId: failure.correlationId,
            sessionId: id,
            error: sanitizedTransportError(err),
          });
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'error',
                ...failure,
              }),
            );
          }
        });
    } else {
      startSession();
    }

    return id;
  }

  async destroySession(
    id: string,
    reason: VoiceLifecycleReason = 'explicit',
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.destroy(reason);
    if (this.sessions.get(id) === session) this.sessions.delete(id);
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.sessions.keys()).map((id) =>
        this.destroySession(id, 'service_stop'),
      ),
    );
    await this.terminalCleanup.stop();
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  getActiveCount(): number {
    return this.sessions.size;
  }
}
