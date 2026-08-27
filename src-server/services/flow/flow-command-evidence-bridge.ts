/**
 * FlowCommandEvidenceBridge — the S1a slice 3 wiring: tool-call command output
 * into the Flow half of the evidence pipeline, WITHOUT re-running the command.
 *
 * Mirrors {@link FlowReadinessBridge}: orchestration spools command output as
 * tool calls complete (`spool`), and the flow completion gate drains the spool
 * before evaluating (`attachSpooledEvidence`), so a gate that expects e.g. a
 * `quality.tests` claim sees the evidence the agent already produced by running
 * the tests — no duplicate execution. Routing (which command satisfies which
 * gate) is delegated to a {@link CommandEvidenceRoutingPolicy}.
 *
 * Telemetry: spooled commands and attachments are counted here
 * (`station.flow.tool_evidence.*`); the underlying attach is also counted by
 * FlowRunService (`station.flow.evidence.attached`).
 */

import {
  flowToolEvidenceAttached,
  flowToolEvidenceSpooled,
} from '../../telemetry/metrics.js';
import type {
  CommandEvidenceRoute,
  CommandEvidenceRoutingPolicy,
  SpooledCommand,
} from '../evidence/command-evidence-routing-policy.js';
import type { FlowRunService } from './flow-run-service.js';
import { commandOutcomePassed } from './flow-run-service.js';
import type { SessionFlowBinding } from './orchestration-flow-gate.js';

/** Per-thread spool cap — drop oldest beyond this; never throw. */
const MAX_SPOOLED_PER_THREAD = 100;

/** Producer recorded on auto-attached command evidence. */
const AUTO_COMMAND_PRODUCER = 'station/command-auto';

export interface CommandEvidenceAttachOutcome {
  attached: boolean;
  route?: CommandEvidenceRoute;
  reason?: string;
}

export class FlowCommandEvidenceBridge {
  private readonly spools = new Map<string, SpooledCommand[]>();

  constructor(
    private readonly deps: {
      flowRunService: FlowRunService;
      policy: CommandEvidenceRoutingPolicy;
    },
  ) {}

  /** Buffer a completed command for the thread (oldest dropped past the cap). */
  spool(threadId: string, cmd: SpooledCommand): void {
    const buffer = this.spools.get(threadId) ?? [];
    buffer.push(cmd);
    if (buffer.length > MAX_SPOOLED_PER_THREAD) {
      buffer.splice(0, buffer.length - MAX_SPOOLED_PER_THREAD);
    }
    this.spools.set(threadId, buffer);
    flowToolEvidenceSpooled.add(1, { tool: cmd.toolName });
  }

  hasSpooled(threadId: string): boolean {
    return (this.spools.get(threadId)?.length ?? 0) > 0;
  }

  clear(threadId: string): void {
    this.spools.delete(threadId);
  }

  /**
   * Route each spooled command for the thread to a gate and attach its evidence
   * (no re-run). The spool is ALWAYS cleared afterward — these are one-shot,
   * tied to the completion evaluation that follows. Fail-soft per command: a
   * routing/attach error is recorded and the next command still attempts.
   */
  async attachSpooledEvidence(
    binding: SessionFlowBinding,
    threadId: string,
  ): Promise<CommandEvidenceAttachOutcome[]> {
    const { flowRunService, policy } = this.deps;
    const buffer = this.spools.get(threadId) ?? [];
    if (buffer.length === 0) return [];

    const outcomes: CommandEvidenceAttachOutcome[] = [];
    try {
      const run = await flowRunService.getRun(binding.cwd, binding.runId);
      for (const cmd of buffer) {
        const route = policy.route(cmd, {
          definition: run.definition,
          openGates: run.openGates,
        });
        if (!route) {
          outcomes.push({ attached: false, reason: 'no-route' });
          continue;
        }
        // Built once so the telemetry verdict below cannot disagree with the
        // durable claim the attach writes.
        const outcome = {
          command: cmd.command,
          output: cmd.output,
          exitCode: cmd.exitCode,
          timedOut: cmd.timedOut,
          durationMs: cmd.durationMs,
          outputTruncated: cmd.outputTruncated,
          observedStatus: cmd.status,
        };
        try {
          await flowRunService.attachCommandEvidenceResult(
            binding.cwd,
            binding.runId,
            outcome,
            {
              gate: route.gateId,
              claimType: route.claimType,
              label: route.label,
              producer: AUTO_COMMAND_PRODUCER,
            },
          );
          flowToolEvidenceAttached.add(1, {
            gate: route.gateId,
            claim_type: route.claimType,
            status: commandOutcomePassed(outcome) ? 'pass' : 'fail',
          });
          outcomes.push({ attached: true, route });
        } catch (error: unknown) {
          outcomes.push({
            attached: false,
            route,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error: unknown) {
      // getRun failed — record one outcome so the caller can log, then fall
      // through to clear the spool (a stale binding never wedges the spool).
      outcomes.push({
        attached: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.clear(threadId);
    }
    return outcomes;
  }
}
