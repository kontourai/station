/**
 * #4520: the managed policy's engine slice (`limits.engines`), as every
 * enforcement seam reads it. `main()` installs the policy it loaded before
 * any engine is started.
 *
 * Two jobs:
 *
 * - The allow list. A disallowed engine starts no session, runs no turn and
 *   gets no new connection; each refusal is a {@link ManagedEngineRefusedError}
 *   (`managed-policy-engine-refused`, answered as a 403).
 * - Pinned launch fields. Every engine spawn passes its launch through
 *   {@link managedEngineLaunch}, so a pinned binary, argument list and
 *   environment reach the child whichever path started it.
 */
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import { managedPolicyDenial } from '@kontourai/station-contracts/managed-policy';
import {
  MANAGED_POLICY_ENGINE_REFUSED_CODE,
  type ManagedPolicyEngineInstance,
  type ManagedPolicyEngineLimits,
  managedEngineAllowed,
} from '@kontourai/station-contracts/managed-policy-engines';
import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';
import { SendTurnRefusedError } from '../providers/adapter-shape.js';

let installedEngines: ManagedPolicyEngineLimits | undefined;
let installedSummary: ManagedPolicySummary | null = null;

/** Install the policy `main()` loaded (null: none). Tests reset with null. */
export function installManagedEngineLimits(
  policy: Pick<LoadedManagedPolicy, 'document' | 'summary'> | null,
): void {
  installedEngines = policy?.document.limits?.engines;
  installedSummary = policy?.summary ?? null;
}

/**
 * Refused before anything was started, so a `SendTurnRefusedError`: the
 * dispatch records the command as rejected and forwards the code, and every
 * route answers it with 403.
 */
class ManagedEngineRefusedError extends SendTurnRefusedError {
  readonly code = MANAGED_POLICY_ENGINE_REFUSED_CODE;
  readonly status = 403;

  constructor(message: string) {
    super(message, 'permission_denied');
    this.name = 'ManagedEngineRefusedError';
  }
}

export function isManagedEngineRefusal(error: unknown): boolean {
  return (
    error instanceof ManagedEngineRefusedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === MANAGED_POLICY_ENGINE_REFUSED_CODE)
  );
}

function denial(subject: string): string {
  if (!installedSummary) return `A managed policy manages ${subject}.`;
  return managedPolicyDenial(installedSummary, subject);
}

/**
 * The policy id of an adapter's provider or engine id. Station's own agent
 * is the provider `station-agent` and the engine `station`
 * (`station-agent-adapter.ts`); a policy names it `station-agent`.
 */
function managedPolicyEngineId(engine: string): string {
  return engine === 'station' ? 'station-agent' : engine;
}

/** Whether the policy lets `engine` run (no allow list: every engine may). */
export function engineAllowedByManagedPolicy(engine: string): boolean {
  return managedEngineAllowed(installedEngines, managedPolicyEngineId(engine));
}

/** False when the policy sets `limits.engines.acpRegistryAgents: false`. */
function acpRegistryAgentsAllowedByManagedPolicy(): boolean {
  return installedEngines?.acpRegistryAgents !== false;
}

/**
 * Throws when `engine` may not run, or when it is an ACP connection added
 * from the public ACP registry and the policy stops those.
 */
export function assertEngineAllowedByManagedPolicy(
  engine: string,
  connection?: { publicRegistry?: unknown },
): void {
  if (!engineAllowedByManagedPolicy(engine))
    throw new ManagedEngineRefusedError(
      denial(
        `which engines run on this computer: ${managedPolicyEngineId(engine)} is not allowed`,
      ),
    );
  if (
    engine === 'acp' &&
    connection?.publicRegistry !== undefined &&
    !acpRegistryAgentsAllowedByManagedPolicy()
  )
    throw new ManagedEngineRefusedError(
      denial(
        'which engines run on this computer: agents added from the public ACP registry are not allowed',
      ),
    );
}

/** The JSON body a route answers a managed engine refusal with (status 403). */
export function managedEngineRefusalBody(error: unknown) {
  return {
    success: false as const,
    code: MANAGED_POLICY_ENGINE_REFUSED_CODE,
    error:
      error instanceof Error
        ? error.message
        : denial('which engines run on this computer'),
    kind: 'permission_denied' as const,
    retryable: false as const,
    failurePhase: 'refused' as const,
  };
}

/** The policy's launch entry for `engine`, if it pins one. */
export function managedEnginePin(
  engine: string,
): ManagedPolicyEngineInstance | undefined {
  const instances = installedEngines?.instances as
    | Record<string, ManagedPolicyEngineInstance | undefined>
    | undefined;
  return instances?.[engine];
}

/**
 * Whether the administrator owns `engine`'s launch environment: a locked
 * entry that pins `environment`. The connection's own `env`, `configHome`
 * and model-proxy routing are then not applied, because each one points the
 * engine at configuration or an endpoint the user chose.
 */
export function managedEngineEnvironmentLocked(engine: string): boolean {
  const pin = managedEnginePin(engine);
  return pin?.locked === true && pin.environment !== undefined;
}

/**
 * The pinned executable for an engine whose executable Station chooses
 * (Claude, Codex, Muse: found by name on the PATH). The user names none, so
 * a pin applies whether or not it is locked.
 */
export function managedEngineBinaryPath(engine: string): string | undefined {
  return managedEnginePin(engine)?.binaryPath;
}

export interface EngineLaunch<Env> {
  command: string;
  args: readonly string[];
  env: Env;
}

/**
 * One engine spawn with the policy's pinned fields merged in. `owner` says
 * whose the command and arguments are:
 *
 * - `station`: Station chose them (Claude, Codex, Muse). A pinned binary
 *   replaces the command, and pinned arguments follow Station's own.
 * - `user`: the connection's (an ACP command and its arguments). A locked
 *   pin replaces each field it sets; an unlocked one fills only a field the
 *   connection left empty (an ACP connection always names a command, so an
 *   unlocked `binaryPath` never replaces it).
 *
 * Environment, for both: a locked variable overrides every other layer; an
 * unlocked one fills only a variable the launch does not already set. On
 * Windows a variable's name is case-insensitive and a child gets only one of
 * `HTTPS_PROXY` and `https_proxy` (Node keeps the first in its sorted,
 * case-insensitive order), so there a locked variable removes every
 * case-variant before it sets its own, and an unlocked one fills only when
 * no case-variant is set. `platform` is injectable for tests.
 */
export function managedEngineLaunch<
  Env extends Record<string, string | undefined>,
>(
  engine: string,
  launch: EngineLaunch<Env>,
  owner: 'station' | 'user',
  platform: NodeJS.Platform = process.platform,
) {
  const pin = managedEnginePin(engine);
  if (!pin) return launch;
  let { command, args } = launch;
  if (pin.binaryPath !== undefined && (owner === 'station' || pin.locked))
    command = pin.binaryPath;
  if (pin.launchArgs !== undefined) {
    if (owner === 'station') args = [...args, ...pin.launchArgs];
    else if (pin.locked || args.length === 0) args = [...pin.launchArgs];
  }
  let env = launch.env;
  if (pin.environment !== undefined) {
    const fold =
      platform === 'win32'
        ? (name: string) => name.toUpperCase()
        : (name: string) => name;
    const next: Record<string, string | undefined> = { ...launch.env };
    for (const [name, value] of Object.entries(pin.environment)) {
      const variants = Object.keys(next).filter(
        (key) => fold(key) === fold(name),
      );
      if (pin.locked) {
        for (const key of variants) delete next[key];
        next[name] = value;
      } else if (variants.every((key) => next[key] === undefined)) {
        next[name] = value;
      }
    }
    env = next as Env;
  }
  return { command, args, env };
}

/**
 * The refusal for a launch that would not run the pinned binary (for
 * example Claude falling back to the copy bundled with its SDK because the
 * pinned path is missing).
 */
export function managedEngineLaunchRefusal(
  engine: string,
  reason: string,
): ManagedEngineRefusedError {
  return new ManagedEngineRefusedError(
    denial(`how ${engine} is launched: ${reason}`),
  );
}
