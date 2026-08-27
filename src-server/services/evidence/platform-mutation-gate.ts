/**
 * Platform-mutation gate (roadmap S3 item 4): agent-driven `station-control`
 * mutations become policy-gated operations.
 *
 * Why this seam: station-control tool calls reach execution over several
 * dispatch paths — regular managed agents (hooked), the default agent (a
 * temp agent, hooked since station#1834), voice agents (hooked since #2016
 * closed: `voice-session.ts`'s `beforeToolCall` delegates to the supplied
 * hooks and fails closed on a gate error), and the raw REST dispatch
 * `POST /agents/:slug/tools/:toolName` (`tool.execute()` directly). The
 * hook-free path (the raw REST dispatch) never reaches the S3-A pre-dispatch seam, and even the
 * hooked ones' config-protection policy ignores non-file tools. Wrapping the Tool objects'
 * `execute` at LOAD time (this module) is the one choke point all of those
 * paths share, so the gate cannot be bypassed by the dispatch route.
 *
 * Semantics (S3-A profile contract, applied to the Station-side
 * `pre:platform-mutation` policy class):
 *   - workspace not policy-opted (no `.flow-agents/`)  → zero change
 *   - opted + active gated Flow run in the workspace   → allow; the mutation
 *     is attached to the run as a command-style audit evidence record
 *   - opted + ungated, default policy profile           → warn (canonical
 *     `platform.mutation` event with outcome 'warned'), execution proceeds
 *   - opted + ungated, strict profile                   → BLOCK; the reason
 *     is thrown so it reaches the model as tool-result text (the FA-2 reason
 *     channel the L3 spec requires)
 *
 * Every mutating call in an opted workspace appends a structured audit
 * record: the canonical `platform.mutation` event (persisted to the
 * orchestration event store via the configured sink) plus the optional Flow
 * evidence attachment when a run is bound. Gate-evaluation errors fail
 * closed and are receipted as blocked; receipt/evidence-write errors remain
 * fail-open after a decision has been made.
 */

import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PlatformMutationEvent,
  PlatformMutationOutcome,
  PolicyHookProfile,
} from '@kontourai/station-contracts/runtime-events';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import {
  bareControlToolName,
  classifyControlTool,
} from '../../runtime/tools/runtime-control-tools.js';
import { platformMutations } from '../../telemetry/metrics.js';
import {
  type AgentPolicyService,
  getAgentPolicyService,
} from '../agents/agent-policy-service.js';
import type { FlowRunService } from '../flow/flow-run-service.js';
import { buildSyntheticTrustBundle } from './trust-bundle.js';

const ARGS_SUMMARY_MAX_CHARS = 512;
const SECRET_KEY_PATTERN = /key|token|secret|password|credential/i;

interface GateLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface PlatformMutationGateOptions {
  /** Defaults to the shared AgentPolicyService instance. */
  policyService?: AgentPolicyService;
  /** When absent, no run binding is ever resolved (ungated path). */
  flowRunService?: FlowRunService;
  /**
   * Canonical-event sink. The runtime wires this to the orchestration event
   * store + event bus; unwired (unit) contexts simply skip event emission.
   */
  emitEvent?: (event: PlatformMutationEvent) => void;
  /**
   * The workspace the platform's own governance opt-in is read from.
   * Defaults to the Station server's working directory — platform
   * self-mutations are scoped to the instance, and the instance's governance
   * workspace is where it runs.
   */
  workspaceCwd?: string;
  logger?: GateLogger;
}

export interface MutationCallContext {
  /** Tool name as dispatched (possibly loader-prefixed/normalized). */
  toolName: string;
  toolArgs: unknown;
  agentSlug?: string;
  conversationId?: string;
}

export interface MutationTicket {
  /** False ⇒ non-opted/disabled: no audit, no events, zero change. */
  active: boolean;
  decision: 'allow' | 'warn' | 'block';
  reason?: string;
  profile: PolicyHookProfile;
  cwd: string;
  /** Bare station-control tool name. */
  tool: string;
  argsSummary: string;
  binding?: { runId: string; gateId?: string };
  context: MutationCallContext;
}

/** Truncated, secret-redacted JSON summary of tool arguments. */
export function summarizeToolArgs(toolArgs: unknown): string {
  try {
    const json = JSON.stringify(toolArgs ?? {}, (key, value) => {
      if (key && SECRET_KEY_PATTERN.test(key)) return '[redacted]';
      return value;
    });
    const text = json ?? '{}';
    return text.length > ARGS_SUMMARY_MAX_CHARS
      ? `${text.slice(0, ARGS_SUMMARY_MAX_CHARS)}…`
      : text;
  } catch {
    return '[unserializable]';
  }
}

export class PlatformMutationGate {
  private readonly options: PlatformMutationGateOptions;

  constructor(options: PlatformMutationGateOptions = {}) {
    this.options = options;
  }

  private get policyService(): AgentPolicyService {
    return this.options.policyService ?? getAgentPolicyService();
  }

  private get workspaceCwd(): string {
    return this.options.workspaceCwd ?? process.cwd();
  }

  /**
   * Pre-dispatch check for a mutating station-control call. Returns the
   * ticket the wrapper threads into `afterMutation`. A 'block' decision has
   * already been audited when this returns.
   */
  async beforeMutation(context: MutationCallContext): Promise<MutationTicket> {
    const tool = bareControlToolName(context.toolName);
    const inactive: MutationTicket = {
      active: false,
      decision: 'allow',
      profile: this.policyService.profile,
      cwd: this.workspaceCwd,
      tool,
      argsSummary: '',
      context,
    };
    try {
      const cwd = this.workspaceCwd;
      if (!this.policyService.isWorkspaceOptedIn(cwd)) {
        return inactive;
      }
      // This query is deliberately side-effect-free. Disabled/minimal is an
      // honest inactive state, even when Flow's run store cannot be
      // enumerated; the stateful policy decision runs only after the actual
      // binding value is known.
      if (!this.policyService.isPlatformMutationEnabled()) {
        return inactive;
      }
      const binding = await this.resolveActiveRunBinding(cwd);
      const verdict = this.policyService.checkPlatformMutation(tool, {
        cwd,
        runBound: binding !== undefined,
        runtimeKind: 'managed',
      });
      const ticket: MutationTicket = {
        active: true,
        decision: verdict.decision,
        reason: verdict.reason,
        profile: verdict.profile,
        cwd,
        tool,
        argsSummary: summarizeToolArgs(context.toolArgs),
        binding,
        context,
      };
      if (ticket.decision === 'block') {
        // Blocked calls never reach afterMutation — audit here.
        await this.audit(ticket, 'blocked');
      }
      return ticket;
    } catch (error) {
      const reason =
        'BLOCKED: platform-mutation policy evaluation failed; mutation was not executed.';
      this.options.logger?.warn(
        'Platform-mutation gate evaluation failed — blocking mutation',
        {
          toolName: context.toolName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // An evaluation failure must not be indistinguishable from an honestly
      // inactive gate: the wrapper needs a blocking ticket and the event sink
      // needs an audit record for the denied mutation.
      const ticket: MutationTicket = {
        active: true,
        decision: 'block',
        reason,
        profile: this.policyService.profile,
        cwd: this.workspaceCwd,
        tool,
        argsSummary: summarizeToolArgs(context.toolArgs),
        context,
      };
      await this.audit(ticket, 'blocked');
      return ticket;
    }
  }

  /**
   * Post-execution audit for allowed/warned mutations. Appends the canonical
   * `platform.mutation` event and, when a run is bound, the Flow evidence
   * record. Fail-open: audit failures are logged, never thrown.
   */
  async afterMutation(
    ticket: MutationTicket,
    result: { outcome: 'success' | 'error'; errorMessage?: string },
  ): Promise<void> {
    if (!ticket.active) return;
    const outcome: PlatformMutationOutcome =
      result.outcome === 'error'
        ? 'failed'
        : ticket.decision === 'warn'
          ? 'warned'
          : 'allowed';
    await this.audit(ticket, outcome, result.errorMessage);
  }

  // ── internals ────────────────────────────────────────

  /**
   * The most recent non-completed run whose definition has gates: an "active
   * gated Flow run" in the workspace. Flow's summary-only list intentionally
   * omits unreadable run locations, so the diagnostics-bearing contract is
   * required here: any diagnostic makes binding selection incomplete and is
   * converted by the caller into an audited blocking decision.
   */
  private async resolveActiveRunBinding(
    cwd: string,
  ): Promise<{ runId: string; gateId?: string } | undefined> {
    const flowRunService = this.options.flowRunService;
    if (!flowRunService) return undefined;
    const { runs, diagnostics } =
      await flowRunService.listRunsWithDiagnostics(cwd);
    if (diagnostics.length > 0) {
      // Do not put Flow's run-location details into the mutation event or tool
      // result. The Flow service retains those diagnostics; this gate only
      // needs to deny a mutation whose binding cannot be selected safely.
      throw new Error('Flow run binding could not be resolved safely.');
    }
    const active = runs
      .filter((run) => run.status !== 'completed')
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    for (const candidate of active) {
      const run = await flowRunService.getRun(cwd, candidate.run_id);
      const gateIds = Object.keys(run.definition.gates ?? {});
      if (gateIds.length === 0) continue; // not a gated run
      const gateId = run.openGates[0]?.id ?? gateIds[0];
      return { runId: candidate.run_id, gateId };
    }
    return undefined;
  }

  private async audit(
    ticket: MutationTicket,
    outcome: PlatformMutationOutcome,
    errorMessage?: string,
  ): Promise<void> {
    platformMutations.add(1, {
      tool: ticket.tool,
      outcome,
      run_bound: String(ticket.binding !== undefined),
    });
    try {
      this.options.emitEvent?.(this.buildEvent(ticket, outcome));
    } catch (error) {
      this.options.logger?.warn('Platform-mutation event emission failed', {
        tool: ticket.tool,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (ticket.binding && outcome !== 'blocked') {
      await this.attachRunEvidence(ticket, outcome, errorMessage);
    }
  }

  /**
   * Command-evidence-style audit attachment: a structured JSON evidence file
   * (tool, args summary, caller, outcome) attached to the bound run's
   * current gate with claimType `station.platform-mutation`. The claim type
   * matches no station-delivery expectation, so the record is pure audit —
   * visible in the run's evidence manifest and report without satisfying or
   * failing any gate.
   */
  private async attachRunEvidence(
    ticket: MutationTicket,
    outcome: PlatformMutationOutcome,
    errorMessage?: string,
  ): Promise<void> {
    const flowRunService = this.options.flowRunService;
    const binding = ticket.binding;
    if (!flowRunService || !binding?.gateId) return;
    try {
      const evidenceDir = await createStationTempDir('platform-mutation');
      // Flow 1.3.x evidence is a Hachure TrustBundle, not a legacy claim record.
      // Assert a synthetic Station bundle carrying claimType
      // `station.platform-mutation` (status `assumed`). The claim type matches
      // no station-delivery expectation, so the record stays pure audit; we
      // never set entry status `failed`, so a failed mutation can't route a
      // gate back. The outcome and tool (+ any error) are recorded on the claim
      // for at-a-glance manifest audit; the full mutation detail rides the
      // emitted PlatformMutationEvent.
      const bundlePath = join(evidenceDir, 'platform-mutation.json');
      await writeFile(
        bundlePath,
        `${JSON.stringify(
          buildSyntheticTrustBundle({
            claimType: 'station.platform-mutation',
            subjectId: binding.runId,
            value: outcome,
            fieldOrBehavior: errorMessage
              ? `${ticket.tool}: ${errorMessage}`
              : ticket.tool,
          }),
          null,
          2,
        )}\n`,
      );
      await flowRunService.attachEvidence(ticket.cwd, binding.runId, {
        gate: binding.gateId,
        file: bundlePath,
        kind: 'trust.bundle',
        producer: 'station/platform-mutation-gate',
        // Pure audit record: never bind gate expectations or drive route-back.
        expectationIds: [],
      });
    } catch (error) {
      this.options.logger?.warn(
        'Platform-mutation evidence attachment failed (fail-open)',
        {
          tool: ticket.tool,
          runId: binding.runId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private buildEvent(
    ticket: MutationTicket,
    outcome: PlatformMutationOutcome,
  ): PlatformMutationEvent {
    return {
      eventId: crypto.randomUUID(),
      provider: 'station',
      threadId:
        ticket.context.conversationId ??
        `agent:${ticket.context.agentSlug ?? 'unknown'}`,
      createdAt: new Date().toISOString(),
      method: 'platform.mutation',
      tool: ticket.tool,
      argsSummary: ticket.argsSummary,
      ...(ticket.context.agentSlug
        ? { agentSlug: ticket.context.agentSlug }
        : {}),
      ...(ticket.context.conversationId
        ? { conversationId: ticket.context.conversationId }
        : {}),
      outcome,
      decision: ticket.decision,
      profile: ticket.profile,
      cwd: ticket.cwd,
      ...(ticket.binding ? { runId: ticket.binding.runId } : {}),
      ...(ticket.binding?.gateId ? { gateId: ticket.binding.gateId } : {}),
      ...(ticket.reason ? { reason: ticket.reason } : {}),
    };
  }
}

// ── Tool wrapping (the execution seam) ─────────────────

interface GatedToolShape {
  name: string;
  execute?: (args: any, execOptions?: any) => Promise<unknown> | unknown;
}

/**
 * Wrap the MUTATING station-control tools of an integration so every
 * dispatch path (managed chat with hooks, default/voice temp agents without
 * hooks, raw REST tool dispatch, scheduler) executes through the
 * platform-mutation gate. Read-only tools are returned untouched. Tools of
 * any other integration are returned untouched.
 */
export function wrapPlatformMutationGatedTools<T extends GatedToolShape>(
  tools: T[],
  options: { agentSlug: string; toolId: string },
): T[] {
  if (options.toolId !== 'station-control') {
    return tools;
  }

  return tools.map((tool) => {
    if (classifyControlTool(tool.name) !== 'mutating') return tool;
    const execute = tool.execute;
    if (typeof execute !== 'function') return tool;

    return {
      ...tool,
      execute: async (args: any, execOptions?: any) => {
        const gate = getPlatformMutationGate();
        const ticket = await gate.beforeMutation({
          toolName: tool.name,
          toolArgs: args,
          agentSlug: options.agentSlug,
          conversationId:
            typeof execOptions?.conversationId === 'string'
              ? execOptions.conversationId
              : undefined,
        });
        if (ticket.decision === 'block') {
          // The thrown message becomes the tool result the model sees —
          // the block reason reaches the agent (FA-2 / L3 reason channel).
          throw new Error(
            ticket.reason ??
              'BLOCKED: platform mutation blocked by the platform-mutation policy.',
          );
        }
        try {
          const result = await execute.call(tool, args, execOptions);
          await gate.afterMutation(ticket, { outcome: 'success' });
          return result;
        } catch (error) {
          await gate.afterMutation(ticket, {
            outcome: 'error',
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    };
  });
}

// ── Shared instance ────────────────────────────────────

let sharedGate: PlatformMutationGate | null = null;

/** Configure the shared gate (runtime bootstrap). Returns the instance. */
export function configurePlatformMutationGate(
  options: PlatformMutationGateOptions,
): PlatformMutationGate {
  sharedGate = new PlatformMutationGate(options);
  return sharedGate;
}

/**
 * Shared gate accessor. Unconfigured contexts get a default instance with no
 * Flow service and no event sink — in a non-opted workspace that is fully
 * inert (zero change).
 */
function getPlatformMutationGate(): PlatformMutationGate {
  if (!sharedGate) {
    sharedGate = new PlatformMutationGate();
  }
  return sharedGate;
}

/** Test seam: replace or reset the shared instance. */
export function setPlatformMutationGateForTesting(
  gate: PlatformMutationGate | null,
): void {
  sharedGate = gate;
}
