import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  mcpUiToolCallEvidenceAttached: { add: vi.fn() },
}));

const { FlowMcpUiEvidenceBridge } = await import(
  '../flow-mcp-ui-evidence-bridge.js'
);

import type { ResolvedMcpUiCall } from '../flow-mcp-ui-evidence-bridge.js';
import type { SessionFlowBinding } from '../orchestration-flow-gate.js';

const BINDING: SessionFlowBinding = {
  runId: 'run-1',
  definitionId: 'test-flow',
  cwd: '/ws',
};

const CALL: ResolvedMcpUiCall = {
  serverId: 'survey-mcp',
  toolName: 'render',
  arguments: { width: 200 },
  result: { content: [{ type: 'text', text: 'ok' }] },
};

function gateExpecting(claimType: string) {
  return {
    expects: [{ id: 'e1', kind: 'trust.bundle', bundle_claim: { claimType } }],
  };
}

describe('FlowMcpUiEvidenceBridge', () => {
  let getRun: ReturnType<typeof vi.fn>;
  let attachCommandEvidenceResult: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    attachCommandEvidenceResult = vi.fn().mockResolvedValue({});
  });

  function makeBridge(runResult: unknown, claimType?: string) {
    getRun = vi.fn().mockResolvedValue(runResult);
    const flowRunService = {
      getRun,
      attachCommandEvidenceResult,
    } as unknown as ConstructorParameters<
      typeof FlowMcpUiEvidenceBridge
    >[0]['flowRunService'];
    return new FlowMcpUiEvidenceBridge({ flowRunService, claimType });
  }

  test('attaches command evidence to an open gate that expects the claim type', async () => {
    const bridge = makeBridge({
      definition: {
        id: 'test-flow',
        gates: { 'tooling-gate': gateExpecting('quality.tooling') },
      },
      openGates: [{ id: 'tooling-gate', step: 'verify' }],
    });

    const outcome = await bridge.attach(BINDING, CALL);

    expect(outcome).toEqual({ attached: true, gateId: 'tooling-gate' });
    expect(attachCommandEvidenceResult).toHaveBeenCalledWith(
      '/ws',
      'run-1',
      expect.objectContaining({
        command: 'mcp-ui:survey-mcp/render',
        // station#4237: the call ran inside the MCP server, so there is no
        // process exit code and no duration Station could have measured. The
        // passing claim derives from the observed fact instead — the approved
        // call returned a result rather than throwing.
        exitCode: null,
        durationMs: null,
        observedStatus: 'success',
      }),
      expect.objectContaining({
        gate: 'tooling-gate',
        claimType: 'quality.tooling',
        producer: 'station/mcp-ui-auto',
      }),
    );
  });

  test('is audit-only (no attach) when no open gate expects the claim type', async () => {
    const bridge = makeBridge({
      definition: {
        id: 'test-flow',
        gates: { 'other-gate': gateExpecting('quality.tests') },
      },
      openGates: [{ id: 'other-gate', step: 'test' }],
    });

    const outcome = await bridge.attach(BINDING, CALL);

    expect(outcome).toEqual({ attached: false, reason: 'no-gate' });
    expect(attachCommandEvidenceResult).not.toHaveBeenCalled();
  });

  test('only considers OPEN gates (a closed gate expecting the claim is skipped)', async () => {
    const bridge = makeBridge({
      definition: {
        id: 'test-flow',
        gates: { 'tooling-gate': gateExpecting('quality.tooling') },
      },
      openGates: [],
    });

    const outcome = await bridge.attach(BINDING, CALL);

    expect(outcome.attached).toBe(false);
    expect(attachCommandEvidenceResult).not.toHaveBeenCalled();
  });

  test('honors a configured claim type', async () => {
    const bridge = makeBridge(
      {
        definition: {
          id: 'test-flow',
          gates: { g: gateExpecting('custom.mcp-ui') },
        },
        openGates: [{ id: 'g', step: 'verify' }],
      },
      'custom.mcp-ui',
    );

    const outcome = await bridge.attach(BINDING, CALL);

    expect(outcome.attached).toBe(true);
    expect(attachCommandEvidenceResult).toHaveBeenCalledWith(
      '/ws',
      'run-1',
      expect.anything(),
      expect.objectContaining({ claimType: 'custom.mcp-ui' }),
    );
  });
});
