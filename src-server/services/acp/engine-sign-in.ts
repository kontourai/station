/**
 * Signing an engine in from Station, using only what the engine itself
 * advertises in a live ACP handshake (ADR 0013: Station never holds, reads or
 * bridges an engine's credentials).
 *
 * - The handshake is a short-lived process that offers `auth.terminal`, so an
 *   engine may list terminal methods. Raw methods (with their `args`/`env`)
 *   stay in this module; only id, name, description and kind leave it.
 * - A terminal method runs the connection's own program with its configured
 *   arguments plus the method's `args`, in a host terminal session a client
 *   can attach to. Exit 0 is the protocol's success signal.
 * - Any other method is passed to ACP `authenticate` on its own short-lived
 *   process. https links the engine prints to stderr meanwhile are shown to
 *   the person; nothing here opens them.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { AuthMethod, AuthMethodTerminal } from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type {
  EngineSignInAttempt,
  EngineSignInMethod,
  EngineSubscriptionTermsNotice,
} from '@kontourai/station-contracts/engine-sign-in';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import type {
  TerminalEvent,
  TerminalOpenInput,
} from '../../domain/terminal-types.js';
import {
  findCliBinaryAsync,
  resolveAugmentedPath,
} from '../../providers/auth/cli-auth.js';
import { sanitizeConnectionEnvMap } from '../connections/connection-env.js';
import { ensureEngineSpawnTmpDir } from '../infra/engine-spawn-tmpdir.js';
import {
  registryAuthFor,
  registryLaunchEnvFor,
} from './acp-engine-descriptors.js';
import { createAcpInboundExtensionRequestHandler } from './acp-inbound-extension-policy.js';
import { createProbeClient } from './acp-probe.js';
import { ACPProcess, type ACPProcessOptions } from './acp-process.js';
import {
  invalidateEngineStatus,
  recordEngineAuthenticated,
} from './engine-auth-status.js';
import { engineCredentialEnvFor } from './engine-credentials.js';

/** Terminal sessions for sign-ins live under this project slug, which no Project can take. */
export const ENGINE_SIGN_IN_TERMINAL_PROJECT = '.engine-sign-in';
export const SIGN_IN_HANDSHAKE_TIMEOUT_MS = 30_000;
export const SIGN_IN_METHODS_TTL_MS = 5 * 60_000;
export const AGENT_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const TERMINAL_SIGN_IN_TIMEOUT_MS = 15 * 60_000;
/** How long a finished attempt stays readable. */
const FINISHED_ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_LIVE_ATTEMPTS = 4;
const MAX_LINKS = 3;
const MAX_LINK_LENGTH = 2048;
const MAX_STDERR_SCAN = 64 * 1024;
const MAX_TERMINAL_ARGS = 32;
const MAX_TERMINAL_ARG_LENGTH = 1024;

export class EngineSignInError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429 | 502 | 503 = 400,
  ) {
    super(message);
  }
}

class EngineSignInDeadlineError extends EngineSignInError {}

/** The terminal surface this module needs; `TerminalService` satisfies it. */
export interface SignInTerminalHost {
  open(input: TerminalOpenInput): Promise<{ sessionId: string }>;
  close(sessionId: string): Promise<void>;
  subscribe(cb: (event: TerminalEvent) => void): () => void;
}

interface MethodsObservation {
  key: string;
  at: number;
  methods?: AuthMethod[];
  error?: string;
}

interface LiveAttempt {
  view: EngineSignInAttempt;
  connectionId: string;
  finish: (
    state: Exclude<EngineSignInAttempt['state'], 'running'>,
    message?: string,
  ) => void;
  cancel: () => void;
  finishedAt?: number;
}

type ProcessFactory = (options: ACPProcessOptions) => ACPProcess;

const logger = {
  debug: () => undefined,
  warn: () => undefined,
};

function connectionKey(config: ACPConnectionConfig): string {
  return JSON.stringify([config.command, config.args ?? []]);
}

function isTerminalMethod(
  method: AuthMethod,
): method is AuthMethodTerminal & { type: 'terminal' } {
  return 'type' in method && method.type === 'terminal';
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = [...value]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
    })
    .join('')
    .trim();
  return text.length > 0 ? text.slice(0, max) : undefined;
}

/** https links in engine output, deduplicated, never anything else. */
export function linksIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https:\/\/[^\s"'<>`]+/g)) {
    const raw = match[0].replace(/[).,;:\]]+$/, '');
    if (raw.length > MAX_LINK_LENGTH) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      const href = url.toString();
      if (!found.includes(href)) found.push(href);
    } catch {
      // Not a URL.
    }
  }
  return found;
}

function errorText(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return redactSecrets(
    boundedText(message, 300) ?? 'The engine did not say why.',
  );
}

function termsNoticeFor(
  config: ACPConnectionConfig,
  methodId: string | undefined,
): EngineSubscriptionTermsNotice | undefined {
  const notices = registryAuthFor(config)?.auth.subscriptionTermsNotices ?? [];
  const notice = notices.find((candidate) =>
    methodId === undefined
      ? candidate.authMethodIds === undefined
      : candidate.authMethodIds?.includes(methodId),
  );
  return notice
    ? { provider: notice.provider, termsUrl: notice.termsUrl }
    : undefined;
}

export class EngineSignInService {
  readonly #methods = new Map<string, MethodsObservation>();
  readonly #attempts = new Map<string, LiveAttempt>();
  readonly #terminal: SignInTerminalHost | null;
  readonly #processFactory: ProcessFactory;
  readonly #now: () => number;
  readonly #timeouts: {
    handshake: number;
    agent: number;
    terminal: number;
  };

  constructor(options: {
    terminal: SignInTerminalHost | null;
    processFactory?: ProcessFactory;
    now?: () => number;
    timeouts?: Partial<{ handshake: number; agent: number; terminal: number }>;
  }) {
    this.#terminal = options.terminal;
    this.#processFactory =
      options.processFactory ?? ((opts) => new ACPProcess(opts));
    this.#now = options.now ?? Date.now;
    this.#timeouts = {
      handshake: options.timeouts?.handshake ?? SIGN_IN_HANDSHAKE_TIMEOUT_MS,
      agent: options.timeouts?.agent ?? AGENT_SIGN_IN_TIMEOUT_MS,
      terminal: options.timeouts?.terminal ?? TERMINAL_SIGN_IN_TIMEOUT_MS,
    };
  }

  get terminalAvailable(): boolean {
    return this.#terminal !== null;
  }

  #spawn(
    config: ACPConnectionConfig,
    onStderr?: (text: string) => void,
  ): ACPProcess {
    return this.#processFactory({
      command: config.command,
      args: config.args,
      cwd: ensureEngineSpawnTmpDir(),
      launchEnv: registryLaunchEnvFor(config),
      credentialEnv: () => engineCredentialEnvFor(config),
      createClient: () =>
        createProbeClient(
          createAcpInboundExtensionRequestHandler({
            connectionId: `sign-in:${config.id}`,
          }),
        ),
      // No filesystem or tool terminal: only the ability to run a terminal
      // login, which is what this process exists to discover.
      clientCapabilities: { auth: { terminal: true } },
      ...(onStderr ? { onStderr } : {}),
      logger,
    });
  }

  async #withDeadline<T>(
    work: Promise<T>,
    ms: number,
    what: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new EngineSignInDeadlineError(
                  `The engine did not ${what} within ${Math.round(ms / 1000)} seconds.`,
                  502,
                ),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Runs a fresh sign-in handshake and keeps what it advertised. */
  async refreshMethods(config: ACPConnectionConfig): Promise<void> {
    const process = this.#spawn(config);
    const key = connectionKey(config);
    try {
      const init = await this.#withDeadline(
        process.start(),
        this.#timeouts.handshake,
        'answer',
      );
      this.#methods.set(config.id, {
        key,
        at: this.#now(),
        methods: Array.isArray(init.authMethods) ? init.authMethods : [],
      });
    } catch (error) {
      this.#methods.set(config.id, {
        key,
        at: this.#now(),
        error: errorText(error),
      });
    } finally {
      await process.destroy().catch(() => undefined);
    }
  }

  #observation(config: ACPConnectionConfig): MethodsObservation | undefined {
    const observed = this.#methods.get(config.id);
    return observed && observed.key === connectionKey(config)
      ? observed
      : undefined;
  }

  /** The advertised methods Station offers, as the person sees them. */
  methodsView(config: ACPConnectionConfig): {
    methods?: EngineSignInMethod[];
    observedAt?: string;
    error?: string;
  } {
    const observed = this.#observation(config);
    if (!observed) return {};
    const observedAt = new Date(observed.at).toISOString();
    if (!observed.methods) return { observedAt, error: observed.error };
    const hidden = new Set(registryAuthFor(config)?.auth.hiddenAuthMethodIds);
    const methods: EngineSignInMethod[] = [];
    for (const method of observed.methods) {
      const id = boundedText(method?.id, 256);
      const name = boundedText(method?.name, 256);
      if (!id || !name || hidden.has(id)) continue;
      const description = boundedText(method.description, 1024);
      const termsNotice = termsNoticeFor(config, id);
      methods.push({
        id,
        name,
        ...(description ? { description } : {}),
        kind: isTerminalMethod(method) ? 'terminal' : 'agent',
        ...(termsNotice ? { termsNotice } : {}),
      });
      if (methods.length >= 32) break;
    }
    return { methods, observedAt };
  }

  /** A raw advertised method from a handshake no older than the TTL, refreshed if needed. */
  async #liveMethod(
    config: ACPConnectionConfig,
    methodId: string,
  ): Promise<AuthMethod> {
    let observed = this.#observation(config);
    if (
      !observed?.methods ||
      this.#now() - observed.at > SIGN_IN_METHODS_TTL_MS
    ) {
      await this.refreshMethods(config);
      observed = this.#observation(config);
    }
    if (!observed?.methods)
      throw new EngineSignInError(
        observed?.error ?? 'The engine did not answer.',
        502,
      );
    const hidden = registryAuthFor(config)?.auth.hiddenAuthMethodIds ?? [];
    const method = observed.methods.find(
      (candidate) => candidate?.id === methodId,
    );
    if (!method || hidden.includes(methodId))
      throw new EngineSignInError(
        'The engine does not offer that sign-in.',
        404,
      );
    return method;
  }

  attempt(connectionId: string): EngineSignInAttempt | null {
    const live = this.#attempts.get(connectionId);
    if (!live) return null;
    if (
      live.finishedAt !== undefined &&
      this.#now() - live.finishedAt > FINISHED_ATTEMPT_TTL_MS
    ) {
      this.#attempts.delete(connectionId);
      return null;
    }
    return {
      ...live.view,
      ...(live.view.links ? { links: [...live.view.links] } : {}),
    };
  }

  cancel(connectionId: string): void {
    const live = this.#attempts.get(connectionId);
    if (live?.view.state === 'running') live.cancel();
  }

  #claim(connectionId: string): void {
    if (this.#attempts.get(connectionId)?.view.state === 'running')
      throw new EngineSignInError(
        'A sign-in for this engine is already running.',
        409,
      );
    const live = [...this.#attempts.values()].filter(
      (attempt) => attempt.view.state === 'running',
    ).length;
    if (live >= MAX_LIVE_ATTEMPTS)
      throw new EngineSignInError(
        'Too many sign-ins are running. Finish one first.',
        429,
      );
  }

  #register(
    connectionId: string,
    view: EngineSignInAttempt,
    cancel: () => void,
    onFinish: () => void,
  ): LiveAttempt {
    const live: LiveAttempt = {
      view,
      connectionId,
      cancel,
      finish: (state, message) => {
        if (live.view.state !== 'running') return;
        live.view = { ...live.view, state, ...(message ? { message } : {}) };
        live.finishedAt = this.#now();
        if (state === 'succeeded') recordEngineAuthenticated(connectionId);
        else invalidateEngineStatus(connectionId);
        onFinish();
      },
    };
    this.#attempts.set(connectionId, live);
    return live;
  }

  /** Runs a terminal method in a host terminal session. */
  async startTerminal(
    config: ACPConnectionConfig,
    methodId: string,
  ): Promise<EngineSignInAttempt> {
    const terminal = this.#terminal;
    if (!terminal)
      throw new EngineSignInError(
        'Terminals are not available on this Station.',
        503,
      );
    this.#claim(config.id);
    const method = await this.#liveMethod(config, methodId);
    if (!isTerminalMethod(method))
      throw new EngineSignInError('That sign-in does not run in a terminal.');
    const extra = Array.isArray(method.args) ? method.args : [];
    if (
      extra.length > MAX_TERMINAL_ARGS ||
      !extra.every(
        (arg) =>
          typeof arg === 'string' &&
          arg.length <= MAX_TERMINAL_ARG_LENGTH &&
          !arg.includes('\u0000'),
      )
    )
      throw new EngineSignInError(
        'The engine sent a sign-in Station cannot run.',
        502,
      );
    const program = await findCliBinaryAsync(config.command);
    if (!program)
      throw new EngineSignInError(
        `Station could not find ${config.command}.`,
        404,
      );
    const path = await resolveAugmentedPath();
    // Recheck: the steps above awaited, and another request may have
    // started a sign-in meanwhile.
    this.#claim(config.id);

    const env: Record<string, string> = {
      PATH: path,
      ...registryLaunchEnvFor(config),
      ...engineCredentialEnvFor(config),
      // The protocol: method variables override the launch configuration.
      ...sanitizeConnectionEnvMap(method.env),
    };
    const terminalId = `${config.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${randomUUID()}`;
    const view: EngineSignInAttempt = {
      id: randomUUID(),
      methodId,
      kind: 'terminal',
      state: 'running',
      startedAt: new Date(this.#now()).toISOString(),
      terminal: { projectSlug: ENGINE_SIGN_IN_TERMINAL_PROJECT, terminalId },
    };
    let sessionId: string | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const close = () => {
      if (sessionId) void terminal.close(sessionId).catch(() => undefined);
    };
    const live = this.#register(
      config.id,
      view,
      () => {
        live.finish('cancelled');
        close();
      },
      () => {
        if (deadline) clearTimeout(deadline);
        unsubscribe?.();
      },
    );
    const expectedSessionId = `${ENGINE_SIGN_IN_TERMINAL_PROJECT}:${terminalId}`;
    unsubscribe = terminal.subscribe((event) => {
      if (event.type !== 'exited' || event.sessionId !== expectedSessionId)
        return;
      live.finish(
        event.exitCode === 0 ? 'succeeded' : 'failed',
        event.exitCode === 0
          ? undefined
          : `The sign-in ended with exit code ${event.exitCode}.`,
      );
    });
    try {
      const snapshot = await terminal.open({
        projectSlug: ENGINE_SIGN_IN_TERMINAL_PROJECT,
        terminalId,
        cwd: homedir(),
        cols: 100,
        rows: 30,
        shell: program,
        shellArgs: [...(config.args ?? []), ...extra],
        env,
      });
      sessionId = snapshot.sessionId;
    } catch (error) {
      live.finish('failed', errorText(error));
      throw new EngineSignInError(
        'Station could not open a terminal for this sign-in.',
        503,
      );
    }
    if (live.view.state === 'running') {
      deadline = setTimeout(() => {
        live.finish('timed-out');
        close();
      }, this.#timeouts.terminal);
      deadline.unref?.();
    }
    return { ...live.view };
  }

  /** Passes an agent method to ACP `authenticate` on a short-lived process. */
  async startAgent(
    config: ACPConnectionConfig,
    methodId: string,
  ): Promise<EngineSignInAttempt> {
    this.#claim(config.id);
    const method = await this.#liveMethod(config, methodId);
    if (isTerminalMethod(method))
      throw new EngineSignInError('That sign-in runs in a terminal.');
    this.#claim(config.id);

    let scanned = 0;
    const view: EngineSignInAttempt = {
      id: randomUUID(),
      methodId,
      kind: 'agent',
      state: 'running',
      startedAt: new Date(this.#now()).toISOString(),
    };
    const process = this.#spawn(config, (text) => {
      if (scanned >= MAX_STDERR_SCAN) return;
      scanned += text.length;
      const current = live.view.links ?? [];
      const links = [...current];
      for (const link of linksIn(text))
        if (!links.includes(link) && links.length < MAX_LINKS) links.push(link);
      if (links.length !== current.length) live.view = { ...live.view, links };
    });
    const live = this.#register(
      config.id,
      view,
      () => live.finish('cancelled'),
      () => void process.destroy().catch(() => undefined),
    );
    void (async () => {
      try {
        await this.#withDeadline(
          process.start(),
          this.#timeouts.handshake,
          'answer',
        );
        await this.#withDeadline(
          process.authenticate(methodId),
          this.#timeouts.agent,
          'finish signing in',
        );
        live.finish('succeeded');
      } catch (error) {
        if (live.view.state !== 'running') return;
        if (error instanceof EngineSignInDeadlineError)
          live.finish('timed-out');
        else live.finish('failed', errorText(error));
      }
    })();
    return { ...live.view };
  }

  /** The note that applies to the engine's sign-in as a whole. */
  engineTermsNotice(config: ACPConnectionConfig) {
    return termsNoticeFor(config, undefined);
  }

  forget(connectionId: string): void {
    this.cancel(connectionId);
    this.#methods.delete(connectionId);
    this.#attempts.delete(connectionId);
  }

  dispose(): void {
    for (const live of this.#attempts.values())
      if (live.view.state === 'running') live.cancel();
  }
}
