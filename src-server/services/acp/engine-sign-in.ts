/**
 * Signing an engine in from Station, using only what the engine itself
 * advertises in a live ACP handshake, or a reviewed built-in login whose
 * required flag was observed in the installed CLI's help. Credentials stay
 * in the engine's own store.
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
import { basename } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type {
  AuthMethod,
  AuthMethodTerminal,
} from '@agentclientprotocol/sdk/unstable';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type {
  EngineSignInAttempt,
  EngineSignInMethod,
  EngineSubscriptionTermsNotice,
} from '@kontourai/station-contracts/engine-sign-in';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import {
  findCliBinaryAsync,
  resolveAugmentedPath,
  runCliCommand,
} from '../../providers/auth/cli-auth.js';
import { managedEngineLaunch } from '../../security/managed-engine-limits.js';
import { sanitizeConnectionEnvMap } from '../connections/connection-env.js';
import { ensureEngineSpawnTmpDir } from '../infra/engine-spawn-tmpdir.js';
import {
  registryAuthFor,
  registryLaunchEnvFor,
} from './acp-engine-descriptors.js';
import { createAcpInboundExtensionRequestHandler } from './acp-inbound-extension-policy.js';
import { createProbeClient } from './acp-probe.js';
import { ACPProcess, type ACPProcessOptions } from './acp-process.js';
import { antigravityOutcomeProfile } from './antigravity-prompt-outcome.js';
import {
  engineSignInStatus,
  forgetEngineAuthStatus,
  forgetSharedEngineAccountStatus,
  invalidateEngineStatus,
  recordEngineAuthenticated,
} from './engine-auth-status.js';
import { engineCredentialEnvFor } from './engine-credentials.js';

/** Terminal sessions for sign-ins live under this project slug, which no Project can take. */
export const ENGINE_SIGN_IN_TERMINAL_PROJECT = '.engine-sign-in';
/** The terminal scope a client attaches to a sign-in under; no Project has this id. */
export const ENGINE_SIGN_IN_TERMINAL_SCOPE = {
  projectId: ENGINE_SIGN_IN_TERMINAL_PROJECT,
  bindingKey: 'engine-sign-in',
} as const;
const SIGN_IN_HANDSHAKE_TIMEOUT_MS = 30_000;
const SIGN_IN_METHODS_TTL_MS = 5 * 60_000;
const AGENT_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_SIGN_IN_TIMEOUT_MS = 15 * 60_000;
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

/**
 * The terminal surface this module needs: a server-owned launch in
 * `TerminalSessions` under {@link ENGINE_SIGN_IN_TERMINAL_SCOPE}, which a
 * client attaches to by id through the terminal socket.
 */
export interface SignInTerminalHost {
  open(input: {
    cwd: string;
    cols: number;
    rows: number;
    launch: { file: string; args: string[]; env: Record<string, string> };
  }): Promise<{
    terminalId: string;
    exited: Promise<{ exitCode: number | null }>;
  }>;
  close(terminalId: string): Promise<void>;
  readSignInOutput?(terminalId: string): Promise<string>;
}

interface MethodsObservation {
  cliMethods?: Array<
    AuthMethodTerminal & { type: 'terminal'; operation?: 'sign-out' }
  >;
  key: string;
  at: number;
  methods?: AuthMethod[];
  error?: string;
}

interface LiveAttempt {
  view: EngineSignInAttempt;
  connectionId: string;
  accountScope?: string;
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
function linksIn(text: string): string[] {
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
  readonly #generations = new Map<string, { key: string }>();
  #disposed = false;
  readonly #methods = new Map<string, MethodsObservation>();
  readonly #attempts = new Map<string, LiveAttempt>();
  readonly #terminal: SignInTerminalHost | null;
  readonly #processFactory: ProcessFactory;
  readonly #now: () => number;
  readonly #accountActionsEnabled: () => boolean;
  readonly #timeouts: {
    handshake: number;
    agent: number;
    terminal: number;
  };

  constructor(options: {
    terminal: SignInTerminalHost | null;
    processFactory?: ProcessFactory;
    accountActionsEnabled?: () => boolean;
    now?: () => number;
    timeouts?: Partial<{ handshake: number; agent: number; terminal: number }>;
  }) {
    this.#terminal = options.terminal;
    this.#accountActionsEnabled =
      options.accountActionsEnabled ?? (() => false);
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
      connection: config,
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

  #generation(config: ACPConnectionConfig): { key: string } {
    if (this.#disposed)
      throw new EngineSignInError('Sign-in has stopped.', 409);
    const key = connectionKey(config);
    let generation = this.#generations.get(config.id);
    if (generation?.key !== key) {
      generation = { key };
      this.#generations.set(config.id, generation);
    }
    return generation;
  }

  #requireCurrent(
    config: ACPConnectionConfig,
    generation: { key: string },
  ): void {
    if (this.#disposed || this.#generations.get(config.id) !== generation)
      throw new EngineSignInError(
        'This sign-in was cancelled or its connection changed.',
        409,
      );
  }

  /** Runs a fresh sign-in handshake and keeps what it advertised. */
  async refreshMethods(config: ACPConnectionConfig): Promise<void> {
    const generation = this.#generation(config);
    const process = this.#spawn(config);
    const key = connectionKey(config);
    try {
      const init = await this.#withDeadline(
        process.start(),
        this.#timeouts.handshake,
        'answer',
      );
      this.#requireCurrent(config, generation);
      this.#methods.set(config.id, {
        key,
        at: this.#now(),
        methods: Array.isArray(init.authMethods) ? init.authMethods : [],
      });
    } catch (error) {
      this.#requireCurrent(config, generation);
      this.#methods.set(config.id, {
        key,
        at: this.#now(),
        error: errorText(error),
      });
    } finally {
      await process.destroy().catch(() => undefined);
    }
    const auth = registryAuthFor(config)?.auth;
    const account = this.#accountActionsEnabled()
      ? auth?.terminalAccount
      : undefined;
    const choices = [
      ...(auth?.terminalLogin ? [auth.terminalLogin] : []),
      ...(account?.signInMethods ?? []),
      ...(account ? [account.signOut] : []),
    ];
    const helpByArgs = new Map<string, string>();
    const cliMethods: NonNullable<MethodsObservation['cliMethods']> = [];
    for (const binding of choices) {
      const key = JSON.stringify(binding.helpArgs);
      if (!helpByArgs.has(key)) {
        const help = await runCliCommand(
          config.command,
          binding.helpArgs,
          undefined,
          registryLaunchEnvFor(config),
          { timeoutMs: 8_000, maxBuffer: 64 * 1024 },
        );
        this.#requireCurrent(config, generation);
        helpByArgs.set(
          key,
          help?.code === 0 && !help.timedOut && !help.outputTruncated
            ? `${help.stdout}\n${help.stderr}`
            : '',
        );
      }
      const help = helpByArgs.get(key);
      if (
        help?.includes(binding.requiredHelpText) &&
        binding.args.every((arg) => !arg.startsWith('--') || help.includes(arg))
      ) {
        cliMethods.push({
          id: binding.id,
          name: binding.name,
          type: 'terminal',
          args: [...binding.args],
          ...(binding === account?.signOut
            ? { operation: 'sign-out' as const }
            : {}),
        });
      }
    }
    if (cliMethods.length > 0) {
      const observed = this.#methods.get(config.id);
      this.#methods.set(config.id, {
        ...observed,
        key,
        at: this.#now(),
        methods: observed?.methods ?? [],
        cliMethods,
      });
    }
  }

  #cliMethods(config: ACPConnectionConfig) {
    const legacy = registryAuthFor(config)?.auth.terminalLogin?.id;
    return (this.#observation(config)?.cliMethods ?? []).filter(
      (method) => method.id === legacy || this.#accountActionsEnabled(),
    );
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
    const auth = registryAuthFor(config)?.auth;
    const hidden = new Set(auth?.hiddenAuthMethodIds);
    if (auth?.terminalAccount) {
      hidden.add(auth.terminalAccount.signOut.id);
      for (const method of auth.terminalAccount.signInMethods)
        hidden.add(method.id);
    }
    const cliMethods = this.#cliMethods(config);
    for (const method of cliMethods) hidden.add(method.id);
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
    methods.unshift(
      ...cliMethods.map(({ id, name, operation }) => ({
        id,
        name,
        kind: 'terminal' as const,
        ...(operation ? { operation } : {}),
      })),
    );
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
    const auth = registryAuthFor(config)?.auth;
    const hidden = auth?.hiddenAuthMethodIds ?? [];
    const cliMethod = this.#cliMethods(config).find(
      (candidate) => candidate.id === methodId,
    );
    const account = auth?.terminalAccount;
    const reserved =
      account?.signOut.id === methodId ||
      account?.signInMethods.some((candidate) => candidate.id === methodId);
    const method =
      cliMethod ??
      (reserved
        ? undefined
        : observed.methods.find((candidate) => candidate?.id === methodId));
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

  async attemptWithTerminalLinks(
    config: ACPConnectionConfig,
  ): Promise<EngineSignInAttempt | null> {
    const attempt = this.attempt(config.id);
    if (
      !attempt?.terminal ||
      attempt.state !== 'running' ||
      !this.#terminal?.readSignInOutput ||
      !this.#cliMethods(config).some(
        (method) =>
          method.id === attempt.methodId && method.operation !== 'sign-out',
      )
    )
      return attempt;
    const output = await this.#terminal
      .readSignInOutput(attempt.terminal.terminalId)
      .catch(() => '');
    const current = this.attempt(config.id);
    if (current?.id !== attempt.id || current.state !== 'running')
      return current;
    const links = linksIn(stripVTControlCharacters(output)).slice(0, MAX_LINKS);
    return links.length ? { ...current, links } : current;
  }

  cancel(connectionId: string): void {
    this.#generations.delete(connectionId);
    const live = this.#attempts.get(connectionId);
    if (live?.view.state === 'running') live.cancel();
  }

  #claim(config: ACPConnectionConfig): void {
    const scope = registryAuthFor(config)?.auth.terminalAccount?.scope;
    if (
      [...this.#attempts.values()].some(
        (attempt) =>
          attempt.view.state === 'running' &&
          (attempt.connectionId === config.id ||
            (scope !== undefined && attempt.accountScope === scope)),
      )
    )
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
    config: ACPConnectionConfig,
    generation: { key: string },
    view: EngineSignInAttempt,
    cancel: () => void,
    onFinish: () => void,
  ): LiveAttempt {
    const live: LiveAttempt = {
      view,
      connectionId: config.id,
      accountScope: registryAuthFor(config)?.auth.terminalAccount?.scope,
      cancel,
      finish: (state, message) => {
        if (live.view.state !== 'running') return;
        if (
          state === 'succeeded' &&
          this.#generations.get(config.id) !== generation
        )
          state = 'cancelled';
        live.view = { ...live.view, state, ...(message ? { message } : {}) };
        live.finishedAt = this.#now();
        if (
          view.operation === 'sign-out' ||
          (state === 'succeeded' && live.accountScope)
        )
          forgetSharedEngineAccountStatus(config.id);
        if (state === 'succeeded' && view.operation !== 'sign-out')
          recordEngineAuthenticated(config);
        else invalidateEngineStatus(config.id);
        onFinish();
      },
    };
    this.#attempts.set(config.id, live);
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
    const generation = this.#generation(config);
    this.#claim(config);
    const method = await this.#liveMethod(config, methodId);
    const reviewedMethod = this.#cliMethods(config).find(
      (candidate) => candidate === method,
    );
    const signOut = reviewedMethod?.operation === 'sign-out';
    if (reviewedMethod) {
      const before = await engineSignInStatus(config, {
        refresh: true,
        commandOnly: true,
      });
      if (!signOut && before.state === 'authenticated')
        throw new EngineSignInError(
          'This engine is already signed in. Sign out before switching accounts.',
          409,
        );
      const required = signOut ? 'authenticated' : 'unauthenticated';
      if (before.state !== required)
        throw new EngineSignInError(
          signOut
            ? 'Station could not verify an active sign-in.'
            : 'Station could not verify that this engine is signed out.',
          409,
        );
    }
    this.#requireCurrent(config, generation);
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
    this.#requireCurrent(config, generation);
    if (reviewedMethod && !this.#cliMethods(config).includes(reviewedMethod))
      throw new EngineSignInError(
        'This account action is no longer available.',
        409,
      );
    // Recheck: the steps above awaited, and another request may have
    // started a sign-in meanwhile.
    this.#claim(config);

    const env: Record<string, string> = {
      PATH: path,
      ...registryLaunchEnvFor(config),
      ...engineCredentialEnvFor(config),
    };
    const configuredArgs = config.args ?? [];
    // The protocol: method variables override the launch configuration.
    const methodEnv = sanitizeConnectionEnvMap(method.env);
    let profile: ReturnType<typeof antigravityOutcomeProfile>;
    if (
      !reviewedMethod &&
      basename(program) === 'agy' &&
      extra.length === 1 &&
      extra[0] === '--login'
    ) {
      const launch = managedEngineLaunch(
        'acp',
        {
          command: config.command,
          args: configuredArgs,
          env: { ...process.env, ...env },
        },
        'user',
      );
      const geminiHome = launch.env.GEMINI_HOME;
      try {
        profile = antigravityOutcomeProfile({
          command: config.command,
          args: configuredArgs,
          geminiHome,
        });
      } catch (error) {
        throw new EngineSignInError(errorText(error), 409);
      }
      if (geminiHome !== undefined) methodEnv.GEMINI_HOME = geminiHome;
    }
    const view: EngineSignInAttempt = {
      id: randomUUID(),
      methodId,
      kind: 'terminal',
      ...(signOut ? { operation: 'sign-out' as const } : {}),
      state: 'running',
      startedAt: new Date(this.#now()).toISOString(),
    };
    let terminalId: string | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (terminalId) void terminal.close(terminalId).catch(() => undefined);
    };
    const live = this.#register(
      config,
      generation,
      view,
      () => {
        live.finish('cancelled');
        close();
      },
      () => {
        if (deadline) clearTimeout(deadline);
      },
    );
    try {
      const opened = await terminal.open({
        cwd: homedir(),
        cols: 100,
        rows: 30,
        launch: {
          file: program,
          args: reviewedMethod
            ? extra
            : [...configuredArgs, ...(profile?.args ?? []), ...extra],
          env: { ...env, ...methodEnv },
        },
      });
      terminalId = opened.terminalId;
      void opened.exited
        .then(async ({ exitCode }) => {
          if (live.view.state !== 'running') return;
          if (exitCode === 0 && reviewedMethod) {
            invalidateEngineStatus(config.id);
            const status = await engineSignInStatus(config, {
              refresh: true,
              commandOnly: true,
            });
            const expected = signOut ? 'unauthenticated' : 'authenticated';
            live.finish(
              status.state === expected ? 'succeeded' : 'failed',
              status.state === expected
                ? undefined
                : signOut
                  ? 'The engine did not confirm sign-out.'
                  : 'The engine did not confirm sign-in.',
            );
            return;
          }
          live.finish(
            exitCode === 0 ? 'succeeded' : 'failed',
            exitCode === 0
              ? undefined
              : `The ${signOut ? 'sign-out' : 'sign-in'} ended with exit code ${exitCode ?? 'unknown'}.`,
          );
        })
        .catch(() =>
          live.finish('failed', 'The engine could not confirm sign-in.'),
        );
      if (live.view.state === 'running')
        live.view = {
          ...live.view,
          terminal: {
            projectSlug: ENGINE_SIGN_IN_TERMINAL_PROJECT,
            ...ENGINE_SIGN_IN_TERMINAL_SCOPE,
            terminalId,
          },
        };
      else close();
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
    const generation = this.#generation(config);
    this.#claim(config);
    const method = await this.#liveMethod(config, methodId);
    this.#requireCurrent(config, generation);
    if (isTerminalMethod(method))
      throw new EngineSignInError('That sign-in runs in a terminal.');
    this.#claim(config);

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
      config,
      generation,
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
        if (live.view.state !== 'running') return;
        this.#requireCurrent(config, generation);
        await this.#withDeadline(
          process.authenticate(methodId),
          this.#timeouts.agent,
          'finish signing in',
        );
        if (live.view.state !== 'running') return;
        this.#requireCurrent(config, generation);
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
    forgetEngineAuthStatus(connectionId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#generations.clear();
    for (const live of this.#attempts.values())
      if (live.view.state === 'running') live.cancel();
  }
}

let registeredSignIn: EngineSignInService | null = null;

/**
 * Route composition installs the instance's service so removing a connection
 * and stopping Station can end its running sign-ins; tests install their own.
 */
export function registerEngineSignIn(service: EngineSignInService | null) {
  registeredSignIn = service;
}

export function engineSignIn(): EngineSignInService | null {
  return registeredSignIn;
}
