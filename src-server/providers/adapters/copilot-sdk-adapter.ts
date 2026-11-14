/**
 * GitHub Copilot through the Copilot SDK: a vendor-native Station engine,
 * behind the `copilot-sdk-engine` Feature Preview
 * (docs/decisions/copilot-sdk-engine.md). The existing ACP built-in
 * (`copilot --acp`) is a separate connection and is unchanged.
 *
 * One Copilot runtime per Station session: the SDK spawns the person's own
 * installed Copilot CLI in headless stdio mode, with Station's child
 * environment and the session's own TMPDIR. How each SDK capability binds to
 * a generic Station seam:
 *
 * - create/resume: `createSession` / `resumeSession`; the resume cursor is
 *   `{ copilotSessionId }`, scoped by `nativeResumeBindingKey` to the
 *   runtime's configuration home.
 * - turns: `send({ mode: 'enqueue', clientTurnId })`; a turn ends on
 *   `session.idle` (or `session.error`).
 * - steer: `send({ mode: 'immediate' })` into the running turn.
 * - interrupt: `abort()`, confirmed by the turn's own `session.idle`.
 * - approvals: `onPermissionRequest` → `request.opened` / `respondToRequest`
 *   (`copilot-sdk-approval.ts`).
 * - rewind: `session.history.rewind` at the turn's `user.message` event id,
 *   restoring captured files (`enableFileChangeTracking`).
 * - subagents, usage, MCP status, reroutes: `copilot-sdk-events.ts`.
 * - MCP reconnect: `session.mcp.restartServer`.
 *
 * Every entry point that starts work selects the preview again, so turning
 * it off stops new sessions and new turns at once. Stop, interrupt and
 * answering an open request stay available so nothing is stranded.
 */
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ModelInfo,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { STEERING_ENGINE_DURABILITY } from '@kontourai/station-contracts/engine-capability-matrix';
import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import {
  ACP_SESSION_REWOUND_CODE,
  type ModelLaunchCapabilities,
  NATIVE_RESUME_BINDING_METADATA_KEY,
  PROVIDER_COPILOT_SDK,
  readApprovalMode,
  SESSION_REWIND_AFFECTED_PATHS_MAX,
  type SessionLiveContinuity,
  type SessionRewindOutcome,
} from '@kontourai/station-contracts/provider';
import {
  FEATURE_PREVIEW_DISABLED_CODE,
  SESSION_RECOVERY_FAILED_CODE,
} from '@kontourai/station-contracts/provider-failure';
import type { ProviderRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import {
  assertEngineAllowedByManagedPolicy,
  managedEngineBinaryPath,
  managedEngineLaunch,
  managedEnginePrerequisites,
} from '../../security/managed-engine-limits.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import { ensureEngineSpawnTmpDir } from '../../services/infra/engine-spawn-tmpdir.js';
import {
  commitEngineLaunch,
  engineSessionTmpDir,
  stampLaunchExit,
} from '../../services/infra/session-tmpdir.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { errorMessage } from '../../utils/error-message.js';
import type { Logger } from '../../utils/logger.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderInterruptTurnResult,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  ProviderTurnEndedError,
  type ProviderTurnStartResult,
  SendTurnRefusedError,
  SessionRewindingError,
  SessionStartRefusedError,
} from '../adapter-shape.js';
import {
  buildCliRuntimePrerequisites,
  findCliBinary,
  resolveAugmentedPathSync,
} from '../auth/cli-auth.js';
import { providerFailureForCode } from '../provider-failure.js';
import {
  AsyncEventQueue,
  type AsyncEventStreamOptions,
} from '../sessions/async-event-queue.js';
import {
  type CopilotAppliedApprovalMode,
  copilotAppliedApprovalMode,
  copilotModeAllows,
  copilotPermissionResult,
  copilotPermissionView,
  copilotSessionGrantKey,
} from './copilot-sdk-approval.js';
import {
  type CopilotEventBody,
  CopilotSdkEventTranslator,
} from './copilot-sdk-events.js';
import {
  type CopilotSdkClientFactory,
  type CopilotSdkClientPort,
  type CopilotSdkSessionPort,
  createCopilotSdkClient,
} from './copilot-sdk-port.js';
import { nativeResumeBindingKey } from './native-resume-binding.js';

export const COPILOT_SDK_PREVIEW_ID = 'copilot-sdk-engine';
const COPILOT_SDK_DISPLAY_NAME = 'GitHub Copilot (SDK)';
const PREVIEW_DISABLED_MESSAGE =
  'Turn on GitHub Copilot through the Copilot SDK in Settings → Advanced → Feature previews.';

/** How long an interrupt waits for the runtime's own `session.idle`. */
export const COPILOT_SDK_INTERRUPT_SETTLE_MS = 10_000;
/** How long a model catalogue read may spend starting a runtime. */
const MODEL_CATALOG_TTL_MS = 5 * 60_000;

export const COPILOT_SDK_MODEL_LAUNCH: ModelLaunchCapabilities = {
  defaultAtStart: 'engine-selected',
  omissionAtResume: 'retain-session-model',
  omissionPerTurn: 'retain-session-model',
  overrideAtStart: true,
  overrideAtResume: true,
  overridePerTurn: false,
};

type CopilotLogger = Pick<Logger, 'warn' | 'info'>;

export interface CopilotSdkAdapterOptions {
  /** The `copilot-sdk-engine` preview; selected at every entry point. */
  preview: FeaturePreviewSelector;
  clientFactory?: CopilotSdkClientFactory;
  /** Resolves the Copilot CLI to launch, or `null` when none is installed. */
  resolveCliPath?: () => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  newId?: () => string;
  logger?: CopilotLogger;
  interruptSettleMs?: number;
  /** Only for the readiness tests: replaces running `copilot --version`. */
  findBinary?: (command: string) => string | null;
}

/** The resume cursor this adapter writes and reads. */
interface CopilotResumeCursor {
  copilotSessionId: string;
}

function readResumeCursor(value: unknown): CopilotResumeCursor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as { copilotSessionId?: unknown }).copilotSessionId;
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    ? { copilotSessionId: id }
    : undefined;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (result: PermissionRequestResult) => void;
}

interface ActiveTurn {
  turnId: string;
  settled: Promise<void>;
  settle: () => void;
}

interface CopilotSessionRecord {
  session: ProviderSession;
  client: CopilotSdkClientPort;
  copilot: CopilotSdkSessionPort;
  cwd: string;
  mode: CopilotAppliedApprovalMode;
  grants: Set<string>;
  translator: CopilotSdkEventTranslator;
  pending: Map<string, PendingPermission>;
  activeTurn?: ActiveTurn;
  /** Station turn id → the id of its `user.message` event (the rewind point). */
  rewindPoints: Map<string, string>;
  turnOrder: string[];
  rewinding: boolean;
  /** Events that arrived before the session record existed. */
  early: SessionEvent[] | null;
}

/**
 * On Windows an npm-installed `copilot` is a `.cmd` shim, which the SDK
 * cannot spawn. Its package entry beside it is a `.js` file the SDK runs with
 * Node (`@github/copilot` declares `bin: { copilot: "npm-loader.js" }`).
 */
export function resolveCopilotCliLaunchPath(found: string): string | null {
  if (!/\.(cmd|bat|ps1)$/i.test(found)) return found;
  const entry = join(
    dirname(found),
    'node_modules',
    '@github',
    'copilot',
    'npm-loader.js',
  );
  return existsSync(entry) ? entry : null;
}

function defaultResolveCliPath(): string | null {
  const found =
    managedEngineBinaryPath(PROVIDER_COPILOT_SDK) ?? findCliBinary('copilot');
  return found ? resolveCopilotCliLaunchPath(found) : null;
}

/** The configuration home the runtime keeps sessions in (`COPILOT_HOME`). */
function copilotHome(env: NodeJS.ProcessEnv): string {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

export class CopilotSdkAdapter implements ProviderAdapterShape {
  readonly provider = PROVIDER_COPILOT_SDK;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: COPILOT_SDK_DISPLAY_NAME,
    description:
      'GitHub Copilot through the Copilot SDK, over your installed Copilot CLI (Feature Preview).',
    capabilities: [
      'agent-runtime',
      'session-lifecycle',
      'external-process',
      'approvals',
    ],
    builtin: true,
    engineId: engineId(PROVIDER_COPILOT_SDK),
    durability: STEERING_ENGINE_DURABILITY,
    continuity: {
      resume: 'same-session',
      fork: 'none',
      rewind: 'in-place',
      nativeReturn: 'same-binding',
    },
    modelLaunch: COPILOT_SDK_MODEL_LAUNCH,
    approvalAcknowledgement: 'in-process',
  };

  private readonly events = new AsyncEventQueue<ProviderRuntimeEvent>();
  private readonly sessions = new Map<string, CopilotSessionRecord>();
  private readonly clientFactory: CopilotSdkClientFactory;
  private readonly resolveCliPath: () => string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly interruptSettleMs: number;
  private modelCatalog?: { at: number; models: ModelInfo[] };

  constructor(private readonly options: CopilotSdkAdapterOptions) {
    this.clientFactory = options.clientFactory ?? createCopilotSdkClient;
    this.resolveCliPath = options.resolveCliPath ?? defaultResolveCliPath;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.interruptSettleMs =
      options.interruptSettleMs ?? COPILOT_SDK_INTERRUPT_SETTLE_MS;
  }

  /** Selects the preview now; never cached (also read by native adoption). */
  previewEnabled(): boolean {
    return this.options.preview.select({
      enabled: () => true,
      disabled: () => false,
    });
  }

  private publish(
    threadId: string,
    turnId: string | undefined,
    body: CopilotEventBody,
  ): void {
    const event = {
      eventId: this.newId(),
      provider: this.provider,
      threadId,
      createdAt: this.now().toISOString(),
      ...(turnId ? { turnId } : {}),
      ...body,
    } as ProviderRuntimeEvent;
    // Lets the session's own TMPDIR be removed once its launch has exited.
    stampLaunchExit(event);
    this.events.push(event);
  }

  private bindingKey(): string {
    return nativeResumeBindingKey(
      PROVIDER_COPILOT_SDK,
      copilotHome(this.env),
      null,
    );
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]> {
    if (!this.previewEnabled()) {
      return [
        {
          id: 'copilot-sdk-preview',
          name: 'Feature preview',
          description: PREVIEW_DISABLED_MESSAGE,
          status: 'missing',
          category: 'required',
        } as Prerequisite,
      ];
    }
    const managed = managedEnginePrerequisites(
      PROVIDER_COPILOT_SDK,
      'copilot',
      COPILOT_SDK_DISPLAY_NAME,
    );
    if (managed) return managed;
    return buildCliRuntimePrerequisites({
      command: 'copilot',
      displayName: COPILOT_SDK_DISPLAY_NAME,
      versionArgs: ['--version'],
      ...(this.options.findBinary
        ? { findBinary: this.options.findBinary }
        : {}),
      installStep:
        'Install the GitHub Copilot CLI (https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) and ensure `copilot` is on PATH.',
      authStep:
        'Run `copilot login` on the computer Station runs on, or set COPILOT_GITHUB_TOKEN before starting Station.',
      // The CLI has no read-only sign-in check; a missing sign-in surfaces as
      // the first turn's error.
      detectAuthState: async () => 'unknown',
      unverifiedAuthDescription:
        'Copilot has no sign-in check Station can run; a missing sign-in shows on the first message.',
      signal: options?.signal,
    });
  }

  async preflightStart(input: ProviderSessionStartInput): Promise<void> {
    this.refuseStartUnlessEnabled();
    assertEngineAllowedByManagedPolicy(PROVIDER_COPILOT_SDK);
    if (
      input.resumeCursor !== undefined &&
      input.nativeResumeBindingKey !== undefined &&
      input.nativeResumeBindingKey !== this.bindingKey()
    ) {
      throw new SessionStartRefusedError(
        'This Copilot session was recorded under a different Copilot configuration home.',
        SESSION_RECOVERY_FAILED_CODE,
      );
    }
  }

  private refuseStartUnlessEnabled(): void {
    if (!this.previewEnabled())
      throw new SessionStartRefusedError(
        PREVIEW_DISABLED_MESSAGE,
        FEATURE_PREVIEW_DISABLED_CODE,
      );
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    await this.preflightStart(input);
    if (this.sessions.has(input.threadId))
      throw new Error(`Copilot SDK session already exists: ${input.threadId}`);
    const cliPath = this.resolveCliPath();
    if (!cliPath)
      throw new Error(
        'The GitHub Copilot CLI is not installed or not on PATH. Install it and run `copilot login`.',
      );
    const cwd = input.cwd ?? process.cwd();
    // The session's own TMPDIR, as for every Station-launched engine.
    const sessionTmpDir = engineSessionTmpDir(input.threadId);
    const launch = managedEngineLaunch(
      PROVIDER_COPILOT_SDK,
      {
        command: cliPath,
        args: [],
        env: {
          ...this.env,
          PATH: resolveAugmentedPathSync(),
          TMPDIR: sessionTmpDir ?? ensureEngineSpawnTmpDir(),
        } as Record<string, string | undefined>,
      },
      'station',
    );
    const env = Object.fromEntries(
      Object.entries(childProcessEnvironment(launch.env)).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const client = await this.clientFactory({
      cliPath: launch.command,
      args: launch.args,
      env,
      cwd,
    });
    const threadId = input.threadId;
    const mode = copilotAppliedApprovalMode(
      readApprovalMode(input.modelOptions),
      input.confinement,
    );
    const translator = new CopilotSdkEventTranslator();
    const pending = new Map<string, PendingPermission>();
    // Filled once the session exists; events before that are held.
    let record: CopilotSessionRecord | undefined;
    const early: SessionEvent[] = [];
    const sessionConfig = {
      clientName: 'station',
      workingDirectory: cwd,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      permissionMode: 'manual',
      enableFileChangeTracking: true,
      ...(input.modelId ? { model: input.modelId } : {}),
      onEvent: (event: SessionEvent) => {
        if (!record) {
          early.push(event);
          return;
        }
        this.onSessionEvent(record, event);
      },
      onPermissionRequest: (request: PermissionRequest) =>
        this.onPermissionRequest(threadId, () => record, request),
    } satisfies Partial<SessionConfig> & Partial<ResumeSessionConfig>;
    let copilot: CopilotSdkSessionPort;
    try {
      const cursor = readResumeCursor(input.resumeCursor);
      copilot = cursor
        ? await client.resumeSession(cursor.copilotSessionId, sessionConfig)
        : await client.createSession(sessionConfig);
    } catch (error) {
      await client.stop();
      throw error;
    }
    const createdAt = this.now().toISOString();
    const resumeCursor: CopilotResumeCursor = {
      copilotSessionId: copilot.sessionId,
    };
    record = {
      session: {
        provider: this.provider,
        threadId,
        status: 'ready',
        cwd,
        ...(input.modelId ? { model: input.modelId } : {}),
        resumeCursor,
        createdAt,
        updatedAt: createdAt,
      },
      client,
      copilot,
      cwd,
      mode,
      grants: new Set(),
      translator,
      pending,
      rewindPoints: new Map(),
      turnOrder: [],
      rewinding: false,
      early: null,
    };
    this.sessions.set(threadId, record);
    commitEngineLaunch(
      threadId,
      sessionTmpDir ? { own: sessionTmpDir } : undefined,
    );
    this.publish(threadId, undefined, {
      method: 'session.started',
      sessionId: copilot.sessionId,
    });
    this.publish(threadId, undefined, {
      method: 'session.configured',
      sessionId: copilot.sessionId,
      cwd,
      ...(input.modelId ? { model: input.modelId } : {}),
      metadata: {
        [NATIVE_RESUME_BINDING_METADATA_KEY]: this.bindingKey(),
        approvalMode: mode,
      },
    });
    for (const event of early) this.onSessionEvent(record, event);
    return record.session;
  }

  private requireRecord(threadId: string): CopilotSessionRecord {
    const record = this.sessions.get(threadId);
    if (!record) throw new Error(`No Copilot SDK session: ${threadId}`);
    return record;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    if (!this.previewEnabled())
      throw new SendTurnRefusedError(PREVIEW_DISABLED_MESSAGE, 'unavailable');
    const record = this.requireRecord(input.threadId);
    if (record.rewinding) throw new SessionRewindingError();
    if (record.activeTurn)
      throw new SendTurnRefusedError(
        'A Copilot turn is still running. Wait for it, steer it, or stop it.',
        'busy',
      );
    if (input.attachments?.length)
      throw new SendTurnRefusedError(
        'Attachments are not supported on the Copilot SDK engine yet.',
        'input_unsupported',
      );
    const turnId = this.newId();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    record.activeTurn = { turnId, settled, settle };
    record.session = { ...record.session, status: 'running' };
    this.publish(input.threadId, turnId, {
      method: 'turn.started',
      turnId,
      prompt: input.displayInput ?? input.input,
      ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
    });
    const prompt = input.ambientContext
      ? `${input.ambientContext}\n\n${input.input}`
      : input.input;
    try {
      await record.copilot.send({
        prompt,
        mode: 'enqueue',
        clientTurnId: turnId,
      });
    } catch (error) {
      this.settleTurn(record, {
        method: 'turn.aborted',
        turnId,
        reason: `Copilot did not accept the message: ${errorMessage(error)}`,
      });
      throw error;
    }
    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: record.session.resumeCursor,
    };
  }

  async steerTurn(
    threadId: string,
    input: string,
    turnId: string,
  ): Promise<void> {
    if (!this.previewEnabled())
      throw new SendTurnRefusedError(PREVIEW_DISABLED_MESSAGE, 'unavailable');
    const record = this.requireRecord(threadId);
    if (record.activeTurn?.turnId !== turnId)
      throw new ProviderTurnEndedError();
    const text = input.trim();
    if (!text) throw new Error('Steer input is empty.');
    await record.copilot.send({ prompt: text, mode: 'immediate' });
    this.publish(threadId, turnId, {
      method: 'turn.started',
      turnId,
      prompt: text,
      inputKind: 'steer',
    });
  }

  async interruptTurn(
    threadId: string,
    turnId?: string,
  ): Promise<ProviderInterruptTurnResult> {
    const record = this.sessions.get(threadId);
    const active = record?.activeTurn;
    if (!record || !active) return { outcome: 'no-active-turn' };
    if (turnId && turnId !== active.turnId)
      return { outcome: 'target-mismatch', activeTurnId: active.turnId };
    this.declineOpenRequests(record);
    await record.copilot.abort();
    const confirmed = await Promise.race([
      active.settled.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.interruptSettleMs);
        timer.unref?.();
      }),
    ]);
    return confirmed
      ? { outcome: 'cancelled', turnId: active.turnId }
      : { outcome: 'termination-unconfirmed', turnId: active.turnId };
  }

  private onSessionEvent(
    record: CopilotSessionRecord,
    event: SessionEvent,
  ): void {
    const threadId = record.session.threadId;
    const turnId = record.activeTurn?.turnId;
    if (event.type === 'user.message') {
      const clientTurnId = event.data.clientTurnId;
      if (clientTurnId && !record.rewindPoints.has(clientTurnId)) {
        record.rewindPoints.set(clientTurnId, event.id);
        record.turnOrder.push(clientTurnId);
      }
      return;
    }
    for (const body of record.translator.translate(event, { threadId, turnId }))
      this.publish(threadId, turnId, body);
    if (event.type === 'session.error' && turnId) {
      this.publish(threadId, turnId, {
        method: 'runtime.error',
        ...providerFailureForCode(undefined),
        severity: 'error',
        message: event.data.message,
        code: 'copilot_sdk_session_error',
        details: {
          errorType: event.data.errorType,
          ...(event.data.statusCode !== undefined
            ? { statusCode: event.data.statusCode }
            : {}),
        },
      });
      this.settleTurn(record, {
        method: 'turn.aborted',
        turnId,
        reason: event.data.message,
      });
      return;
    }
    if (event.type === 'session.idle' && turnId) {
      this.settleTurn(
        record,
        event.data.aborted
          ? { method: 'turn.aborted', turnId, reason: 'Interrupted.' }
          : { method: 'turn.completed', turnId, finishReason: 'stop' },
      );
    }
  }

  private settleTurn(
    record: CopilotSessionRecord,
    terminal: Extract<
      CopilotEventBody,
      { method: 'turn.completed' | 'turn.aborted' }
    >,
  ): void {
    const active = record.activeTurn;
    if (!active || active.turnId !== terminal.turnId) return;
    const threadId = record.session.threadId;
    for (const body of record.translator.settleOpenChildren(threadId))
      this.publish(threadId, active.turnId, body);
    record.activeTurn = undefined;
    record.session = {
      ...record.session,
      status: 'ready',
      updatedAt: this.now().toISOString(),
    };
    this.publish(threadId, active.turnId, terminal);
    active.settle();
  }

  private onPermissionRequest(
    threadId: string,
    current: () => CopilotSessionRecord | undefined,
    request: PermissionRequest,
  ): Promise<PermissionRequestResult> | PermissionRequestResult {
    const record = current();
    if (!record) return { kind: 'user-not-available' };
    if (copilotModeAllows(record.mode, request, record.cwd, record.grants))
      return { kind: 'approve-once' };
    const requestId = this.newId();
    const view = copilotPermissionView(request);
    return new Promise<PermissionRequestResult>((resolve) => {
      record.pending.set(requestId, { request, resolve });
      this.publish(threadId, record.activeTurn?.turnId, {
        method: 'request.opened',
        requestId,
        requestType: 'approval',
        blocking: true,
        title: view.title,
        payload: {
          toolName: view.toolName,
          toolKind: view.toolKind,
          toolInput: view.toolInput,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        },
      });
    });
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const record = this.requireRecord(threadId);
    const pending = record.pending.get(requestId);
    if (!pending) throw new Error(`No open Copilot request: ${requestId}`);
    record.pending.delete(requestId);
    if (decision === 'acceptForSession') {
      const key = copilotSessionGrantKey(pending.request);
      if (key) record.grants.add(key);
    }
    pending.resolve(copilotPermissionResult(decision));
    this.publish(threadId, record.activeTurn?.turnId, {
      method: 'request.resolved',
      requestId,
      blocking: true,
      status:
        decision === 'accept' || decision === 'acceptForSession'
          ? 'approved'
          : decision === 'decline'
            ? 'denied'
            : 'cancelled',
      acknowledgement: 'in-process',
    });
  }

  private declineOpenRequests(record: CopilotSessionRecord): void {
    for (const [requestId, pending] of record.pending) {
      pending.resolve({ kind: 'user-not-available' });
      this.publish(record.session.threadId, record.activeTurn?.turnId, {
        method: 'request.resolved',
        requestId,
        blocking: true,
        status: 'cancelled',
        acknowledgement: 'in-process',
      });
    }
    record.pending.clear();
  }

  sessionContinuity(threadId: string): SessionLiveContinuity {
    return {
      live: this.sessions.has(threadId),
      rewind: 'in-place',
      fork: 'none',
    };
  }

  async rewindSession(
    threadId: string,
    turnId: string,
  ): Promise<SessionRewindOutcome> {
    const record = this.sessions.get(threadId);
    if (!record) return { kind: 'refused', reason: 'not-live' };
    if (record.rewinding) return { kind: 'refused', reason: 'rewind-pending' };
    if (record.activeTurn) return { kind: 'refused', reason: 'turn-running' };
    const eventId = record.rewindPoints.get(turnId);
    const index = record.turnOrder.indexOf(turnId);
    if (!eventId || index < 0)
      return { kind: 'refused', reason: 'unknown-turn' };
    record.rewinding = true;
    try {
      const result = await record.copilot.rewind({
        eventId,
        mode: 'conversation-and-files',
      });
      switch (result.outcome) {
        case 'session-busy':
          return { kind: 'refused', reason: 'turn-running' };
        case 'unsupported-remote-session':
          return { kind: 'refused', reason: 'unsupported' };
        case 'success':
        case 'checkpoint-cleanup-failed':
        case 'snapshot-prune-failed': {
          const hiddenTurnIds = record.turnOrder.splice(index);
          for (const hidden of hiddenTurnIds)
            record.rewindPoints.delete(hidden);
          const affectedFiles =
            result.restoredFiles.length > 0
              ? {
                  count: result.restoredFiles.length,
                  paths: result.restoredFiles.slice(
                    0,
                    SESSION_REWIND_AFFECTED_PATHS_MAX,
                  ),
                }
              : undefined;
          this.publish(threadId, undefined, {
            method: 'runtime.warning',
            severity: 'warning',
            code: ACP_SESSION_REWOUND_CODE,
            message: 'Copilot was rewound to before an earlier message.',
            details: {
              beforeTurnId: turnId,
              hiddenTurnIds,
              ...(affectedFiles
                ? { affectedFileCount: affectedFiles.count }
                : {}),
            },
          });
          return {
            kind: 'rewound',
            beforeTurnId: turnId,
            hiddenTurnIds,
            ...(affectedFiles ? { affectedFiles } : {}),
          };
        }
        default:
          // files-rolled-back, rollback-incomplete, truncation-failed,
          // file-change-tracking-disabled: the runtime's own refusal or a
          // partial failure, reported as it gave it.
          return {
            kind: 'failed',
            message: `Copilot could not rewind (${result.outcome})${
              result.error ? `: ${result.error}` : ''
            }.`,
          };
      }
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    } finally {
      record.rewinding = false;
    }
  }

  async reconnectMcpServer(
    threadId: string,
    serverName: string,
    options: { startOAuth: boolean },
  ): Promise<EngineCommandOutcome> {
    const record = this.sessions.get(threadId);
    if (!record)
      return { kind: 'failed', message: 'The session is not running.' };
    // `restartServer` has no sign-in option; a server that needs one reports
    // `needs-auth` again and the engine's own OAuth flow runs from there.
    if (options.startOAuth) return { kind: 'unsupported' };
    try {
      await record.copilot.restartMcpServer(serverName);
      return { kind: 'answered', success: true };
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
  }

  async listModels(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<Array<{ id: string; name: string; originalId: string }>> {
    if (!this.previewEnabled()) return [];
    const models = await this.readModelCatalog(options?.signal);
    return models
      .slice(0, options?.maxEntries ?? models.length)
      .map((model) => ({
        id: model.id,
        name: model.name,
        originalId: model.id,
      }));
  }

  private async readModelCatalog(signal?: AbortSignal): Promise<ModelInfo[]> {
    const cached = this.modelCatalog;
    if (cached && this.now().getTime() - cached.at < MODEL_CATALOG_TTL_MS)
      return cached.models;
    // A live session's runtime answers without a new process.
    const live = this.sessions.values().next().value as
      | CopilotSessionRecord
      | undefined;
    let models: ModelInfo[];
    if (live) {
      models = await live.client.listModels();
    } else {
      assertEngineAllowedByManagedPolicy(PROVIDER_COPILOT_SDK);
      const cliPath = this.resolveCliPath();
      if (!cliPath) return [];
      signal?.throwIfAborted();
      const client = await this.clientFactory({
        cliPath,
        args: [],
        env: Object.fromEntries(
          Object.entries(
            childProcessEnvironment({
              ...this.env,
              PATH: resolveAugmentedPathSync(),
            } as Record<string, string | undefined>),
          ).filter((e): e is [string, string] => typeof e[1] === 'string'),
        ),
        cwd: homedir(),
      });
      try {
        models = await client.listModels();
      } finally {
        await client.stop();
      }
    }
    this.modelCatalog = { at: this.now().getTime(), models };
    return models;
  }

  async stopSession(threadId: string): Promise<void> {
    const record = this.sessions.get(threadId);
    if (!record) return;
    this.sessions.delete(threadId);
    this.declineOpenRequests(record);
    const active = record.activeTurn;
    if (active) {
      await record.copilot.abort().catch(() => undefined);
      this.settleTurn(record, {
        method: 'turn.aborted',
        turnId: active.turnId,
        reason: 'The session stopped.',
      });
    }
    await record.copilot.disconnect().catch(() => undefined);
    const errors = await record.client.stop();
    if (errors.length > 0)
      this.options.logger?.warn('Copilot runtime did not stop cleanly', {
        threadId,
        errors: errors.map((error) => error.message),
      });
    this.publish(threadId, undefined, {
      method: 'session.exited',
      sessionId: record.copilot.sessionId,
      reason: 'stopped',
    });
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((record) => record.session);
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  hasOpenEngineWork(threadId: string): boolean {
    const record = this.sessions.get(threadId);
    return (
      !!record &&
      (record.activeTurn !== undefined ||
        record.translator.openChildIds().length > 0)
    );
  }

  async stopAll(): Promise<void> {
    try {
      await Promise.all(
        [...this.sessions.keys()].map((threadId) => this.stopSession(threadId)),
      );
    } finally {
      this.events.close();
    }
  }

  streamEvents(
    options?: AsyncEventStreamOptions<ProviderRuntimeEvent>,
  ): AsyncIterable<ProviderRuntimeEvent> {
    return this.events.iterable(options);
  }
}
