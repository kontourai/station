import crypto from 'node:crypto';
import {
  engineId,
  engineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import {
  acceptModelLaunchPlan,
  MODEL_LAUNCH_PLAN_METADATA_KEY,
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
  type ModelLaunchPlan,
  modelSelectionReceipt,
  type ProviderKind,
} from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  RequestResolvedEvent,
} from '@kontourai/station-contracts/runtime-events';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { DEFAULT_OLLAMA_BASE_URL } from '../../constants.js';
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter-shape.js';
import { reportedModelMetadata } from '../llm/effective-model-metadata.js';
import type {
  LLMMessage,
  LLMStreamChunk,
} from '../llm/model-provider-types.js';
import { OllamaLLMProvider } from '../llm/ollama-provider.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';
import { ollamaReportedUsage } from './ai-sdk-reported-usage.js';

const DEFAULT_BASE_URL = DEFAULT_OLLAMA_BASE_URL;

/**
 * station#3588: boundary guard mirroring `bedrock-adapter.ts`'s
 * `normalizeFinishReason` — `LLMStreamChunk.finishReason` is typed as a bare
 * `string | undefined` (it also has to accommodate any value
 * `mapAiSdkFinishReason` maps through, `ai-sdk-llm-provider.ts`), so this
 * narrows it to exactly what `publishCompletion` accepts. An unrecognized
 * string (or a genuinely absent value) becomes `undefined`, not a guessed
 * member — `publishCompletion`'s own `options.finishReason ?? 'stop'`
 * fallback still governs "genuinely no information" exactly as it always
 * has; this function only ever narrows a value that IS present into the
 * vocabulary this adapter accepts, it never invents one.
 */
function normalizeOllamaFinishReason(
  reason?: string,
): 'stop' | 'tool-calls' | 'max-tokens' | 'other' | undefined {
  switch (reason) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
    case 'other':
      return reason;
    default:
      return undefined;
  }
}

interface OllamaSession extends ProviderSession {
  systemPrompt?: string;
  history: LLMMessage[];
}

export class OllamaAdapter implements ProviderAdapterShape {
  readonly provider: ProviderKind = 'ollama';
  readonly metadata: ProviderAdapterShape['metadata'];

  private sessions = new Map<string, OllamaSession>();
  private readonly activeTurns = new Map<
    string,
    { turnId: string; controller: AbortController }
  >();
  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly llm: OllamaLLMProvider;

  constructor(baseUrl?: string, dependencies?: { llm?: OllamaLLMProvider }) {
    const locality = baseUrl === undefined ? 'local' : 'unknown';
    this.metadata = {
      displayName: 'Ollama',
      description: 'Direct chat with locally running Ollama models.',
      capabilities: ['agent-runtime', 'session-lifecycle'],
      continuity: {
        resume: 'same-session',
        fork: 'replay-seed',
        rewind: 'none',
      },
      runtimeId: engineRuntimeId('ollama-runtime'),
      builtin: true,
      engineId: engineId('station'),
      abortSettlement: 'await',
      modelExecution: {
        runtime: { id: 'ollama', version: null },
        adapter: { id: 'station-ollama', version: null },
        locality,
      },
      modelLaunch: {
        defaultAtStart: 'station-resolved',
        omissionAtResume: 'retain-session-model',
        omissionPerTurn: 'retain-session-model',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
        modelConnectionId: 'ollama-runtime',
      },
    };
    this.llm =
      dependencies?.llm ??
      new OllamaLLMProvider({
        baseUrl: baseUrl ?? DEFAULT_BASE_URL,
        locality,
      });
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]> {
    const available = await this.llm.healthCheck(options);
    return [
      {
        id: 'ollama-server',
        name: 'Ollama server',
        description: 'Ollama must be running locally (ollama serve).',
        status: available ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: [
            'Install Ollama from https://ollama.com',
            'Run `ollama serve` to start the server',
            'Pull a model: `ollama pull llama3.2`',
          ],
          links: ['https://ollama.com'],
        },
      },
    ];
  }

  async listModels(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<Array<{ id: string; name: string; originalId: string }>> {
    return (await this.listModelCatalog(options)).models;
  }

  async listModelCatalog(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
    skipCapabilityEnrichment?: boolean;
  }) {
    const catalog = await this.llm.listModelCatalog(options);
    return {
      models: catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        originalId: model.id,
      })),
      ...(catalog.truncated ? { truncated: true } : {}),
    };
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const model = await this.resolveModelId(input.modelId);
    const now = new Date().toISOString();
    const systemPrompt =
      typeof input.modelOptions?.systemPrompt === 'string'
        ? input.modelOptions.systemPrompt
        : undefined;
    const session: OllamaSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      model,
      // Retained so a later `session.configured` can restate it: consumers
      // read `cwd` off the latest such event, so an event that omits it
      // erases the session's working directory downstream (#796 review).
      ...(input.cwd ? { cwd: input.cwd } : {}),
      resumeCursor: input.resumeCursor,
      createdAt: now,
      updatedAt: now,
      systemPrompt,
      history: [],
    };

    this.sessions.set(session.threadId, session);
    const acceptedLaunchPlan = acceptModelLaunchPlan(
      input.metadata?.[MODEL_LAUNCH_PLAN_METADATA_KEY] as
        | ModelLaunchPlan
        | undefined,
      { modelId: model },
    );
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: session.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: session.threadId,
      initialState: 'created',
      metadata: { ...input.metadata, cwd: input.cwd },
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: session.threadId,
      createdAt: now,
      method: 'session.configured',
      sessionId: session.threadId,
      model: session.model,
      cwd: input.cwd,
      metadata: {
        ...input.metadata,
        ...input.modelOptions,
        ...(acceptedLaunchPlan
          ? { [MODEL_LAUNCH_PLAN_METADATA_KEY]: acceptedLaunchPlan }
          : {}),
        [MODEL_SELECTION_RECEIPT_METADATA_KEY]: modelSelectionReceipt(
          input.modelId,
          session.model,
        ),
      },
    });

    return session;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(
        `Ollama adapter cannot send turn for missing session: ${input.threadId}`,
      );
    }

    const now = new Date().toISOString();
    const turnId = crypto.randomUUID();
    const requestedModel = input.modelId?.trim();
    const model =
      requestedModel && requestedModel !== session.model
        ? await this.resolveModelId(requestedModel)
        : session.model;
    if (!model) {
      throw new Error('Ollama adapter requires a launchable model selector.');
    }
    const acceptedLaunchPlan = acceptModelLaunchPlan(
      input.metadata?.[MODEL_LAUNCH_PLAN_METADATA_KEY] as
        | ModelLaunchPlan
        | undefined,
      { modelId: model },
    );
    const controller = new AbortController();
    const superseded = this.activeTurns.get(input.threadId);
    if (superseded) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: now,
        turnId: superseded.turnId,
        method: 'turn.aborted',
        reason: 'superseded',
      });
      superseded.controller.abort(new Error('Superseded by a newer turn.'));
    }
    this.activeTurns.set(input.threadId, { turnId, controller });

    // #796: a per-turn model override changes the model this session actually
    // runs on, but only `session.configured` carries a model into the read
    // model and the persisted row — without republishing it the stored model
    // silently disagrees with what ran once the session is rehydrated.
    if (model !== session.model) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: now,
        method: 'session.configured',
        sessionId: input.threadId,
        model,
        // `buildAgentRunSummary` reads `cwd` from the latest
        // `session.configured` with no fallback to an earlier one, so this
        // restatement has to carry it forward or the run summary loses the
        // session's working directory from this turn onward.
        ...(session.cwd ? { cwd: session.cwd } : {}),
        metadata: {
          ...(acceptedLaunchPlan
            ? { [MODEL_LAUNCH_PLAN_METADATA_KEY]: acceptedLaunchPlan }
            : {}),
          [MODEL_SELECTION_RECEIPT_METADATA_KEY]: modelSelectionReceipt(
            input.modelId,
            model,
          ),
        },
      });
    }
    this.updateSession(input.threadId, {
      status: 'running',
      updatedAt: now,
      model,
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.state-changed',
      sessionId: input.threadId,
      from: 'idle',
      to: 'running',
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      turnId,
      method: 'turn.started',
      // Transcript-facing: the typed text, never the composed model input.
      prompt: input.displayInput ?? input.input,
    });

    const messages: LLMMessage[] = [];
    if (session.systemPrompt) {
      messages.push({ role: 'system', content: session.systemPrompt });
    }
    messages.push(...session.history);
    messages.push({ role: 'user', content: input.input });

    let assistantText = '';
    // station#1182: Ollama's OpenAI-compatible chat response genuinely
    // includes a `model` field describing what actually served the
    // request (ai-sdk's openai-compatible provider parses it straight off
    // the response body — `@ai-sdk/openai-compatible`'s
    // `getResponseMetadata`), unlike Bedrock's ai-sdk provider, which
    // always echoes the request's own model id back (verified in
    // `@ai-sdk/amazon-bedrock`'s `doStream`: `response: { modelId:
    // this.modelId }`) — so only this adapter treats the shared
    // `LLMStreamChunk.reportedModel` as trustworthy.
    let reportedModel: string | undefined;
    // station#3588: the signal `AiSdkLLMProvider.createStream` (which this
    // adapter's `OllamaLLMProvider` inherits unmodified) has propagated
    // since station#3545, and this adapter never read: `chunk.finishReason`
    // on the finish chunk. Before this fix, a truncated (token-ceiling-cut)
    // Ollama generation still published `finishReason: 'stop'` —
    // `publishCompletion`'s `options.finishReason ?? 'stop'` default was the
    // ONLY value ever supplied, since nothing here ever populated
    // `options.finishReason` — a positive claim of natural completion for a
    // response that was cut off.
    let finishReason:
      | 'stop'
      | 'tool-calls'
      | 'max-tokens'
      | 'other'
      | undefined;
    // station#4197: the finish chunk's reported usage, held for
    // `publishCompletion` to translate into `token-usage.updated`. Stays
    // `undefined` when the stream reported none — absence publishes no
    // event, never an event of zeros.
    let turnUsage: LLMStreamChunk['usage'];
    // station#3457: one id for the ONE assistant text item this turn
    // streams, minted before the loop and reused by every chunk of it.
    // Minting inside the loop gave each token its own `itemId`, which is
    // per-chunk identity — that is what `eventId` is for.
    const contentItemId = crypto.randomUUID();
    try {
      for await (const chunk of this.llm.createStream({
        model,
        messages,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        if (chunk.type === 'text-delta' && chunk.content) {
          assistantText += chunk.content;
          this.publish({
            eventId: crypto.randomUUID(),
            provider: this.provider,
            threadId: input.threadId,
            createdAt: new Date().toISOString(),
            turnId,
            itemId: contentItemId,
            method: 'content.text-delta',
            delta: chunk.content,
          });
        }
        if (chunk.type === 'finish') {
          if (chunk.reportedModel) reportedModel = chunk.reportedModel;
          finishReason = normalizeOllamaFinishReason(chunk.finishReason);
          // station#4197: Ollama's OpenAI-compatible endpoint reports usage
          // on every completed turn and this adapter used to discard it
          // (the #4048 audit's "engines report, Station drops" finding).
          if (chunk.usage) turnUsage = chunk.usage;
        }
        // station#3596 (found while implementing station#3586/#3588, folded
        // into this branch on review: station#3586 widens the population
        // that reaches an `error` chunk — request-time failures and
        // mid-stream ai-sdk failures both now produce one, see
        // `ai-sdk-llm-provider.ts`'s docblock — and this adapter, unlike
        // `BedrockAdapter`/`FleetInferenceService`, never checked for it.
        // Left alone, a failed generation published `turn.completed` with
        // whatever `finishReason` happened to be on the LAST `finish` chunk
        // seen before the error (never, since a failed stream from
        // `AiSdkLLMProvider` no longer emits one at all after an error —
        // see `createStream`'s `return` — so `finishReason` here stays
        // `undefined` and `publishCompletion`'s `?? 'stop'` default
        // republishes a truthful-looking `'stop'`), AND `'stop'` has clear
        // authority (`PROVIDER_PROVEN_FINISH_REASONS`) — so a failed Ollama
        // turn would have cleared its own recorded auth failure and reset
        // the backoff streak, erasing the evidence of the very failure it
        // represents. Mirrors `bedrock-adapter.ts`'s identical branch.
        if (chunk.type === 'error') {
          throw new Error(chunk.error || 'Ollama stream failed');
        }
      }
    } catch (err) {
      if (
        this.sessions.has(input.threadId) &&
        this.isCurrentTurn(input.threadId, turnId)
      ) {
        // station#3466: this used to branch on `controller.signal.aborted`
        // and publish `turn.completed`/`finishReason:'cancelled'` there.
        // That branch is UNREACHABLE, not merely untested: every `.abort()`
        // call site (the superseded-turn overwrite, `interruptTurn`'s
        // delete, `stopSession`'s delete) mutates `activeTurns`
        // (delete/overwrite) SYNCHRONOUSLY, in the same tick as the abort —
        // before any code below can run — while an abort's rejection only
        // ever reaches this catch handler on a LATER microtask. So by the
        // time this handler runs for an aborted turn, `isCurrentTurn` above
        // has already gone false and this whole `if` is skipped; the three
        // ordering-invariant tests pinning each abort site (ollama-
        // adapter.test.ts) fail if a future reorder ever lets one of them
        // race the other way. Correction to the issue's own framing: the
        // issue argued deleting the dead arm means a future reorder
        // produces "no cancel event at all rather than a wrong one" — with
        // the arm gone, that is no longer accurate. A reorder now falls
        // through to `publishTurnFailure` below, which emits `runtime.error`
        // — the event the session-lifecycle projector folds to 'failed'. So
        // a regression here would record a user-initiated cancel as a
        // FAILURE, not silence. The ordering-invariant tests above are what
        // actually catch it either way; this comment just says what the
        // failure mode is now. station#3442: a genuine stream/runtime
        // failure — not a cancellation — must publish `runtime.error`, the
        // only canonical event the session-lifecycle projector folds to
        // 'failed'. This branch used to publish `turn.completed` with
        // `finishReason: 'other'` unconditionally, which is
        // indistinguishable from an ordinary terminal completion and folded
        // the session to 'completed'.
        this.publishTurnFailure(
          input.threadId,
          turnId,
          err instanceof Error ? err.message : String(err),
        );
      }
      this.clearCurrentTurn(input.threadId, turnId);
      throw err;
    }

    if (!this.isCurrentTurn(input.threadId, turnId)) {
      throw new Error('Turn was superseded before completion.');
    }

    // Accumulate history for multi-turn context
    session.history.push({ role: 'user', content: input.input });
    if (assistantText) {
      session.history.push({ role: 'assistant', content: assistantText });
    }

    this.publishCompletion(input.threadId, turnId, assistantText, {
      finishReason,
      reportedModel,
      usage: turnUsage,
    });
    this.clearCurrentTurn(input.threadId, turnId);

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string, turnId?: string) {
    const activeTurn = this.activeTurns.get(threadId);
    if (!activeTurn) return { outcome: 'no-active-turn' } as const;
    if (turnId && turnId !== activeTurn.turnId) {
      return {
        outcome: 'target-mismatch',
        activeTurnId: activeTurn.turnId,
      } as const;
    }
    this.activeTurns.delete(threadId);
    activeTurn.controller.abort(new Error('Turn interrupted.'));
    if (this.sessions.has(threadId)) {
      this.updateSession(threadId, {
        status: 'ready',
        updatedAt: new Date().toISOString(),
      });
      const interruptedTurnId = activeTurn.turnId;
      if (interruptedTurnId) {
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId,
          createdAt: new Date().toISOString(),
          turnId: interruptedTurnId,
          method: 'turn.aborted',
          reason: 'interrupted',
        });
      }
    }
    return { outcome: 'cancelled', turnId: activeTurn.turnId } as const;
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const statusMap: Record<string, RequestResolvedEvent['status']> = {
      accept: 'approved',
      acceptForSession: 'approved',
      decline: 'denied',
      cancel: 'cancelled',
    };
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      requestId,
      method: 'request.resolved',
      status: statusMap[decision] ?? 'cancelled',
    });
  }

  async stopSession(threadId: string): Promise<void> {
    this.activeTurns
      .get(threadId)
      ?.controller.abort(new Error('Session stopped.'));
    this.activeTurns.delete(threadId);
    if (!this.sessions.has(threadId)) return;
    this.sessions.delete(threadId);
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: threadId,
      reason: 'stopped',
    });
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    try {
      const threadIds = [...this.sessions.keys()];
      await Promise.all(threadIds.map((id) => this.stopSession(id)));
    } finally {
      this.events.close();
    }
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  publish(event: CanonicalRuntimeEvent): void {
    this.events.push(event);
  }

  private isCurrentTurn(threadId: string, turnId: string): boolean {
    return this.activeTurns.get(threadId)?.turnId === turnId;
  }

  private clearCurrentTurn(threadId: string, turnId: string): void {
    if (this.isCurrentTurn(threadId, turnId)) this.activeTurns.delete(threadId);
  }

  private publishCompletion(
    threadId: string,
    turnId: string,
    outputText: string | undefined,
    options: {
      // station#3588: widened from `'stop' | 'cancelled' | 'other'` to
      // include `'tool-calls'` and `'max-tokens'` — the finish branch of
      // `sendTurn`'s loop now actually populates this from the producer's
      // `chunk.finishReason` (`normalizeOllamaFinishReason`), so values
      // beyond `'stop'` are genuinely reachable here for the first time.
      // `'cancelled'` stays declared though nothing currently supplies it
      // (see the `station#3466` comment on the unreachable abort branch
      // above `sendTurn`'s catch block) — narrowing the accepted type is a
      // separate decision from fixing this issue's actual gap.
      finishReason?:
        | 'stop'
        | 'tool-calls'
        | 'max-tokens'
        | 'cancelled'
        | 'other';
      reportedModel?: string;
      /** station#4197: the finish chunk's reported usage, when present. */
      usage?: LLMStreamChunk['usage'];
    } = {},
  ): void {
    if (!this.isCurrentTurn(threadId, turnId)) return;
    const completedAt = new Date().toISOString();
    const metadata = reportedModelMetadata(options.reportedModel);
    // station#4197: publish exactly what Ollama reported for THIS turn —
    // one per-turn event (declared `per-turn` in `PROVIDER_USAGE_SCOPE`),
    // derived by `ollamaReportedUsage` (cache-read presence-gated on the
    // OpenAI-compatible wire object; see that function's docblock). No
    // usable figures -> no event: absence is not an event of zeros.
    const reportedUsage = ollamaReportedUsage(options.usage);
    if (reportedUsage) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId,
        createdAt: completedAt,
        turnId,
        method: 'token-usage.updated',
        ...reportedUsage,
      });
    }
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: completedAt,
      turnId,
      method: 'turn.completed',
      finishReason: options.finishReason ?? 'stop',
      outputText,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    this.updateSession(threadId, { status: 'ready', updatedAt: completedAt });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: completedAt,
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });
  }

  /**
   * station#3442: the failure counterpart to `publishCompletion` — publishes
   * `runtime.error` (never `turn.completed`) so the session-lifecycle
   * projector derives `failed`, then restores the same adapter-internal
   * session bookkeeping (`ready`/`idle`) `publishCompletion` performs so a
   * failed turn does not leave the session stuck reporting `running`.
   */
  private publishTurnFailure(
    threadId: string,
    turnId: string,
    message: string,
  ): void {
    if (!this.isCurrentTurn(threadId, turnId)) return;
    const completedAt = new Date().toISOString();
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: completedAt,
      turnId,
      method: 'runtime.error',
      severity: 'error',
      message,
    });
    this.updateSession(threadId, { status: 'ready', updatedAt: completedAt });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: completedAt,
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });
  }

  private async resolveModelId(modelId?: string): Promise<string> {
    const requested = modelId?.trim() ?? '';
    if (!requested) {
      throw new Error('Ollama adapter requires a launchable model selector.');
    }
    // station#1430 review, H-2: this only ever reads `match.id` — never a
    // capability field — but runs on every session start and model switch,
    // an unbounded-frequency hot path. `skipCapabilityEnrichment` keeps it
    // from paying for (or being stalled by) `/api/show` lookups whose result
    // it would discard.
    const catalog = await this.llm.listModelCatalog({
      skipCapabilityEnrichment: true,
    });
    const match = catalog.models.find((model) => model.id === requested);
    if (!match) {
      throw new Error(
        `Ollama model selector '${requested}' is not available from the configured server.`,
      );
    }
    return match.id;
  }

  private updateSession(
    threadId: string,
    updates: Partial<OllamaSession>,
  ): void {
    const current = this.sessions.get(threadId);
    if (!current) return;
    this.sessions.set(threadId, { ...current, ...updates });
  }
}
