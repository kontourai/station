/**
 * #4520: `limits.engines`, the managed policy's engine slice. It says which
 * engines may run on the machine and pins how the ones Station launches are
 * started (`binaryPath`, `launchArgs`, `environment`).
 *
 * `./managed-policy.js` registers the slice in its limit-slice list. This
 * module imports nothing from it, so the two never form an import cycle.
 */
import { isRecord, ownMember } from './record-guard.js';
import {
  isRemoteTaskVendorId,
  REMOTE_TASK_VENDOR_IDS,
  type RemoteTaskVendorId,
} from './remote-task-engine.js';

/**
 * Every engine id a policy may name: the built-in adapters Station registers
 * (`runtime-initialize.ts`, `registerProviderAdapters`). A plugin engine has
 * an id outside this list, so an allow list never admits one.
 */
export const MANAGED_POLICY_ENGINE_IDS = [
  'claude',
  'codex',
  'muse',
  'acp',
  'station-agent',
] as const;
export type ManagedPolicyEngineId = (typeof MANAGED_POLICY_ENGINE_IDS)[number];

/**
 * The engines Station starts as a separate program, so the ones whose launch
 * a policy can pin. Station's own agent runs inside Station.
 */
export const MANAGED_POLICY_LAUNCH_ENGINE_IDS = [
  'claude',
  'codex',
  'muse',
  'acp',
] as const;
export type ManagedPolicyLaunchEngineId =
  (typeof MANAGED_POLICY_LAUNCH_ENGINE_IDS)[number];

/** The launch fields an instance entry can pin. */
export const MANAGED_POLICY_ENGINE_LAUNCH_FIELDS = [
  'binaryPath',
  'launchArgs',
  'environment',
] as const;
export type ManagedPolicyEngineLaunchField =
  (typeof MANAGED_POLICY_ENGINE_LAUNCH_FIELDS)[number];

/**
 * How every connection of one engine is launched. `locked: true` makes each
 * pinned field the administrator's (it replaces the user's value); `false`
 * fills only what the user left unset.
 */
export interface ManagedPolicyEngineInstance {
  locked: boolean;
  /** An absolute path; a bare name would be looked up on a PATH the user controls. */
  binaryPath?: string;
  launchArgs?: string[];
  environment?: Record<string, string>;
}

export interface ManagedPolicyEngineLimits {
  /** The only engines that may run. Absent: every engine may. */
  allowed?: ManagedPolicyEngineId[];
  /** `false`: ACP connections added from the public ACP registry do not run. */
  acpRegistryAgents?: false;
  /**
   * `off`: Station issues no credential from its engine host-auth vault to
   * an engine (docs/decisions/engine-credential-provider.md). Engines that
   * keep their own sign-in are unaffected. Absent or `allowed`: issuing works.
   */
  engineHostAuth?: 'allowed' | 'off';
  /**
   * The remote task engine vendors that may be used
   * (docs/decisions/remote-task-engines.md). Unlike every other engine key,
   * absence restricts: on a machine with a managed policy, a vendor this list
   * does not name is off, because a remote task sends prompts and code to
   * another company's machines.
   */
  remoteTasks?: RemoteTaskVendorId[];
  instances?: Partial<
    Record<ManagedPolicyLaunchEngineId, ManagedPolicyEngineInstance>
  >;
}

/**
 * What clients learn about `limits.engines`. Like `lockedSettings`, it names
 * what is managed and never carries a value: launch arguments and
 * environment values can hold a gateway token.
 */
export interface ManagedPolicyEngineSummary {
  /** Null: every engine may run. */
  allowed: ManagedPolicyEngineId[] | null;
  acpRegistryAgents: boolean;
  pinned: ManagedPolicyPinnedEngineSummary[];
}

export interface ManagedPolicyPinnedEngineSummary {
  engine: ManagedPolicyLaunchEngineId;
  locked: boolean;
  fields: ManagedPolicyEngineLaunchField[];
  /** The names of the pinned environment variables, sorted. */
  environmentNames: string[];
}

/**
 * The refusal code for an engine the managed policy does not allow, and for
 * a launch that cannot honor a locked pin (in `./managed-policy-codes.js`,
 * which the provider failure table imports without this module).
 */
export { MANAGED_POLICY_ENGINE_REFUSED_CODE } from './managed-policy-codes.js';

interface EngineProblem {
  path: string;
  message: string;
}

const ENGINE_LIMIT_KEYS = [
  'allowed',
  'acpRegistryAgents',
  'engineHostAuth',
  'remoteTasks',
  'instances',
];
const INSTANCE_KEYS = ['locked', ...MANAGED_POLICY_ENGINE_LAUNCH_FIELDS];
const BINARY_PATH_MAX_CHARS = 1024;
const LAUNCH_ARGS_MAX = 64;
const LAUNCH_ARG_MAX_CHARS = 4096;
const ENVIRONMENT_MAX_ENTRIES = 64;
const ENVIRONMENT_VALUE_MAX_CHARS = 32 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNKNOWN_KEY =
  'unknown key; this version of Station refuses keys it cannot enforce';

function keyPath(parent: string, key: string): string {
  const shown = key.length > 64 ? `${key.slice(0, 64)}…` : key;
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(shown)}]`;
}

function unknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  parent: string,
): EngineProblem[] {
  return Reflect.ownKeys(record)
    .filter((key) => typeof key !== 'string' || !known.includes(key))
    .map((key) => ({
      path: keyPath(parent, String(key)),
      message: UNKNOWN_KEY,
    }));
}

/** POSIX `/…`, or a Windows drive (`C:\…`) or UNC (`\\host\…`) path. */
export function isAbsoluteManagedBinaryPath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

function noControlCharacters(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the check itself.
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function allowedProblems(value: unknown): EngineProblem[] {
  const path = 'limits.engines.allowed';
  if (!Array.isArray(value))
    return [{ path, message: 'must be an array of engine ids' }];
  const seen = new Set<string>();
  const problems: EngineProblem[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (
      typeof entry !== 'string' ||
      !(MANAGED_POLICY_ENGINE_IDS as readonly string[]).includes(entry)
    ) {
      problems.push({
        path: at,
        message: `must be one of ${MANAGED_POLICY_ENGINE_IDS.join(', ')}`,
      });
      return;
    }
    if (seen.has(entry))
      problems.push({ path: at, message: 'repeats an earlier engine' });
    seen.add(entry);
  });
  return problems;
}

function remoteTasksProblems(value: unknown): EngineProblem[] {
  const path = 'limits.engines.remoteTasks';
  if (!Array.isArray(value))
    return [{ path, message: 'must be an array of remote task vendor ids' }];
  const seen = new Set<string>();
  const problems: EngineProblem[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRemoteTaskVendorId(entry)) {
      problems.push({
        path: at,
        message: `must be one of ${REMOTE_TASK_VENDOR_IDS.join(', ')}`,
      });
      return;
    }
    if (seen.has(entry))
      problems.push({ path: at, message: 'repeats an earlier vendor' });
    seen.add(entry);
  });
  return problems;
}

function environmentProblems(value: unknown, path: string): EngineProblem[] {
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  const names = Reflect.ownKeys(value);
  if (names.length > ENVIRONMENT_MAX_ENTRIES)
    return [
      {
        path,
        message: `must set at most ${ENVIRONMENT_MAX_ENTRIES} variables`,
      },
    ];
  const problems: EngineProblem[] = [];
  for (const name of names) {
    const at = keyPath(path, String(name));
    if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name)) {
      problems.push({
        path: at,
        message: 'must be a variable name of letters, digits and underscores',
      });
      continue;
    }
    // Station owns its engines' temporary folder and its own `STATION_*`
    // variables (session attribution, a proxy key); a policy setting one
    // would break the spawn rather than restrict it.
    if (name === 'TMPDIR' || /^STATION_/i.test(name)) {
      problems.push({
        path: at,
        message: 'is set by Station for every engine and cannot be pinned',
      });
      continue;
    }
    const entry = ownMember(value, name);
    if (
      typeof entry !== 'string' ||
      entry.length > ENVIRONMENT_VALUE_MAX_CHARS ||
      entry.includes('\u0000')
    )
      problems.push({
        path: at,
        message: `must be a string of at most ${ENVIRONMENT_VALUE_MAX_CHARS} characters`,
      });
  }
  return problems;
}

function instanceProblems(value: unknown, path: string): EngineProblem[] {
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  const problems = unknownKeys(value, INSTANCE_KEYS, path);
  if (typeof ownMember(value, 'locked') !== 'boolean')
    problems.push({ path: `${path}.locked`, message: 'must be true or false' });
  const binaryPath = ownMember(value, 'binaryPath');
  if (
    binaryPath !== undefined &&
    (typeof binaryPath !== 'string' ||
      binaryPath.length > BINARY_PATH_MAX_CHARS ||
      !noControlCharacters(binaryPath) ||
      !isAbsoluteManagedBinaryPath(binaryPath))
  )
    problems.push({
      path: `${path}.binaryPath`,
      message: `must be an absolute path of at most ${BINARY_PATH_MAX_CHARS} characters; a bare name would be looked up on a PATH each user controls`,
    });
  const launchArgs = ownMember(value, 'launchArgs');
  if (
    launchArgs !== undefined &&
    (!Array.isArray(launchArgs) ||
      launchArgs.length > LAUNCH_ARGS_MAX ||
      !launchArgs.every(
        (arg) =>
          typeof arg === 'string' &&
          arg.length <= LAUNCH_ARG_MAX_CHARS &&
          !arg.includes('\u0000'),
      ))
  )
    problems.push({
      path: `${path}.launchArgs`,
      message: `must be an array of at most ${LAUNCH_ARGS_MAX} strings of at most ${LAUNCH_ARG_MAX_CHARS} characters`,
    });
  const environment = ownMember(value, 'environment');
  if (environment !== undefined)
    problems.push(...environmentProblems(environment, `${path}.environment`));
  if (
    MANAGED_POLICY_ENGINE_LAUNCH_FIELDS.every(
      (field) => ownMember(value, field) === undefined,
    )
  )
    problems.push({
      path,
      message: 'must pin at least one of binaryPath, launchArgs or environment',
    });
  return problems;
}

function instancesProblems(value: unknown, allowed: unknown): EngineProblem[] {
  const path = 'limits.engines.instances';
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  const problems: EngineProblem[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const at = keyPath(path, String(key));
    if (
      typeof key !== 'string' ||
      !(MANAGED_POLICY_LAUNCH_ENGINE_IDS as readonly string[]).includes(key)
    ) {
      problems.push({
        path: at,
        message:
          key === 'station-agent'
            ? "Station's own agent runs inside Station, so there is no launch to pin"
            : `must be one of ${MANAGED_POLICY_LAUNCH_ENGINE_IDS.join(', ')}`,
      });
      continue;
    }
    // An entry for an engine the allow list leaves out never applies; it is
    // more likely a mistake in one of the two than an intent.
    if (Array.isArray(allowed) && !allowed.includes(key))
      problems.push({
        path: at,
        message: 'pins an engine that limits.engines.allowed does not allow',
      });
    problems.push(...instanceProblems(ownMember(value, key), at));
  }
  return problems;
}

/** Problems with `limits.engines`; other limit keys are not checked. */
export function engineLimitProblems(
  limits: Record<string, unknown>,
): EngineProblem[] {
  const engines = ownMember(limits, 'engines');
  if (engines === undefined) return [];
  const path = 'limits.engines';
  if (!isRecord(engines)) return [{ path, message: 'must be an object' }];
  const problems = unknownKeys(engines, ENGINE_LIMIT_KEYS, path);
  const allowed = ownMember(engines, 'allowed');
  if (allowed !== undefined) problems.push(...allowedProblems(allowed));
  const acpRegistryAgents = ownMember(engines, 'acpRegistryAgents');
  if (acpRegistryAgents !== undefined && acpRegistryAgents !== false)
    problems.push({
      path: `${path}.acpRegistryAgents`,
      message:
        'must be false; a policy can stop ACP registry agents from running but never force them on, so omit the key to allow them',
    });
  const engineHostAuth = ownMember(engines, 'engineHostAuth');
  if (
    engineHostAuth !== undefined &&
    engineHostAuth !== 'allowed' &&
    engineHostAuth !== 'off'
  )
    problems.push({
      path: `${path}.engineHostAuth`,
      message: "must be 'allowed' or 'off'",
    });
  const remoteTasks = ownMember(engines, 'remoteTasks');
  if (remoteTasks !== undefined)
    problems.push(...remoteTasksProblems(remoteTasks));
  const instances = ownMember(engines, 'instances');
  if (instances !== undefined)
    problems.push(...instancesProblems(instances, allowed));
  return problems;
}

/** `limits.engines` of a value that passed {@link engineLimitProblems}, copied. */
export function engineLimitsOf(limits: Record<string, unknown>): {
  engines?: ManagedPolicyEngineLimits;
} {
  const engines = ownMember(limits, 'engines');
  if (!isRecord(engines)) return {};
  const copy: ManagedPolicyEngineLimits = {};
  const allowed = ownMember(engines, 'allowed');
  if (Array.isArray(allowed))
    copy.allowed = allowed.filter((id): id is ManagedPolicyEngineId =>
      (MANAGED_POLICY_ENGINE_IDS as readonly unknown[]).includes(id),
    );
  if (ownMember(engines, 'acpRegistryAgents') === false)
    copy.acpRegistryAgents = false;
  const engineHostAuth = ownMember(engines, 'engineHostAuth');
  if (engineHostAuth === 'allowed' || engineHostAuth === 'off')
    copy.engineHostAuth = engineHostAuth;
  const remoteTasks = ownMember(engines, 'remoteTasks');
  if (Array.isArray(remoteTasks))
    copy.remoteTasks = remoteTasks.filter(isRemoteTaskVendorId);
  const instances = ownMember(engines, 'instances');
  if (isRecord(instances)) {
    const pinned: NonNullable<ManagedPolicyEngineLimits['instances']> = {};
    for (const engine of MANAGED_POLICY_LAUNCH_ENGINE_IDS) {
      const entry = ownMember(instances, engine);
      if (!isRecord(entry)) continue;
      const instance: ManagedPolicyEngineInstance = {
        locked: ownMember(entry, 'locked') === true,
      };
      const binaryPath = ownMember(entry, 'binaryPath');
      if (typeof binaryPath === 'string') instance.binaryPath = binaryPath;
      const launchArgs = ownMember(entry, 'launchArgs');
      if (Array.isArray(launchArgs))
        instance.launchArgs = launchArgs.filter(
          (arg): arg is string => typeof arg === 'string',
        );
      const environment = ownMember(entry, 'environment');
      if (isRecord(environment)) {
        const env: Record<string, string> = {};
        for (const name of Object.keys(environment)) {
          const variable = ownMember(environment, name);
          if (typeof variable === 'string') env[name] = variable;
        }
        instance.environment = env;
      }
      pinned[engine] = instance;
    }
    copy.instances = pinned;
  }
  return { engines: copy };
}

/** The value-free client view of `limits.engines`. */
export function summarizeManagedEngineLimits(
  engines: ManagedPolicyEngineLimits | undefined,
): ManagedPolicyEngineSummary {
  return {
    allowed: engines?.allowed ? [...engines.allowed] : null,
    acpRegistryAgents: engines?.acpRegistryAgents !== false,
    pinned: MANAGED_POLICY_LAUNCH_ENGINE_IDS.flatMap((engine) => {
      const instance = engines?.instances?.[engine];
      if (!instance) return [];
      return [
        {
          engine,
          locked: instance.locked,
          fields: MANAGED_POLICY_ENGINE_LAUNCH_FIELDS.filter(
            (field) => instance[field] !== undefined,
          ),
          environmentNames: Object.keys(instance.environment ?? {}).sort(),
        },
      ];
    }),
  };
}

/** Boundary parser for a {@link ManagedPolicyEngineSummary} read from a server. */
export function parseManagedEngineSummary(
  value: unknown,
): ManagedPolicyEngineSummary | null {
  if (!isRecord(value)) return null;
  const { allowed, acpRegistryAgents, pinned } = value;
  if (
    (allowed !== null &&
      (!Array.isArray(allowed) || allowedProblems(allowed).length > 0)) ||
    typeof acpRegistryAgents !== 'boolean' ||
    !Array.isArray(pinned)
  )
    return null;
  const entries: ManagedPolicyPinnedEngineSummary[] = [];
  for (const entry of pinned) {
    if (
      !isRecord(entry) ||
      typeof entry.engine !== 'string' ||
      !(MANAGED_POLICY_LAUNCH_ENGINE_IDS as readonly string[]).includes(
        entry.engine,
      ) ||
      typeof entry.locked !== 'boolean' ||
      !Array.isArray(entry.fields) ||
      !entry.fields.every((field) =>
        (MANAGED_POLICY_ENGINE_LAUNCH_FIELDS as readonly unknown[]).includes(
          field,
        ),
      ) ||
      !Array.isArray(entry.environmentNames) ||
      !entry.environmentNames.every(
        (name) => typeof name === 'string' && ENVIRONMENT_NAME.test(name),
      )
    )
      return null;
    entries.push({
      engine: entry.engine as ManagedPolicyLaunchEngineId,
      locked: entry.locked,
      fields: [...entry.fields] as ManagedPolicyEngineLaunchField[],
      environmentNames: [...(entry.environmentNames as string[])],
    });
  }
  return {
    allowed:
      allowed === null ? null : [...(allowed as ManagedPolicyEngineId[])],
    acpRegistryAgents,
    pinned: entries,
  };
}

/**
 * Whether `engine` may run. Without an allow list every engine may; with
 * one, an id it does not list (a plugin engine included) may not.
 */
export function managedEngineAllowed(
  engines: Pick<ManagedPolicyEngineLimits, 'allowed'> | undefined,
  engine: string,
): boolean {
  const allowed = engines?.allowed as readonly string[] | undefined;
  return !allowed || allowed.includes(engine);
}

/**
 * Whether a remote task engine `vendor` may be used. Without a managed policy
 * every vendor may (the Feature Preview and the per-connection
 * acknowledgement still apply); with one, only a vendor
 * `limits.engines.remoteTasks` names.
 */
export function managedRemoteTaskVendorAllowed(
  policy: { engines?: Pick<ManagedPolicyEngineLimits, 'remoteTasks'> } | null,
  vendor: RemoteTaskVendorId,
): boolean {
  if (!policy) return true;
  return policy.engines?.remoteTasks?.includes(vendor) ?? false;
}

/** The pinned fields of `summary` for `engine`, or null when none are pinned. */
export function managedEnginePin(
  summary: ManagedPolicyEngineSummary | null | undefined,
  engine: string,
): ManagedPolicyPinnedEngineSummary | null {
  return summary?.pinned.find((entry) => entry.engine === engine) ?? null;
}
