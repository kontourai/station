import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConfinementFallbackReason,
  ConfinementLevel,
  ConfinementMechanism,
  ConfinementPlan,
  ConfinementPolicyBasis,
  ConfinementPosture,
  ConfinementRefusalCode,
  ConfinementWorkspaceAccess,
  ConfinementWriteGrant,
  ExecutionConfinementRecord,
} from '@kontourai/station-contracts/execution-confinement';
import type {
  ApprovalMode,
  StationConfinement,
} from '@kontourai/station-contracts/provider';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import { SessionStartRefusedError } from '../../providers/adapter-shape.js';

/**
 * #2494: one interface for every confinement mechanism. See
 * docs/design/approval-posture-server-ordered.md#410-confinement-providers-2494.
 */

/**
 * What a provider is handed: the spawn it confines and what it may reach.
 * Every path is absolute and symlink-resolved by whoever builds the spec;
 * a provider matches paths as given.
 *
 * - `writable`: directory trees the process may write (and read).
 * - `writableFiles`: single files it may write, matched exactly (a branch
 *   ref, its lock and its log), never as a tree.
 * - `writeDenied`: trees or files inside a writable grant that stay
 *   read-only; these win over every grant.
 * - `writeDeniedExact`: paths denied exactly, not as a tree (a directory
 *   that may not be removed, renamed or replaced while its contents stay
 *   writable).
 * - `writeDeniedNames`: directory names (a single path segment, matched
 *   case-insensitively) that may not be created, written, renamed or
 *   replaced at any depth inside any writable grant.
 * - `hidden`: trees or files the process may not read at all.
 * - `readable`: trees inside a hidden one that stay readable (the writable
 *   grants are readable without being listed here).
 */
export interface ConfinementSpawnSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  grants: {
    writable: readonly string[];
    readable: readonly string[];
    writableFiles?: readonly string[];
    writeDenied?: readonly string[];
    writeDeniedExact?: readonly string[];
    writeDeniedNames?: readonly string[];
    hidden?: readonly string[];
  };
  network: 'none' | 'loopback' | 'full';
}

/**
 * A posture not yet known: the provider derives it from what the STARTED
 * process (or its engine) reports. Configuration is never evidence, so
 * nothing here can return `confined` before there is something to observe.
 */
export interface PendingConfinementPosture<Evidence> {
  observe(evidence: Evidence | undefined): ConfinementPosture;
}

export interface ConfinedSpawn<Evidence> {
  spec: ConfinementSpawnSpec;
  pending: PendingConfinementPosture<Evidence>;
}

export type ConfinementAvailability =
  | { available: true; reason: string }
  | { available: false; reason: string };

export interface ConfinementProvider<Evidence = unknown> {
  readonly level: Exclude<ConfinementLevel, 'host'>;
  readonly mechanism: ConfinementMechanism;
  readonly workspaceAccess: ConfinementWorkspaceAccess;
  /** The isolation modes this provider can run a session in. */
  readonly supportedIsolationModes: readonly WorkspaceIsolationMode[];
  /**
   * - `engine-native`: the engine applies it from its own protocol settings,
   *   and reports what it applied; `confine` leaves the spawn as it is.
   * - `spawn-wrapper`: `confine` rewrites the spawn itself.
   */
  readonly engagement: 'engine-native' | 'spawn-wrapper';
  /** The engines whose sessions it can confine; absent is every engine. */
  readonly engines?: readonly EngineId[];
  /** Whether it can apply on this host, and why. */
  availability(): ConfinementAvailability;
  confine(spec: ConfinementSpawnSpec): ConfinedSpawn<Evidence>;
}

const LEVEL_RANK: Readonly<Record<ConfinementLevel, number>> = {
  host: 0,
  'os-profile': 1,
  container: 2,
  microvm: 3,
};

/** What each level needs on this host, for a refusal that names it. */
function expectedMechanism(
  level: ConfinementLevel,
  platform: NodeJS.Platform,
): string {
  switch (level) {
    case 'os-profile':
      return platform === 'darwin'
        ? 'a macOS Seatbelt profile'
        : platform === 'linux'
          ? 'a bubblewrap or Landlock profile'
          : `an operating-system sandbox for ${platform}`;
    case 'container':
      return 'a container runtime';
    case 'microvm':
      return 'a microVM runtime';
    case 'host':
      return 'nothing';
  }
}

/**
 * A definitive refusal to start: a `SessionStartRefusedError`, so the start
 * boundary settles it (the thread is not fenced as indeterminate, and its
 * next start is admitted) and the command outcome is `rejected`, with the
 * typed code carried to the caller.
 */
export class ConfinementRefusedError extends SessionStartRefusedError {
  declare readonly code: ConfinementRefusalCode;

  constructor(code: ConfinementRefusalCode, message: string) {
    super(message, code);
    this.name = 'ConfinementRefusedError';
  }
}

/**
 * The level a start's policy requires (owner decisions 2026-09-24 and
 * 2026-10-18 on #2494). Full access means no prompts inside the
 * confinement, so a `workspace` start whose engine will actually run at
 * `never` requires an `os-profile` mechanism. Every other start requires
 * `host`, and is recorded honestly as such.
 *
 * `appliedMode` is the mode the engine is given, after
 * `ApprovalPosture.resolve`: an engine with no mechanism at all (ACP) has
 * already had a `workspace` `never` lowered to `auto` there, so it requires
 * nothing here. Codex and Claude keep `never` and require `os-profile`.
 */
export function requiredConfinementLevel(
  confinement: StationConfinement,
  appliedMode: ApprovalMode | undefined,
): ConfinementLevel {
  return confinement === 'workspace' && appliedMode === 'never'
    ? 'os-profile'
    : 'host';
}

export interface ConfinementResolutionInput {
  confinement: StationConfinement;
  engine: EngineId;
  appliedMode: ApprovalMode | undefined;
  isolationMode: WorkspaceIsolationMode;
  providers: readonly ConfinementProvider[];
  platform?: NodeJS.Platform;
}

export interface ConfinementResolution {
  /** Present exactly when a mechanism is engaged for this start. */
  plan?: ConfinementPlan;
  requiredLevel: ConfinementLevel;
  policyBasis: ConfinementPolicyBasis;
}

/**
 * Whether `provider` can run a session in `mode`. A copied provider never
 * pairs with `shared`: shared means writing the live checkout, which a
 * provider with its own filesystem cannot do, whatever it declares.
 */
function workspaceCompatible(
  provider: ConfinementProvider,
  mode: WorkspaceIsolationMode,
): boolean {
  return (
    provider.supportedIsolationModes.includes(mode) &&
    !(provider.workspaceAccess === 'copied' && mode === 'shared')
  );
}

function planFor(
  provider: ConfinementProvider,
  requiredLevel: ConfinementLevel,
  policyBasis: ConfinementPolicyBasis,
): ConfinementPlan {
  return {
    requiredLevel,
    policyBasis,
    mechanism: provider.mechanism,
    level: provider.level,
    workspaceAccess: provider.workspaceAccess,
  };
}

/**
 * #2494: the confinement a start resolves to, before anything starts.
 *
 * - Not required: an engine-native mechanism that applies to this engine is
 *   still engaged and observed (Codex's sandbox runs in every confined
 *   mode), so its record says what Codex reported. With none, no mechanism.
 * - Required: the first provider of at least the required level that is
 *   available, can run this workspace isolation, and that this start path
 *   can engage: an engine-native provider, or a spawn-wrapper that names
 *   this engine (its adapter is the one that wraps the spawn, as the Claude
 *   adapter does for Seatbelt). A spawn-wrapper naming no engine is refused
 *   rather than resolved and silently not applied. With none, the start is
 *   refused (fail closed) and the refusal names the missing mechanism.
 */
export function resolveConfinement(
  input: ConfinementResolutionInput,
): ConfinementResolution {
  const policyBasis: ConfinementPolicyBasis =
    input.confinement === 'host' ? 'operator-policy' : 'workspace-floor';
  const requiredLevel = requiredConfinementLevel(
    input.confinement,
    input.appliedMode,
  );
  const applicable = input.providers.filter(
    (provider) => !provider.engines || provider.engines.includes(input.engine),
  );
  if (requiredLevel === 'host') {
    const native = applicable.find(
      (provider) =>
        provider.engagement === 'engine-native' &&
        provider.availability().available &&
        workspaceCompatible(provider, input.isolationMode),
    );
    return {
      requiredLevel,
      policyBasis,
      ...(native ? { plan: planFor(native, requiredLevel, policyBasis) } : {}),
    };
  }
  const reasons: string[] = [];
  let incompatible = false;
  for (const provider of applicable) {
    if (LEVEL_RANK[provider.level] < LEVEL_RANK[requiredLevel]) continue;
    const availability = provider.availability();
    if (!availability.available) {
      reasons.push(`${provider.mechanism}: ${availability.reason}`);
      continue;
    }
    if (!workspaceCompatible(provider, input.isolationMode)) {
      incompatible = true;
      reasons.push(
        `${provider.mechanism}: a ${provider.workspaceAccess} provider cannot run a ${input.isolationMode} workspace`,
      );
      continue;
    }
    if (
      provider.engagement !== 'engine-native' &&
      !provider.engines?.includes(input.engine)
    ) {
      reasons.push(
        `${provider.mechanism}: no start path applies a spawn-wrapped confinement for ${input.engine}`,
      );
      continue;
    }
    return {
      requiredLevel,
      policyBasis,
      plan: planFor(provider, requiredLevel, policyBasis),
    };
  }
  const missing = expectedMechanism(
    requiredLevel,
    input.platform ?? process.platform,
  );
  const detail = reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
  throw incompatible
    ? new ConfinementRefusedError(
        'confinement_workspace_incompatible',
        `This ${input.engine} session requires ${requiredLevel} confinement, and no ${requiredLevel} mechanism can run its ${input.isolationMode} workspace${detail}. Nothing started.`,
      )
    : new ConfinementRefusedError(
        'confinement_mechanism_unavailable',
        `This ${input.engine} session requires ${requiredLevel} confinement, which needs ${missing}; none is available to it on this host${detail}. Nothing started.`,
      );
}

/** The record a start with no engaged mechanism writes before it starts. */
export function noMechanismConfinementRecord(
  resolution: Pick<ConfinementResolution, 'requiredLevel' | 'policyBasis'>,
): ExecutionConfinementRecord {
  return {
    level: 'host',
    required: resolution.requiredLevel !== 'host',
    posture: 'no-mechanism',
    workspaceAccess: 'mounted',
    policyBasis: resolution.policyBasis,
  };
}

/**
 * The record of a start whose plan engaged a mechanism, from the posture its
 * provider derived from the engine's report. It says only what happened: a
 * start where nothing was engaged is `host` / `no-mechanism` with no
 * mechanism named, required or not. A required one is still refused
 * (`assertRequiredConfinementObserved`), because its posture is not
 * `confined`.
 */
export function observedConfinementRecord(
  plan: ConfinementPlan,
  observed: ConfinementPosture,
  writeGrants?: readonly ConfinementWriteGrant[],
): ExecutionConfinementRecord {
  const required = plan.requiredLevel !== 'host';
  if (observed === 'no-mechanism')
    return {
      level: 'host',
      required,
      posture: observed,
      workspaceAccess: 'mounted',
      policyBasis: plan.policyBasis,
    };
  return {
    level: plan.level,
    required,
    posture: observed,
    mechanism: plan.mechanism,
    workspaceAccess: plan.workspaceAccess,
    policyBasis: plan.policyBasis,
    ...(writeGrants ? { writeGrants: [...writeGrants] } : {}),
  };
}

/**
 * #2494: the record of a start whose plan asked for confinement but which
 * ran with none engaged, at a lower approval mode, for `reason`. Not
 * required (the mode the engine runs at no longer requires it), and
 * `no-mechanism`: nothing confines it.
 */
export function fallbackConfinementRecord(
  plan: Pick<ConfinementPlan, 'policyBasis'>,
  reason: ConfinementFallbackReason,
): ExecutionConfinementRecord {
  return {
    level: 'host',
    required: false,
    posture: 'no-mechanism',
    workspaceAccess: 'mounted',
    policyBasis: plan.policyBasis,
    fallback: reason,
  };
}

/** Whether a required start may proceed: only once reported `confined`. */
export function assertRequiredConfinementObserved(
  record: ExecutionConfinementRecord,
  engine: EngineId,
  /** What the engine reported instead, and how to fix it, when known. */
  detail?: string,
): void {
  if (record.required && record.posture !== 'confined')
    throw new ConfinementRefusedError(
      'confinement_not_observed',
      `This ${engine} session requires ${record.level} confinement, but the started engine did not report it applied (${record.posture}). ${detail ? `${detail} ` : ''}The session was not started.`,
    );
}

const LEVELS = new Set<string>(Object.keys(LEVEL_RANK));
const POSTURES = new Set<string>([
  'confined',
  'no-mechanism',
  'configured-but-failed',
]);
const MECHANISMS = new Set<string>(['codex-sandbox', 'seatbelt']);
const WRITE_GRANTS = new Set<string>([
  'workspace',
  'git-worktree',
  'git-objects',
  'git-branch-ref',
  'station-temp',
  'station-config',
]);
const FALLBACKS = new Set<string>([
  'confined-credential-unavailable',
  'config-root-pinned',
  'resume-bound-elsewhere',
  'workspace-too-broad',
]);

/** A stored record read back, or `undefined` when it is not one. */
export function readConfinementRecord(
  value: unknown,
): ExecutionConfinementRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.level !== 'string' ||
    !LEVELS.has(record.level) ||
    typeof record.required !== 'boolean' ||
    typeof record.posture !== 'string' ||
    !POSTURES.has(record.posture) ||
    (record.workspaceAccess !== 'mounted' &&
      record.workspaceAccess !== 'copied') ||
    (record.policyBasis !== 'operator-policy' &&
      record.policyBasis !== 'workspace-floor') ||
    (record.mechanism !== undefined &&
      (typeof record.mechanism !== 'string' ||
        !MECHANISMS.has(record.mechanism))) ||
    (record.writeGrants !== undefined &&
      (!Array.isArray(record.writeGrants) ||
        !record.writeGrants.every(
          (grant) => typeof grant === 'string' && WRITE_GRANTS.has(grant),
        ))) ||
    (record.fallback !== undefined &&
      (typeof record.fallback !== 'string' || !FALLBACKS.has(record.fallback)))
  )
    return undefined;
  return {
    level: record.level as ConfinementLevel,
    required: record.required,
    posture: record.posture as ConfinementPosture,
    ...(record.mechanism
      ? { mechanism: record.mechanism as ConfinementMechanism }
      : {}),
    workspaceAccess: record.workspaceAccess,
    policyBasis: record.policyBasis,
    ...(record.writeGrants
      ? { writeGrants: record.writeGrants as ConfinementWriteGrant[] }
      : {}),
    ...(record.fallback
      ? { fallback: record.fallback as ConfinementFallbackReason }
      : {}),
  };
}
