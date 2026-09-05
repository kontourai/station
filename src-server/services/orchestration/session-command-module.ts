import crypto from 'node:crypto';
import type {
  OrchestrationCommandReceipt,
  OrchestrationStartSessionInput,
} from '@kontourai/station-contracts/orchestration';
import type {
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import type { WorkflowSidecarAttachMode } from '../evidence/orchestration-workflow-sidecar.js';
import type { RuntimeEngineStartIntent } from '../infra/resource-posture.js';
import type { ForegroundInvocationAdmission } from './foreground-invocation-admission.js';

/** The only start-session intent callers may issue. */
export type SessionCommand = {
  type: 'start-session';
  input: OrchestrationStartSessionInput;
};

export type SessionCommandContext = {
  userId?: string;
  tenantExecutionContext?: TenantExecutionContext;
};

export type SessionCommandOutcome =
  | {
      status: 'accepted';
      receipt: OrchestrationCommandReceipt;
      receiptStatus: 'persisted';
      session: ProviderSession;
    }
  | {
      status: 'rejected' | 'failed';
      receipt: OrchestrationCommandReceipt;
      receiptStatus: 'persisted' | 'unavailable';
      message: string;
      /** Typed, retryable refusal facts survive to HTTP/delegation callers. */
      code?: string;
    }
  | {
      /** Session effects completed, but accepted-receipt durability is unknown. */
      status: 'indeterminate';
      receipt: OrchestrationCommandReceipt;
      receiptStatus: 'unavailable';
      session: ProviderSession;
      message: string;
    };

/** Closed, total command Interface shared by routes, tools, and tests. */
export interface SessionCommandModule {
  execute(
    command: SessionCommand,
    context: SessionCommandContext,
  ): Promise<SessionCommandOutcome>;
}

/** Service-only recovery choices. They cannot cross the public command seam. */
export type SessionCommandInternalOptions = {
  /** Captured server-owned action admission; never accepted from public JSON. */
  foregroundInvocationAdmission?: ForegroundInvocationAdmission;
  /** Server-minted correlation for an exact higher-level start claim. */
  commandId?: string;
  skipModelOptionSupportCheck?: boolean;
  credentialProfileApplication?: boolean;
  workflowSidecarAttachMode?: WorkflowSidecarAttachMode;
  /** Server-owned execution policy for independent review sessions. */
  reviewIsolation?: ProviderSessionStartInput['reviewIsolation'];
  /**
   * archive#2821 hardening L3: re-stamps `metadata.sessionVisibility =
   * 'ephemeral'` after `stripReservedCapabilityMetadata` removes any
   * caller-supplied value. Only the foreground webhook execution seam sets
   * this, and only for its own server-composed metadata — never accepted
   * from an HTTP command.
   */
  ephemeralSessionVisibility?: boolean;
  /** Server-resolved durable identity re-stamped after public metadata strip. */
  conversationIdentity?: {
    conversationId: string;
    environmentId: string;
  };
  /** Server-derived caller topology; never accepted from a command body. */
  resourceAdmissionIntent?: RuntimeEngineStartIntent;
  /** Opaque controller capability; only the foreground route can carry it. */
};

type ExistingSession = {
  adapter?: ProviderAdapterShape;
  session?: ProviderSession;
};

/**
 * Private composition root. Each capability owns a coherent concern; no
 * public caller can use these operations to bypass the closed command intent.
 */
export interface SessionCommandDependencies {
  receiptLedger: {
    initialize(): void;
    recordDispatch(input: OrchestrationStartSessionInput): void;
    persist(receipt: OrchestrationCommandReceipt): void;
    /** Optional exact readback after a write may have succeeded then thrown. */
    read?(commandId: string): OrchestrationCommandReceipt | null;
    /** Observation must not make the public command Interface reject. */
    reportUnavailable?(input: {
      phase:
        | 'initialize'
        | 'record-dispatch'
        | 'persist-accepted'
        | 'read-accepted'
        | 'read-terminal'
        | 'persist-terminal';
      error: unknown;
      receipt: OrchestrationCommandReceipt;
    }): void;
  };
  sessionState: {
    boundTenant(threadId: string): TenantExecutionContext | undefined;
    recordTenantMismatch(): void;
    isQuarantined(threadId: string): boolean;
    isReadOnlyAttached(threadId: string): boolean;
    recordAttachedMutationRejection(): void;
    canRead(
      threadId: string,
      userId: string,
      tenant: TenantExecutionContext | undefined,
    ): boolean;
    existing(threadId: string): ExistingSession;
    claimStart(threadId: string): boolean;
    releaseStart(threadId: string): void;
    attachStarted(
      session: ProviderSession,
      adapter: ProviderAdapterShape,
      tenant: TenantExecutionContext | undefined,
      startInput: OrchestrationStartSessionInput,
    ): void;
  };
  launchPolicy: {
    assertStartAllowed(
      input: OrchestrationStartSessionInput,
      context: SessionCommandContext,
      internal: SessionCommandInternalOptions | undefined,
    ): void;
    validateReattach(
      input: OrchestrationStartSessionInput,
      existing: Required<ExistingSession>,
    ): void;
    /**
     * archive#3493 residual 6: the adapter-free half of
     * {@link validateReattach}, run against the PERSISTED session BEFORE
     * {@link materializeRestoredSession} — a reattach conflict must refuse
     * before the engine spawn it would otherwise only be raised after.
     */
    validateReattachAgainstPersisted?(
      input: OrchestrationStartSessionInput,
      session: ProviderSession,
    ): void;
    requireAdapter(
      provider: OrchestrationStartSessionInput['provider'],
    ): ProviderAdapterShape;
    /**
     * archive#3476: start the engine for a session this process restored at
     * boot without spawning one, so a reattach can bind to a real engine
     * instead of failing on the half-populated state below. Resolves to
     * `undefined` when the thread is not a dormant restored session, which
     * leaves every pre-existing outcome unchanged.
     */
    materializeRestoredSession?(
      threadId: string,
    ): Promise<ProviderAdapterShape | undefined>;
    prepareStart(
      input: OrchestrationStartSessionInput,
      context: SessionCommandContext,
      internal: SessionCommandInternalOptions | undefined,
      adapter: ProviderAdapterShape,
    ): Promise<ProviderSessionStartInput>;
    start(
      adapter: ProviderAdapterShape,
      input: ProviderSessionStartInput,
      context: SessionCommandContext,
      internal: SessionCommandInternalOptions | undefined,
    ): Promise<ProviderSession>;
    recordStarted(
      adapter: ProviderAdapterShape,
      input: ProviderSessionStartInput,
    ): void;
    ensureStartedSessionCurrent(
      adapter: ProviderAdapterShape,
      session: ProviderSession,
      signal: AbortSignal | undefined,
    ): Promise<void>;
    logStarted(
      adapter: ProviderAdapterShape,
      input: ProviderSessionStartInput,
    ): void;
    recordGateBlocked(adapter: ProviderAdapterShape, error: unknown): void;
  };
  bindings: {
    bind(
      input: OrchestrationStartSessionInput | ProviderSessionStartInput,
      internal: SessionCommandInternalOptions | undefined,
    ): Promise<void>;
  };
  publicSession(session: ProviderSession): ProviderSession;
  isRejectedError(error: unknown): boolean;
  attachedSessionReadOnlyMessage: string;
}

export interface SessionCommandImplementation extends SessionCommandModule {
  /** Private service seam for recovery; never handed to routes or tools. */
  executeInternal(
    command: SessionCommand,
    context: SessionCommandContext,
    internal: SessionCommandInternalOptions,
  ): Promise<SessionCommandOutcome>;
}

export function createSessionCommandModule(
  deps: SessionCommandDependencies,
): SessionCommandImplementation {
  const execute = async (
    command: SessionCommand,
    context: SessionCommandContext,
    internal?: SessionCommandInternalOptions,
  ): Promise<SessionCommandOutcome> => {
    const input = command.input;
    const receipt: OrchestrationCommandReceipt = {
      commandId: internal?.commandId ?? crypto.randomUUID(),
      threadId: input.threadId,
      commandType: 'startSession',
      status: 'accepted',
      createdAt: new Date().toISOString(),
    };
    const reportUnavailable = (
      phase:
        | 'initialize'
        | 'record-dispatch'
        | 'persist-accepted'
        | 'read-accepted'
        | 'read-terminal'
        | 'persist-terminal',
      error: unknown,
      observedReceipt: OrchestrationCommandReceipt,
    ) => {
      try {
        deps.receiptLedger.reportUnavailable?.({
          phase,
          error,
          receipt: observedReceipt,
        });
      } catch {
        // Receipt-failure observation is best effort. It must not make a
        // total public command Interface reject.
      }
    };
    const persist = (
      persistedReceipt: OrchestrationCommandReceipt,
      phase: 'persist-accepted' | 'persist-terminal',
    ): { kind: 'persisted' } | { kind: 'unavailable'; error: unknown } => {
      try {
        deps.receiptLedger.persist(persistedReceipt);
        return { kind: 'persisted' };
      } catch (error) {
        reportUnavailable(phase, error, persistedReceipt);
        return { kind: 'unavailable', error };
      }
    };
    const readReceipt = (
      expected: OrchestrationCommandReceipt,
      phase: 'read-accepted' | 'read-terminal',
    ): OrchestrationCommandReceipt | null => {
      if (!deps.receiptLedger.read) return null;
      try {
        const readback = deps.receiptLedger.read(expected.commandId);
        return readback?.commandId === expected.commandId &&
          readback.threadId === expected.threadId &&
          readback.commandType === expected.commandType &&
          readback.status === expected.status
          ? readback
          : null;
      } catch (error) {
        reportUnavailable(phase, error, expected);
        return null;
      }
    };
    const acceptedAfterReceiptFault = (
      error: unknown,
      session: ProviderSession,
    ): SessionCommandOutcome => {
      const readback = readReceipt(receipt, 'read-accepted');
      if (readback) {
        return {
          status: 'accepted',
          receipt: readback,
          receiptStatus: 'persisted',
          session,
        };
      }
      return {
        status: 'indeterminate',
        receipt,
        receiptStatus: 'unavailable',
        session,
        message: `Session started, but the accepted command receipt is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    };
    const fail = (error: unknown, rejected = false): SessionCommandOutcome => {
      const terminalReceipt = {
        ...receipt,
        status: rejected ? ('rejected' as const) : ('failed' as const),
      };
      // Do not recurse if durable failure persistence is also unavailable. A
      // matching exact readback is the only proof that the terminal receipt is
      // durable; otherwise callers receive the terminal result with explicit
      // unavailable receipt certainty.
      const persisted = persist(terminalReceipt, 'persist-terminal');
      const readback =
        persisted.kind === 'persisted'
          ? terminalReceipt
          : readReceipt(terminalReceipt, 'read-terminal');
      return {
        status: terminalReceipt.status,
        receipt: readback ?? terminalReceipt,
        receiptStatus: readback ? 'persisted' : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error === 'object' &&
        error !== null &&
        typeof (error as { code?: unknown }).code === 'string'
          ? { code: (error as { code: string }).code }
          : {}),
      };
    };

    try {
      try {
        deps.receiptLedger.initialize();
      } catch (error) {
        reportUnavailable('initialize', error, receipt);
        return fail(error);
      }
      try {
        deps.receiptLedger.recordDispatch(input);
      } catch (error) {
        reportUnavailable('record-dispatch', error, receipt);
        return fail(error);
      }

      const boundTenant = deps.sessionState.boundTenant(input.threadId);
      if (
        boundTenant &&
        context.tenantExecutionContext &&
        boundTenant.tenantId !== context.tenantExecutionContext.tenantId
      ) {
        deps.sessionState.recordTenantMismatch();
        return fail(
          `Tenant execution context does not match session: ${input.threadId}`,
          true,
        );
      }
      if (deps.sessionState.isQuarantined(input.threadId)) {
        return fail(`Session is unavailable: ${input.threadId}`, true);
      }
      if (deps.sessionState.isReadOnlyAttached(input.threadId)) {
        deps.sessionState.recordAttachedMutationRejection();
        return fail(deps.attachedSessionReadOnlyMessage, true);
      }

      deps.launchPolicy.assertStartAllowed(input, context, internal);
      if (!deps.sessionState.claimStart(input.threadId)) {
        throw new Error(
          `Session is already starting for thread: ${input.threadId}`,
        );
      }
      let adapter: ProviderAdapterShape | undefined;
      try {
        let existing = deps.sessionState.existing(input.threadId);
        if (existing.adapter || existing.session) {
          if (
            context.userId !== undefined &&
            !deps.sessionState.canRead(
              input.threadId,
              context.userId,
              context.tenantExecutionContext,
            )
          ) {
            throw new Error(`Session not found: ${input.threadId}`);
          }
          // archive#3476: boot recovery restores a session's state without
          // starting an engine, so a restored thread arrives here with a
          // `session` and no `adapter` — a shape that used to be impossible
          // and that the reattach branch below rejects as
          // "Session already exists". Give it its engine first, then reattach
          // exactly as before. Only for a thread whose persisted provider is
          // the one being asked for: a genuine provider mismatch must still
          // fail rather than spawn the wrong engine.
          //
          // This runs BELOW the ownership check above, and must stay there:
          // starting an engine is the first side effect this command has, and
          // a caller who may not read the session must not be able to cause
          // one — the start would run with the OWNER's cwd, credential
          // profile and tenant context, and a failed start durably writes a
          // `runtime.error` into the owner's thread.
          if (
            existing.session &&
            !existing.adapter &&
            existing.session.provider === input.provider &&
            deps.launchPolicy.materializeRestoredSession
          ) {
            // archive#3493 residual 6: a reattach that conflicts with the
            // persisted row must refuse HERE, before the engine spawns —
            // raising it only from `validateReattach` below meant the
            // conflict arrived after `materializeRestoredSession` had
            // already started a process the command then abandons.
            deps.launchPolicy.validateReattachAgainstPersisted?.(
              input,
              existing.session,
            );
            await deps.launchPolicy.materializeRestoredSession(input.threadId);
            existing = deps.sessionState.existing(input.threadId);
          }
          if (
            !existing.adapter ||
            !existing.session ||
            existing.adapter.provider !== input.provider
          ) {
            throw new Error(
              `Session already exists for thread: ${input.threadId}`,
            );
          }
          deps.launchPolicy.validateReattach(input, {
            adapter: existing.adapter,
            session: existing.session,
          });
          await deps.bindings.bind(input, internal);
          const persisted = persist(receipt, 'persist-accepted');
          const publicSession = deps.publicSession(existing.session);
          if (persisted.kind === 'unavailable')
            return acceptedAfterReceiptFault(persisted.error, publicSession);
          return {
            status: 'accepted',
            receipt,
            receiptStatus: 'persisted',
            session: publicSession,
          };
        }
        adapter = deps.launchPolicy.requireAdapter(input.provider);
        const startInput = await deps.launchPolicy.prepareStart(
          input,
          context,
          internal,
          adapter,
        );
        const session = await deps.launchPolicy.start(
          adapter,
          startInput,
          context,
          internal,
        );
        deps.launchPolicy.recordStarted(adapter, startInput);
        await deps.launchPolicy.ensureStartedSessionCurrent(
          adapter,
          session,
          startInput.signal,
        );
        deps.sessionState.attachStarted(
          session,
          adapter,
          context.tenantExecutionContext,
          startInput,
        );
        deps.launchPolicy.logStarted(adapter, startInput);
        await deps.bindings.bind(startInput, internal);
        const persisted = persist(receipt, 'persist-accepted');
        const publicSession = deps.publicSession(session);
        if (persisted.kind === 'unavailable')
          return acceptedAfterReceiptFault(persisted.error, publicSession);
        return {
          status: 'accepted',
          receipt,
          receiptStatus: 'persisted',
          session: publicSession,
        };
      } catch (error) {
        if (adapter) deps.launchPolicy.recordGateBlocked(adapter, error);
        throw error;
      } finally {
        deps.sessionState.releaseStart(input.threadId);
      }
    } catch (error) {
      return fail(error, deps.isRejectedError(error));
    }
  };

  return {
    execute: (command, context) => execute(command, context),
    executeInternal: (command, context, internal) =>
      execute(command, context, internal),
  };
}
