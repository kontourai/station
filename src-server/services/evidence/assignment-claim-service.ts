/**
 * AssignmentProvider claim/release/status seam (roadmap archive#584, part of epic
 * archive#580, S4, following the S3 provider-seam precedent).
 *
 * When Station dispatches a provider-backed work item (a `TaskRecord`
 * carrying a namespaced `workItemRef`), the dispatch records an
 * `@kontourai/flow-agents` AssignmentProvider claim, so a Station dispatch
 * and a concurrent flow-agents CLI session (or another Station instance)
 * agree on who owns the work — Decision 3 in
 * `docs/design/work-plane-composition.md`.
 *
 * CRITICAL version constraint (kontourai/station-archive#592 tracks the
 * `@kontourai/flow-agents` bump lineage, same as archive#583's read-path backend):
 * the pinned exact `3.4.3` package's public library entry does NOT export
 * typed assignment-claim interfaces (those merged to flow-agents `main`
 * after 3.4.3). The `3.4.3` package DOES ship the `assignment-provider` CLI
 * bin (`build/src/cli/assignment-provider.js`) — the SAME artifact the
 * flow-agents orchestrator itself shells out to when a CLI-driven session
 * claims a lane — so this service shells to that CLI, exactly mirroring
 * `flow-agents-work-item-provider.ts`'s package-root resolution and its
 * injectable, process-tree-killing, bounded-timeout CLI runner (imported
 * from there directly rather than duplicated).
 *
 * The bare `assignment-provider claim` CLI command does NOT itself perform
 * stale-lease/TTL reclaim — `performLocalClaim` (verified by reading the
 * installed package's `build/src/cli/assignment-provider.js`) only checks
 * whether the subject is currently claimed by a DIFFERENT actor; it never
 * inspects `ttl_seconds` or liveness. Stale-lease takeover lives in a
 * different, more involved code path (`ensure-session`'s ownership guard,
 * which joins liveness events) that this service deliberately does not
 * reimplement — per the roadmap archive#584 instruction, this service calls `claim`
 * and surfaces the CLI's own result honestly. If flow-agents later exposes
 * stale-reclaim on the bare `claim` path, this service picks it up for free.
 *
 * FAIL-OPEN VS FAIL-CLOSED (review finding #4, post-ship hardening): exactly
 * ONE condition is allowed to fail OPEN (dispatch proceeds without a claim)
 * — the assignment-provider CLI bin genuinely does not exist on the resolved
 * package root (`outcome: 'unavailable'`). That means no claim system
 * exists for this station install at all, so there is nothing to be
 * indeterminate ABOUT. Every other failure — a lock-acquire timeout, a
 * corrupt/unreadable claim record, malformed CLI output on a reported
 * success, a killed/timed-out process, a thrown spawn error — means
 * ownership could not be determined, which is NOT the same as "no one holds
 * it". Those all fail CLOSED as `outcome: 'blocked', kind:
 * 'operational-error'`, exactly like a genuine actor conflict (`kind:
 * 'conflict'`) — the caller (`TaskGraphService.claimForDispatch`) refuses
 * dispatch on any `'blocked'`, regardless of kind. Only `'unavailable'`
 * lets dispatch proceed unclaimed.
 *
 * Release (review finding #3) mirrors this asymmetry on the write-back side:
 * only an exit-0 success or the CLI's own idempotent "no active claim to
 * release" message are safe to treat as "nothing left to release" — every
 * other non-zero exit (actor mismatch, lock timeout, corrupt record) is
 * `outcome: 'failed'`, meaning the durable claim may STILL be active and the
 * caller must not mark it released; it must remain retryable.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStationTempDirSync } from '@kontourai/station-shared/temp-dir';
import {
  createDefaultFlowAgentsCliRunner,
  type FlowAgentsCliResult,
  type FlowAgentsCliRunner,
} from '../work-item-providers/flow-agents-work-item-provider.js';

const require = createRequire(import.meta.url);

const ASSIGNMENT_PROVIDER_CLI = 'build/src/cli/assignment-provider.js';
const DEFAULT_TIMEOUT_MS = 15_000;
const STDERR_TAIL_CHARS = 600;
/** The CLI's own exact idempotent-release message (releaseLocalFile's
 * `no active claim to release for subject: <id>` — see
 * `performLocalRelease` in the pinned package). Only THIS specific failure
 * is a safe no-op; every other non-zero release exit is a real failure. */
const NO_ACTIVE_CLAIM_PATTERN = /no active claim to release/;
/** The CLI's own exact ownership-conflict message (`performLocalClaim`'s
 * "subject already claimed by a different actor..."). */
const ALREADY_CLAIMED_PATTERN = /already claimed by a different actor/;

export interface AssignmentClaimActor {
  runtime: string;
  session_id: string;
  host: string;
  human?: string | null;
}

export interface AssignmentClaimRecord {
  schema_version: string;
  role: string;
  subject_id: string;
  actor: AssignmentClaimActor;
  actor_key?: string;
  claimed_at: string;
  ttl_seconds: number;
  branch: string;
  artifact_dir: string;
  status: 'claimed' | 'released';
  audit_trail?: unknown[];
}

export interface AssignmentClaimParams {
  artifactRoot: string;
  subjectId: string;
  actor: AssignmentClaimActor;
  branch: string;
  artifactDir: string;
  reason: string;
  ttlSeconds?: number;
}

/**
 * `'blocked'` covers BOTH a genuine actor conflict (`kind: 'conflict'`,
 * `holderActor` populated when resolvable) and an operational failure that
 * leaves ownership indeterminate (`kind: 'operational-error'`, e.g. a lock
 * timeout or corrupt record) — see the module doc for the fail-open-vs-
 * fail-closed rationale. Callers must treat every `'blocked'` the same way:
 * refuse dispatch. Only `'unavailable'` (package genuinely not installed)
 * is safe to treat as "no claim system here, proceed."
 */
export type AssignmentClaimResult =
  | { outcome: 'claimed'; record: AssignmentClaimRecord }
  | {
      outcome: 'blocked';
      kind: 'conflict' | 'operational-error';
      reason: string;
      holderActor?: AssignmentClaimActor;
    }
  | { outcome: 'unavailable'; reason: string };

export interface AssignmentReleaseParams {
  artifactRoot: string;
  subjectId: string;
  actor: AssignmentClaimActor;
  reason: string;
}

/**
 * `'skipped'` is the ONLY safe no-op outcome (the CLI's own idempotent "no
 * active claim to release" case). `'failed'` means the release did NOT
 * happen — the durable claim may still be held — and the caller must leave
 * its own bookkeeping as still-claimed so the release is retried later
 * (review finding #3). `'unavailable'` is package-absence only.
 */
export type AssignmentReleaseResult =
  | { outcome: 'released'; record: AssignmentClaimRecord }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'unavailable'; reason: string };

export interface AssignmentStatusParams {
  artifactRoot: string;
  subjectId: string;
}

export type AssignmentStatusResult =
  | {
      outcome: 'claimed';
      actor: AssignmentClaimActor;
      record: AssignmentClaimRecord;
    }
  | { outcome: 'free' }
  | { outcome: 'unavailable'; reason: string };

interface AssignmentClaimServiceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AssignmentClaimServiceOptions {
  /** Root of the @kontourai/flow-agents package (the directory containing
   * `build/src/cli/`). When provided but invalid, resolution does NOT fall
   * back to auto-discovery — mirrors `FlowAgentsWorkItemProvider`'s rule. */
  packageRoot?: string;
  logger?: AssignmentClaimServiceLogger;
  runCli?: FlowAgentsCliRunner;
  timeoutMs?: number;
  killGracePeriodMs?: number;
  hardDeadlineSlackMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function actorFromRecord(value: unknown): AssignmentClaimActor | null {
  const record = asRecord(value);
  if (!record) return null;
  const { runtime, session_id: sessionId, host } = record;
  if (
    typeof runtime !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof host !== 'string'
  ) {
    return null;
  }
  return {
    runtime,
    session_id: sessionId,
    host,
    human: typeof record.human === 'string' ? record.human : null,
  };
}

function claimRecordFrom(value: unknown): AssignmentClaimRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const actor = actorFromRecord(record.actor);
  if (
    !actor ||
    typeof record.subject_id !== 'string' ||
    typeof record.status !== 'string'
  ) {
    return null;
  }
  return record as unknown as AssignmentClaimRecord;
}

export class AssignmentClaimService {
  private readonly packageRoot: string | null;
  private readonly logger?: AssignmentClaimServiceLogger;
  private readonly runCli: FlowAgentsCliRunner;
  private readonly timeoutMs: number;

  constructor(options: AssignmentClaimServiceOptions = {}) {
    this.logger = options.logger;
    this.runCli =
      options.runCli ??
      createDefaultFlowAgentsCliRunner({
        killGracePeriodMs: options.killGracePeriodMs,
        hardDeadlineSlackMs: options.hardDeadlineSlackMs,
      });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.packageRoot = this.resolvePackageRoot(options.packageRoot);
  }

  /** True when the assignment-provider CLI bin was found on the pinned
   * package. Does NOT imply any claim exists. */
  get isPackageAvailable(): boolean {
    return this.packageRoot !== null;
  }

  async claim(params: AssignmentClaimParams): Promise<AssignmentClaimResult> {
    if (!this.packageRoot) {
      return {
        outcome: 'unavailable',
        reason: '@kontourai/flow-agents is not installed',
      };
    }
    const bin = path.join(this.packageRoot, ASSIGNMENT_PROVIDER_CLI);
    const tmpDir = createStationTempDirSync('assignment-claim');
    try {
      const actorJsonPath = path.join(tmpDir, 'actor.json');
      fs.writeFileSync(actorJsonPath, JSON.stringify(params.actor));
      const args = [
        'claim',
        '--provider',
        'local-file',
        '--artifact-root',
        params.artifactRoot,
        '--subject-id',
        params.subjectId,
        '--actor-json',
        actorJsonPath,
        '--branch',
        params.branch,
        '--artifact-dir',
        params.artifactDir,
        '--reason',
        params.reason,
      ];
      if (params.ttlSeconds !== undefined) {
        args.push('--ttl-seconds', String(params.ttlSeconds));
      }
      const result = await this.runCli(bin, args, {
        cwd: os.tmpdir(),
        timeoutMs: this.timeoutMs,
      });
      if (result.exitCode === 0) {
        const record = this.parseClaimEnvelope(result.stdout);
        if (!record) {
          // The CLI reported success (exit 0) but its output could not be
          // verified — we cannot confirm what, if anything, was actually
          // written. Ownership is indeterminate, not absent: fail CLOSED
          // (finding #4), never silently treat a verification failure as
          // "no claim system here."
          return {
            outcome: 'blocked',
            kind: 'operational-error',
            reason:
              'assignment-provider claim returned malformed JSON on a reported success — ownership could not be verified',
          };
        }
        return { outcome: 'claimed', record };
      }
      const reason = this.extractReason(result);
      if (ALREADY_CLAIMED_PATTERN.test(reason)) {
        const status = await this.status({
          artifactRoot: params.artifactRoot,
          subjectId: params.subjectId,
        });
        return {
          outcome: 'blocked',
          kind: 'conflict',
          reason,
          holderActor: status.outcome === 'claimed' ? status.actor : undefined,
        };
      }
      // Any other non-zero exit (lock-acquire timeout, a corrupt/unreadable
      // claim record, a killed/timed-out process, a CLI usage error) means
      // we could not determine whether the claim succeeded or who — if
      // anyone — holds the subject. Fail CLOSED (finding #4): block
      // dispatch rather than silently proceeding unclaimed.
      return {
        outcome: 'blocked',
        kind: 'operational-error',
        reason: `assignment-provider claim failed (exit ${result.exitCode ?? 'timeout'}): ${reason}`,
      };
    } catch (error) {
      // A thrown error (spawn failure, temp-file write failure) is the same
      // operational-failure class as a non-zero exit — never conflated with
      // genuine package-absence, which is checked and returned above BEFORE
      // this try block runs.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger?.warn('assignment-provider claim threw unexpectedly', {
        subjectId: params.subjectId,
        reason,
      });
      return { outcome: 'blocked', kind: 'operational-error', reason };
    } finally {
      this.cleanupTempDir(tmpDir);
    }
  }

  async release(
    params: AssignmentReleaseParams,
  ): Promise<AssignmentReleaseResult> {
    if (!this.packageRoot) {
      return {
        outcome: 'unavailable',
        reason: '@kontourai/flow-agents is not installed',
      };
    }
    const bin = path.join(this.packageRoot, ASSIGNMENT_PROVIDER_CLI);
    const tmpDir = createStationTempDirSync('assignment-release');
    try {
      const actorJsonPath = path.join(tmpDir, 'actor.json');
      fs.writeFileSync(actorJsonPath, JSON.stringify(params.actor));
      const args = [
        'release',
        '--provider',
        'local-file',
        '--artifact-root',
        params.artifactRoot,
        '--subject-id',
        params.subjectId,
        '--actor-json',
        actorJsonPath,
        '--reason',
        params.reason,
      ];
      const result = await this.runCli(bin, args, {
        cwd: os.tmpdir(),
        timeoutMs: this.timeoutMs,
      });
      if (result.exitCode === 0) {
        const record = this.parseClaimEnvelope(result.stdout);
        if (!record) {
          // Same asymmetry as claim(): a reported success we can't verify
          // is a failure, not a no-op — the caller must NOT mark this
          // released (finding #3).
          return {
            outcome: 'failed',
            reason:
              'assignment-provider release returned malformed JSON on a reported success',
          };
        }
        return { outcome: 'released', record };
      }
      const reason = this.extractReason(result);
      // ONLY the CLI's own exact idempotent "no active claim to release"
      // message is a safe no-op (release-on-session-end firing twice, or a
      // dispatch that never actually held a claim). Every other non-zero
      // exit — an actor mismatch ("does not match the current holder"), a
      // lock-acquire timeout, a corrupt record — means the release did NOT
      // happen and the durable claim may still be active. Those must be
      // surfaced as 'failed' so the caller leaves its bookkeeping as
      // still-claimed and retries later (finding #3) — never silently
      // marked 'skipped'/released.
      if (NO_ACTIVE_CLAIM_PATTERN.test(reason)) {
        return { outcome: 'skipped', reason };
      }
      return {
        outcome: 'failed',
        reason: `assignment-provider release failed (exit ${result.exitCode ?? 'timeout'}): ${reason}`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger?.warn('assignment-provider release threw unexpectedly', {
        subjectId: params.subjectId,
        reason,
      });
      return { outcome: 'failed', reason };
    } finally {
      this.cleanupTempDir(tmpDir);
    }
  }

  async status(
    params: AssignmentStatusParams,
  ): Promise<AssignmentStatusResult> {
    if (!this.packageRoot) {
      return {
        outcome: 'unavailable',
        reason: '@kontourai/flow-agents is not installed',
      };
    }
    const bin = path.join(this.packageRoot, ASSIGNMENT_PROVIDER_CLI);
    try {
      const result = await this.runCli(
        bin,
        [
          'status',
          '--provider',
          'local-file',
          '--artifact-root',
          params.artifactRoot,
          '--subject-id',
          params.subjectId,
        ],
        { cwd: os.tmpdir(), timeoutMs: this.timeoutMs },
      );
      if (result.exitCode !== 0) {
        return {
          outcome: 'unavailable',
          reason: `assignment-provider status failed (exit ${result.exitCode ?? 'timeout'}): ${this.extractReason(result)}`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'assignment-provider status returned malformed JSON',
        };
      }
      const envelope = asRecord(parsed);
      const assignment = envelope ? asRecord(envelope.assignment) : null;
      const record = assignment ? claimRecordFrom(assignment.record) : null;
      if (record?.status !== 'claimed') return { outcome: 'free' };
      return { outcome: 'claimed', actor: record.actor, record };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger?.warn('assignment-provider status threw unexpectedly', {
        subjectId: params.subjectId,
        reason,
      });
      return { outcome: 'unavailable', reason };
    }
  }

  // ── internals ────────────────────────────────────────

  private resolvePackageRoot(override?: string): string | null {
    const hasCli = (candidate: string): boolean =>
      fs.existsSync(path.join(candidate, ASSIGNMENT_PROVIDER_CLI));
    if (override !== undefined) {
      return hasCli(override) ? override : null;
    }
    try {
      const packageJsonPath = require.resolve(
        '@kontourai/flow-agents/package.json',
      );
      const root = path.dirname(packageJsonPath);
      return hasCli(root) ? root : null;
    } catch {
      return null;
    }
  }

  private parseClaimEnvelope(stdout: string): AssignmentClaimRecord | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    const envelope = asRecord(parsed);
    return envelope ? claimRecordFrom(envelope.record) : null;
  }

  private extractReason(result: FlowAgentsCliResult): string {
    const raw = (result.stderr || '').trim();
    const stripped = raw.replace(/^assignment-provider:\s*/, '');
    return (stripped || 'no output').slice(-STDERR_TAIL_CHARS);
  }

  private cleanupTempDir(tmpDir: string): void {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      this.logger?.warn('Failed to clean up assignment-claim temp dir', {
        tmpDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
