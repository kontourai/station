/**
 * Native enforcement of @kontourai/flow-agents' four canonical policy classes
 * at Station's orchestration layer (roadmap S3 item 1 — the proposed L3 tier).
 *
 * The four policy classes are the canonical hook scripts shipped under the
 * package's `scripts/hooks/`:
 *
 *   - config-protection.js  → checkToolCall()   (BLOCKING pre-tool)
 *   - quality-gate.js       → afterWrite()      (non-blocking post-write)
 *   - workflow-steering.js  → steeringContext() (non-blocking context inject)
 *   - stop-goal-fit.js      → checkStop()       (blocking in strict mode)
 *
 * Binding form: Form 2 NATIVE import of each hook's `module.exports.run(raw,
 * {truncated, maxStdin})` API — no subprocess — following the Strands TS
 * adapter's `PolicyGate` reference (flow-agents integrations/strands-ts).
 * Everything fails OPEN: if the engine cannot be loaded, config-protection
 * degrades to a pure-TS reimplementation of the documented protected-file set
 * and the other three policies become no-ops, logged once.
 *
 * Env contract (shared with the canonical harness adapters):
 *   - SA_HOOK_PROFILE=minimal|standard|strict (default standard)
 *   - SA_DISABLED_HOOKS=comma,separated,hook,ids
 *   - FLOW_AGENTS_GOAL_FIT_STRICT=true  → stop-goal-fit blocks
 *   - FLOW_AGENTS_ENGINE_ROOT           → explicit engine location
 *   - FLOW_AGENTS_HOOK_RUNTIME          → set to 'station' during native runs
 *
 * Hook ids + profile gating mirror the canonical agent wiring shipped in the
 * package (`agents/dev.json`):
 *   pre:config-protection    standard,strict
 *   post:quality-gate        strict
 *   prompt:workflow-steering standard,strict
 *   stop:goal-fit            standard,strict
 *
 * Workspace opt-in: a workspace participates when it contains
 * `.kontourai/flow-agents/`, with legacy `.flow-agents/` compatibility.
 * Non-opted workspaces see zero behavior change.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { STANDARD_FLOW_BUILDER_GUIDANCE } from '@kontourai/station-contracts';
import type {
  CanonicalRuntimeEvent,
  PolicyHookProfile,
} from '@kontourai/station-contracts/runtime-events';
import { policyChecks } from '../../telemetry/metrics.js';
import {
  flowAgentsRoot,
  legacyFlowAgentsRoot,
} from '../evidence/local-artifact-paths.js';

const require = createRequire(import.meta.url);

const MAX_STDIN = 1024 * 1024;
let asyncEnvOverlayTail: Promise<void> = Promise.resolve();

// ── Hook ids / profile gating (mirrors the package's agents/dev.json) ──

const HOOK_PROFILES: Record<string, readonly PolicyHookProfile[]> = {
  'pre:config-protection': ['standard', 'strict'],
  'post:quality-gate': ['strict'],
  'prompt:workflow-steering': ['standard', 'strict'],
  'stop:goal-fit': ['standard', 'strict'],
  // Station-side policy class (S3 item 4): no canonical hook script exists
  // upstream yet — the L3 spec proposal asks for one. Same profile gating
  // and SA_DISABLED_HOOKS contract as the canonical four.
  'pre:platform-mutation': ['standard', 'strict'],
};

const VALID_PROFILES: ReadonlySet<string> = new Set([
  'minimal',
  'standard',
  'strict',
]);

/**
 * Protected linter/formatter config files — mirrors PROTECTED_FILES in
 * config-protection.js. Used ONLY when the native engine is unavailable
 * (same built-in guard shape as the Strands PolicyGate reference).
 */
const PROTECTED_FILES: ReadonlySet<string> = new Set([
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'biome.json',
  'biome.jsonc',
  '.ruff.toml',
  'ruff.toml',
  '.shellcheckrc',
  '.stylelintrc',
  '.stylelintrc.json',
  '.stylelintrc.yml',
  '.markdownlint.json',
  '.markdownlint.yaml',
  '.markdownlintrc',
]);

/**
 * Write-like tool names — only write-like tools are policy-gated; reads pass.
 * Superset of the Strands PolicyGate reference set plus the file-write tool
 * names Station's managed runtimes and common MCP filesystem servers use.
 */
const DEFAULT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'fs_write',
  'apply_patch',
  'create_file',
  'str_replace_editor',
  'write_file',
  'edit_file',
  'file_write',
  'save_file',
]);

// ── Native engine plumbing (Form 2) ───────────────────

interface HookRunOutput {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}

type HookRunResult = string | HookRunOutput | Promise<string | HookRunOutput>;

interface HookModule {
  run(
    raw: string,
    options: { truncated: boolean; maxStdin: number },
  ): HookRunResult;
}

const HOOK_SCRIPTS = {
  'config-protection': 'config-protection.js',
  'quality-gate': 'quality-gate.js',
  'workflow-steering': 'workflow-steering.js',
  'stop-goal-fit': 'stop-goal-fit.js',
} as const;

type PolicyClass = keyof typeof HOOK_SCRIPTS;

/**
 * Who wrote a blocking verdict's `reason` (station#3210).
 *
 * `engine` cannot answer this and must not be used to guess it: the `native`
 * engine returns the hook process's own `stderr`/`stdout` on one path and
 * Station's own fallback literal on another, so it maps one-to-many onto
 * authorship. This field is declared by the branch that produced the string,
 * which is the only place that knows.
 *
 * The consumer (`pre-tool-policy.ts`) attributes the text to the external hook
 * unless this says `station`, so a future branch that returns a reason without
 * declaring authorship is quoted rather than spoken in Station's voice — the
 * safe direction of the two, since presenting foreign prose as Station's own
 * verdict is the defect station#3210 exists to close.
 */
export type PolicyReasonAuthor = 'station' | 'external-hook';

export type PolicyToolCallResult =
  | {
      decision: 'allow';
      reason?: string;
      engine: 'native' | 'typescript' | 'disabled';
    }
  | {
      decision: 'block';
      reason: string;
      /** Required on a block: a user-visible reason must name its author. */
      reasonAuthor: PolicyReasonAuthor;
      engine: 'native' | 'typescript' | 'disabled';
    };

export interface PolicyAfterWriteResult {
  warnings: string[];
}

export interface PolicyStopResult {
  verdict: 'pass' | 'warn' | 'block';
  warnings: string[];
  /** True when strict enforcement was active for this check. */
  strict: boolean;
}

export interface PolicyPlatformMutationResult {
  decision: 'allow' | 'warn' | 'block';
  reason?: string;
  /**
   * 'station' when the Station-side check ran; 'disabled' when the hook is
   * profile/env-disabled or the workspace is not policy-opted (zero change).
   */
  engine: 'station' | 'disabled';
  profile: PolicyHookProfile;
}

export interface SessionPolicyBinding {
  cwd: string;
  profile: PolicyHookProfile;
}

interface PolicyLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentPolicyServiceOptions {
  /**
   * Root of the @kontourai/flow-agents engine (the directory containing
   * scripts/hooks/run-hook.js, or the hooks directory itself). When provided
   * but invalid, the service falls back WITHOUT auto-discovery — an explicit
   * but wrong override must surface, per the PolicyGate reference.
   */
  engineRoot?: string;
  /** Env source for profile/strictness flags. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Additional write-like tool names to gate (merged with the default set). */
  writeToolNames?: Iterable<string>;
  logger?: PolicyLogger;
}

interface CheckContext {
  /** Attribute for station.policy.checks (managed/connected/acp/unknown). */
  runtimeKind?: string;
}

/** Resolve the session -> policy binding from canonical event history. */
export function resolveSessionPolicyBinding(
  events: CanonicalRuntimeEvent[],
): SessionPolicyBinding | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.method === 'policy.hooks-attached') {
      return { cwd: event.cwd, profile: event.profile };
    }
  }
  return null;
}

/** Extract the file path a write-like tool call targets, if any. */
export function extractToolFilePath(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const record = toolInput as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath', 'filepath']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export class AgentPolicyService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger?: PolicyLogger;
  private readonly writeTools: ReadonlySet<string>;
  private readonly hooksDir: string | null;
  private readonly hookModules = new Map<PolicyClass, HookModule | null>();
  private readonly warnedTypeScript = new Set<PolicyClass>();

  constructor(options: AgentPolicyServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.logger = options.logger;
    this.writeTools = options.writeToolNames
      ? new Set(
          [...DEFAULT_WRITE_TOOLS, ...options.writeToolNames].map((name) =>
            name.toLowerCase(),
          ),
        )
      : DEFAULT_WRITE_TOOLS;
    this.hooksDir = this.resolveHooksDir(options.engineRoot);
  }

  /** True when the canonical engine directory was found. */
  get engineAvailable(): boolean {
    return this.hooksDir !== null;
  }

  /** Active hook profile (SA_HOOK_PROFILE, default standard). */
  get profile(): PolicyHookProfile {
    const raw = String(this.env.SA_HOOK_PROFILE || 'standard')
      .trim()
      .toLowerCase();
    return (VALID_PROFILES.has(raw) ? raw : 'standard') as PolicyHookProfile;
  }

  /** Workspace opt-in: new or legacy Flow Agents sidecar root is present. */
  isWorkspaceOptedIn(cwd: string | undefined): boolean {
    if (!cwd) return false;
    return [flowAgentsRoot(cwd), legacyFlowAgentsRoot(cwd)].some(
      (candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      },
    );
  }

  /**
   * Walk up from a file path looking for an opted-in workspace root
   * (a directory containing `.kontourai/flow-agents/` or legacy
   * `.flow-agents/`). Used at tool seams where the session cwd is not in scope
   * but the write target is.
   */
  resolveOptedInWorkspace(filePath: string): string | null {
    let dir = path.resolve(path.dirname(filePath));
    const root = path.parse(dir).root;
    for (let depth = 0; depth < 40; depth += 1) {
      if (this.isWorkspaceOptedIn(dir)) return dir;
      if (dir === root) break;
      dir = path.dirname(dir);
    }
    return null;
  }

  /** True for write-like tool names (reads are never policy-gated). */
  isWriteTool(toolName: string): boolean {
    return this.writeTools.has(toolName.toLowerCase());
  }

  /**
   * Whether the Station-side platform-mutation class is enabled by the active
   * profile and explicit hook-disable list. This intentionally has no policy
   * decision, metric, or event side effect; callers use it to avoid work that
   * is irrelevant to an honestly inactive class.
   */
  isPlatformMutationEnabled(): boolean {
    return this.isHookEnabled('pre:platform-mutation');
  }

  /**
   * Config-protection policy (BLOCKING). Checks a tool call BEFORE execution.
   * Returns 'block' with the canonical reason when the call writes a
   * protected config file inside an opted-in workspace. Fail-open on every
   * error path.
   */
  checkToolCall(
    toolName: string,
    toolInput: unknown,
    context: CheckContext & { cwd?: string } = {},
  ): PolicyToolCallResult {
    if (!this.isHookEnabled('pre:config-protection')) {
      return { decision: 'allow', engine: 'disabled' };
    }
    if (!this.isWriteTool(toolName)) {
      return { decision: 'allow', engine: 'disabled' };
    }
    const filePath = extractToolFilePath(toolInput);
    if (!filePath) return { decision: 'allow', engine: 'disabled' };

    const optedIn = context.cwd
      ? this.isWorkspaceOptedIn(context.cwd)
      : this.resolveOptedInWorkspace(filePath) !== null;
    if (!optedIn) return { decision: 'allow', engine: 'disabled' };

    const result = this.runConfigProtection(toolName, filePath, toolInput);
    this.record('config-protection', result.decision, result.engine, context);
    return result;
  }

  /**
   * Quality-gate policy (non-blocking, strict profile only). Runs the
   * canonical per-file quality check after a successful write and returns
   * any warnings the hook logged. Never throws, never blocks.
   */
  afterWrite(
    filePath: string,
    context: CheckContext & { cwd?: string } = {},
  ): PolicyAfterWriteResult {
    if (!this.isHookEnabled('post:quality-gate')) return { warnings: [] };
    const optedIn = context.cwd
      ? this.isWorkspaceOptedIn(context.cwd)
      : this.resolveOptedInWorkspace(filePath) !== null;
    if (!optedIn) return { warnings: [] };

    const hook = this.loadHook('quality-gate');
    if (!hook) {
      this.warnTypeScriptOnce('quality-gate');
      return { warnings: [] };
    }

    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_input: { file_path: filePath },
    });
    const warnings: string[] = [];
    try {
      // quality-gate.js logs warnings straight to process.stderr; the run()
      // call is fully synchronous (spawnSync inside), so a synchronous
      // stderr intercept captures them safely.
      this.withEnvOverlay(
        {
          FLOW_AGENTS_HOOK_RUNTIME: 'station',
          SA_QUALITY_GATE_STRICT: this.env.SA_QUALITY_GATE_STRICT ?? 'true',
        },
        () => {
          const original = process.stderr.write.bind(process.stderr);
          (process.stderr as { write: unknown }).write = (
            chunk: unknown,
          ): boolean => {
            warnings.push(String(chunk).trimEnd());
            return true;
          };
          try {
            hook.run(payload, { truncated: false, maxStdin: MAX_STDIN });
          } finally {
            (process.stderr as { write: unknown }).write = original;
          }
        },
      );
    } catch (error) {
      this.logFailOpen('quality-gate', error);
      return { warnings: [] };
    }
    const filtered = warnings.filter(Boolean);
    this.record(
      'quality-gate',
      filtered.length > 0 ? 'warn' : 'pass',
      'native',
      context,
    );
    return { warnings: filtered };
  }

  /**
   * Workflow-steering policy (non-blocking). Returns the ambient steering
   * text the canonical hook would inject at the start of a turn for the
   * workspace's actor-scoped `.kontourai/flow-agents` state, or null when there is nothing
   * to say. Callers append it where they compose prompt context.
   */
  steeringContext(
    session: { cwd: string; actorKey?: string },
    context: CheckContext = {},
  ): string | null {
    if (!this.isHookEnabled('prompt:workflow-steering')) return null;
    if (!this.isWorkspaceOptedIn(session.cwd)) return null;

    const hook = this.loadHook('workflow-steering');
    if (!hook) {
      this.warnTypeScriptOnce('workflow-steering');
      return null;
    }

    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd: session.cwd,
    });
    try {
      const output = this.withEnvOverlay(
        {
          FLOW_AGENTS_HOOK_RUNTIME: 'station',
          ...(session.actorKey ? { FLOW_AGENTS_ACTOR: session.actorKey } : {}),
        },
        () => hook.run(payload, { truncated: false, maxStdin: MAX_STDIN }),
      );
      // The steering hook appends its hints to the raw payload and returns
      // the combined string; the injected context is the appended suffix.
      if (typeof output !== 'string' || output.length <= payload.length) {
        this.record('workflow-steering', 'pass', 'native', context);
        return null;
      }
      const steering = output.slice(payload.length).trim();
      if (!steering) {
        this.record('workflow-steering', 'pass', 'native', context);
        return null;
      }
      this.record('workflow-steering', 'inject', 'native', context);
      return steering;
    } catch (error) {
      this.logFailOpen('workflow-steering', error);
      return null;
    }
  }

  /**
   * Stop-goal-fit policy. Checks whether the workspace's active workflow is
   * being stopped short of its goal. Verdict 'block' only in strict mode
   * (SA_HOOK_PROFILE=strict or FLOW_AGENTS_GOAL_FIT_STRICT=true) when the
   * hook reports blocking findings; otherwise findings surface as 'warn'.
   *
   * Async because the canonical `stop-goal-fit` hook's
   * `run()` is async (Surface bundle load); its return shape is unchanged
   * (`string | {stdout,stderr,exitCode}`). The other three canonical hooks
   * stay synchronous, so only this seam awaits.
   */
  async checkStop(
    session: { cwd: string; actorKey?: string },
    context: CheckContext = {},
  ): Promise<PolicyStopResult> {
    const strict =
      this.profile === 'strict' ||
      /^(1|true|yes)$/i.test(
        String(this.env.FLOW_AGENTS_GOAL_FIT_STRICT || ''),
      );
    if (!this.isHookEnabled('stop:goal-fit')) {
      return { verdict: 'pass', warnings: [], strict };
    }
    if (!this.isWorkspaceOptedIn(session.cwd)) {
      return { verdict: 'pass', warnings: [], strict };
    }

    const hook = this.loadHook('stop-goal-fit');
    if (!hook) {
      this.warnTypeScriptOnce('stop-goal-fit');
      return { verdict: 'pass', warnings: [], strict };
    }

    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      cwd: session.cwd,
    });
    try {
      const output = await this.withEnvOverlayAsync(
        {
          FLOW_AGENTS_HOOK_RUNTIME: 'station',
          ...(session.actorKey ? { FLOW_AGENTS_ACTOR: session.actorKey } : {}),
          // Station's policy profile is authoritative over the verdict mode.
          // FLOW_AGENTS_GOAL_FIT_MODE takes
          // precedence over the legacy STRICT alias — set it explicitly so an
          // ambient GOAL_FIT_MODE can't override the profile. default → warn,
          // strict → block.
          FLOW_AGENTS_GOAL_FIT_MODE: strict ? 'block' : 'warn',
          FLOW_AGENTS_GOAL_FIT_STRICT: strict ? 'true' : 'false',
        },
        () => hook.run(payload, { truncated: false, maxStdin: MAX_STDIN }),
      );
      if (typeof output === 'string' || !output) {
        this.record('stop-goal-fit', 'pass', 'native', context);
        return { verdict: 'pass', warnings: [], strict };
      }
      const warnings = parseGoalFitWarnings(output.stderr);
      const verdict: PolicyStopResult['verdict'] =
        output.exitCode === 2
          ? strict
            ? 'block'
            : 'warn'
          : warnings.length > 0
            ? 'warn'
            : 'pass';
      this.record('stop-goal-fit', verdict, 'native', context);
      return { verdict, warnings, strict };
    } catch (error) {
      this.logFailOpen('stop-goal-fit', error);
      return { verdict: 'pass', warnings: [], strict };
    }
  }

  /**
   * Platform-mutation policy (S3 item 4) — a Station-side policy class in
   * the canonical fail-open pattern. Agent-driven platform mutations
   * (mutating station-control tool calls) in a policy-opted workspace
   * require an active gated Flow run (`runBound`); ungated mutations warn in
   * the default policy profile and BLOCK in the strict policy profile,
   * mirroring the stop-goal-fit policy semantics. Non-opted workspaces: zero change.
   */
  checkPlatformMutation(
    toolName: string,
    context: CheckContext & { cwd?: string; runBound?: boolean } = {},
  ): PolicyPlatformMutationResult {
    const profile = this.profile;
    try {
      if (!this.isPlatformMutationEnabled()) {
        return { decision: 'allow', engine: 'disabled', profile };
      }
      if (!this.isWorkspaceOptedIn(context.cwd)) {
        return { decision: 'allow', engine: 'disabled', profile };
      }
      if (context.runBound) {
        this.record('platform-mutation', 'allow', 'station', context);
        return { decision: 'allow', engine: 'station', profile };
      }
      const decision = profile === 'strict' ? 'block' : 'warn';
      const reason =
        decision === 'block'
          ? `BLOCKED: platform mutation '${toolName}' requires an active ` +
            'gated Flow run in this policy-opted workspace ' +
            `(strict profile). ${STANDARD_FLOW_BUILDER_GUIDANCE}, or disable ` +
            'the pre:platform-mutation hook ' +
            'temporarily via SA_DISABLED_HOOKS.'
          : `Platform mutation '${toolName}' is ungated: the workspace is ` +
            'policy-opted (.flow-agents/) but no active gated Flow run is ' +
            `bound. The mutation proceeds with a warning; ${STANDARD_FLOW_BUILDER_GUIDANCE}.`;
      this.record('platform-mutation', decision, 'station', context);
      return { decision, reason, engine: 'station', profile };
    } catch (error) {
      // Fail-open, per the PolicyGate reference: a policy-machinery error
      // must never block agent work.
      policyChecks.add(1, {
        policy: 'platform-mutation',
        outcome: 'error',
        engine: 'station',
        runtime_kind: context.runtimeKind ?? 'unknown',
      });
      this.logger?.warn('Platform-mutation policy errored — failing open', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { decision: 'allow', engine: 'station', profile };
    }
  }

  // ── internals ────────────────────────────────────────

  private runConfigProtection(
    toolName: string,
    filePath: string,
    toolInput: unknown,
  ): PolicyToolCallResult {
    const hook = this.loadHook('config-protection');
    if (hook) {
      const payload = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: {
          ...(typeof toolInput === 'object' && toolInput ? toolInput : {}),
          file_path: filePath,
        },
      });
      try {
        const result = this.withEnvOverlay(
          { FLOW_AGENTS_HOOK_RUNTIME: 'station' },
          () => hook.run(payload, { truncated: false, maxStdin: MAX_STDIN }),
        );
        if (
          result &&
          typeof result === 'object' &&
          (result as HookRunOutput).exitCode === 2
        ) {
          const output = result as HookRunOutput;
          // station#3210: the hook's own output and Station's fallback are
          // two different authors reached from the same `engine: 'native'`
          // branch, so authorship is decided here, where the two are still
          // distinguishable, rather than inferred downstream from `engine`.
          const hookOutput = output.stderr?.trim() || output.stdout?.trim();
          return hookOutput
            ? {
                decision: 'block',
                reason: hookOutput,
                reasonAuthor: 'external-hook',
                engine: 'native',
              }
            : {
                decision: 'block',
                reason:
                  'BLOCKED: config-protection policy blocked this action.',
                reasonAuthor: 'station',
                engine: 'native',
              };
        }
        return { decision: 'allow', engine: 'native' };
      } catch (error) {
        this.logFailOpen('config-protection', error);
        return { decision: 'allow', engine: 'native' };
      }
    }

    // Pure TypeScript guard — mirrors config-protection.js (documented set).
    this.warnTypeScriptOnce('config-protection');
    const basename = path.basename(filePath);
    if (PROTECTED_FILES.has(basename)) {
      return {
        decision: 'block',
        // Station's own remediation prose. `basename` is interpolated, but it
        // is a member of the closed `PROTECTED_FILES` set by the guard above,
        // so nothing model-controlled reaches the string.
        reason:
          `BLOCKED: Modifying ${basename} is not allowed. ` +
          'Fix the source code to satisfy linter/formatter rules instead of ' +
          'weakening the config. If this is a legitimate config change, ' +
          'disable the config-protection hook temporarily.',
        reasonAuthor: 'station',
        engine: 'typescript',
      };
    }
    return { decision: 'allow', engine: 'typescript' };
  }

  private isHookEnabled(hookId: string): boolean {
    const disabled = String(this.env.SA_DISABLED_HOOKS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (disabled.includes(hookId)) return false;
    const profiles = HOOK_PROFILES[hookId] ?? ['standard', 'strict'];
    return profiles.includes(this.profile);
  }

  private resolveHooksDir(engineRootOverride?: string): string | null {
    const asHooksDir = (candidate: string): string | null =>
      fs.existsSync(path.join(candidate, 'run-hook.js')) ? candidate : null;
    const asEngineRoot = (candidate: string): string | null =>
      asHooksDir(path.join(candidate, 'scripts', 'hooks')) ??
      asHooksDir(candidate);

    // 1. Explicit override — invalid overrides do NOT fall through.
    if (engineRootOverride !== undefined) {
      return asEngineRoot(engineRootOverride);
    }

    // 2. Env var.
    const envRoot = this.env.FLOW_AGENTS_ENGINE_ROOT;
    if (envRoot) {
      const resolved = asEngineRoot(envRoot);
      if (resolved) return resolved;
    }

    // 3. The installed npm package.
    try {
      const packageJson = require.resolve(
        '@kontourai/flow-agents/package.json',
      );
      const resolved = asEngineRoot(path.dirname(packageJson));
      if (resolved) return resolved;
    } catch {
      // not installed — use the built-in TypeScript guard
    }

    return null;
  }

  private loadHook(policy: PolicyClass): HookModule | null {
    if (this.hookModules.has(policy)) {
      return this.hookModules.get(policy) ?? null;
    }
    let loaded: HookModule | null = null;
    if (this.hooksDir) {
      const scriptPath = path.join(this.hooksDir, HOOK_SCRIPTS[policy]);
      try {
        const mod = require(scriptPath) as Partial<HookModule>;
        if (mod && typeof mod.run === 'function') {
          loaded = mod as HookModule;
        }
      } catch (error) {
        this.logger?.warn('Flow Agents policy hook failed to load', {
          policy,
          scriptPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.hookModules.set(policy, loaded);
    return loaded;
  }

  /**
   * The canonical hooks read flags from process.env. run() is synchronous,
   * so a synchronous set/restore overlay is race-free.
   */
  private withEnvOverlay<T>(overrides: Record<string, string>, fn: () => T): T {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** Keep async hook flags installed until its promise settles. */
  private async withEnvOverlayAsync<T>(
    overrides: Record<string, string>,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const run = asyncEnvOverlayTail.then(async () => {
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      try {
        return await fn();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
    asyncEnvOverlayTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private warnTypeScriptOnce(policy: PolicyClass): void {
    if (this.warnedTypeScript.has(policy)) return;
    this.warnedTypeScript.add(policy);
    this.logger?.warn(
      'Flow Agents policy engine unavailable — degrading (fail-open)',
      {
        policy,
        degradation:
          policy === 'config-protection'
            ? 'pure TypeScript protected-file guard'
            : 'policy disabled',
        hint: 'install @kontourai/flow-agents or set FLOW_AGENTS_ENGINE_ROOT',
      },
    );
  }

  private logFailOpen(policy: PolicyClass, error: unknown): void {
    policyChecks.add(1, {
      policy,
      outcome: 'error',
      engine: 'native',
      runtime_kind: 'unknown',
    });
    this.logger?.warn('Flow Agents policy hook errored — failing open', {
      policy,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private record(
    policy: PolicyClass | 'platform-mutation',
    outcome: string,
    engine: string,
    context: CheckContext,
  ): void {
    policyChecks.add(1, {
      policy,
      outcome,
      engine,
      runtime_kind: context.runtimeKind ?? 'unknown',
    });
  }
}

function parseGoalFitWarnings(stderr: string | undefined): string[] {
  if (!stderr) return [];
  return stderr
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^\[Hook\]/.test(line));
}

// ── Shared instance ────────────────────────────────────
//
// The policy service is stateless apart from the cached hook modules, so the
// runtime (agent hooks), chat preparation (steering), and orchestration
// (stop gate, post-hoc warnings) share one instance.

let sharedInstance: AgentPolicyService | null = null;

export function getAgentPolicyService(
  logger?: PolicyLogger,
): AgentPolicyService {
  if (!sharedInstance) {
    sharedInstance = new AgentPolicyService({ logger });
  }
  return sharedInstance;
}
