/**
 * VeritasReadinessService - merge readiness for project workspaces (S1b).
 *
 * Veritas has no MCP server; the consumer surface is its CLI plus on-disk
 * artifacts. This service shells out to the *workspace's own* `veritas`
 * binary (`veritas readiness --working-tree --format json`), loads the
 * evidence record the report points at
 * (`.kontourai/veritas/evidence/<run-id>.json`),
 * extracts the embedded Surface TrustBundle (`trust.bundle`), and derives a
 * Station-shaped readiness snapshot:
 *
 *   - requirement list (evidence checks, policy results, governance,
 *     recommendations, exceptions) mapped onto the roadmap status vocabulary
 *     (satisfied/missing/stale/failing/advisory/recheckable/accepted)
 *   - a Surface TrustReport via `buildTrustReport(bundle)` for the
 *     "why is this allowed to merge?" evidence detail
 *
 * Contract notes (re-verified against @kontourai/veritas@1.5.0 real output):
 *   - stdout is NOT pure JSON — evidence-check passthrough output precedes
 *     the final pretty-printed JSON object, so we parse the trailing object.
 *   - exit code 0 = ready, 1 = report produced but evidence check failed
 *     (JSON still emitted), >=2 = hard error (no JSON).
 *   - the CLI summary itself carries no per-requirement statuses; those are
 *     derived from the evidence record (`selected_evidence_checks`,
 *     `policy_results`, `recommendations`, `governance_state`,
 *     `override_or_bypass`) plus the trust report (stale/recompute queues).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  buildTrustReport,
  type TrustBundle,
  type TrustReport,
} from '@kontourai/surface';
import {
  veritasReadinessDuration,
  veritasReadinessInits,
  veritasReadinessRuns,
} from '../../telemetry/metrics.js';
import {
  remapGeneratedArtifactReference,
  resolveGeneratedArtifactReference,
  workspaceRelativePath,
} from './local-artifact-paths.js';

// ── Errors ────────────────────────────────────────────────────────────────

/** Workspace has no usable Veritas setup (.veritas/ or CLI missing) → not an error state for callers; routes report `configured: false`. */
export class VeritasNotConfiguredError extends Error {
  constructor(
    message: string,
    public readonly reason: 'no-veritas-dir' | 'no-cli',
  ) {
    super(message);
    this.name = 'VeritasNotConfiguredError';
  }
}

/** The veritas CLI ran but failed (hard exit, unparseable output) → 502-ish. */
export class VeritasCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'VeritasCliError';
  }
}

// ── Public shapes ─────────────────────────────────────────────────────────

const READINESS_STATUSES = [
  'satisfied',
  'missing',
  'stale',
  'failing',
  'advisory',
  'recheckable',
  'accepted',
] as const;

export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export interface ReadinessWorkspaceStatus {
  configured: boolean;
  reason?: 'no-veritas-dir' | 'no-cli';
  cliPath?: string;
}

export interface ReadinessCliSummary {
  runId: string;
  message: string;
  reportArtifactPath: string;
  sourceKind: string;
  evidenceCheckLabels: string[];
  evidenceCheckFailure: {
    id?: string;
    label?: string;
    message?: string;
    exitCode?: number | null;
  } | null;
}

export interface ReadinessRequirement {
  id: string;
  kind:
    | 'evidence-check'
    | 'policy'
    | 'governance'
    | 'recommendation'
    | 'exception';
  label: string;
  status: ReadinessStatus;
  summary: string;
  /** Surface claim ids backing this requirement (keys into the trust report). */
  claimIds: string[];
}

export interface ReadinessSnapshot {
  generatedAt: string;
  overall: 'ready' | 'not-ready';
  cli: ReadinessCliSummary;
  requirements: ReadinessRequirement[];
  counts: Record<ReadinessStatus, number>;
  /** Surface trust report derived from the evidence record's embedded bundle; null when the record carries no bundle. */
  trustReport: TrustReport | null;
}

/** Outcome of a workspace init attempt from the readiness setup CTA. */
export interface ReadinessInitResult {
  outcome: 'created' | 'already-initialized' | 'no-cli';
  /** A copyable command to run manually when no CLI is resolvable. */
  command?: string;
}

export interface GetReadinessOptions {
  /** Force a fresh CLI run, bypassing the in-memory cache. */
  refresh?: boolean;
  /** Optional readiness check subset (`--check evidence|boundaries|coverage`). */
  check?: 'evidence' | 'boundaries' | 'coverage';
}

export interface VeritasCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Injectable CLI runner so tests never depend on a slow real veritas run. */
export type VeritasCliRunner = (
  cwd: string,
  binPath: string,
  args: string[],
) => Promise<VeritasCliResult>;

export interface VeritasReadinessServiceOptions {
  runCli?: VeritasCliRunner;
  cliTimeoutMs?: number;
}

// ── Evidence record shapes (the slice Station reads; verified 1.5.0) ──────

interface EvidenceCheckEntry {
  id?: string;
  label?: string;
  summary?: string;
  evidence_check_result?: {
    passed?: boolean;
    exitCode?: number | null;
  };
}

interface PolicyResultEntry {
  rule_id?: string;
  stage?: string;
  enforcement?: string;
  enforcementLevel?: string;
  passed?: boolean;
  status?: string;
  summary?: string;
  message?: string;
}

interface RecommendationEntry {
  kind?: string;
  severity?: string;
  message?: string;
}

interface VeritasEvidenceRecord {
  run_id?: string;
  governance_state?: { state?: string };
  selected_evidence_checks?: EvidenceCheckEntry[];
  policy_results?: PolicyResultEntry[];
  recommendations?: RecommendationEntry[];
  override_or_bypass?: unknown;
  trust?: { bundle?: TrustBundle };
}

interface ReadinessCliJson {
  reportRunId?: string;
  message?: string;
  reportArtifactPath?: string;
  reportSourceKind?: string;
  evidenceCheckLabels?: string[];
  evidenceCheckRan?: boolean;
  evidenceCheckFailure?: ReadinessCliSummary['evidenceCheckFailure'];
}

const STDERR_TAIL_CHARS = 600;
const DEFAULT_CLI_TIMEOUT_MS = 5 * 60 * 1000;

function defaultRunCli(timeoutMs: number): VeritasCliRunner {
  return (cwd, binPath, args) =>
    new Promise<VeritasCliResult>((resolvePromise, rejectPromise) => {
      const child = spawn(binPath, args, {
        cwd,
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(
          new VeritasCliError(
            `veritas readiness timed out after ${timeoutMs}ms`,
            null,
            stderr.slice(-STDERR_TAIL_CHARS),
          ),
        );
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectPromise(
          new VeritasCliError(
            `failed to spawn veritas CLI: ${error.message}`,
            null,
            stderr.slice(-STDERR_TAIL_CHARS),
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode: code });
      });
    });
}

/**
 * Extract the trailing pretty-printed JSON object from CLI stdout. The
 * readiness command streams evidence-check output before the JSON summary,
 * so we scan candidate `{` line starts from the end of the output.
 */
export function parseTrailingJson(stdout: string): ReadinessCliJson | null {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].trimEnd() !== '{') continue;
    const candidate = lines.slice(index).join('\n');
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as ReadinessCliJson;
      }
    } catch {
      // keep scanning earlier candidates
    }
  }
  // Single-line / compact JSON fallback.
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(stdout.slice(start));
      if (parsed && typeof parsed === 'object') {
        return parsed as ReadinessCliJson;
      }
    } catch {
      // fall through
    }
  }
  return null;
}

/** Walk from cwd upward looking for a locally installed veritas binary. */
function resolveVeritasBin(cwd: string): string | null {
  const binName = process.platform === 'win32' ? 'veritas.cmd' : 'veritas';
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, 'node_modules', '.bin', binName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function emptyCounts(): Record<ReadinessStatus, number> {
  return {
    satisfied: 0,
    missing: 0,
    stale: 0,
    failing: 0,
    advisory: 0,
    recheckable: 0,
    accepted: 0,
  };
}

function governanceStatus(state: string | undefined): ReadinessStatus {
  switch (state) {
    // 0.5.0 reports a matching attestation as "current" (observed while
    // dogfooding readiness on this repo); keep "active" for compatibility.
    case 'current':
    case 'active':
      return 'satisfied';
    case 'missing':
      return 'missing';
    case 'expired':
      return 'stale';
    default:
      return 'advisory';
  }
}

export class VeritasReadinessService {
  private readonly runCli: VeritasCliRunner;
  private readonly cache = new Map<string, ReadinessSnapshot>();
  private readonly inflight = new Map<string, Promise<ReadinessSnapshot>>();

  constructor(options: VeritasReadinessServiceOptions = {}) {
    this.runCli =
      options.runCli ??
      defaultRunCli(options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS);
  }

  /**
   * Detect whether a workspace is Veritas-governed: `.veritas/` present and
   * a veritas CLI resolvable from the workspace. Never throws — absence is a
   * normal "not configured" state, not an error.
   */
  detectWorkspace(cwd: string): ReadinessWorkspaceStatus {
    if (!existsSync(join(cwd, '.veritas'))) {
      return { configured: false, reason: 'no-veritas-dir' };
    }
    const cliPath = resolveVeritasBin(cwd);
    if (!cliPath) {
      return { configured: false, reason: 'no-cli' };
    }
    return { configured: true, cliPath };
  }

  /**
   * Scaffold a Veritas workspace via `veritas init --root <cwd> --non-interactive`.
   * Safe + idempotent: if `.veritas/` is already present we short-circuit to
   * `already-initialized` without shelling out. If no veritas CLI is resolvable
   * from the workspace we report `no-cli` so the caller can degrade to a
   * copyable command + docs link rather than faking a one-click. Never throws
   * for the not-configured cases — only a hard CLI failure throws (VeritasCliError).
   */
  async initWorkspace(cwd: string): Promise<ReadinessInitResult> {
    if (existsSync(join(cwd, '.veritas'))) {
      veritasReadinessInits.add(1, { outcome: 'already-initialized' });
      return { outcome: 'already-initialized' };
    }
    const cliPath = resolveVeritasBin(cwd);
    if (!cliPath) {
      veritasReadinessInits.add(1, { outcome: 'no-cli' });
      return {
        outcome: 'no-cli',
        command: 'npx veritas init --non-interactive',
      };
    }
    const args = ['init', '--root', cwd, '--non-interactive'];
    let result: VeritasCliResult;
    try {
      result = await this.runCli(cwd, cliPath, args);
    } catch (error: unknown) {
      veritasReadinessInits.add(1, { outcome: 'error' });
      throw error;
    }
    if (result.exitCode !== 0) {
      veritasReadinessInits.add(1, { outcome: 'error' });
      throw new VeritasCliError(
        `veritas init exited with code ${result.exitCode}`,
        result.exitCode,
        result.stderr.slice(-STDERR_TAIL_CHARS),
      );
    }
    // Drop any cached "not configured" snapshot so the next read re-detects.
    this.cache.delete(resolve(cwd));
    veritasReadinessInits.add(1, { outcome: 'created' });
    return { outcome: 'created' };
  }

  /**
   * Cached-or-run readiness. Concurrent callers for the same workspace share
   * a single CLI run (readiness runs can take a while); `refresh` forces a
   * re-run but still joins an already in-flight run.
   */
  async getReadiness(
    cwd: string,
    options: GetReadinessOptions = {},
  ): Promise<ReadinessSnapshot> {
    const key = resolve(cwd);
    if (!options.refresh) {
      const cached = this.cache.get(key);
      if (cached) {
        veritasReadinessRuns.add(1, {
          status: cached.overall,
          source: 'cache',
        });
        return cached;
      }
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const run = this.runReadiness(key, options).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  private async runReadiness(
    cwd: string,
    options: GetReadinessOptions,
  ): Promise<ReadinessSnapshot> {
    const workspace = this.detectWorkspace(cwd);
    if (!workspace.configured || !workspace.cliPath) {
      veritasReadinessRuns.add(1, { status: 'not-configured', source: 'cli' });
      throw new VeritasNotConfiguredError(
        workspace.reason === 'no-cli'
          ? 'Veritas CLI is not installed in this workspace'
          : 'Workspace has no .veritas directory',
        workspace.reason ?? 'no-veritas-dir',
      );
    }

    const args = ['readiness'];
    if (options.check) args.push('--check', options.check);
    args.push('--working-tree', '--format', 'json');

    const startedAt = Date.now();
    let result: VeritasCliResult;
    try {
      result = await this.runCli(cwd, workspace.cliPath, args);
    } catch (error: unknown) {
      veritasReadinessRuns.add(1, { status: 'error', source: 'cli' });
      veritasReadinessDuration.record(Date.now() - startedAt, {
        status: 'error',
      });
      throw error;
    }

    const cliJson = parseTrailingJson(result.stdout);
    if (!cliJson || (result.exitCode !== 0 && result.exitCode !== 1)) {
      veritasReadinessRuns.add(1, { status: 'error', source: 'cli' });
      veritasReadinessDuration.record(Date.now() - startedAt, {
        status: 'error',
      });
      throw new VeritasCliError(
        cliJson
          ? `veritas readiness exited with code ${result.exitCode}`
          : 'veritas readiness produced no JSON summary',
        result.exitCode,
        result.stderr.slice(-STDERR_TAIL_CHARS),
      );
    }

    const snapshot = await this.buildSnapshot(cwd, cliJson, result.exitCode);
    this.cache.set(cwd, snapshot);
    veritasReadinessRuns.add(1, { status: snapshot.overall, source: 'cli' });
    veritasReadinessDuration.record(Date.now() - startedAt, {
      status: snapshot.overall,
    });
    return snapshot;
  }

  private async buildSnapshot(
    cwd: string,
    cliJson: ReadinessCliJson,
    exitCode: number | null,
  ): Promise<ReadinessSnapshot> {
    let record: VeritasEvidenceRecord = {};
    let reportArtifactPath = cliJson.reportArtifactPath ?? '';
    if (cliJson.reportArtifactPath) {
      const recordPath = isAbsolute(cliJson.reportArtifactPath)
        ? cliJson.reportArtifactPath
        : resolveGeneratedArtifactReference(cwd, cliJson.reportArtifactPath);
      try {
        record = JSON.parse(
          await readFile(recordPath, 'utf8'),
        ) as VeritasEvidenceRecord;
        reportArtifactPath = await this.mirrorGeneratedEvidencePath(
          cwd,
          cliJson.reportArtifactPath,
          recordPath,
        );
      } catch {
        // Record unreadable — snapshot degrades to the CLI summary only.
        record = {};
        reportArtifactPath = remapGeneratedArtifactReference(
          cliJson.reportArtifactPath,
        );
      }
    }

    const bundle = record.trust?.bundle;
    let trustReport: TrustReport | null = null;
    if (bundle) {
      try {
        trustReport = buildTrustReport(bundle);
      } catch {
        trustReport = null;
      }
    }

    const requirements = this.deriveRequirements(record, cliJson, trustReport);
    const counts = emptyCounts();
    for (const requirement of requirements) {
      counts[requirement.status] += 1;
    }

    return {
      generatedAt: new Date().toISOString(),
      overall: exitCode === 0 ? 'ready' : 'not-ready',
      cli: {
        runId: cliJson.reportRunId ?? record.run_id ?? 'unknown',
        message: cliJson.message ?? '',
        reportArtifactPath,
        sourceKind: cliJson.reportSourceKind ?? 'working-tree',
        evidenceCheckLabels: cliJson.evidenceCheckLabels ?? [],
        evidenceCheckFailure: cliJson.evidenceCheckFailure ?? null,
      },
      requirements,
      counts,
      trustReport,
    };
  }

  private async mirrorGeneratedEvidencePath(
    cwd: string,
    artifactPath: string,
    sourcePath: string,
  ): Promise<string> {
    if (isAbsolute(artifactPath)) return artifactPath;
    const mapped = remapGeneratedArtifactReference(artifactPath);
    if (mapped === artifactPath) return artifactPath;
    const targetPath = join(cwd, mapped);
    if (targetPath !== sourcePath) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
    return workspaceRelativePath(cwd, targetPath);
  }

  private deriveRequirements(
    record: VeritasEvidenceRecord,
    cliJson: ReadinessCliJson,
    trustReport: TrustReport | null,
  ): ReadinessRequirement[] {
    const requirements: ReadinessRequirement[] = [];
    const claims = trustReport?.claims ?? [];
    const staleClaimIds = new Set(trustReport?.summary?.staleClaims ?? []);
    const recheckClaimIds = new Set(
      trustReport?.summary?.recomputeNeededClaims ?? [],
    );

    const claimIdsFor = (facet: string, fieldOrBehavior?: string) =>
      claims
        .filter(
          (claim) =>
            claim.facet === facet &&
            (fieldOrBehavior === undefined ||
              claim.fieldOrBehavior === fieldOrBehavior),
        )
        .map((claim) => claim.id);

    const applyTrustQueues = (
      status: ReadinessStatus,
      claimIds: string[],
    ): ReadinessStatus => {
      if (claimIds.some((id) => staleClaimIds.has(id))) return 'stale';
      if (
        status === 'satisfied' &&
        claimIds.some((id) => recheckClaimIds.has(id))
      ) {
        return 'recheckable';
      }
      return status;
    };

    // Evidence checks (the workspace's configured proof commands).
    for (const check of record.selected_evidence_checks ?? []) {
      const label = check.label ?? check.id ?? 'evidence check';
      const ran =
        cliJson.evidenceCheckRan !== false &&
        check.evidence_check_result !== undefined;
      const base: ReadinessStatus = !ran
        ? 'missing'
        : check.evidence_check_result?.passed
          ? 'satisfied'
          : 'failing';
      const claimIds = claimIdsFor('veritas.evidence-check', label);
      requirements.push({
        id: `evidence-check:${check.id ?? label}`,
        kind: 'evidence-check',
        label,
        status: applyTrustQueues(base, claimIds),
        summary: check.summary ?? '',
        claimIds,
      });
    }

    // Repo-standards policy results.
    for (const policy of record.policy_results ?? []) {
      const ruleId = policy.rule_id ?? 'policy';
      const required =
        policy.enforcementLevel === 'Require' ||
        policy.enforcement === 'deny' ||
        policy.stage === 'block';
      const base: ReadinessStatus = policy.passed
        ? 'satisfied'
        : required
          ? 'failing'
          : 'advisory';
      const claimIds = claimIdsFor('veritas.policy-results', ruleId);
      requirements.push({
        id: `policy:${ruleId}`,
        kind: 'policy',
        label: ruleId,
        status: applyTrustQueues(base, claimIds),
        summary: policy.summary ?? policy.message ?? '',
        claimIds,
      });
    }

    // Governance attestation state.
    if (record.governance_state) {
      const claimIds = claimIdsFor('veritas.governance');
      requirements.push({
        id: 'governance:attestation',
        kind: 'governance',
        label: 'Governance attestation',
        status: applyTrustQueues(
          governanceStatus(record.governance_state.state),
          claimIds,
        ),
        summary: `Attestation state: ${record.governance_state.state ?? 'unknown'}`,
        claimIds,
      });
    }

    // Advisory recommendations (e.g. files outside configured work areas).
    (record.recommendations ?? []).forEach((recommendation, index) => {
      requirements.push({
        id: `recommendation:${recommendation.kind ?? index}`,
        kind: 'recommendation',
        label: recommendation.kind ?? 'recommendation',
        status: 'advisory',
        summary: recommendation.message ?? '',
        claimIds: [],
      });
    });

    // Recorded overrides/bypasses are accepted exceptions.
    if (record.override_or_bypass) {
      requirements.push({
        id: 'exception:override-or-bypass',
        kind: 'exception',
        label: 'Override or bypass recorded',
        status: 'accepted',
        summary: 'A readiness override or bypass was recorded for this run.',
        claimIds: [],
      });
    }

    return requirements;
  }
}
