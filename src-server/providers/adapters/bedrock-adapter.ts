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
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter-shape.js';
import { checkBedrockCredentials } from '../llm/bedrock.js';
import { BedrockLLMProvider } from '../llm/bedrock-llm-provider.js';
import { BedrockModelCatalog } from '../llm/bedrock-models.js';
import type {
  LLMMessage,
  LLMStreamChunk,
} from '../llm/model-provider-types.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';
import { bedrockReportedUsage } from './ai-sdk-reported-usage.js';

export interface BedrockAdapterCallbacks {
  startSession?(
    input: ProviderSessionStartInput,
  ): Promise<Partial<ProviderSession> | undefined>;
  sendTurn?(
    input: ProviderSendTurnInput,
  ): Promise<
    (Partial<ProviderTurnStartResult> & { outputText?: string }) | undefined
  >;
  interruptTurn?(threadId: string, turnId?: string): Promise<void>;
  respondToRequest?(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void>;
  stopSession?(threadId: string): Promise<void>;
  stopAll?(): Promise<void>;
}

interface BedrockSession extends ProviderSession {
  systemPrompt?: string;
  history: LLMMessage[];
}

export class BedrockAdapter implements ProviderAdapterShape {
  readonly provider: ProviderKind = 'bedrock';
  readonly metadata = {
    displayName: 'Amazon Bedrock',
    description:
      'Built-in Station agent runtime backed by Amazon Bedrock. AWS credentials and Bedrock model access are required.',
    capabilities: [
      'agent-runtime',
      'session-lifecycle',
      'tool-calls',
      'interrupt',
    ],
    continuity: { resume: 'same-session', fork: 'replay-seed', rewind: 'none' },
    runtimeId: engineRuntimeId('bedrock-runtime'),
    builtin: true,
    engineId: engineId('station'),
    abortSettlement: 'await',
    modelLaunch: {
      defaultAtStart: 'station-resolved',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
      modelConnectionId: 'bedrock-runtime',
    },
  } as const;

  private sessions = new Map<string, BedrockSession>();
  private readonly activeTurns = new Map<
    string,
    { turnId: string; controller: AbortController }
  >();
  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private llm?: BedrockLLMProvider;
  private modelCatalog?: Pick<BedrockModelCatalog, 'resolveModelId'>;

  constructor(
    private readonly callbacks: BedrockAdapterCallbacks = {},
    dependencies?: {
      llm?: BedrockLLMProvider;
      modelCatalog?: Pick<BedrockModelCatalog, 'resolveModelId'>;
    },
  ) {
    this.llm = dependencies?.llm;
    this.modelCatalog = dependencies?.modelCatalog;
  }

  configureLaunchability(dependencies: {
    llm: BedrockLLMProvider;
    modelCatalog: Pick<BedrockModelCatalog, 'resolveModelId'>;
  }): void {
    this.llm = dependencies.llm;
    this.modelCatalog = dependencies.modelCatalog;
  }

  private requireLLM(): BedrockLLMProvider {
    if (!this.llm) throw new Error('Bedrock runtime is not configured.');
    return this.llm;
  }

  private requireModelCatalog(): Pick<BedrockModelCatalog, 'resolveModelId'> {
    if (!this.modelCatalog) {
      throw new Error('Bedrock model catalog is not configured.');
    }
    return this.modelCatalog;
  }

  async getPrerequisites(): Promise<Prerequisite[]> {
    const hasCredentials = await checkBedrockCredentials();
    return [
      {
        id: 'bedrock-credentials',
        name: 'Bedrock Credentials',
        description:
          'AWS credentials or profile with Amazon Bedrock model access.',
        status: hasCredentials ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: [
            'Option 1: Configure AWS CLI credentials — run `aws configure` or edit ~/.aws/credentials',
            'Option 2: Use AWS SSO — run `aws sso login --profile <your-profile>` before starting Station',
            'Option 3: Set a credential_process helper in ~/.aws/config for automatic token refresh',
            'Ensure the credentials have Amazon Bedrock model access in the target region.',
          ],
          links: [
            'https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html',
            'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html',
          ],
        },
      },
    ];
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const requestedModel = input.modelId?.trim() ?? '';
    if (!requestedModel) {
      throw new Error(
        'Bedrock adapter requires an evidence-backed model selector.',
      );
    }
    const modelCatalog = this.requireModelCatalog();
    let model = await modelCatalog.resolveModelId(requestedModel);
    const resolvedInput = { ...input, modelId: model };
    const now = new Date().toISOString();
    const callbackResult = await this.callbacks.startSession?.(resolvedInput);
    if (callbackResult?.model && callbackResult.model !== model) {
      model = await modelCatalog.resolveModelId(callbackResult.model);
    }
    const systemPrompt =
      typeof input.modelOptions?.systemPrompt === 'string'
        ? input.modelOptions.systemPrompt
        : undefined;
    const session: BedrockSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: callbackResult?.status ?? 'ready',
      model,
      // Retained so a later `session.configured` can restate it: consumers
      // read `cwd` off the latest such event, so an event that omits it
      // erases the session's working directory downstream (archive#903).
      ...(input.cwd ? { cwd: input.cwd } : {}),
      resumeCursor: callbackResult?.resumeCursor ?? input.resumeCursor,
      createdAt: callbackResult?.createdAt ?? now,
      updatedAt: callbackResult?.updatedAt ?? now,
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
      metadata: {
        ...input.metadata,
        cwd: input.cwd,
      },
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
        `Bedrock adapter cannot send turn for missing session: ${input.threadId}`,
      );
    }

    const requestedModel = input.modelId ?? session.model;
    if (!requestedModel) {
      throw new Error(
        'Bedrock adapter requires an evidence-backed model selector.',
      );
    }
    const model =
      await this.requireModelCatalog().resolveModelId(requestedModel);
    const resolvedInput = { ...input, modelId: model };
    const acceptedLaunchPlan = acceptModelLaunchPlan(
      input.metadata?.[MODEL_LAUNCH_PLAN_METADATA_KEY] as
        | ModelLaunchPlan
        | undefined,
      { modelId: model },
    );

    const now = new Date().toISOString();
    const turnId = crypto.randomUUID();
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

    // archive#903: a per-turn model change must reach the read model and the
    // persisted row, and `session.configured` is the only event that carries a
    // model. Published before the state/turn events below so a consumer
    // folding in order ends on the turn's own state. Gated on the turn
    // actually supplying a selector: every turn re-resolves the model through
    // the catalog, so comparing resolved-vs-stored alone would restate on
    // ordinary turns whenever resolution is not idempotent.
    //
    // Disclosed residual gap (archive#903 review): `updateSession` below overwrites
    // the stored model unconditionally, so a turn that omits a selector while
    // catalog resolution returns something new — an inference profile added or
    // deprecated behind the TTL cache — changes the session's model without
    // announcing it. Every UI turn resends a selector, so this is only live
    // for callers that don't (e.g. the connection smoke lane).
    if (input.modelId && model !== session.model) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: now,
        method: 'session.configured',
        sessionId: input.threadId,
        model,
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

    try {
      const callbackResult = await this.callbacks.sendTurn?.(resolvedInput);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (callbackResult) {
        if (callbackResult.outputText) {
          this.publish({
            eventId: crypto.randomUUID(),
            provider: this.provider,
            threadId: input.threadId,
            createdAt: new Date().toISOString(),
            turnId,
            itemId: crypto.randomUUID(),
            method: 'content.text-delta',
            delta: callbackResult.outputText,
          });
        }

        this.publishCompletion({
          input: resolvedInput,
          turnId,
          outputText: callbackResult.outputText,
          finishReason: callbackResult.outputText ? 'stop' : 'other',
          resumeCursor: callbackResult.resumeCursor ?? session.resumeCursor,
        });
        return {
          threadId: input.threadId,
          turnId: callbackResult.turnId ?? turnId,
          resumeCursor: callbackResult.resumeCursor,
        };
      }

      const messages: LLMMessage[] = [];
      if (session.systemPrompt) {
        messages.push({ role: 'system', content: session.systemPrompt });
      }
      messages.push(...session.history);
      messages.push({ role: 'user', content: input.input });

      let assistantText = '';
      // archive#3457: one id for the ONE assistant text item this turn
      // streams, minted before the loop and reused by every chunk of it.
      // Minting inside the loop gave each token its own `itemId`, which is
      // per-chunk identity — that is what `eventId` is for.
      const contentItemId = crypto.randomUUID();
      let finishReason:
        | 'stop'
        | 'tool-calls'
        | 'max-tokens'
        | 'cancelled'
        | 'other'
        | undefined;
      // archive#4197: the finish chunk's reported usage, held for
      // `publishCompletion` to translate into `token-usage.updated`. Stays
      // `undefined` when the stream reported none — absence publishes no
      // event, never an event of zeros.
      let turnUsage: LLMStreamChunk['usage'];

      for await (const chunk of this.requireLLM().createStream({
        model,
        messages,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) throw controller.signal.reason;
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
        } else if (chunk.type === 'finish') {
          finishReason = normalizeFinishReason(chunk.finishReason);
          // archive#4197: Bedrock reports usage on every completed turn and
          // this adapter used to discard it (the archive#4048 audit's "engines
          // report, Station drops" finding).
          if (chunk.usage) turnUsage = chunk.usage;
          // archive#1182: `chunk.reportedModel` (populated by
          // `AiSdkLLMProvider.createStream`, shared with Ollama) is
          // deliberately NOT consumed here. Verified against
          // `@ai-sdk/amazon-bedrock`'s `doStream`/`doGenerate`: its
          // `response` metadata is built as `{ modelId: this.modelId, ... }`
          // — a bare echo of the request's own model id, never anything
          // read off Bedrock's Converse/ConverseStream API response (which
          // carries no model-identity field at all; Bedrock either serves
          // the exact modelId/inference-profile ARN given or errors, with no
          // server-side alias resolution). Surfacing it as `reportedModel`
          // would recreate exactly the "requested presented as observed"
          // bug this ticket exists to fix. If Bedrock ever gains a genuine
          // resolved-model response field (e.g. for cross-region inference
          // profiles), wire it through the same `reportedModelMetadata`
          // path Ollama uses.
        } else if (chunk.type === 'error') {
          throw new Error(chunk.error || 'Bedrock stream failed');
        }
      }

      if (!this.isCurrentTurn(input.threadId, turnId)) {
        throw new Error('Turn was superseded before completion.');
      }
      session.history.push({ role: 'user', content: input.input });
      if (assistantText) {
        session.history.push({ role: 'assistant', content: assistantText });
      }

      // archive#3545: `finishReason` is `undefined` whenever the stream's
      // finish chunk carried no `finishReason` — reachable here because the
      // loop above completed without throwing or being aborted, i.e. the
      // turn genuinely succeeded. This fallback used to be dead:
      // `normalizeFinishReason` defaulted absence to the truthy `'other'`,
      // so it never reached this fallback. `??`, not `||`: `finishReason` is
      // a vocabulary string, never `''`/`0`/`false`, so the two operators
      // agree today — but `||` would silently start treating some future
      // falsy-but-valid member as absent, and review HIGH's producer-level
      // fix makes the recognized-string arms genuinely reachable again, so
      // this is no longer a purely inert distinction.
      this.publishCompletion({
        input: resolvedInput,
        turnId,
        outputText: assistantText,
        finishReason: finishReason ?? 'stop',
        resumeCursor: session.resumeCursor,
        usage: turnUsage,
      });
      return { threadId: input.threadId, turnId };
    } catch (error) {
      if (
        this.sessions.has(input.threadId) &&
        this.isCurrentTurn(input.threadId, turnId)
      ) {
        // archive#3466: this used to branch on `controller.signal.aborted`
        // and publish `turn.completed`/`finishReason:'cancelled'` there.
        // That branch is UNREACHABLE, not merely untested: every `.abort()`
        // call site (the superseded-turn overwrite, `interruptTurn`'s
        // delete, `stopSession`'s delete) mutates `activeTurns`
        // (delete/overwrite) SYNCHRONOUSLY, in the same tick as the abort —
        // before any code below can run — while an abort's rejection only
        // ever reaches this catch handler on a LATER microtask. So by the
        // time this handler runs for an aborted turn, `isCurrentTurn` above
        // has already gone false and this whole `if` is skipped; the three
        // ordering-invariant tests pinning each abort site (bedrock-
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
        // failure mode is now. archive#3442: a genuine stream/runtime
        // failure — not a cancellation — must publish `runtime.error`, the
        // only canonical event the session-lifecycle projector folds to
        // 'failed'. This branch used to publish `turn.completed` with
        // `finishReason: 'other'` unconditionally, which is
        // indistinguishable from an ordinary terminal completion and folded
        // the session to 'completed'.
        this.publishTurnFailure({
          input: resolvedInput,
          turnId,
          message: error instanceof Error ? error.message : String(error),
          resumeCursor: session.resumeCursor,
        });
      }
      throw error;
    } finally {
      if (this.activeTurns.get(input.threadId)?.turnId === turnId) {
        this.activeTurns.delete(input.threadId);
      }
    }
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
    await this.callbacks.interruptTurn?.(threadId, activeTurn.turnId);
    return { outcome: 'cancelled', turnId: activeTurn.turnId } as const;
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    await this.callbacks.respondToRequest?.(threadId, requestId, decision);
    const statusByDecision: Record<
      RequestResolvedEvent['status'] | 'acceptForSession',
      RequestResolvedEvent['status']
    > = {
      approved: 'approved',
      denied: 'denied',
      cancelled: 'cancelled',
      expired: 'expired',
      acceptForSession: 'approved',
    };
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      requestId,
      method: 'request.resolved',
      status:
        decision === 'accept'
          ? statusByDecision.approved
          : decision === 'acceptForSession'
            ? statusByDecision.acceptForSession
            : decision === 'decline'
              ? statusByDecision.denied
              : statusByDecision.cancelled,
    });
  }

  async stopSession(threadId: string): Promise<void> {
    this.activeTurns
      .get(threadId)
      ?.controller.abort(new Error('Session stopped.'));
    this.activeTurns.delete(threadId);
    await this.callbacks.stopSession?.(threadId);
    const session = this.sessions.get(threadId);
    if (!session) return;
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

  async listModels(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<Array<{ id: string; name: string; originalId: string }>> {
    return (await this.listModelCatalog(options)).models;
  }

  async listModelCatalog(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }) {
    const catalog = await this.requireLLM().listModelCatalog(options);
    if (catalog.source !== 'live') {
      throw new Error('Bedrock model catalog is unavailable.');
    }
    return {
      models: catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        originalId: model.id,
      })),
      ...(catalog.truncated ? { truncated: true } : {}),
    };
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    try {
      await this.callbacks.stopAll?.();
      const threadIds = [...this.sessions.keys()];
      await Promise.all(
        threadIds.map((threadId) => this.stopSession(threadId)),
      );
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

  private updateSession(
    threadId: string,
    updates: Partial<BedrockSession>,
  ): void {
    const current = this.sessions.get(threadId);
    if (!current) return;
    this.sessions.set(threadId, { ...current, ...updates });
  }

  private publishCompletion(options: {
    input: ProviderSendTurnInput;
    turnId: string;
    outputText?: string;
    finishReason: 'stop' | 'tool-calls' | 'max-tokens' | 'cancelled' | 'other';
    resumeCursor?: unknown;
    /** archive#4197: the finish chunk's reported usage, when it carried one. */
    usage?: LLMStreamChunk['usage'];
  }): void {
    if (!this.isCurrentTurn(options.input.threadId, options.turnId)) return;
    const completedAt = new Date().toISOString();
    // archive#4197: publish exactly what Bedrock reported for THIS turn —
    // one per-turn event (declared `per-turn` in `PROVIDER_USAGE_SCOPE`),
    // derived by `bedrockReportedUsage` (cache fields presence-gated on the
    // Converse wire object; see that function's docblock). No usable
    // figures -> no event: absence is not an event of zeros.
    const reportedUsage = bedrockReportedUsage(options.usage);
    if (reportedUsage) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: options.input.threadId,
        createdAt: completedAt,
        turnId: options.turnId,
        method: 'token-usage.updated',
        ...reportedUsage,
      });
    }
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: options.input.threadId,
      createdAt: completedAt,
      turnId: options.turnId,
      method: 'turn.completed',
      finishReason: options.finishReason,
      outputText: options.outputText,
    });
    this.updateSession(options.input.threadId, {
      status: 'ready',
      updatedAt: completedAt,
      resumeCursor: options.resumeCursor,
      ...(options.input.modelId ? { model: options.input.modelId } : {}),
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: options.input.threadId,
      createdAt: completedAt,
      method: 'session.state-changed',
      sessionId: options.input.threadId,
      from: 'running',
      to: 'idle',
    });
  }

  /**
   * archive#3442: the failure counterpart to `publishCompletion` — publishes
   * `runtime.error` (never `turn.completed`) so the session-lifecycle
   * projector derives `failed`, then restores the same adapter-internal
   * session bookkeeping (`ready`/`idle`) `publishCompletion` performs so a
   * failed turn does not leave the session stuck reporting `running`.
   */
  private publishTurnFailure(options: {
    input: ProviderSendTurnInput;
    turnId: string;
    message: string;
    resumeCursor?: unknown;
  }): void {
    if (!this.isCurrentTurn(options.input.threadId, options.turnId)) return;
    const completedAt = new Date().toISOString();
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: options.input.threadId,
      createdAt: completedAt,
      turnId: options.turnId,
      method: 'runtime.error',
      severity: 'error',
      message: options.message,
    });
    this.updateSession(options.input.threadId, {
      status: 'ready',
      updatedAt: completedAt,
      resumeCursor: options.resumeCursor,
      ...(options.input.modelId ? { model: options.input.modelId } : {}),
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: options.input.threadId,
      createdAt: completedAt,
      method: 'session.state-changed',
      sessionId: options.input.threadId,
      from: 'running',
      to: 'idle',
    });
  }

  private isCurrentTurn(threadId: string, turnId: string): boolean {
    return this.activeTurns.get(threadId)?.turnId === turnId;
  }
}

// archive#3545: a finish chunk with no `finishReason` key at all is
// *absent*, not a recognized-but-other value. Collapsing that absence into
// `'other'` made every successful Bedrock turn indistinguishable from a
// genuinely unclassified one. This function preserves absence as `undefined`
// and leaves only genuinely-unrecognized *explicit* strings mapped to
// `'other'`; the call site (`sendTurn`'s `finishReason ?? 'stop'`), which
// only runs after the stream loop has completed without throwing or being
// aborted, is where "absent, but the turn plainly succeeded" becomes
// `'stop'`.
//
// archive#3545 review HIGH, fixed one level down: `AiSdkLLMProvider.
// createStream` (which `BedrockLLMProvider` inherits unmodified) now awaits
// ai-sdk's own `result.finishReason` and maps it onto this vocabulary
// (`ai-sdk-llm-provider.ts`'s `mapAiSdkFinishReason`) instead of never
// setting `chunk.finishReason` at all. So the `'stop'` / `'tool-calls'` /
// `'other'` arms below are reachable in production again — this function
// no longer only ever sees `undefined` from Bedrock's real stream, and a
// genuine truncation now reaches `sendTurn` as `'max-tokens'` rather than
// being indistinguishable from an absent value. `'cancelled'` remains
// adapter-only (it is never something the LLM stream itself reports).
//
// archive#3545 review round 2 NIT: two mapping tables now exist for one
// vocabulary — `mapAiSdkFinishReason` (ai-sdk-llm-provider.ts) is
// AUTHORITATIVE for translating ai-sdk's own vocabulary; this function is
// deliberately NOT that translation. It stays as a boundary guard against a
// hand-injected `llm` dependency (this file's own tests construct
// `{ createStream }` stubs directly, bypassing `AiSdkLLMProvider` entirely)
// supplying a string outside station's vocabulary. Do not extend this
// function's arms to cover new ai-sdk-specific values — that belongs in
// `mapAiSdkFinishReason`, which then reaches here as an already-station-
// vocabulary string this function simply recognizes and passes through.
function normalizeFinishReason(
  reason?: string,
): 'stop' | 'tool-calls' | 'max-tokens' | 'cancelled' | 'other' | undefined {
  switch (reason) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
    case 'cancelled':
    case 'other':
      return reason;
    case undefined:
      return undefined;
    default:
      return 'other';
  }
}
