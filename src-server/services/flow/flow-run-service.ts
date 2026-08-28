/**
 * FlowRunService - wraps the @kontourai/flow library API for project workspaces.
 *
 * Every method takes the project workspace path (cwd). Durable definitions and
 * config stay in Flow's contract-owned `<cwd>/.flow/`; GENERATED run state
 * lives only under `<cwd>/.kontourai/flow/runs/` — Flow 3's canonical runtime
 * root. There is no legacy `.flow/runs` read or write (archive#290).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acceptException,
  attachEvidence,
  ensureFlowLayout,
  evaluateRun,
  type FlowConsoleProjection,
  type FlowDefinition,
  type FlowEvidenceEntry,
  type FlowEvidenceManifest,
  type FlowRunState,
  findGate,
  type GateOutcome,
  listRunsWithDiagnostics,
  loadRun,
  openGates,
  projectFlowRunFromFiles,
  renderAndWriteReport,
  renderMarkdownReport,
  reportJson,
  routeBackDecision,
  startRun,
  validateDefinitionWithDiagnostics,
} from '@kontourai/flow';
import type { GateEvaluationRef } from '@kontourai/flow/gate-evaluation-contract';
import {
  type GateEvaluationReadResult,
  readGateEvaluation,
} from '@kontourai/flow/gate-evaluation-reader';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import {
  flowEvidenceAttached,
  flowEvidenceAutoSuperseded,
  flowExceptionsAccepted,
  flowGateEvaluations,
  flowReportsGenerated,
  flowRunConsoleProjections,
  flowRunLocationDiagnostics,
  flowRunsStarted,
} from '../../telemetry/metrics.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { flowRunDir } from '../evidence/local-artifact-paths.js';
import { buildSyntheticTrustBundle } from '../evidence/trust-bundle.js';

/**
 * Stable Flow error codes Station branches on. Flow 3 attaches a `code` to its
 * run-location errors; the human message is not a contract and has already
 * changed once ("run already exists" → the collision code below), silently
 * breaking a load-bearing resume. Match the code, never the message.
 */
export const FLOW_RUN_LOCATION_NOT_FOUND = 'flow.run_location.not_found';
export const FLOW_RUN_LOCATION_ALLOCATION_COLLISION =
  'flow.run_location.allocation_collision';
/** The run directory exists but is missing required artifacts. */
export const FLOW_RUN_LOCATION_NO_COMPLETE_CANDIDATE =
  'flow.run_location.no_complete_candidate';
/** A directory resolved for this run id is not a usable run location. */
export const FLOW_RUN_LOCATION_RESOLVED_DIR_INVALID =
  'flow.run_location.resolved_dir_invalid';
/** Flow could not stat a run artifact for a reason other than absence. */
export const FLOW_RUN_LOCATION_INSPECTION_FAILED =
  'flow.run_location.inspection_failed';

/** Requested resource (run, definition, workspace) does not exist → 404. */
export class FlowRunNotFoundError extends Error {
  /** Originating Flow error code, when Flow supplied one. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'FlowRunNotFoundError';
    if (code !== undefined) this.code = code;
  }
}

/** Request is structurally valid but violates Flow contracts → 400. */
export class FlowRunInvalidError extends Error {
  /** Originating Flow error code, when Flow supplied one. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'FlowRunInvalidError';
    if (code !== undefined) this.code = code;
  }
}

export interface FlowDefinitionSummary {
  id: string;
  version?: string;
  path: string;
  valid: boolean;
}

export interface FlowWorkspaceStatus {
  initialized: boolean;
  definitions: FlowDefinitionSummary[];
}

/** A Flow run-location diagnostic, as raised by `listRunsWithDiagnostics`. */
export interface FlowRunLocationDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  run_id: string;
  message: string;
}

export interface FlowRunSummary {
  run_id: string;
  definition_id: string;
  subject: string;
  status: string;
  current_step: string;
  updated_at: string;
}

export interface FlowRunStatus {
  runId: string;
  dir: string;
  definition: FlowDefinition;
  state: FlowRunState;
  manifest: FlowEvidenceManifest;
  openGates: Array<{ id: string; step: string }>;
}

export interface StartFlowRunOptions {
  /** Definition id (looked up in .flow/definitions/) or path relative to cwd. */
  definition: string;
  runId?: string;
  params?: Record<string, unknown>;
}

export interface AttachFlowEvidenceOptions {
  gate: string;
  file: string;
  kind?: string;
  status?: string;
  producer?: string;
  routeReason?: string;
  expectationIds?: string[];
  supersede?: string | string[];
}

export interface AttachCommandEvidenceOptions {
  gate: string;
  /** Command line, executed through the platform shell in the workspace. */
  command: string;
  /** Claim type asserted over the command output (e.g. quality.static-checks). */
  claimType: string;
  /** Claim producer recorded on the evidence entry. */
  producer?: string;
  /** Human label written into the evidence file (defaults to the command). */
  label?: string;
  /** Expectation ids to bind; defaults to the gate's claimType expectations. */
  expectationIds?: string[];
  /**
   * Evidence ids to supersede. When omitted, prior non-superseded FAILED
   * entries on the same gate with the same claimType and producer are
   * superseded automatically (the fix-and-rerun loop without id plumbing).
   * Pass an explicit value (including `[]`) to override the default.
   */
  supersede?: string | string[];
  /** Kill the command after this long (default 10 minutes). */
  timeoutMs?: number;
}

export interface CommandEvidenceResult {
  entry: FlowEvidenceEntry;
  exitCode: number | null;
  /** Null when the command was not executed by Station (nothing timed it). */
  durationMs: number | null;
  timedOut: boolean;
  /** Where the structured evidence file was written (Flow copies it into the run). */
  evidencePath: string;
  /** Last lines of combined stdout+stderr, as recorded in the evidence file. */
  outputTail: string[];
}

/**
 * An already-executed command's outcome — the input to
 * {@link FlowRunService.attachCommandEvidenceResult}. Decouples evidence
 * attachment from running the command, so output captured elsewhere (e.g. a
 * tool call) can be attached without a re-run.
 */
export interface CommandRunOutcome {
  /** Command line, recorded verbatim in the evidence file. */
  command: string;
  /** Combined stdout+stderr in arrival order. */
  output: string;
  /** Process exit code (null when killed/unknown). */
  exitCode: number | null;
  /** Whether the command was killed for exceeding its time budget. */
  timedOut: boolean;
  /**
   * Wall-clock duration in milliseconds, or null when nothing measured one.
   * A command Station only observed has no duration; recording 0 would read
   * as a measured instantaneous run (archive#4237).
   */
  durationMs: number | null;
  /** Whether `output` was truncated before capture. */
  outputTruncated: boolean;
  /**
   * The observing runtime's own outcome, for a command Station did NOT
   * execute. Consulted only when `exitCode` is null — it is then the single
   * execution fact available, so the pass/fail claim is derived from it
   * instead of from an exit code nobody measured. Never set on the executed
   * path, so a real exit code always decides.
   */
  observedStatus?: 'success' | 'error' | 'cancelled';
}

/**
 * Whether a command outcome counts as passing. Exported so the callers that
 * report their own telemetry derive the verdict from the same rule that writes
 * the durable claim, rather than reimplementing it and drifting.
 *
 * A null exit code means nothing measured one: for an observed command the
 * runtime's status decides; for an executed command killed by a signal there
 * is no such status, so the claim stays failing exactly as before.
 */
export function commandOutcomePassed(
  result: Pick<CommandRunOutcome, 'exitCode' | 'timedOut' | 'observedStatus'>,
): boolean {
  // A timeout fails regardless of how the outcome was sourced. Today no
  // observed producer can set this, but the predicate must be TOTAL: the
  // natural follow-up to archive#4237 is plumbing a real observed timeout, and a
  // runtime that reports a timed-out call as `success` would otherwise pass
  // it (archive#4237 review M2).
  if (result.timedOut) return false;
  if (result.exitCode === null) return result.observedStatus === 'success';
  return result.exitCode === 0 && !result.timedOut;
}

/**
 * Options for {@link FlowRunService.attachCommandEvidenceResult}. The same shape
 * as {@link AttachCommandEvidenceOptions} minus the fields that only apply to
 * running a command in-process (`command`, `timeoutMs`) — those travel in the
 * {@link CommandRunOutcome} instead.
 */
export type AttachCommandEvidenceResultOptions = Omit<
  AttachCommandEvidenceOptions,
  'command' | 'timeoutMs'
>;

export interface AcceptFlowExceptionOptions {
  gate: string;
  reason: string;
  authority: string;
}

export interface FlowEvaluationResult {
  runId: string;
  outcomes: GateOutcome[];
  state: FlowRunState;
}

export interface FlowRouteBackPreview extends Record<string, unknown> {
  status?: string;
  route_back_to?: string;
  attempt?: number;
  max_attempts?: number;
  limit_exceeded?: boolean;
  recovery_step?: string;
}

/**
 * Message shapes Flow raises WITHOUT a stable code. Every entry here is a
 * message match by necessity, not by choice — where Flow exposes a code, the
 * code is matched instead (see {@link FLOW_ERROR_CODE_TRANSLATIONS}).
 *
 * `/run already exists/` is deliberately gone: Flow 3 raises the duplicate-run
 * error as `flow.run_location.allocation_collision`, and leaving the old
 * pattern here would keep the table looking correct while matching nothing.
 */
const INVALID_PATTERNS = [
  /unknown gate/i,
  /cannot supersede/i,
  /no gate for current step/i,
  /invalid run id/i,
  /invalid Flow transition/i,
  /mismatch/i,
  /must be/i,
];

/**
 * Every `flow.run_location.*` code, classified. Enumerated rather than
 * cherry-picked so a code cannot be silently *omitted*: before this, a
 * half-written run directory raised `no_complete_candidate`, matched nothing,
 * and surfaced as an untyped 500 where Flow 1.3.0 had produced a typed 404 —
 * and the resume-on-collision path in `attachFlowRunForSessionStart` then
 * re-threw it untyped for a deterministic run id, wedging session start.
 *
 * `infrastructure` is a deliberate passthrough, not an oversight. Those codes
 * mean the filesystem under the run is unreadable or unsafe, which is a server
 * fault (500); translating them to 404 would tell an operator "no such run"
 * when the truth is "this run could not be read". They are listed so the next
 * reader can see they were classified rather than missed.
 */
const FLOW_ERROR_CODE_TRANSLATIONS: Record<
  string,
  'not-found' | 'invalid' | 'infrastructure'
> = {
  // No loadable run exists at this id in this workspace.
  [FLOW_RUN_LOCATION_NOT_FOUND]: 'not-found',
  [FLOW_RUN_LOCATION_NO_COMPLETE_CANDIDATE]: 'not-found',
  [FLOW_RUN_LOCATION_RESOLVED_DIR_INVALID]: 'not-found',
  // The request itself is the problem.
  [FLOW_RUN_LOCATION_ALLOCATION_COLLISION]: 'invalid',
  // Environment/safety faults: honest 500s.
  [FLOW_RUN_LOCATION_INSPECTION_FAILED]: 'infrastructure',
  'flow.run_location.invalid_artifact_path': 'infrastructure',
  'flow.run_location.symlink_not_allowed': 'infrastructure',
  'flow.run_location.unsafe_directory': 'infrastructure',
  'flow.run_location.unsafe_working_directory': 'infrastructure',
};

/** Producer recorded on command evidence when the caller does not override it. */
const COMMAND_EVIDENCE_PRODUCER = 'station/command';

const COMMAND_OUTPUT_TAIL_LINES = 80;
/** Cap on retained combined output while streaming (last N characters). */
const COMMAND_OUTPUT_MAX_CHARS = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

interface ShellCommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr in arrival order, capped to the last 1 MiB. */
  output: string;
  outputTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

/** Run a command line through the platform shell, capturing combined output. */
function runShellCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<ShellCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: childProcessEnvironment(),
      // Own process group (POSIX) so a timeout can kill the whole tree. With
      // shell:true the command runs as a grandchild of the shell; killing only
      // the shell leaves the grandchild alive holding the inherited stdio pipes,
      // so 'close' never fires until it exits on its own — the command appears
      // to hang far past timeoutMs (a flaky multi-second stall under load).
      detached: process.platform !== 'win32',
    });
    let output = '';
    let outputTruncated = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > COMMAND_OUTPUT_MAX_CHARS) {
        output = output.slice(-COMMAND_OUTPUT_MAX_CHARS);
        outputTruncated = true;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killCommandTree(child);
    }, timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(
        new Error(`failed to spawn command shell: ${error.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        output,
        outputTruncated,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/**
 * Terminate a timed-out shell command and its descendants. On POSIX the child
 * was spawned `detached`, so it leads its own process group and a negative-pid
 * signal reaches the shell plus any grandchildren — releasing the stdio pipes
 * so the parent's 'close' fires promptly. On Windows, `taskkill /t` walks the
 * tree. Falls back to a direct kill if the group is already gone.
 */
function killCommandTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // process already exited
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Translate raw @kontourai/flow errors into typed service errors. */
function translateFlowError(error: unknown, notFoundContext: string): never {
  const code = errorCode(error);
  if (code === 'ENOENT') {
    throw new FlowRunNotFoundError(notFoundContext, code);
  }
  const translation = code ? FLOW_ERROR_CODE_TRANSLATIONS[code] : undefined;
  if (translation === 'infrastructure') {
    // Rethrow verbatim, BEFORE the message patterns get a chance at it:
    // `unsafe_directory`'s message ("... must be a real directory") matches
    // `/must be/i`, so falling through would have relabelled a filesystem
    // safety fault as a client error.
    throw error;
  }
  if (translation === 'not-found') {
    // Keep Flow's own words — "not found" and "exists but is incomplete" send
    // an operator to different places, and only Flow knows which one it is.
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlowRunNotFoundError(`${notFoundContext} (${detail})`, code);
  }
  if (error instanceof Error) {
    if (
      translation === 'invalid' ||
      INVALID_PATTERNS.some((pattern) => pattern.test(error.message))
    ) {
      throw new FlowRunInvalidError(error.message, code);
    }
    throw error;
  }
  throw new Error(String(error));
}

export class FlowRunService {
  /** Remove a newly-created run during an atomic caller rollback. */
  async discardRun(cwd: string, runId: string): Promise<void> {
    await rm(flowRunDir(cwd, runId), { recursive: true, force: true });
  }

  /** Create the canonical Flow layout in a workspace. */
  async ensureLayout(cwd: string): Promise<string> {
    return ensureFlowLayout(cwd);
  }

  /** Detect whether a workspace has Flow definitions to run against. */
  async detectWorkspace(cwd: string): Promise<FlowWorkspaceStatus> {
    const definitionsDir = join(cwd, '.flow', 'definitions');
    if (!existsSync(definitionsDir)) {
      return { initialized: false, definitions: [] };
    }
    const definitions: FlowDefinitionSummary[] = [];
    const entries = await readdir(definitionsDir);
    for (const entry of entries.filter((name) => name.endsWith('.json'))) {
      const relativePath = join('.flow', 'definitions', entry);
      try {
        const parsed = JSON.parse(
          await readFile(join(definitionsDir, entry), 'utf8'),
        );
        const { valid } = validateDefinitionWithDiagnostics(parsed);
        definitions.push({
          id: parsed?.id ?? parsed?.metadata?.name ?? entry,
          version: parsed?.version ?? parsed?.spec?.version,
          path: relativePath,
          valid,
        });
      } catch {
        definitions.push({ id: entry, path: relativePath, valid: false });
      }
    }
    return { initialized: true, definitions };
  }

  /** Resolve a definition id or workspace-relative path to a startable path. */
  private async resolveDefinitionPath(
    cwd: string,
    definition: string,
  ): Promise<string> {
    const candidates = [
      definition,
      join('.flow', 'definitions', definition),
      join('.flow', 'definitions', `${definition}.json`),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(cwd, candidate))) return candidate;
    }
    const { definitions } = await this.detectWorkspace(cwd);
    const byId = definitions.find((entry) => entry.id === definition);
    if (byId) return byId.path;
    throw new FlowRunNotFoundError(`Flow definition not found: ${definition}`);
  }

  async startRun(
    cwd: string,
    options: StartFlowRunOptions,
  ): Promise<{ runId: string; dir: string; state: FlowRunState }> {
    const definitionPath = await this.resolveDefinitionPath(
      cwd,
      options.definition,
    );
    try {
      const result = await startRun(definitionPath, {
        cwd,
        runId: options.runId,
        params: options.params ?? {},
      });
      flowRunsStarted.add(1, {
        definition: result.state.definition_id,
      });
      return { ...result, dir: flowRunDir(cwd, result.state.run_id) };
    } catch (error: unknown) {
      translateFlowError(error, `Flow definition not found: ${definitionPath}`);
    }
  }

  async getRun(cwd: string, runId: string): Promise<FlowRunStatus> {
    const run = await this.loadRun(cwd, runId);
    return {
      runId,
      dir: flowRunDir(cwd, runId),
      definition: run.definition,
      state: run.state,
      manifest: run.manifest,
      openGates: openGates(run.definition, run.state),
    };
  }

  /**
   * Run summaries plus the run-location diagnostics Flow raised while
   * enumerating them.
   *
   * Flow's `listRuns` silently drops a run directory it cannot inspect, so a
   * corrupted or half-written run simply vanishes from the list — a shorter
   * list that looks complete. The diagnostics are the honest gap: they name
   * every directory that was skipped and why.
   */
  async listRunsWithDiagnostics(cwd: string): Promise<{
    runs: FlowRunSummary[];
    diagnostics: FlowRunLocationDiagnostic[];
  }> {
    const result = (await listRunsWithDiagnostics(cwd)) as {
      runs: FlowRunSummary[];
      diagnostics: FlowRunLocationDiagnostic[];
    };
    const diagnostics = (result.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
    }));
    for (const diagnostic of diagnostics) {
      flowRunLocationDiagnostics.add(1, {
        code: diagnostic.code,
        severity: diagnostic.severity,
      });
    }
    return {
      runs: (result.runs ?? []).map((run) => ({ ...run })),
      diagnostics,
    };
  }

  /**
   * Summaries only. Callers that just need to find a run (the platform-mutation
   * gate resolving an active binding) take this; the diagnostics are still
   * counted in {@link listRunsWithDiagnostics}, so nothing goes unrecorded.
   */
  async listRuns(cwd: string): Promise<FlowRunSummary[]> {
    return (await this.listRunsWithDiagnostics(cwd)).runs;
  }

  /**
   * Console projection for one run — Flow's own read-side shape
   * (`projectFlowRunFromFiles`): gates with outcomes and open expectations,
   * evidence manifest, exceptions, route-backs, and the report path when a
   * report has been rendered. This is the data contract behind the Flow run
   * console layout (S2); Station renders it without interpreting semantics.
   */
  async getRunConsole(
    cwd: string,
    runId: string,
  ): Promise<FlowConsoleProjection> {
    // Resolve through loadRun first so missing runs are typed 404s.
    await this.loadRun(cwd, runId);
    try {
      const projection = await projectFlowRunFromFiles(runId, { cwd });
      flowRunConsoleProjections.add(1, { status: 'ok' });
      return projection;
    } catch (error: unknown) {
      flowRunConsoleProjections.add(1, { status: 'error' });
      translateFlowError(error, `Flow run not found: ${runId}`);
    }
  }

  /**
   * Native Flow read seam for one owner-issued immutable gate evaluation.
   * The caller supplies authorization; Flow invokes it before run I/O and
   * again immediately before returning a projection.
   */
  async readGateEvaluation(
    cwd: string,
    ref: GateEvaluationRef,
    authorize: () => boolean | Promise<boolean>,
  ): Promise<GateEvaluationReadResult> {
    return readGateEvaluation(ref, { cwd, authorize: () => authorize() });
  }

  async attachEvidence(
    cwd: string,
    runId: string,
    options: AttachFlowEvidenceOptions,
  ): Promise<FlowEvidenceEntry> {
    try {
      const entry = await attachEvidence(runId, {
        cwd,
        gate: options.gate,
        file: options.file,
        kind: options.kind,
        status: options.status,
        producer: options.producer,
        route_reason: options.routeReason,
        expectation_ids: options.expectationIds,
        supersede: options.supersede,
      });
      flowEvidenceAttached.add(1, {
        kind: entry.kind,
        gate: options.gate,
      });
      return entry;
    } catch (error: unknown) {
      translateFlowError(
        error,
        `Flow run or evidence file not found: ${runId} (${options.file})`,
      );
    }
  }

  /**
   * Run a command and attach its tail as claim evidence — the "command output
   * gate" helper that replaces the manual `command > log; tail > file;
   * flow attach-evidence` ceremony.
   *
   * The command executes through the platform shell in the workspace. Exit 0
   * attaches the provided claimType with status `trusted`; a non-zero exit
   * (or timeout) attaches failed evidence with route_reason
   * `implementation_defect`, so a failing command produces a route-back on
   * the next evaluate instead of silence. The structured evidence file
   * (command, exit code, duration, output tail) is written to a temp
   * location; Flow copies it into the run's evidence dir on attach.
   *
   * Retry loop: unless an explicit `supersede` option is passed, prior
   * non-superseded FAILED entries on the gate with the same claimType and
   * producer are superseded automatically, mirroring what the readiness
   * bridge does — a fail -> fix -> rerun loop recovers the gate without the
   * caller plumbing evidence ids.
   */
  async attachCommandEvidence(
    cwd: string,
    runId: string,
    options: AttachCommandEvidenceOptions,
  ): Promise<CommandEvidenceResult> {
    // Validate the run + gate up front so an unknown gate never burns a
    // (potentially expensive) command run.
    const run = await this.getRun(cwd, runId);
    if (!run.definition.gates?.[options.gate]) {
      throw new FlowRunInvalidError(`unknown gate: ${options.gate}`);
    }

    const result = await runShellCommand(
      cwd,
      options.command,
      options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    );

    return this.attachCommandEvidenceResult(
      cwd,
      runId,
      {
        command: options.command,
        output: result.output,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTruncated: result.outputTruncated,
      },
      {
        gate: options.gate,
        claimType: options.claimType,
        ...(options.producer !== undefined
          ? { producer: options.producer }
          : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.expectationIds !== undefined
          ? { expectationIds: options.expectationIds }
          : {}),
        ...(options.supersede !== undefined
          ? { supersede: options.supersede }
          : {}),
      },
    );
  }

  /**
   * Attach evidence for a command that has *already run* — no re-execution.
   * This is the builder half of {@link attachCommandEvidence}, shared with the
   * orchestration command-evidence bridge, which spools tool-call output and
   * attaches it without paying to run the command twice.
   *
   * Behavior matches {@link attachCommandEvidence}: exit 0 (and no timeout)
   * attaches `claimType`/`trusted`; a non-zero exit or timeout attaches failed
   * evidence with route_reason `implementation_defect`. Prior non-superseded
   * FAILED entries on the gate for the same claimType+producer are superseded
   * automatically unless the caller passes an explicit `supersede`.
   */
  async attachCommandEvidenceResult(
    cwd: string,
    runId: string,
    result: CommandRunOutcome,
    options: AttachCommandEvidenceResultOptions,
  ): Promise<CommandEvidenceResult> {
    const run = await this.getRun(cwd, runId);
    const gate = run.definition.gates?.[options.gate];
    if (!gate) {
      throw new FlowRunInvalidError(`unknown gate: ${options.gate}`);
    }

    const passed = commandOutcomePassed(result);

    const lines = result.output.length ? result.output.split('\n') : [];
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const outputTail = lines.slice(-COMMAND_OUTPUT_TAIL_LINES);
    // Both null rather than omitted when unmeasured: an explicit null asserts
    // "unknown" to a reader, where a missing key is indistinguishable from a
    // record written before the field existed (archive#4237).
    const startedAt =
      result.durationMs === null
        ? null
        : new Date(Date.now() - result.durationMs).toISOString();

    const evidenceDir = await createStationTempDir('command-evidence');
    const evidencePath = join(evidenceDir, 'command-evidence.json');
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          kind: 'station.command-evidence',
          label: options.label ?? result.command,
          command: result.command,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          duration_ms: result.durationMs,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          output_total_lines: lines.length,
          output_tail_lines: outputTail.length,
          output_truncated:
            result.outputTruncated || lines.length > outputTail.length,
          output_tail: outputTail,
        },
        null,
        2,
      )}\n`,
    );

    // Flow 1.3.x evidence is a Hachure TrustBundle, not a legacy claim record. Assert a
    // synthetic Station bundle carrying a single quality claim. Status is
    // `assumed` (enforced by the trust model — Surface downgrades `verified`
    // without backing verification); the entry status (`failed` vs default) is
    // what drives gate route-back. The command-evidence JSON above is retained
    // as an audit sidecar.
    const bundlePath = join(evidenceDir, 'trust-bundle.json');
    await writeFile(
      bundlePath,
      `${JSON.stringify(
        buildSyntheticTrustBundle({
          claimType: options.claimType,
          subjectId: runId,
          value: passed ? 'pass' : 'fail',
          fieldOrBehavior: options.label ?? result.command,
        }),
        null,
        2,
      )}\n`,
    );

    // Default expectation binding: the gate's expectations for this claim type.
    const expectationIds =
      options.expectationIds ??
      (gate.expects ?? [])
        .filter(
          (expectation) =>
            expectation.kind === 'trust.bundle' &&
            expectation.bundle_claim?.claimType === options.claimType,
        )
        .map((expectation) => expectation.id);

    // Auto-supersede: a retry replaces this helper's own prior failed
    // attempt(s) for the same claim on the gate unless the caller takes over
    // supersede handling explicitly.
    const producer = options.producer ?? COMMAND_EVIDENCE_PRODUCER;
    const autoSupersede =
      options.supersede === undefined
        ? run.manifest.evidence
            .filter(
              (existing: FlowEvidenceEntry) =>
                existing.gate_id === options.gate &&
                !existing.superseded_by &&
                existing.status === 'failed' &&
                existing.bundle?.claims?.some(
                  (claim: { claimType?: string }) =>
                    claim.claimType === options.claimType,
                ) === true &&
                existing.producer === producer,
            )
            .map((existing: FlowEvidenceEntry) => existing.id)
        : undefined;
    const supersede = options.supersede ?? autoSupersede;
    if (autoSupersede?.length) {
      flowEvidenceAutoSuperseded.add(autoSupersede.length, {
        gate: options.gate,
      });
    }

    const entry = await this.attachEvidence(cwd, runId, {
      gate: options.gate,
      file: bundlePath,
      kind: 'trust.bundle',
      producer,
      ...(passed
        ? {}
        : { status: 'failed', routeReason: 'implementation_defect' }),
      ...(expectationIds.length ? { expectationIds } : {}),
      ...(supersede !== undefined &&
      (!Array.isArray(supersede) || supersede.length)
        ? { supersede }
        : {}),
    });

    return {
      entry,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      evidencePath,
      outputTail,
    };
  }

  /**
   * Evaluate all open gates (or a single gate). Outcomes carry route-back data.
   *
   * Flow's `evaluateRun` is the sole policy decision and writer of run state:
   * it holds the mutation lock, re-derives freshness, and enforces configured
   * producer and authority policy from the rich trust bundle.
   */
  async evaluate(
    cwd: string,
    runId: string,
    gate?: string,
  ): Promise<FlowEvaluationResult> {
    try {
      const result = await evaluateRun(runId, { cwd, gate });
      this.recordGateEvaluations(result.outcomes);
      return {
        runId,
        outcomes: result.outcomes,
        state: result.state,
      };
    } catch (error: unknown) {
      translateFlowError(error, `Flow run not found: ${runId}`);
    }
  }

  private recordGateEvaluations(outcomes: GateOutcome[]): void {
    for (const outcome of outcomes) {
      flowGateEvaluations.add(1, {
        gate: outcome.gate_id,
        status: outcome.status,
      });
    }
  }

  /**
   * Preview the route-back contract for a gate without mutating run state —
   * target step, attempt vs. budget, recovery step on exhaustion.
   */
  async previewRouteBack(
    cwd: string,
    runId: string,
    gateId: string,
    routeReason?: string,
  ): Promise<FlowRouteBackPreview> {
    const run = await this.loadRun(cwd, runId);
    const gate = findGate(run.definition, gateId);
    if (!gate) {
      throw new FlowRunInvalidError(`unknown gate: ${gateId}`);
    }
    const evidence = run.manifest.evidence.filter(
      (entry: FlowEvidenceEntry) =>
        entry.gate_id === gateId && !entry.superseded_by,
    );
    return routeBackDecision(
      run.state,
      gate,
      routeReason ?? null,
      evidence,
    ) as FlowRouteBackPreview;
  }

  async acceptException(
    cwd: string,
    runId: string,
    options: AcceptFlowExceptionOptions,
  ): Promise<Record<string, unknown>> {
    try {
      const exception = await acceptException(runId, {
        cwd,
        gate: options.gate,
        reason: options.reason,
        authority: options.authority,
      });
      flowExceptionsAccepted.add(1, { gate: options.gate });
      return exception;
    } catch (error: unknown) {
      translateFlowError(error, `Flow run not found: ${runId}`);
    }
  }

  /** Generate (and persist) the run report; return it as json or markdown. */
  async getReport(
    cwd: string,
    runId: string,
    format: 'json' | 'markdown',
  ): Promise<Record<string, unknown> | string> {
    const run = await this.loadRun(cwd, runId);
    await renderAndWriteReport(
      run.definition,
      run.state,
      run.manifest,
      run.dir,
    );
    flowReportsGenerated.add(1, { format });
    if (format === 'markdown') {
      return renderMarkdownReport(run.definition, run.state, run.manifest);
    }
    return reportJson(run.definition, run.state, run.manifest);
  }

  private async loadRun(cwd: string, runId: string) {
    try {
      return await loadRun(runId, cwd);
    } catch (error: unknown) {
      translateFlowError(error, `Flow run not found: ${runId}`);
    }
  }
}
