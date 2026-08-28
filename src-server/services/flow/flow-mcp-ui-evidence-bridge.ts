/**
 * FlowMcpUiEvidenceBridge — S2 wiring: a resolved (human-approved) MCP-UI
 * tool-call result into the Flow half of the evidence pipeline.
 *
 * Mirrors {@link FlowCommandEvidenceBridge}: rather than re-running anything, it
 * takes the already-captured MCP-UI tool-call result and attaches it as
 * `station.command-evidence` via {@link FlowRunService.attachCommandEvidenceResult}
 * (the same kind/shape used for command evidence — an MCP-UI call is just
 * another captured artifact). It only attaches when the bound run has an OPEN
 * gate expecting the configured claim type, so a session with no relevant gate
 * gets an audit receipt (the inbox approval) but no evidence noise.
 *
 * Today only sessions that carry a `threadId` into the tool-call route reach
 * here; layout-tab MCP-UI panels without session context are gated + audited
 * but produce no Flow evidence. The mechanism is ready for when MCP-UI frames
 * gain session context.
 *
 * Telemetry: attachments are counted here
 * (`station.mcp_ui.tool_call_evidence.attached`) and again by FlowRunService
 * (`station.flow.evidence.attached`).
 */

import { mcpUiToolCallEvidenceAttached } from '../../telemetry/metrics.js';
import { gateExpectsClaim } from '../evidence/command-evidence-routing-policy.js';
import type { FlowRunService } from './flow-run-service.js';
import type { SessionFlowBinding } from './orchestration-flow-gate.js';

/** Default claim type a generic MCP-UI tool call asserts when a gate wants it. */
const DEFAULT_MCP_UI_CLAIM_TYPE = 'quality.tooling';

/** Producer recorded on auto-attached MCP-UI command evidence. */
const MCP_UI_EVIDENCE_PRODUCER = 'station/mcp-ui-auto';

/** A resolved MCP-UI tool call awaiting evidence attachment. */
export interface ResolvedMcpUiCall {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface McpUiEvidenceOutcome {
  attached: boolean;
  gateId?: string;
  reason?: string;
}

function stringifyResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export class FlowMcpUiEvidenceBridge {
  private readonly claimType: string;

  constructor(
    private readonly deps: {
      flowRunService: FlowRunService;
      claimType?: string;
    },
  ) {
    this.claimType = deps.claimType ?? DEFAULT_MCP_UI_CLAIM_TYPE;
  }

  /**
   * Attach an approved MCP-UI tool call's result to the bound run's gate as
   * command evidence (no re-run). No-op (audit-only) when no OPEN gate expects
   * the claim type. Fail-soft: callers never block the tool result on this.
   */
  async attach(
    binding: SessionFlowBinding,
    call: ResolvedMcpUiCall,
  ): Promise<McpUiEvidenceOutcome> {
    const { flowRunService } = this.deps;
    const run = await flowRunService.getRun(binding.cwd, binding.runId);
    const openIds = new Set(run.openGates.map((gate) => gate.id));
    const gateId = Object.keys(run.definition.gates ?? {}).find(
      (id) =>
        openIds.has(id) && gateExpectsClaim(run.definition, id, this.claimType),
    );
    if (!gateId) {
      return { attached: false, reason: 'no-gate' };
    }

    const label = `mcp-ui:${call.serverId}/${call.toolName}`;
    await flowRunService.attachCommandEvidenceResult(
      binding.cwd,
      binding.runId,
      {
        command: label,
        output: stringifyResult(call.result),
        // The call ran inside the MCP server, not Station: there is no process
        // exit code and no measured duration, so neither is claimed
        // (archive#4237). Reaching here means the approved call returned a
        // result instead of throwing, which is the observed fact the passing
        // claim derives from. `outputTruncated` is genuinely false —
        // `stringifyResult` serializes the whole result Station holds.
        exitCode: null,
        observedStatus: 'success',
        timedOut: false,
        durationMs: null,
        outputTruncated: false,
      },
      {
        gate: gateId,
        claimType: this.claimType,
        label,
        producer: MCP_UI_EVIDENCE_PRODUCER,
      },
    );
    mcpUiToolCallEvidenceAttached.add(1, {
      server: call.serverId,
      tool: call.toolName,
      gate: gateId,
      status: 'pass',
    });
    return { attached: true, gateId };
  }
}
