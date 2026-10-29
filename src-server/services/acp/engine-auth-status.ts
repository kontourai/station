/**
 * Whether an engine reached through a local command is signed in (#1940),
 * from two kinds of evidence, in this order:
 *
 * 1. The engine's documented status command, from its built-in descriptor,
 *    read by that descriptor's rule. argv only (no shell), bounded in time
 *    and output, killed at the deadline. An exit code alone never reads as
 *    signed in unless the rule says the vendor documents that.
 * 2. What the engine itself said: refusing a chat with ACP `auth_required`
 *    (signed out), or finishing a Station-started sign-in the way the
 *    protocol defines success (signed in, as the engine reports it).
 *
 * A session that merely starts is not evidence: some engines accept
 * `session/new` and refuse only at the first prompt.
 */

import { RequestError } from '@agentclientprotocol/sdk';
import type { ACPEngineAuthStatusRule } from '@kontourai/station-contracts/acp';
import type {
  EngineSignInSource,
  EngineSignInState,
  EngineSignInStatus,
} from '@kontourai/station-contracts/engine-sign-in';
import {
  type CliCommandResult,
  findCliBinaryAsync,
  runCliCommand,
} from '../../providers/auth/cli-auth.js';
import {
  namesSameExecutable,
  registryAuthFor,
  registryLaunchEnvFor,
} from './acp-engine-descriptors.js';
import { engineCredentialEnvFor } from './engine-credentials.js';

/**
 * ACP's `auth_required` error, in the exact shape the ACP SDK's
 * `RequestError.authRequired` builds: code -32000 and a message beginning
 * "Authentication required". The code alone is not enough: -32000 opens
 * JSON-RPC's generic server-error range.
 */
const ACP_AUTH_REQUIRED = RequestError.authRequired();

export function isAcpAuthRequired(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === ACP_AUTH_REQUIRED.code &&
    typeof message === 'string' &&
    message.startsWith(ACP_AUTH_REQUIRED.message)
  );
}

const ENGINE_STATUS_COMMAND_TIMEOUT_MS = 8_000;
const ENGINE_STATUS_COMMAND_MAX_OUTPUT = 64 * 1024;
/** How long a status command's answer is reused before it runs again. */
const ENGINE_STATUS_TTL_MS = 60_000;

interface ConnectionLike {
  id: string;
  command: string;
  args?: string[];
}

function executionKey(connection: ConnectionLike): string {
  return JSON.stringify([connection.command, connection.args ?? []]);
}

function jsonField(stdout: string, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one finished status command. Exported for the rule's own tests. */
export function readStatusCommandResult(
  result: CliCommandResult | null,
  rule: ACPEngineAuthStatusRule,
): EngineSignInState {
  if (!result || result.timedOut || result.outputTruncated) return 'unknown';
  if (rule.signedInJsonField) {
    const field = jsonField(result.stdout, rule.signedInJsonField);
    if (field === false) return 'unauthenticated';
    if (field === true && result.code === 0) return 'authenticated';
  }
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const mentions = (fragments: readonly string[] | undefined) =>
    (fragments ?? []).some((fragment) =>
      output.includes(fragment.toLowerCase()),
    );
  if (mentions(rule.signedOutText)) return 'unauthenticated';
  if (
    result.code !== null &&
    (rule.signedOutExitCodes ?? []).includes(result.code)
  )
    return 'unauthenticated';
  if (result.code !== 0) return 'unknown';
  if (mentions(rule.signedInText)) return 'authenticated';
  if (rule.exitZeroMeansSignedIn === true) return 'authenticated';
  return 'unknown';
}

export type StatusCommandRunner = (
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
) => Promise<CliCommandResult | null>;

let timeoutMs = ENGINE_STATUS_COMMAND_TIMEOUT_MS;
const defaultRunner: StatusCommandRunner = (command, args, env) =>
  runCliCommand(command, args, undefined, env, {
    timeoutMs,
    maxBuffer: ENGINE_STATUS_COMMAND_MAX_OUTPUT,
    killSignal: 'SIGKILL',
  });

interface Observation {
  state: EngineSignInState;
  source: EngineSignInSource;
  at: number;
}

const commandResults = new Map<
  string,
  { key: string; observation: Observation | null }
>();
const inFlight = new Map<
  string,
  { key: string; promise: Promise<Observation | null> }
>();
const engineEvidence = new Map<
  string,
  { key: string; observation: Observation }
>();
let runner: StatusCommandRunner = defaultRunner;
let now: () => number = Date.now;

/** Test seams: the command runner and the clock. */
export function setEngineStatusTestHooks(hooks: {
  runner?: StatusCommandRunner;
  now?: () => number;
  timeoutMs?: number;
}): void {
  runner = hooks.runner ?? defaultRunner;
  now = hooks.now ?? Date.now;
  timeoutMs = hooks.timeoutMs ?? ENGINE_STATUS_COMMAND_TIMEOUT_MS;
}

export function resetEngineAuthStatus(): void {
  commandResults.clear();
  inFlight.clear();
  engineEvidence.clear();
}

/** The engine refused a chat because it needs a sign-in. */
export function recordEngineSignInRefused(connection: ConnectionLike): void {
  engineEvidence.set(connection.id, {
    key: executionKey(connection),
    observation: { state: 'unauthenticated', source: 'refusal', at: now() },
  });
  invalidateEngineStatus(connection.id);
}

/** A Station-started sign-in succeeded (`authenticate` answered, or the terminal login exited 0). */
export function recordEngineAuthenticated(connection: ConnectionLike): void {
  engineEvidence.set(connection.id, {
    key: executionKey(connection),
    observation: { state: 'authenticated', source: 'sign-in', at: now() },
  });
  invalidateEngineStatus(connection.id);
}

/**
 * The engine answered a prompt, so an earlier refusal no longer describes it
 * (the person may have signed in outside Station). Clears only a refusal;
 * an answer is not itself sign-in evidence.
 */
export function clearEngineSignInRefusal(connection: ConnectionLike): void {
  const evidence = engineEvidence.get(connection.id);
  if (
    evidence?.key === executionKey(connection) &&
    evidence.observation.source === 'refusal'
  )
    engineEvidence.delete(connection.id);
}

/** Forget a cached status-command answer so the next read runs it again. */
export function invalidateEngineStatus(connectionId: string): void {
  commandResults.delete(connectionId);
  inFlight.delete(connectionId);
}

/** Retire observations when a connection is removed or its invocation changes. */
export function forgetEngineAuthStatus(connectionId: string): void {
  invalidateEngineStatus(connectionId);
  engineEvidence.delete(connectionId);
}

async function statusCommandFor(
  connection: ConnectionLike,
): Promise<{ command: string; args: string[] } | null> {
  const descriptor = registryAuthFor(connection);
  const argv = descriptor?.auth.statusCommand;
  if (!descriptor || !argv || argv.length === 0 || !descriptor.auth.statusRule)
    return null;
  const [argv0, ...args] = argv as [string, ...string[]];
  // The engine's own program: run the binary this connection launches (it
  // may be a full path), not whatever else on PATH shares the name.
  const program = namesSameExecutable(argv0, descriptor.command)
    ? connection.command
    : argv0;
  const resolved = await findCliBinaryAsync(program);
  return resolved ? { command: resolved, args } : null;
}

async function runStatusCommand(
  connection: ConnectionLike,
): Promise<Observation | null> {
  const auth = registryAuthFor(connection)?.auth;
  const rule = auth?.statusRule;
  const target = await statusCommandFor(connection);
  if (!rule || !target) return null;
  const credentials = engineCredentialEnvFor(connection) ?? {};
  const env = { ...registryLaunchEnvFor(connection), ...credentials };
  const result = await runner(
    target.command,
    target.args,
    Object.keys(env).length > 0 ? env : undefined,
  );
  const state = readStatusCommandResult(result, rule);
  // No vendor documents its status command reading a key from the
  // environment, so with one present "signed out" is not established.
  const keyPresent = (auth.credentialEnvVars ?? []).some(
    (name) => !!(credentials[name] ?? process.env[name]),
  );
  return {
    state: state === 'unauthenticated' && keyPresent ? 'unknown' : state,
    source: 'status-command',
    at: now(),
  };
}

/** Whether the connection's engine has a status command Station may run. */
export function engineStatusCheckable(connection: ConnectionLike): boolean {
  const auth = registryAuthFor(connection)?.auth;
  return !!auth?.statusCommand?.length && !!auth.statusRule;
}

async function commandObservation(
  connection: ConnectionLike,
  refresh: boolean,
): Promise<Observation | null> {
  // A changed command means a different program; never reuse its answer.
  const key = executionKey(connection);
  const cached = commandResults.get(connection.id);
  if (
    !refresh &&
    cached &&
    cached.key === key &&
    (cached.observation === null ||
      now() - cached.observation.at < ENGINE_STATUS_TTL_MS)
  )
    return cached.observation;
  const pending = inFlight.get(connection.id);
  if (pending?.key === key) return pending.promise;
  const run = runStatusCommand(connection)
    .catch(() => null)
    .then((observation) => {
      if (inFlight.get(connection.id)?.promise !== run) return null;
      commandResults.set(connection.id, { key, observation });
      return observation;
    })
    .finally(() => {
      if (inFlight.get(connection.id)?.promise === run)
        inFlight.delete(connection.id);
    });
  inFlight.set(connection.id, { key, promise: run });
  return run;
}

/**
 * The connection's sign-in status. `refresh` reruns the status command
 * instead of reusing an answer younger than {@link ENGINE_STATUS_TTL_MS}.
 * `commandOnly` leaves out what the engine said: readiness gates chats on
 * this answer, and a refusal is cleared only by a later answered prompt, so
 * gating on it could keep a person who signed in elsewhere locked out.
 */
export async function engineSignInStatus(
  connection: ConnectionLike,
  options: { refresh?: boolean; commandOnly?: boolean } = {},
): Promise<EngineSignInStatus> {
  const checkable = engineStatusCheckable(connection);
  const fromCommand = checkable
    ? await commandObservation(connection, options.refresh === true)
    : null;
  const evidence = engineEvidence.get(connection.id);
  const chosen =
    fromCommand && fromCommand.state !== 'unknown'
      ? fromCommand
      : options.commandOnly
        ? null
        : evidence?.key === executionKey(connection)
          ? evidence.observation
          : null;
  if (!chosen) return { state: 'unknown', source: 'none', checkable };
  return {
    state: chosen.state,
    source: chosen.source,
    observedAt: new Date(chosen.at).toISOString(),
    checkable,
  };
}
