/**
 * Package MCP admission evidence on EventStore's existing SQLite handle.
 * This is NOT a package mutation permit, a process supervisor, or a second
 * integration registry. No path/argv/credential/provider definition is stored.
 */
import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import {
  activationPermitExecutionCurrent,
  activationPermitPlan,
  consumePluginActivationPermit,
  issuePluginActivationPermit,
  markPluginActivationPermitCompleted,
  type PluginActivationPermit,
  type PluginActivationPlan,
  revokePluginActivationPermit,
  validPluginActivationPlan,
  verifyPluginActivation,
} from './plugin-activation-plan.js';

export const PACKAGE_MCP_ADMISSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS package_mcp_admission_journal (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  journal_id TEXT NOT NULL,
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS package_mcp_settled_effects (
  journal_id TEXT NOT NULL, incarnation TEXT NOT NULL, claim_id TEXT NOT NULL,
  claim_json TEXT NOT NULL, PRIMARY KEY(journal_id, claim_id)
);
CREATE TABLE IF NOT EXISTS package_plugin_activation_plans (
  journal_id TEXT NOT NULL, incarnation TEXT NOT NULL, plan_json TEXT NOT NULL,
  PRIMARY KEY(journal_id, incarnation)
);
CREATE TABLE IF NOT EXISTS package_mcp_generation_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL, incarnation TEXT NOT NULL, state_json TEXT NOT NULL,
  UNIQUE(journal_id, incarnation)
);
CREATE INDEX IF NOT EXISTS package_mcp_generation_history_page ON package_mcp_generation_history(journal_id, plugin_id, sequence);`;
const MAX_BYTES = 512 * 1024;
const MAX_GENERATIONS = 256;
const MAX_CLAIMS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PURPOSES = [
  'managed',
  'probe',
  'app',
  'oauth',
  'native-control',
  'strands',
] as const;
export type PackageMcpPurpose = (typeof PURPOSES)[number];
export interface PackageMcpInstallation {
  readonly journalId: string;
  readonly pluginId: string;
  readonly incarnation: string;
  readonly contentDigest: string;
  readonly materialization?: string;
  readonly dataScope?: string;
  readonly origin?: string;
}
type RuntimeOwner = {
  id: string;
  pid: number;
  birth?: string;
  identityKind: 'exact' | 'unverified';
};
type StoredOwner = { id: string; pid: number; birth: string };
type Claim = {
  id: string;
  owner: StoredOwner;
  purpose: PackageMcpPurpose;
  state: 'reserved' | 'effect-possible' | 'local-settled';
};
type Retirement = { id: string; owner: StoredOwner };
type Generation = {
  pluginId: string;
  incarnation: string;
  contentDigest: string;
  materialization?: string;
  dataScope?: string;
  origin?: string;
  activation?: 'pending' | 'ready';
  current: boolean;
  claims: Claim[];
  settledEffects?: number;
  retirement?: Retirement;
};
type Journal = { version: 1; generations: Generation[] };
type Transition = { state: 'applied' | 'stale' | 'blocked' | 'unavailable' };
export type PackageMcpInspection =
  | { state: 'unavailable' | 'superseded'; mutationAllowed: false }
  | {
      state: 'observed';
      mutationAllowed: false;
      admission: 'open' | 'fenced' | 'activation-pending';
      reserved: number;
      possibleEffects: number;
      localSettled: number;
      reasons: Array<
        'compatibility-unproved' | 'external-effect-unproved' | 'claims-pending'
      >;
    };
export interface PackageMcpClaim {
  /** One way, before any SDK constructor or external effect. Not repeat admission. */
  enterEffectBoundary(): Transition;
  /** Only an exact capability that never attempted the effect boundary may release. */
  releaseNotStarted(): Transition;
  /** Observation only. SDK settlement does not release possible external effects. */
  observeLocalSettlement(): Transition;
  isCurrent(): boolean;
}
export interface PackageMcpRetirement {
  inspect(): PackageMcpInspection;
  /** Withdraws routing only; retained code/data and external claims remain. */
  withdraw(): Transition;
  replace(input: {
    contentDigest: string;
    materialization: string;
    dataScope: string;
    origin?: string;
    activationPlan?: PluginActivationPlan;
  }):
    | { state: 'recorded'; installation: PackageMcpInstallation }
    | { state: 'stale' | 'unavailable' };
  /** Withdraws this request only; it neither drains nor deletes a claim/package. */
  cancel(): Transition;
}
export interface PackageMcpAdmissionJournal {
  activationState(
    installation: PackageMcpInstallation,
  ): 'pending' | 'ready' | 'unavailable';
  activationPlan(
    installation: PackageMcpInstallation,
  ): PluginActivationPlan | null;
  claimActivation(installation: PackageMcpInstallation): PluginActivationPermit;
  activationInstallation(
    permit: PluginActivationPermit,
  ): PackageMcpInstallation;
  completeActivation(permit: PluginActivationPermit): {
    state: 'applied' | 'stale' | 'unavailable';
  };

  verifyActivation(
    permit: PluginActivationPermit,
    verify: (plan: PluginActivationPlan) => Promise<void>,
  ): Promise<void>;
  closeActivationPermit(permit: PluginActivationPermit): void;
  reserveActivation(
    permit: PluginActivationPermit,
    purpose: PackageMcpPurpose,
  ): ReturnType<PackageMcpAdmissionJournal['reserve']>;
  installationRecorded(installation: PackageMcpInstallation): boolean;
  admissionOpen(installation: PackageMcpInstallation): boolean;
  selectedInstallations():
    | { state: 'observed'; installations: PackageMcpInstallation[] }
    | { state: 'unavailable' };
  history(
    pluginId: string,
    options?: { after?: number; limit?: number },
  ):
    | {
        state: 'observed';
        nextCursor?: number;
        generations: Array<{
          installation: PackageMcpInstallation;
          selected: boolean;
          possibleEffects: number;
          reserved: number;
          reclamation: 'not-proven';
        }>;
      }
    | { state: 'unavailable' };
  /** Positive historical scope only. Unclassified is NOT proof of unrelatedness. */
  inspectMutationImpact(pluginId: string): {
    scope: 'recorded-package-history' | 'unclassified' | 'unavailable';
    mutationAllowed: false;
  };
  /** Host installation-owner event, not filesystem mutation authorization.
   * A replacement explicitly mints a new incarnation even for identical bytes. */
  recordInstallation(input: {
    pluginId: string;
    contentDigest: string;
    previous: PackageMcpInstallation | null;
    materialization?: string;
    dataScope?: string;
    origin?: string;
    activationPlan?: PluginActivationPlan;
  }):
    | { state: 'recorded'; installation: PackageMcpInstallation }
    | { state: 'stale' | 'blocked' | 'unavailable' };
  currentInstallation(
    pluginId: string,
  ):
    | { state: 'observed'; installation: PackageMcpInstallation }
    | { state: 'not-observed' | 'unavailable' };
  reserve(
    installation: PackageMcpInstallation,
    purpose: PackageMcpPurpose,
  ):
    | { state: 'reserved'; claim: PackageMcpClaim }
    | { state: 'stale' | 'blocked' | 'unavailable' };
  requestRetirement(
    installation: PackageMcpInstallation,
  ):
    | { state: 'fenced'; retirement: PackageMcpRetirement }
    | { state: 'stale' | 'blocked' | 'unavailable' };
  inspect(installation: PackageMcpInstallation): PackageMcpInspection;
  closeAdmission(): void;
}

function record(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function text(value: unknown, limit = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= limit
  );
}
function owner(value: unknown): value is StoredOwner {
  return (
    record(value, ['id', 'pid', 'birth']) &&
    typeof value.id === 'string' &&
    UUID.test(value.id) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    text(value.birth)
  );
}
function validJournal(value: unknown): value is Journal {
  if (
    !record(value, ['version', 'generations']) ||
    value.version !== 1 ||
    !Array.isArray(value.generations) ||
    value.generations.length > MAX_GENERATIONS
  )
    return false;
  const generations = new Set<string>();
  const current = new Set<string>();
  const claims = new Set<string>();
  const retirements = new Set<string>();
  for (const generation of value.generations) {
    if (
      !record(generation, [
        'pluginId',
        'incarnation',
        'contentDigest',
        'materialization',
        'dataScope',
        'origin',
        'current',
        'activation',
        'claims',
        'settledEffects',
        'retirement',
      ]) ||
      !isCanonicalPluginId(generation.pluginId) ||
      typeof generation.incarnation !== 'string' ||
      !UUID.test(generation.incarnation) ||
      generations.has(generation.incarnation) ||
      typeof generation.contentDigest !== 'string' ||
      !DIGEST.test(generation.contentDigest) ||
      (generation.materialization !== undefined &&
        (typeof generation.materialization !== 'string' ||
          !UUID.test(generation.materialization))) ||
      (generation.origin !== undefined &&
        (typeof generation.origin !== 'string' ||
          !/^[a-f0-9]{64}$/.test(generation.origin))) ||
      (generation.dataScope !== undefined &&
        (typeof generation.dataScope !== 'string' ||
          !UUID.test(generation.dataScope))) ||
      (generation.activation !== undefined &&
        !['pending', 'ready'].includes(generation.activation as string)) ||
      typeof generation.current !== 'boolean' ||
      !Array.isArray(generation.claims) ||
      (generation.settledEffects !== undefined &&
        (!Number.isSafeInteger(generation.settledEffects) ||
          (generation.settledEffects as number) < 0))
    )
      return false;
    generations.add(generation.incarnation);
    if (generation.current) {
      if (current.has(generation.pluginId)) return false;
      current.add(generation.pluginId);
    }
    for (const claim of generation.claims) {
      if (
        !record(claim, ['id', 'owner', 'purpose', 'state']) ||
        typeof claim.id !== 'string' ||
        !UUID.test(claim.id) ||
        claims.has(claim.id) ||
        !owner(claim.owner) ||
        !PURPOSES.includes(claim.purpose as PackageMcpPurpose) ||
        typeof claim.state !== 'string' ||
        !['reserved', 'effect-possible', 'local-settled'].includes(claim.state)
      )
        return false;
      claims.add(claim.id);
      if (claims.size > MAX_CLAIMS) return false;
    }
    if (generation.retirement !== undefined) {
      const retirement = generation.retirement;
      if (
        !record(retirement, ['id', 'owner']) ||
        typeof retirement.id !== 'string' ||
        !UUID.test(retirement.id) ||
        retirements.has(retirement.id) ||
        !owner(retirement.owner)
      )
        return false;
      retirements.add(retirement.id);
    }
  }
  return true;
}
function sameOwner(left: StoredOwner, right: StoredOwner) {
  return (
    left.id === right.id && left.pid === right.pid && left.birth === right.birth
  );
}

/** EventStore-only composition. No new database open or bootstrap in a request. */
export function createPackageMcpAdmissionJournal(
  db: {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: SQLInputValue[]): unknown;
      get(...values: SQLInputValue[]): unknown;
    };
  },
  runtimeOwner: RuntimeOwner,
  /** Private fault seam proving unknown post-commit results never permit effects. */
  afterCommit?: () => void,
): PackageMcpAdmissionJournal {
  const capturedOwner: StoredOwner | undefined =
    runtimeOwner.identityKind === 'exact' &&
    owner({
      id: runtimeOwner.id,
      pid: runtimeOwner.pid,
      birth: runtimeOwner.birth,
    })
      ? {
          id: runtimeOwner.id,
          pid: runtimeOwner.pid,
          birth: runtimeOwner.birth!,
        }
      : undefined;
  let accepting = true;
  const initial = read();
  const journalId = initial?.id;
  function read(): { id: string; value: Journal } | undefined {
    try {
      const row = db
        .prepare(
          `SELECT CASE WHEN typeof(journal_id) = 'text' AND length(CAST(journal_id AS BLOB)) = 36 THEN journal_id END AS journal_id,
            CASE WHEN length(CAST(state_json AS BLOB)) <= ${MAX_BYTES} THEN state_json END AS body
            FROM package_mcp_admission_journal WHERE singleton = 1`,
        )
        .get() as { journal_id?: unknown; body?: unknown } | undefined;
      if (
        !row ||
        typeof row.journal_id !== 'string' ||
        !UUID.test(row.journal_id) ||
        typeof row.body !== 'string'
      )
        return;
      const value: unknown = JSON.parse(row.body);
      return validJournal(value) ? { id: row.journal_id, value } : undefined;
    } catch {
      return;
    }
  }
  function transaction<T>(
    update: (state: Journal) => T,
  ): { state: 'committed'; result: T } | { state: 'unavailable' } {
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      const loaded = read();
      if (!loaded || !journalId || loaded.id !== journalId)
        throw new Error('Journal unavailable');
      const result = update(loaded.value);
      for (const generation of loaded.value.generations) {
        const settled = generation.claims.filter(
          (claim) => claim.state === 'local-settled',
        );
        for (const claim of settled)
          db.prepare(
            'INSERT INTO package_mcp_settled_effects(journal_id, incarnation, claim_id, claim_json) VALUES (?, ?, ?, ?)',
          ).run(
            journalId,
            generation.incarnation,
            claim.id,
            JSON.stringify(claim),
          );
        generation.settledEffects =
          (generation.settledEffects ?? 0) + settled.length;
        generation.claims = generation.claims.filter(
          (claim) => claim.state !== 'local-settled',
        );
      }
      const retired = loaded.value.generations.filter(
        (generation) =>
          !generation.current &&
          !generation.retirement &&
          generation.claims.length === 0,
      );
      for (const generation of retired)
        db.prepare(
          'INSERT INTO package_mcp_generation_history(journal_id, plugin_id, incarnation, state_json) VALUES (?, ?, ?, ?)',
        ).run(
          journalId,
          generation.pluginId,
          generation.incarnation,
          JSON.stringify(generation),
        );
      loaded.value.generations = loaded.value.generations.filter(
        (generation) => !retired.includes(generation),
      );
      if (!validJournal(loaded.value))
        throw new Error('Journal transition invalid');
      const serialized = JSON.stringify(loaded.value);
      if (Buffer.byteLength(serialized) > MAX_BYTES)
        throw new Error('Journal capacity exceeded');
      const written = db
        .prepare(
          'UPDATE package_mcp_admission_journal SET state_json = ? WHERE singleton = 1 AND journal_id = ?',
        )
        .run(serialized, journalId) as { changes?: number | bigint };
      if (Number(written.changes) !== 1)
        throw new Error('Journal publication was not observed');
      const observed = read();
      if (
        !observed ||
        observed.id !== journalId ||
        JSON.stringify(observed.value) !== serialized
      )
        throw new Error('Journal publication did not match its transition');
      db.exec('COMMIT');
      began = false;
      afterCommit?.();
      return { state: 'committed', result };
    } catch {
      if (began) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* Unknown outcome stays unavailable. */
        }
      }
      return { state: 'unavailable' };
    }
  }
  function find(
    state: Journal,
    ref: PackageMcpInstallation,
  ): Generation | undefined {
    if (
      !record(ref, [
        'journalId',
        'pluginId',
        'incarnation',
        'contentDigest',
        'materialization',
        'dataScope',
        'origin',
      ]) ||
      ref.journalId !== journalId
    )
      return;
    return state.generations.find(
      (generation) =>
        generation.pluginId === ref.pluginId &&
        generation.incarnation === ref.incarnation &&
        generation.contentDigest === ref.contentDigest &&
        generation.materialization === ref.materialization &&
        generation.dataScope === ref.dataScope &&
        generation.origin === ref.origin,
    );
  }
  function ref(generation: Generation): PackageMcpInstallation {
    return Object.freeze({
      journalId: journalId!,
      pluginId: generation.pluginId,
      incarnation: generation.incarnation,
      contentDigest: generation.contentDigest,
      ...(generation.materialization
        ? { materialization: generation.materialization }
        : {}),
      ...(generation.dataScope ? { dataScope: generation.dataScope } : {}),
      ...(generation.origin ? { origin: generation.origin } : {}),
    });
  }
  function fenced(state: Journal, pluginId: string) {
    return state.generations.some(
      (generation) =>
        generation.pluginId === pluginId && generation.retirement !== undefined,
    );
  }
  let observation = 0;
  function observe<T>(readObservation: () => T, unavailable: T): T {
    const name = `package_mcp_observation_${++observation}`;
    let opened = false;
    try {
      db.exec(`SAVEPOINT ${name}`);
      opened = true;
      const result = readObservation();
      db.exec(`RELEASE ${name}`);
      opened = false;
      return result;
    } catch {
      if (opened) {
        try {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
        } catch {
          /* unavailable */
        }
      }
      return unavailable;
    }
  }
  function inspect(installation: PackageMcpInstallation): PackageMcpInspection {
    return observe(() => inspectSnapshot(installation), {
      state: 'unavailable',
      mutationAllowed: false,
    });
  }
  function inspectSnapshot(
    installation: PackageMcpInstallation,
  ): PackageMcpInspection {
    const loaded = read();
    if (!loaded || loaded.id !== journalId)
      return { state: 'unavailable', mutationAllowed: false };
    const generation = find(loaded.value, installation);
    if (!generation?.current)
      return { state: 'superseded', mutationAllowed: false };
    const claims = loaded.value.generations
      .filter((item) => item.pluginId === installation.pluginId)
      .flatMap((item) => item.claims);
    const reserved = claims.filter(
      (claim) => claim.state === 'reserved',
    ).length;
    let archived = 0;
    try {
      archived = Number(
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(json_extract(state_json, '$.settledEffects')), 0) AS count FROM package_mcp_generation_history WHERE journal_id = ? AND plugin_id = ?",
            )
            .get(journalId!, installation.pluginId) as { count: unknown }
        ).count,
      );
    } catch {
      return { state: 'unavailable', mutationAllowed: false };
    }
    const settled = loaded.value.generations
      .filter((item) => item.pluginId === installation.pluginId)
      .reduce((sum, item) => sum + (item.settledEffects ?? 0), archived);
    if (!Number.isSafeInteger(settled))
      return { state: 'unavailable', mutationAllowed: false };
    const possibleEffects =
      settled + claims.filter((claim) => claim.state !== 'reserved').length;
    return {
      state: 'observed',
      mutationAllowed: false,
      admission: fenced(loaded.value, installation.pluginId)
        ? 'fenced'
        : find(loaded.value, installation)?.activation === 'pending'
          ? 'activation-pending'
          : 'open',
      reserved,
      possibleEffects,
      localSettled:
        settled +
        claims.filter((claim) => claim.state === 'local-settled').length,
      reasons: [
        'compatibility-unproved',
        ...(claims.length ? ['claims-pending' as const] : []),
        ...(possibleEffects ? ['external-effect-unproved' as const] : []),
      ],
    };
  }
  const activationLeases = new WeakMap<
    PluginActivationPermit,
    PackageMcpInstallation
  >();
  const reserveClaim = (
    installation: PackageMcpInstallation,
    purpose: PackageMcpPurpose,
    permit?: PluginActivationPermit,
  ): ReturnType<PackageMcpAdmissionJournal['reserve']> => {
    const activationCurrent = () => {
      if (!permit) return false;
      try {
        return (
          activationLeases.get(permit)?.incarnation ===
            installation.incarnation &&
          activationPermitExecutionCurrent(permit, journal)
        );
      } catch {
        return false;
      }
    };

    if (!accepting || !capturedOwner || !PURPOSES.includes(purpose))
      return { state: 'unavailable' as const };
    const captured = Object.freeze({ ...installation });
    const claimId = randomUUID();
    const outcome = transaction((state) => {
      const generation = find(state, captured);
      if (!generation?.current) return 'stale' as const;
      if (
        ((permit || generation.activation === 'pending') &&
          !activationCurrent()) ||
        fenced(state, captured.pluginId)
      )
        return 'blocked' as const;
      if (
        state.generations.reduce(
          (total, item) => total + item.claims.length,
          0,
        ) >= MAX_CLAIMS
      )
        return 'unavailable' as const;
      generation.claims.push({
        id: claimId,
        owner: capturedOwner,
        purpose,
        state: 'reserved',
      });
      return 'reserved' as const;
    });
    if (outcome.state !== 'committed') return outcome;
    if (outcome.result !== 'reserved') return { state: outcome.result };
    let effectAttempted = false;
    const transition = (
      operation: 'enter' | 'release' | 'settled',
    ): Transition => {
      if (operation === 'enter') {
        if (effectAttempted || !accepting) return { state: 'blocked' };
        effectAttempted = true;
      }
      if (operation === 'release' && effectAttempted)
        return { state: 'blocked' };
      const result = transaction((state) => {
        const generation = find(state, captured);
        const claim = generation?.claims.find(
          (item) => item.id === claimId && sameOwner(item.owner, capturedOwner),
        );
        if (!generation || !claim) return 'stale' as const;
        if (operation === 'enter') {
          if (
            !generation.current ||
            ((permit || generation.activation === 'pending') &&
              !activationCurrent()) ||
            fenced(state, captured.pluginId)
          )
            return 'blocked' as const;
          if (claim.state !== 'reserved') return 'stale' as const;
          claim.state = 'effect-possible';
        } else if (operation === 'release') {
          if (claim.state !== 'reserved') return 'blocked' as const;
          generation.claims = generation.claims.filter(
            (item) => item !== claim,
          );
        } else {
          if (claim.state === 'reserved') return 'blocked' as const;
          claim.state = 'local-settled';
        }
        return 'applied' as const;
      });
      if (
        operation === 'enter' &&
        result.state === 'committed' &&
        result.result !== 'applied'
      )
        effectAttempted = false;
      return result.state === 'committed' ? { state: result.result } : result;
    };
    const claim: PackageMcpClaim = Object.freeze({
      enterEffectBoundary: () => transition('enter'),
      releaseNotStarted: () => transition('release'),
      observeLocalSettlement: () => transition('settled'),
      isCurrent() {
        const loaded = read();
        if (
          !accepting ||
          !loaded ||
          loaded.id !== journalId ||
          fenced(loaded.value, captured.pluginId)
        )
          return false;
        const generation = find(loaded.value, captured);
        return (
          generation?.current === true &&
          ((!permit && generation.activation !== 'pending') ||
            activationCurrent()) &&
          generation.claims.some(
            (item) =>
              item.id === claimId && sameOwner(item.owner, capturedOwner),
          )
        );
      },
    });
    return { state: 'reserved' as const, claim };
  };
  const persistActivationPlan = (
    state: Journal,
    generation: Generation,
    plan: PluginActivationPlan,
  ) => {
    if (plan.parent) {
      const parent = state.generations.find(
        (candidate) =>
          candidate.pluginId === plan.parent!.installation &&
          candidate.incarnation === plan.parent!.generation,
      );
      if (
        !parent?.current ||
        parent.activation !== 'pending' ||
        fenced(state, parent.pluginId)
      )
        throw new Error('Parent activation ownership changed');
      const row = db
        .prepare(
          'SELECT plan_json FROM package_plugin_activation_plans WHERE journal_id = ? AND incarnation = ?',
        )
        .get(journalId!, parent.incarnation) as
        | { plan_json: string }
        | undefined;
      const parentPlan: unknown = row ? JSON.parse(row.plan_json) : undefined;
      if (
        !validPluginActivationPlan(parentPlan) ||
        parentPlan.consent.kind !== 'operator-decision'
      )
        throw new Error('Parent activation consent is unavailable');
      const approval = parentPlan.consent.dependencyApprovals?.find(
        (entry) => entry.id === generation.pluginId,
      );
      if (
        !parentPlan.consent.dependencies.includes(generation.pluginId) ||
        approval?.contentDigest !== plan.sourceDigest
      )
        throw new Error('Child activation differs from the parent consent');
      parentPlan.ownedDependencies = [
        ...parentPlan.ownedDependencies.filter(
          (entry) => entry.id !== generation.pluginId,
        ),
        {
          id: generation.pluginId,
          contentDigest: generation.contentDigest,
          generation: generation.incarnation,
        },
      ];
      if (!validPluginActivationPlan(parentPlan))
        throw new Error('Parent activation graph exceeds supported bounds');
      db.prepare(
        'UPDATE package_plugin_activation_plans SET plan_json = ? WHERE journal_id = ? AND incarnation = ?',
      ).run(JSON.stringify(parentPlan), journalId!, parent.incarnation);
    }
    db.prepare(
      'INSERT INTO package_plugin_activation_plans(journal_id, incarnation, plan_json) VALUES (?, ?, ?)',
    ).run(journalId!, generation.incarnation, JSON.stringify(plan));
  };
  const journal: PackageMcpAdmissionJournal = {
    activationState(installation) {
      const loaded = read();
      const generation =
        loaded && loaded.id === journalId
          ? find(loaded.value, installation)
          : undefined;
      return generation?.current
        ? (generation.activation ?? 'ready')
        : 'unavailable';
    },
    activationPlan(installation) {
      return observe(() => {
        if (!journal.installationRecorded(installation)) return null;
        const row = db
          .prepare(
            'SELECT plan_json FROM package_plugin_activation_plans WHERE journal_id = ? AND incarnation = ?',
          )
          .get(journalId!, installation.incarnation) as
          | { plan_json: string }
          | undefined;
        if (!row) return null;
        const plan: unknown = JSON.parse(row.plan_json);
        return validPluginActivationPlan(plan) &&
          plan.artifactDigest === installation.contentDigest &&
          plan.origin === installation.origin
          ? plan
          : null;
      }, null);
    },
    claimActivation(installation) {
      const captured = Object.freeze({ ...installation });
      const plan = journal.activationPlan(captured);
      if (!plan || journal.activationState(captured) !== 'pending')
        throw new Error('Plugin activation plan is unavailable');
      const current = () => {
        const loaded = read();
        const generation =
          loaded && loaded.id === journalId
            ? find(loaded.value, captured)
            : undefined;
        return (
          generation?.current === true &&
          generation.activation === 'pending' &&
          !fenced(loaded!.value, captured.pluginId)
        );
      };
      if (!current())
        throw new Error('Plugin activation ownership is unavailable');
      const permit = issuePluginActivationPermit(journal, current, plan, () =>
        journal.activationPlan(captured),
      );
      activationLeases.set(permit, captured);
      return permit;
    },
    activationInstallation(permit) {
      const captured = activationLeases.get(permit);
      if (!captured)
        throw new Error(
          'Plugin activation permit is not owned by this journal',
        );
      activationPermitPlan(permit, journal);
      return captured;
    },
    completeActivation(permit) {
      const captured = journal.activationInstallation(permit);
      consumePluginActivationPermit(permit, journal);
      const result = transaction((state) => {
        const generation = find(state, captured);
        if (
          !generation?.current ||
          generation.activation !== 'pending' ||
          fenced(state, captured.pluginId)
        )
          return 'stale' as const;
        generation.activation = 'ready';
        return 'applied' as const;
      });
      if (result.state === 'committed' && result.result === 'applied')
        markPluginActivationPermitCompleted(permit, journal);
      return result.state === 'committed'
        ? { state: result.result }
        : { state: 'unavailable' };
    },
    installationRecorded(installation) {
      return observe(() => {
        const loaded = read();
        if (!loaded || loaded.id !== journalId) return false;
        if (find(loaded.value, installation)) return true;
        const row = db
          .prepare(
            'SELECT state_json FROM package_mcp_generation_history WHERE journal_id = ? AND plugin_id = ? AND incarnation = ?',
          )
          .get(journalId!, installation.pluginId, installation.incarnation) as
          | { state_json: string }
          | undefined;
        if (!row) return false;
        const state: Journal = {
          version: 1,
          generations: [JSON.parse(row.state_json)],
        };
        return validJournal(state) && !!find(state, installation);
      }, false);
    },
    admissionOpen(installation) {
      const loaded = read();
      return (
        !!loaded &&
        loaded.id === journalId &&
        find(loaded.value, installation)?.current === true &&
        find(loaded.value, installation)?.activation !== 'pending' &&
        !fenced(loaded.value, installation.pluginId)
      );
    },
    selectedInstallations() {
      const loaded = read();
      return loaded && loaded.id === journalId
        ? {
            state: 'observed',
            installations: loaded.value.generations
              .filter((item) => item.current)
              .map(ref),
          }
        : { state: 'unavailable' };
    },
    history(pluginId, options = {}) {
      return observe<ReturnType<PackageMcpAdmissionJournal['history']>>(
        () => {
          const loaded = read();
          const after = options.after ?? 0,
            limit = options.limit ?? 50;
          if (
            !isCanonicalPluginId(pluginId) ||
            !loaded ||
            loaded.id !== journalId ||
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100
          )
            return { state: 'unavailable' };
          try {
            const raw = db
              .prepare(
                `SELECT json_group_array(json_object('sequence', sequence, 'state', json(state_json))) AS body FROM (SELECT sequence, state_json FROM package_mcp_generation_history WHERE journal_id = ? AND plugin_id = ? AND sequence > ? ORDER BY sequence LIMIT ?)`,
              )
              .get(journalId!, pluginId, after, limit + 1) as { body: string };
            const archived = JSON.parse(raw.body) as Array<{
              sequence: number;
              state: Generation;
            }>;
            if (
              !Array.isArray(archived) ||
              archived.some(
                (row) =>
                  !Number.isSafeInteger(row.sequence) ||
                  !validJournal({ version: 1, generations: [row.state] }),
              )
            )
              return { state: 'unavailable' };
            const page = archived.slice(0, limit);
            const generations = new Map<string, Generation>();
            if (after === 0)
              for (const item of loaded.value.generations.filter(
                (item) => item.pluginId === pluginId,
              ))
                generations.set(item.incarnation, item);
            for (const row of page)
              generations.set(row.state.incarnation, row.state);
            return {
              state: 'observed',
              ...(archived.length > limit
                ? { nextCursor: page.at(-1)!.sequence }
                : {}),
              generations: [...generations.values()].map((item) => ({
                installation: ref(item),
                selected: item.current,
                possibleEffects:
                  (item.settledEffects ?? 0) +
                  item.claims.filter((claim) => claim.state !== 'reserved')
                    .length,
                reserved: item.claims.filter(
                  (claim) => claim.state === 'reserved',
                ).length,
                reclamation: 'not-proven',
              })),
            };
          } catch {
            return { state: 'unavailable' };
          }
        },
        { state: 'unavailable' },
      );
    },
    inspectMutationImpact(pluginId) {
      return observe<
        ReturnType<PackageMcpAdmissionJournal['inspectMutationImpact']>
      >(
        () => {
          const loaded = read();
          if (
            !isCanonicalPluginId(pluginId) ||
            !loaded ||
            loaded.id !== journalId
          )
            return { scope: 'unavailable', mutationAllowed: false };
          return {
            scope:
              loaded.value.generations.some(
                (generation) => generation.pluginId === pluginId,
              ) ||
              db
                .prepare(
                  'SELECT 1 FROM package_mcp_generation_history WHERE journal_id = ? AND plugin_id = ? LIMIT 1',
                )
                .get(journalId!, pluginId)
                ? 'recorded-package-history'
                : 'unclassified',
            mutationAllowed: false,
          };
        },
        { scope: 'unavailable', mutationAllowed: false },
      );
    },
    closeAdmission() {
      accepting = false;
    },
    inspect,
    currentInstallation(pluginId: string) {
      const loaded = read();
      if (!loaded || loaded.id !== journalId) return { state: 'unavailable' };
      const generation = loaded.value.generations.find(
        (item) => item.pluginId === pluginId && item.current,
      );
      return generation
        ? { state: 'observed', installation: ref(generation) }
        : { state: 'not-observed' };
    },
    recordInstallation(input) {
      if (
        !accepting ||
        !capturedOwner ||
        !record(input, [
          'pluginId',
          'contentDigest',
          'previous',
          'materialization',
          'dataScope',
          'origin',
          'activationPlan',
        ]) ||
        !isCanonicalPluginId(input.pluginId) ||
        (input.materialization !== undefined &&
          !UUID.test(input.materialization)) ||
        (input.dataScope !== undefined && !UUID.test(input.dataScope)) ||
        (input.origin !== undefined && !/^[a-f0-9]{64}$/.test(input.origin)) ||
        (input.activationPlan !== undefined &&
          (!validPluginActivationPlan(input.activationPlan) ||
            input.activationPlan.artifactDigest !== input.contentDigest ||
            input.activationPlan.origin !== input.origin)) ||
        !DIGEST.test(input.contentDigest)
      )
        return { state: 'unavailable' as const };
      const outcome = transaction((state) => {
        const previous = state.generations.find(
          (item) => item.pluginId === input.pluginId && item.current,
        );
        if (
          previous
            ? !input.previous || find(state, input.previous) !== previous
            : input.previous !== null
        )
          return { state: 'stale' as const };
        if (fenced(state, input.pluginId)) return { state: 'blocked' as const };
        if (state.generations.length >= MAX_GENERATIONS)
          return { state: 'unavailable' as const };
        if (previous) previous.current = false;
        const generation: Generation = {
          pluginId: input.pluginId,
          incarnation: randomUUID(),
          ...(input.materialization
            ? { materialization: input.materialization }
            : {}),
          ...(input.dataScope ? { dataScope: input.dataScope } : {}),
          ...(input.origin ? { origin: input.origin } : {}),
          contentDigest: input.contentDigest,
          activation: input.activationPlan ? 'pending' : 'ready',
          current: true,
          claims: [],
        };
        if (input.activationPlan)
          persistActivationPlan(state, generation, input.activationPlan);
        state.generations.push(generation);
        return { state: 'recorded' as const, installation: ref(generation) };
      });
      return outcome.state === 'committed' ? outcome.result : outcome;
    },
    reserve(installation, purpose) {
      return reserveClaim(installation, purpose);
    },
    reserveActivation(permit, purpose) {
      try {
        return reserveClaim(
          journal.activationInstallation(permit),
          purpose,
          permit,
        );
      } catch {
        return { state: 'blocked' };
      }
    },
    verifyActivation(permit, verify) {
      return verifyPluginActivation(permit, journal, verify);
    },
    closeActivationPermit(permit) {
      revokePluginActivationPermit(permit, journal);
    },
    requestRetirement(installation) {
      if (!accepting || !capturedOwner)
        return { state: 'unavailable' as const };
      const captured = Object.freeze({ ...installation });
      const id = randomUUID();
      const result = transaction((state) => {
        const generation = find(state, captured);
        if (!generation?.current) return 'stale' as const;
        if (fenced(state, captured.pluginId)) return 'blocked' as const;
        generation.retirement = { id, owner: capturedOwner };
        return 'fenced' as const;
      });
      if (result.state !== 'committed') return result;
      if (result.result !== 'fenced') return { state: result.result };
      return {
        state: 'fenced' as const,
        retirement: Object.freeze({
          inspect: () => inspect(captured),
          replace(input: {
            contentDigest: string;
            materialization: string;
            dataScope: string;
            origin?: string;
            activationPlan?: PluginActivationPlan;
          }) {
            if (
              (input.activationPlan !== undefined &&
                (!validPluginActivationPlan(input.activationPlan) ||
                  input.activationPlan.artifactDigest !== input.contentDigest ||
                  input.activationPlan.origin !== input.origin)) ||
              !DIGEST.test(input.contentDigest) ||
              !UUID.test(input.materialization) ||
              !UUID.test(input.dataScope) ||
              (input.origin !== undefined &&
                !/^[a-f0-9]{64}$/.test(input.origin))
            )
              return { state: 'unavailable' as const };
            const result = transaction((state) => {
              const generation = find(state, captured);
              if (
                !generation?.current ||
                generation.retirement?.id !== id ||
                !sameOwner(generation.retirement.owner, capturedOwner)
              )
                return { state: 'stale' as const };
              if (state.generations.length >= MAX_GENERATIONS)
                return { state: 'unavailable' as const };
              generation.current = false;
              delete generation.retirement;
              const next: Generation = {
                pluginId: generation.pluginId,
                incarnation: randomUUID(),
                contentDigest: input.contentDigest,
                materialization: input.materialization,
                dataScope: input.dataScope,
                ...(input.origin ? { origin: input.origin } : {}),
                activation: input.activationPlan ? 'pending' : 'ready',
                current: true,
                claims: [],
              };
              if (input.activationPlan)
                persistActivationPlan(state, next, input.activationPlan);
              state.generations.push(next);
              return { state: 'recorded' as const, installation: ref(next) };
            });
            return result.state === 'committed' ? result.result : result;
          },
          withdraw(): Transition {
            const result = transaction((state) => {
              const generation = find(state, captured);
              if (
                !generation?.current ||
                generation.retirement?.id !== id ||
                !sameOwner(generation.retirement.owner, capturedOwner)
              )
                return 'stale' as const;
              generation.current = false;
              delete generation.retirement;
              return 'applied' as const;
            });
            return result.state === 'committed'
              ? { state: result.result }
              : result;
          },
          cancel(): Transition {
            const result = transaction((state) => {
              const generation = find(state, captured);
              if (
                !generation?.retirement ||
                generation.retirement.id !== id ||
                !sameOwner(generation.retirement.owner, capturedOwner)
              )
                return 'stale' as const;
              delete generation.retirement;
              return 'applied' as const;
            });
            return result.state === 'committed'
              ? { state: result.result }
              : result;
          },
        }),
      };
    },
  };
  return Object.freeze(journal);
}
