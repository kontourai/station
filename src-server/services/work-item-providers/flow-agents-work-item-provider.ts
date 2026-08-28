/**
 * flow-agents-contract work-item provider backend (roadmap archive#583, part of
 * epic archive#580, S3, read path only).
 *
 * Reads the SAME shared provider settings files `@kontourai/flow-agents`
 * itself resolves (workspace -> project -> defaults; see the pinned
 * package's `schemas/backlog-provider-settings.schema.json` and
 * `src/cli/effective-backlog-settings.ts`) by shelling to the pinned
 * package's own `effective-backlog-settings` CLI — Station never
 * reimplements that precedence, it reuses the resolver. When a project
 * resolves a `configured` GitHub-backed `WorkItemProvider`/`BoardProvider`
 * pair, this backend shells to the pinned package's `pull-work-provider`
 * CLI (render-only: Station never invokes provider mutation paths) to list
 * the board's `ready_queue`.
 *
 * Flow Agents 5.7 exposes the canonical `WorkItem` interface and this
 * adapter uses its listed-item fields at the CLI boundary. It still shells to
 * the package CLIs: those CLIs own settings resolution and provider I/O, while
 * this adapter owns Station's render-only availability/error boundary. It does
 * not implement a provider mutation path or reinterpret provider settings.
 *
 * Every failure mode here (package not installed, no settings configured,
 * malformed settings, CLI timeout, `gh` missing/unauthenticated, malformed
 * CLI output) resolves to `{ available: false, reason }` — this backend
 * NEVER throws out of `listWorkItems`, so a project with no flow-agents
 * setup renders local-only behavior with zero errors.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { WorkItem as FlowAgentsWorkItem } from '@kontourai/flow-agents';
import { isTaskStatus } from '@kontourai/station-contracts/task-graph';
import type {
  ProviderWorkItem,
  WorkItemProviderCapabilities,
  WorkItemProviderIdentity,
  WorkItemProviderListResult,
} from '@kontourai/station-contracts/work-item-provider';
import type {
  IWorkItemProvider,
  WorkItemProjectContext,
} from '../../providers/provider-interfaces.js';

const require = createRequire(import.meta.url);

const EFFECTIVE_BACKLOG_SETTINGS_CLI =
  'build/src/cli/effective-backlog-settings.js';
const PULL_WORK_PROVIDER_CLI = 'build/src/cli/pull-work-provider.js';
const PROJECT_SETTINGS_RELATIVE_PATH = path.join(
  'context',
  'settings',
  'backlog-provider-settings.json',
);
const DEFAULT_TIMEOUT_MS = 15_000;
const STDERR_TAIL_CHARS = 600;
/** Grace period between the soft timeout's SIGTERM (POSIX) / taskkill (win32)
 * and escalating to SIGKILL when the process tree hasn't exited yet. */
const DEFAULT_KILL_GRACE_PERIOD_MS = 2_000;
/** Extra buffer past the SIGKILL escalation before the runner force-settles
 * the promise regardless of whether 'close' ever fired — a grandchild that
 * inherited the stdio pipes (e.g. an orphaned `gh` call) can otherwise keep
 * the pipes open and starve 'close' past any kill signal landing. */
const DEFAULT_HARD_DEADLINE_SLACK_MS = 500;

/** The canonical fields `pull-work-provider` emits for every ready item. */
type FlowAgentsListedWorkItem = Pick<
  FlowAgentsWorkItem,
  'id' | 'title' | 'status' | 'labels' | 'priority' | 'updated_at'
>;

export const FLOW_AGENTS_WORK_ITEM_PROVIDER_IDENTITY: WorkItemProviderIdentity =
  {
    kind: 'flow-agents-github',
    id: 'flow-agents-github',
    label: 'Flow Agents (GitHub)',
  };

const FLOW_AGENTS_CAPABILITIES: WorkItemProviderCapabilities = {
  readOnly: true,
  supportsDispatch: false,
  supportsStatusWrite: false,
};

export interface FlowAgentsCliResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed (e.g. on timeout) rather than exiting. */
  exitCode: number | null;
}

/** Injectable so tests never shell out to the real CLI/`gh`; the default
 * runner spawns `node <binPath> ...args` with a hard timeout. */
export type FlowAgentsCliRunner = (
  binPath: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs: number },
) => Promise<FlowAgentsCliResult>;

interface FlowAgentsProviderLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface FlowAgentsWorkItemProviderOptions {
  /** Root of the @kontourai/flow-agents package (the directory containing
   * `build/src/cli/`). When provided but invalid, resolution does NOT fall
   * back to auto-discovery — an explicit but wrong override must surface
   * (the same rule WorkflowSidecarService uses for its schema root). */
  packageRoot?: string;
  logger?: FlowAgentsProviderLogger;
  runCli?: FlowAgentsCliRunner;
  timeoutMs?: number;
  /** Only meaningful when `runCli` is not injected — forwarded to the
   * default runner's process-tree-kill escalation. Exposed for tests. */
  killGracePeriodMs?: number;
  hardDeadlineSlackMs?: number;
}

type EffectiveSettingsResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Terminate a timed-out CLI child and its whole process tree — not just the
 * Node wrapper. `pull-work-provider` synchronously spawns `gh` (a
 * grandchild); killing only the wrapper would orphan `gh`, which keeps the
 * inherited stdio pipes open and starves the wrapper's own 'close' event, so
 * the timeout would appear to do nothing. On POSIX the child is spawned
 * `detached` (its own process group, matching FlowRunService's
 * `killCommandTree` precedent) so a negative-pid signal reaches the whole
 * group. On win32, `taskkill /T /F` walks the tree (no process-group
 * signaling primitive available).
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // process (or its whole group) already exited
    }
  }
}

export function createDefaultFlowAgentsCliRunner(
  runnerOptions: {
    killGracePeriodMs?: number;
    hardDeadlineSlackMs?: number;
  } = {},
): FlowAgentsCliRunner {
  const killGracePeriodMs =
    runnerOptions.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS;
  const hardDeadlineSlackMs =
    runnerOptions.hardDeadlineSlackMs ?? DEFAULT_HARD_DEADLINE_SLACK_MS;
  return (binPath, args, options) =>
    new Promise<FlowAgentsCliResult>((resolvePromise) => {
      const child = spawn(process.execPath, [binPath, ...args], {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group (POSIX) so a timeout can terminate the whole
        // tree — see killProcessTree above.
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let softTimer: ReturnType<typeof setTimeout> | undefined;
      let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
      let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const clearAllTimers = () => {
        clearTimeout(softTimer);
        clearTimeout(hardKillTimer);
        clearTimeout(hardDeadlineTimer);
      };
      const settle = (result: FlowAgentsCliResult) => {
        if (settled) return;
        settled = true;
        clearAllTimers();
        resolvePromise(result);
      };

      softTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) killProcessTree(child.pid, 'SIGTERM');
        // Escalate if SIGTERM/taskkill didn't land within the grace period.
        hardKillTimer = setTimeout(() => {
          if (child.pid !== undefined) killProcessTree(child.pid, 'SIGKILL');
        }, killGracePeriodMs);
        // Hard deadline: settle no matter what, even if 'close' never fires
        // (an orphan still holding an inherited stdio fd open).
        hardDeadlineTimer = setTimeout(() => {
          settle({
            stdout,
            stderr: `${stderr}\ntimed out after ${options.timeoutMs}ms (process tree force-terminated)`,
            exitCode: null,
          });
        }, killGracePeriodMs + hardDeadlineSlackMs);
      }, options.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        settle({
          stdout,
          stderr: `${stderr}\nfailed to spawn: ${error.message}`,
          exitCode: null,
        });
      });
      child.on('close', (code) => {
        settle({
          stdout,
          stderr: timedOut
            ? `${stderr}\ntimed out after ${options.timeoutMs}ms`
            : stderr,
          exitCode: timedOut ? null : code,
        });
      });
      if (options.input !== undefined) child.stdin.write(options.input);
      child.stdin.end();
    });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export class FlowAgentsWorkItemProvider implements IWorkItemProvider {
  readonly identity = FLOW_AGENTS_WORK_ITEM_PROVIDER_IDENTITY;
  readonly capabilities = FLOW_AGENTS_CAPABILITIES;

  private readonly packageRoot: string | null;
  private readonly logger?: FlowAgentsProviderLogger;
  private readonly runCli: FlowAgentsCliRunner;
  private readonly timeoutMs: number;

  constructor(options: FlowAgentsWorkItemProviderOptions = {}) {
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

  /** True when both CLI bins were found on the pinned package. Does NOT
   * imply a project has settings configured, or that `gh` is available —
   * `listWorkItems` still degrades gracefully past this point. */
  get isPackageAvailable(): boolean {
    return this.packageRoot !== null;
  }

  async listWorkItems(
    context: WorkItemProjectContext,
  ): Promise<WorkItemProviderListResult> {
    if (!this.packageRoot) {
      return {
        available: false,
        items: [],
        reason: '@kontourai/flow-agents is not installed',
      };
    }
    try {
      const settingsResult = await this.resolveEffectiveSettings(context);
      if (!settingsResult.ok) {
        return { available: false, items: [], reason: settingsResult.reason };
      }
      return await this.listReadyWorkItems(context, settingsResult.settings);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger?.warn('flow-agents work-item listing failed', {
        projectId: context.projectId,
        reason,
      });
      return { available: false, items: [], reason };
    }
  }

  // ── internals ────────────────────────────────────────

  private resolvePackageRoot(override?: string): string | null {
    const hasBothClis = (candidate: string): boolean =>
      fs.existsSync(path.join(candidate, EFFECTIVE_BACKLOG_SETTINGS_CLI)) &&
      fs.existsSync(path.join(candidate, PULL_WORK_PROVIDER_CLI));
    if (override !== undefined) {
      return hasBothClis(override) ? override : null;
    }
    try {
      const packageJsonPath = require.resolve(
        '@kontourai/flow-agents/package.json',
      );
      const root = path.dirname(packageJsonPath);
      return hasBothClis(root) ? root : null;
    } catch {
      return null;
    }
  }

  private async resolveEffectiveSettings(
    context: WorkItemProjectContext,
  ): Promise<EffectiveSettingsResult> {
    const bin = path.join(this.packageRoot!, EFFECTIVE_BACKLOG_SETTINGS_CLI);
    const projectSettingsPath = path.join(
      context.workingDirectory,
      PROJECT_SETTINGS_RELATIVE_PATH,
    );
    const result = await this.runCli(
      bin,
      [
        '--repo-path',
        context.workingDirectory,
        '--project-settings',
        projectSettingsPath,
        '--json',
      ],
      { cwd: context.workingDirectory, timeoutMs: this.timeoutMs },
    );
    // effective-backlog-settings exits 0 (configured) or 2 (ask_user) with
    // valid --json output either way; only a hard failure (1, or a kill on
    // timeout) has no usable stdout.
    if (result.exitCode !== 0 && result.exitCode !== 2) {
      return {
        ok: false,
        reason: `effective-backlog-settings failed (exit ${result.exitCode ?? 'timeout'}): ${result.stderr.slice(-STDERR_TAIL_CHARS).trim() || 'no output'}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return {
        ok: false,
        reason: 'effective-backlog-settings returned malformed JSON',
      };
    }
    const record = asRecord(parsed);
    if (record?.status !== 'configured') {
      const reason =
        stringValue(record?.message) ??
        stringValue(record?.reason) ??
        'no backlog provider settings configured';
      return { ok: false, reason };
    }
    const settings = asRecord(record.settings);
    if (!settings) {
      return {
        ok: false,
        reason:
          'effective-backlog-settings reported configured with no settings payload',
      };
    }
    return { ok: true, settings };
  }

  private async listReadyWorkItems(
    context: WorkItemProjectContext,
    settings: Record<string, unknown>,
  ): Promise<WorkItemProviderListResult> {
    const bin = path.join(this.packageRoot!, PULL_WORK_PROVIDER_CLI);
    const result = await this.runCli(bin, ['--settings-json', '-'], {
      cwd: context.workingDirectory,
      input: JSON.stringify(settings),
      timeoutMs: this.timeoutMs,
    });
    if (result.exitCode !== 0) {
      return {
        available: false,
        items: [],
        reason: `pull-work-provider failed (exit ${result.exitCode ?? 'timeout'}): ${result.stderr.slice(-STDERR_TAIL_CHARS).trim() || 'no output'}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return {
        available: false,
        items: [],
        reason: 'pull-work-provider returned malformed JSON',
      };
    }
    // A structurally valid pull-work-provider response is always an object
    // with a `ready_queue` array (see boardResult() in the pinned package's
    // src/cli/pull-work-provider.ts) — null/array/object-with-no-ready_queue
    // is an upstream contract break, not "zero ready items", and must NOT
    // coerce into an empty-but-available board (that would mask the break as
    // healthy silence).
    const record = asRecord(parsed);
    if (!record || !Array.isArray(record.ready_queue)) {
      return {
        available: false,
        items: [],
        reason:
          'pull-work-provider returned an invalid response shape (missing or non-array ready_queue)',
      };
    }
    const readyQueue = record.ready_queue as unknown[];
    const cliWarnings = Array.isArray(record.warnings)
      ? (record.warnings as unknown[])
          .map((warning) => stringValue(asRecord(warning)?.message))
          .filter((message): message is string => Boolean(message))
      : [];
    const skipped: string[] = [];
    const items = readyQueue
      .map((candidate) => this.candidateToProviderWorkItem(candidate))
      .filter((item): item is ProviderWorkItem => {
        if (item) return true;
        skipped.push('skipped a malformed ready-queue candidate');
        return false;
      });
    return {
      available: true,
      items,
      warnings: [...cliWarnings, ...skipped],
    };
  }

  private candidateToProviderWorkItem(
    candidate: unknown,
  ): ProviderWorkItem | null {
    const record = asRecord(candidate);
    const id = stringValue(record?.id);
    const title = stringValue(record?.title);
    const rawStatus = stringValue(record?.status);
    if (!id || !title || !rawStatus || !isTaskStatus(rawStatus)) return null;
    const sourceProvider = asRecord(record?.source_provider);
    const owner = stringValue(sourceProvider?.owner);
    const repo = stringValue(sourceProvider?.repo);
    const provider: WorkItemProviderIdentity =
      owner && repo
        ? {
            kind: 'flow-agents-github',
            id: `flow-agents-github:${owner}/${repo}`,
            label: `GitHub (${owner}/${repo})`,
          }
        : FLOW_AGENTS_WORK_ITEM_PROVIDER_IDENTITY;
    const labels = Array.isArray(record?.labels)
      ? (record!.labels as unknown[]).filter(
          (label): label is string => typeof label === 'string',
        )
      : undefined;
    const priority = stringValue(record?.priority);
    const updatedAt = stringValue(record?.updated_at);
    const flowAgentsItem: FlowAgentsListedWorkItem = {
      id,
      title,
      status: rawStatus,
      ...(labels ? { labels } : {}),
      ...(priority ? { priority } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    };
    return {
      id: flowAgentsItem.id,
      title: flowAgentsItem.title,
      status: rawStatus,
      provider,
      workItemRef: flowAgentsItem.id,
      url: stringValue(sourceProvider?.url),
      labels: flowAgentsItem.labels,
      priority: flowAgentsItem.priority,
      updatedAt: flowAgentsItem.updated_at,
    };
  }
}
