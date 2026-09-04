/**
 * Package MCP admission evidence on EventStore's existing SQLite handle.
 * This is NOT a package mutation permit, a process supervisor, or a second
 * integration registry. No path/argv/credential/provider definition is stored.
 */
import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';

export const PACKAGE_MCP_ADMISSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS package_mcp_admission_journal (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  journal_id TEXT NOT NULL,
  state_json TEXT NOT NULL
);`;
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
  current: boolean;
  claims: Claim[];
  retirement?: Retirement;
};
type Journal = { version: 1; generations: Generation[] };
type Transition = { state: 'applied' | 'stale' | 'blocked' | 'unavailable' };
export type PackageMcpInspection =
  | { state: 'unavailable' | 'superseded'; mutationAllowed: false }
  | {
      state: 'observed';
      mutationAllowed: false;
      admission: 'open' | 'fenced';
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
  /** Withdraws this request only; it neither drains nor deletes a claim/package. */
  cancel(): Transition;
}
export interface PackageMcpAdmissionJournal {
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
        'current',
        'claims',
        'retirement',
      ]) ||
      !isCanonicalPluginId(generation.pluginId) ||
      typeof generation.incarnation !== 'string' ||
      !UUID.test(generation.incarnation) ||
      generations.has(generation.incarnation) ||
      typeof generation.contentDigest !== 'string' ||
      !DIGEST.test(generation.contentDigest) ||
      typeof generation.current !== 'boolean' ||
      !Array.isArray(generation.claims)
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
        !['reserved', 'effect-possible', 'local-settled'].includes(
          String(claim.state),
        )
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
          `SELECT journal_id, CASE WHEN length(CAST(state_json AS BLOB)) <= ${MAX_BYTES} THEN state_json END AS body FROM package_mcp_admission_journal WHERE singleton = 1`,
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
      !record(ref, ['journalId', 'pluginId', 'incarnation', 'contentDigest']) ||
      ref.journalId !== journalId
    )
      return;
    return state.generations.find(
      (generation) =>
        generation.pluginId === ref.pluginId &&
        generation.incarnation === ref.incarnation &&
        generation.contentDigest === ref.contentDigest,
    );
  }
  function ref(generation: Generation): PackageMcpInstallation {
    return Object.freeze({
      journalId: journalId!,
      pluginId: generation.pluginId,
      incarnation: generation.incarnation,
      contentDigest: generation.contentDigest,
    });
  }
  function fenced(state: Journal, pluginId: string) {
    return state.generations.some(
      (generation) =>
        generation.pluginId === pluginId && generation.retirement !== undefined,
    );
  }
  function inspect(installation: PackageMcpInstallation): PackageMcpInspection {
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
    const possibleEffects = claims.filter(
      (claim) => claim.state !== 'reserved',
    ).length;
    return {
      state: 'observed',
      mutationAllowed: false,
      admission: fenced(loaded.value, installation.pluginId)
        ? 'fenced'
        : 'open',
      reserved,
      possibleEffects,
      localSettled: claims.filter((claim) => claim.state === 'local-settled')
        .length,
      reasons: [
        'compatibility-unproved',
        ...(claims.length ? ['claims-pending' as const] : []),
        ...(possibleEffects ? ['external-effect-unproved' as const] : []),
      ],
    };
  }
  const journal: PackageMcpAdmissionJournal = {
    inspectMutationImpact(pluginId) {
      const loaded = read();
      if (!isCanonicalPluginId(pluginId) || !loaded || loaded.id !== journalId)
        return { scope: 'unavailable', mutationAllowed: false };
      return {
        scope: loaded.value.generations.some(
          (generation) => generation.pluginId === pluginId,
        )
          ? 'recorded-package-history'
          : 'unclassified',
        mutationAllowed: false,
      };
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
        !record(input, ['pluginId', 'contentDigest', 'previous']) ||
        !isCanonicalPluginId(input.pluginId) ||
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
          contentDigest: input.contentDigest,
          current: true,
          claims: [],
        };
        state.generations.push(generation);
        return { state: 'recorded' as const, installation: ref(generation) };
      });
      return outcome.state === 'committed' ? outcome.result : outcome;
    },
    reserve(installation, purpose) {
      if (!accepting || !capturedOwner || !PURPOSES.includes(purpose))
        return { state: 'unavailable' as const };
      const captured = Object.freeze({ ...installation });
      const claimId = randomUUID();
      const outcome = transaction((state) => {
        const generation = find(state, captured);
        if (!generation?.current) return 'stale' as const;
        if (fenced(state, captured.pluginId)) return 'blocked' as const;
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
            (item) =>
              item.id === claimId && sameOwner(item.owner, capturedOwner),
          );
          if (!generation || !claim) return 'stale' as const;
          if (operation === 'enter') {
            if (!generation.current || fenced(state, captured.pluginId))
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
            generation.claims.some(
              (item) =>
                item.id === claimId && sameOwner(item.owner, capturedOwner),
            )
          );
        },
      });
      return { state: 'reserved' as const, claim };
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
