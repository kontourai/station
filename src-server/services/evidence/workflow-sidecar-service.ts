/**
 * Durable Flow Agents workflow sidecars (roadmap S3 item 2).
 *
 * Reads and writes `.kontourai/flow-agents/<task-slug>/{state.json,
 * handoff.json}` in a project workspace, with legacy `.flow-agents/<task-slug>`
 * read compatibility — the runtime-agnostic workflow memory: a session
 * of ANY runtime kind (managed, connected, ACP) that starts with the same task
 * slug resumes the same state. The canonical Flow Agents hooks read these same
 * files. Station also binds each orchestration thread through Flow Agents'
 * public actor-scoped host contract so policy hooks cannot inherit another
 * co-located session's task.
 *
 * Contract discipline:
 * - Files are validated against the schema JSON shipped in the installed
 *   @kontourai/flow-agents package (`schemas/workflow-state.schema.json`,
 *   `schemas/workflow-handoff.schema.json`, draft 2020-12) — the package
 *   stays the source of truth. When sidecar schemas are unavailable,
 *   non-correlation fields use the documented structural check mirrored in
 *   @kontourai/station-contracts/workflow, logged once. Run correlation is
 *   always validated by Flow Agents' public validator; it never degrades.
 * - Writes delegate to @kontourai/flow-agents' exported sidecar JSON writer,
 *   so formatting and write behavior stay tied to the dependency contract.
 * - Station writes ONLY the JSON sidecars, never `<slug>--deliver.md`
 *   workflow artifacts. Station retains its own legacy-root state mirror only
 *   for older Station workspaces; current Flow Agents hooks resolve the
 *   canonical actor-scoped root.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  bindHostWorkflowSession,
  phases as flowAgentsWorkflowPhases,
  statuses as flowAgentsWorkflowStatuses,
  readRunCorrelation,
  validateRunCorrelationEnvelope,
  validateRunCorrelationPresence,
  writeJson as writeFlowAgentsJson,
} from '@kontourai/flow-agents';
import type {
  WorkflowHandoff,
  WorkflowNextAction,
  WorkflowPhase,
  WorkflowRunCorrelation,
  WorkflowState,
  WorkflowTaskStatus,
  WorkflowTaskSummary,
} from '@kontourai/station-contracts/workflow';
import { WORKFLOW_NEXT_ACTION_STATUSES } from '@kontourai/station-contracts/workflow';
import { workflowSidecarTransitions } from '../../telemetry/metrics.js';
import {
  flowAgentsRoot,
  legacyFlowAgentsRoot,
  STATION_ARTIFACT_ROOTS,
  STATION_LEGACY_ROOTS,
  workflowSidecarTaskPaths,
} from './local-artifact-paths.js';

const require = createRequire(import.meta.url);

const SCHEMA_FILES = {
  state: 'workflow-state.schema.json',
  handoff: 'workflow-handoff.schema.json',
} as const;

type SchemaKind = keyof typeof SCHEMA_FILES;

/** Task slugs are path segments — keep them strictly filesystem-safe. */
const TASK_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type WorkflowTransitionTrigger =
  | 'session-start'
  | 'gate-verdict'
  | 'completion'
  | 'manual';

export class WorkflowSidecarNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowSidecarNotFoundError';
  }
}

export class WorkflowSidecarInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowSidecarInvalidError';
  }
}

export interface WorkflowTransitionPatch {
  status?: WorkflowTaskStatus;
  phase?: WorkflowPhase;
  nextAction?: WorkflowNextAction;
}

export interface EnsureTaskResult {
  state: WorkflowState;
  /** True when the sidecar was created by this call (fresh task). */
  created: boolean;
}

interface SidecarLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface WorkflowSidecarServiceOptions {
  /**
   * Root of the @kontourai/flow-agents package (the directory containing
   * `schemas/`). When provided but invalid, validation falls back WITHOUT
   * auto-discovery — an explicit but wrong override must surface (the same
   * rule as the policy engine root).
   */
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  logger?: SidecarLogger;
}

type ValidateFn = (data: unknown) => { ok: boolean; message?: string };

export class WorkflowSidecarService {
  private readonly logger?: SidecarLogger;
  private readonly schemaDir: string | null;
  private readonly validators = new Map<SchemaKind, ValidateFn | null>();
  private warnedFallback = false;

  constructor(options: WorkflowSidecarServiceOptions = {}) {
    this.logger = options.logger;
    this.schemaDir = this.resolveSchemaDir(
      options.packageRoot,
      options.env ?? process.env,
    );
  }

  /** True when the package's schema files were found. */
  get schemaAvailable(): boolean {
    return this.schemaDir !== null;
  }

  /** List the workspace's task sidecars (valid state.json files). */
  listTasks(cwd: string): WorkflowTaskSummary[] {
    const roots = [
      { dir: flowAgentsRoot(cwd), relative: STATION_ARTIFACT_ROOTS.flowAgents },
      {
        dir: legacyFlowAgentsRoot(cwd),
        relative: STATION_LEGACY_ROOTS.flowAgents,
      },
    ];
    const tasks: WorkflowTaskSummary[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'archive') continue;
        if (!TASK_SLUG_PATTERN.test(entry.name)) continue;
        if (seen.has(entry.name)) continue;
        const state = this.tryReadState(cwd, entry.name);
        if (!state) continue;
        const runCorrelation = this.projectRunCorrelation(state);
        seen.add(entry.name);
        tasks.push({
          taskSlug: state.task_slug,
          status: state.status,
          phase: state.phase,
          updatedAt: state.updated_at,
          nextAction: state.next_action,
          ...(state.work_item_refs
            ? { workItemRefs: state.work_item_refs }
            : {}),
          // station#189 S4: the run-correlation envelope is the only join key
          // a session Station did not start can be matched on, so the list
          // projection has to carry it — a summary without it forces callers
          // back to per-task reads or, worse, to guessing.
          ...(runCorrelation ? { runCorrelation } : {}),
          ...(state.flow_run ? { flowRun: state.flow_run } : {}),
          hasHandoff: fs.existsSync(
            workflowSidecarTaskPaths(cwd, entry.name).readHandoffFile,
          ),
          path: `${root.relative}/${entry.name}`,
        });
      }
    }
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Read a task's state.json; null when it does not exist. */
  readState(cwd: string, taskSlug: string): WorkflowState | null {
    this.assertTaskSlug(taskSlug);
    const file = this.readStateFile(cwd, taskSlug);
    if (!fs.existsSync(file)) return null;
    const parsed = this.parseJsonFile(file);
    this.assertValid('state', parsed, file);
    return parsed as WorkflowState;
  }

  /** Read a task's handoff.json; null when it does not exist. */
  readHandoff(cwd: string, taskSlug: string): WorkflowHandoff | null {
    this.assertTaskSlug(taskSlug);
    const file = this.readHandoffFile(cwd, taskSlug);
    if (!fs.existsSync(file)) return null;
    const parsed = this.parseJsonFile(file);
    this.assertValid('handoff', parsed, file);
    return parsed as WorkflowHandoff;
  }

  /**
   * Read a task's `trust.bundle` (the session evidence store owned by
   * @kontourai/flow-agents' sidecar CLI, roadmap #753); `null` when the file
   * does not exist — the same "no signal available" meaning
   * `readHandoff`/`listTasks` already use for an absent sidecar. Unlike
   * `state.json`/`handoff.json`, the installed package ships no JSON Schema
   * for `trust.bundle` (verified against @kontourai/flow-agents@5.2.0's
   * `schemas/` directory), so this is a read-and-parse only — no
   * `assertValid` call — returning the raw parsed value for callers (the
   * `workflow-process-projection-mirror.ts` critique reader) to shape-check
   * defensively themselves. Malformed JSON still throws
   * `WorkflowSidecarInvalidError` via `parseJsonFile`, matching every other
   * sidecar read in this service.
   */
  readTrustBundle(cwd: string, taskSlug: string): unknown | null {
    this.assertTaskSlug(taskSlug);
    const file = workflowSidecarTaskPaths(cwd, taskSlug).readTrustBundleFile;
    if (!fs.existsSync(file)) return null;
    return this.parseJsonFile(file);
  }

  /** Validate and atomically write a task's full state. */
  writeState(cwd: string, taskSlug: string, state: WorkflowState): void {
    this.assertTaskSlug(taskSlug);
    if (state.task_slug !== taskSlug) {
      throw new WorkflowSidecarInvalidError(
        `state.task_slug (${state.task_slug}) does not match task directory (${taskSlug})`,
      );
    }
    const file = this.writeStateFile(cwd, taskSlug);
    this.assertValid('state', state, file);
    this.writeSidecarJson(file, state);
    this.mirrorStateForLegacyHooks(cwd, taskSlug, file, state);
  }

  /** Validate and atomically write a task's handoff. */
  writeHandoff(cwd: string, taskSlug: string, handoff: WorkflowHandoff): void {
    this.assertTaskSlug(taskSlug);
    const file = workflowSidecarTaskPaths(cwd, taskSlug).writeHandoffFile;
    this.assertValid('handoff', handoff, file);
    this.writeSidecarJson(file, handoff);
  }

  /**
   * Read the task's state, creating a fresh sidecar when none exists. Fresh
   * tasks start as status `new` / phase `pickup` — the orchestration seams
   * advance them from there.
   */
  ensureTask(
    cwd: string,
    taskSlug: string,
    init: { summary?: string } = {},
  ): EnsureTaskResult {
    this.assertTaskSlug(taskSlug);
    const existing = this.readState(cwd, taskSlug);
    if (existing) return { state: existing, created: false };

    const now = new Date().toISOString();
    const state: WorkflowState = {
      schema_version: '1.0',
      task_slug: taskSlug,
      status: 'new',
      phase: 'pickup',
      created_at: now,
      updated_at: now,
      next_action: {
        status: 'continue',
        summary: init.summary ?? `Task ${taskSlug} picked up`,
      },
    };
    this.writeState(cwd, taskSlug, state);
    return { state, created: true };
  }

  /**
   * Apply a partial transition to an existing task's state: merge the patch,
   * bump `updated_at`, validate, write atomically. An empty patch is a
   * "touch" (records activity without changing status/phase).
   */
  transition(
    cwd: string,
    taskSlug: string,
    patch: WorkflowTransitionPatch,
    options: { trigger?: WorkflowTransitionTrigger } = {},
  ): WorkflowState {
    const current = this.readState(cwd, taskSlug);
    if (!current) {
      throw new WorkflowSidecarNotFoundError(
        `No workflow sidecar for task: ${taskSlug}`,
      );
    }
    const next: WorkflowState = {
      ...current,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.phase ? { phase: patch.phase } : {}),
      ...(patch.nextAction ? { next_action: patch.nextAction } : {}),
      updated_at: new Date().toISOString(),
    };
    this.writeState(cwd, taskSlug, next);
    workflowSidecarTransitions.add(1, {
      trigger: options.trigger ?? 'manual',
      status: next.status,
    });
    return next;
  }

  /** Bind one Station actor to this task through Flow Agents' public host contract. */
  bindActor(
    cwd: string,
    taskSlug: string,
    actorKey: string,
    source: string,
  ): void {
    this.assertTaskSlug(taskSlug);
    const paths = workflowSidecarTaskPaths(cwd, taskSlug);
    bindHostWorkflowSession({
      artifactRoot: flowAgentsRoot(cwd),
      artifactDir: paths.writeDir,
      actorKey,
      owner: 'station',
      source,
    });
  }

  // ── internals ────────────────────────────────────────

  private readStateFile(cwd: string, taskSlug: string): string {
    return workflowSidecarTaskPaths(cwd, taskSlug).readStateFile;
  }

  private readHandoffFile(cwd: string, taskSlug: string): string {
    return workflowSidecarTaskPaths(cwd, taskSlug).readHandoffFile;
  }

  private writeStateFile(cwd: string, taskSlug: string): string {
    return workflowSidecarTaskPaths(cwd, taskSlug).writeStateFile;
  }

  private mirrorStateForLegacyHooks(
    cwd: string,
    taskSlug: string,
    primaryFile: string,
    state: WorkflowState,
  ): void {
    const legacyFile = workflowSidecarTaskPaths(
      cwd,
      taskSlug,
    ).compatibilityStateMirrorFile;
    if (path.resolve(primaryFile) === path.resolve(legacyFile)) return;
    this.writeSidecarJson(legacyFile, state);
  }

  private assertTaskSlug(taskSlug: string): void {
    if (!TASK_SLUG_PATTERN.test(taskSlug)) {
      throw new WorkflowSidecarInvalidError(
        `Invalid task slug: ${JSON.stringify(taskSlug)} — expected a filesystem-safe segment matching ${TASK_SLUG_PATTERN}`,
      );
    }
  }

  private tryReadState(cwd: string, taskSlug: string): WorkflowState | null {
    try {
      return this.readState(cwd, taskSlug);
    } catch (error) {
      this.logger?.warn('Skipping invalid workflow sidecar', {
        taskSlug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private parseJsonFile(file: string): unknown {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      throw new WorkflowSidecarNotFoundError(
        `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new WorkflowSidecarInvalidError(
        `Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private writeSidecarJson(file: string, data: unknown): void {
    writeFlowAgentsJson(file, data as Record<string, unknown>);
  }

  private assertValid(kind: SchemaKind, data: unknown, file: string): void {
    const validate = this.loadValidator(kind) ?? this.fallbackValidator(kind);
    const result = validate(data);
    if (!result.ok) {
      throw new WorkflowSidecarInvalidError(
        `${file} failed ${SCHEMA_FILES[kind]} validation: ${result.message ?? 'invalid'}`,
      );
    }
    if (kind === 'state') this.assertCanonicalRunCorrelation(data, file);
  }

  /**
   * Run correlation is a Flow Agents-owned envelope. The sidecar JSON Schema
   * deliberately is not a second authority for it: validate the value through
   * the installed package on every state read and write, including when the
   * sidecar schema itself uses its structural fallback.
   */
  private assertCanonicalRunCorrelation(data: unknown, file: string): void {
    const record = data as { run_correlation?: unknown } | null;
    if (!record || typeof record !== 'object') return;
    if (record.run_correlation === undefined) return;
    try {
      validateRunCorrelationPresence(record.run_correlation);
    } catch {
      throw new WorkflowSidecarInvalidError(
        `${file} failed Flow Agents run-correlation validation`,
      );
    }
  }

  /** Convert a Flow Agents-validated envelope into Station's local projection. */
  private projectRunCorrelation(
    state: WorkflowState,
  ): WorkflowRunCorrelation | undefined {
    if (state.run_correlation === undefined) return undefined;
    const presence = readRunCorrelation(state);
    if (presence.status === 'incomplete') {
      return { status: 'incomplete', reason: presence.reason };
    }
    return validateRunCorrelationEnvelope(presence.envelope);
  }

  private resolveSchemaDir(
    packageRootOverride: string | undefined,
    env: NodeJS.ProcessEnv,
  ): string | null {
    const asSchemaDir = (candidate: string): string | null =>
      fs.existsSync(path.join(candidate, SCHEMA_FILES.state))
        ? candidate
        : null;
    const asPackageRoot = (candidate: string): string | null =>
      asSchemaDir(path.join(candidate, 'schemas')) ?? asSchemaDir(candidate);

    // 1. Explicit override — invalid overrides do NOT fall through.
    if (packageRootOverride !== undefined) {
      return asPackageRoot(packageRootOverride);
    }

    // 2. Env var (shared with the policy engine root).
    const envRoot = env.FLOW_AGENTS_ENGINE_ROOT;
    if (envRoot) {
      const resolved = asPackageRoot(envRoot);
      if (resolved) return resolved;
    }

    // 3. The installed npm package.
    try {
      const packageJson = require.resolve(
        '@kontourai/flow-agents/package.json',
      );
      const resolved = asPackageRoot(path.dirname(packageJson));
      if (resolved) return resolved;
    } catch {
      // not installed — fall through to fallback validation
    }

    return null;
  }

  private loadValidator(kind: SchemaKind): ValidateFn | null {
    if (this.validators.has(kind)) {
      return this.validators.get(kind) ?? null;
    }
    let loaded: ValidateFn | null = null;
    if (this.schemaDir) {
      try {
        const schema = JSON.parse(
          fs.readFileSync(
            path.join(this.schemaDir, SCHEMA_FILES[kind]),
            'utf-8',
          ),
        );
        // The package schemas are draft 2020-12; formats (date-time) are
        // structural hints, not validated here.
        const { Ajv2020 } = require('ajv/dist/2020.js') as {
          Ajv2020: new (
            opts: Record<string, unknown>,
          ) => {
            compile(schema: unknown): ((data: unknown) => boolean) & {
              errors?: Array<{
                instancePath?: string;
                message?: string;
              }> | null;
            };
          };
        };
        const ajv = new Ajv2020({ strict: false, validateFormats: false });
        const compiled = ajv.compile(schema);
        loaded = (data: unknown) => {
          if (compiled(data)) return { ok: true };
          const first = compiled.errors?.[0];
          return {
            ok: false,
            message: first
              ? `${first.instancePath || '/'} ${first.message ?? 'invalid'}`
              : 'invalid',
          };
        };
      } catch (error) {
        this.logger?.warn('Failed to load Flow Agents sidecar schema', {
          kind,
          schemaDir: this.schemaDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.validators.set(kind, loaded);
    return loaded;
  }

  /**
   * Structural fallback mirroring the documented schema (used only when the
   * package schemas are unavailable), logged once.
   */
  private fallbackValidator(kind: SchemaKind): ValidateFn {
    if (!this.warnedFallback) {
      this.warnedFallback = true;
      this.logger?.warn(
        'Flow Agents sidecar schemas unavailable — degrading to structural validation',
        {
          hint: 'install @kontourai/flow-agents or set FLOW_AGENTS_ENGINE_ROOT',
        },
      );
    }
    if (kind === 'handoff') {
      return (data: unknown) => {
        const record = data as Partial<WorkflowHandoff> | null;
        if (!record || typeof record !== 'object') {
          return { ok: false, message: 'not an object' };
        }
        if (record.schema_version !== '1.0') {
          return { ok: false, message: 'schema_version must be "1.0"' };
        }
        if (!record.task_slug || typeof record.task_slug !== 'string') {
          return { ok: false, message: 'task_slug is required' };
        }
        if (!record.summary || typeof record.summary !== 'string') {
          return { ok: false, message: 'summary is required' };
        }
        if (!Array.isArray(record.next_steps)) {
          return { ok: false, message: 'next_steps is required' };
        }
        return { ok: true };
      };
    }
    return (data: unknown) => {
      const record = data as Partial<WorkflowState> | null;
      if (!record || typeof record !== 'object') {
        return { ok: false, message: 'not an object' };
      }
      if (record.schema_version !== '1.0') {
        return { ok: false, message: 'schema_version must be "1.0"' };
      }
      if (!record.task_slug || typeof record.task_slug !== 'string') {
        return { ok: false, message: 'task_slug is required' };
      }
      if (
        !flowAgentsWorkflowStatuses.has(record.status as WorkflowTaskStatus)
      ) {
        return { ok: false, message: `invalid status: ${record.status}` };
      }
      if (!flowAgentsWorkflowPhases.includes(record.phase as WorkflowPhase)) {
        return { ok: false, message: `invalid phase: ${record.phase}` };
      }
      if (!record.updated_at || typeof record.updated_at !== 'string') {
        return { ok: false, message: 'updated_at is required' };
      }
      if (
        record.work_item_refs !== undefined &&
        (!Array.isArray(record.work_item_refs) ||
          record.work_item_refs.length === 0 ||
          record.work_item_refs.some(
            (ref) => typeof ref !== 'string' || ref.length === 0,
          ) ||
          new Set(record.work_item_refs).size !== record.work_item_refs.length)
      ) {
        return {
          ok: false,
          message: 'work_item_refs must be a non-empty array of unique strings',
        };
      }
      const flowRun = record.flow_run;
      if (flowRun !== undefined) {
        if (!flowRun || typeof flowRun !== 'object') {
          return { ok: false, message: 'invalid flow_run projection' };
        }
        const requiredStrings = [
          flowRun.run_id,
          flowRun.definition_id,
          flowRun.definition_version,
          flowRun.status,
          flowRun.current_step,
          flowRun.run_ref,
        ];
        if (
          requiredStrings.some(
            (value) => typeof value !== 'string' || value.length === 0,
          ) ||
          !Array.isArray(flowRun.open_gate_ids) ||
          flowRun.open_gate_ids.some(
            (gateId) => typeof gateId !== 'string' || gateId.length === 0,
          ) ||
          new Set(flowRun.open_gate_ids).size !==
            flowRun.open_gate_ids.length ||
          (flowRun.route_back_attempt !== undefined &&
            (!Number.isInteger(flowRun.route_back_attempt) ||
              flowRun.route_back_attempt < 1)) ||
          (flowRun.route_back_max_attempts !== undefined &&
            (!Number.isInteger(flowRun.route_back_max_attempts) ||
              flowRun.route_back_max_attempts < 1))
        ) {
          return { ok: false, message: 'invalid flow_run projection' };
        }
      }
      const next = record.next_action;
      if (
        !next ||
        typeof next !== 'object' ||
        !WORKFLOW_NEXT_ACTION_STATUSES.includes(next.status) ||
        !next.summary ||
        typeof next.summary !== 'string'
      ) {
        return {
          ok: false,
          message: 'next_action {status, summary} is required',
        };
      }
      return { ok: true };
    };
  }
}
