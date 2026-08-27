/**
 * station#3344: pins each engine's `imageInput` matrix cell to the SAME
 * declaration the server actually enforces.
 *
 * There are two places the answer "can a pasted image reach this model?" is
 * written down, and they are written down for different readers:
 *
 * - `ProviderAdapterShape.metadata.capabilities` includes `'image-input'`.
 *   `OrchestrationService.dispatchWithReceipt` reads exactly this before a
 *   turn and throws when an image-bearing turn meets an adapter without it.
 *   It is the ENFORCEMENT point, and it is only reachable from the server.
 * - `ENGINE_CAPABILITY_MATRICES[...].imageInput` is the DECLARATION the
 *   composer reads at paste time. A Station-engine chat has no engine
 *   connection to carry adapter metadata to the browser, so this cell is the
 *   only thing the composer can ask.
 *
 * Two writings of one fact drift. This test is the join: for every engine that
 * has both, the cell and the adapter must agree in both directions. If a new
 * engine gains image support in its adapter and nobody updates the cell, the
 * composer keeps refusing pastes it should accept — the exact defect #3344 was
 * filed for. If a cell claims support the adapter does not declare, the paste
 * is accepted and the dispatch throws.
 */

import {
  ENGINE_CAPABILITY_MATRICES,
  type EngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { describe, expect, test, vi } from 'vitest';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { MuseAdapter } from '../adapters/muse-adapter.js';
import { StationAgentAdapter } from '../adapters/station-agent-adapter.js';

function stationAgentApprovalDeps() {
  const eventBus = new EventBus();
  return {
    eventBus,
    approvalRegistry: new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    ),
  };
}

/**
 * The adapter that actually dispatches an interactive chat turn for each
 * engine, which is not always the only adapter carrying that engine id:
 * `bedrock-adapter` and `ollama-adapter` also declare `engineId('station')`,
 * but `execution-target-resolver.ts` routes an unbound Station agent — every
 * ordinary Station chat — to `station-agent`, whose relay is what carries the
 * image (station#1885). Naming the mapping here rather than deriving it from
 * `engineId` keeps that distinction visible instead of averaging three
 * adapters into one wrong answer.
 */
const INTERACTIVE_DISPATCH_ADAPTERS: {
  matrixKey: string;
  capabilities: readonly string[];
}[] = [
  {
    matrixKey: 'station',
    capabilities: new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...stationAgentApprovalDeps(),
    }).metadata.capabilities,
  },
  {
    matrixKey: 'claude',
    capabilities: new ClaudeAdapter().metadata.capabilities,
  },
  {
    matrixKey: 'codex',
    capabilities: new CodexAdapter().metadata.capabilities,
  },
  {
    matrixKey: 'acp',
    capabilities: new AcpAdapter({ getConnections: async () => [] }).metadata
      .capabilities,
  },
  { matrixKey: 'muse', capabilities: new MuseAdapter().metadata.capabilities },
];

describe('engine imageInput declaration', () => {
  test('every engine matrix carries an imageInput cell', () => {
    for (const [key, matrix] of Object.entries(ENGINE_CAPABILITY_MATRICES) as [
      string,
      EngineCapabilityMatrix,
    ][]) {
      expect(matrix.imageInput, `${key} has no imageInput cell`).toBeDefined();
      if (matrix.imageInput.state === 'unsupported') {
        // An unsupported cell is shown to the user verbatim at paste time. A
        // blank reason is a refusal that explains nothing.
        expect(matrix.imageInput.reason.length, key).toBeGreaterThan(0);
      }
    }
  });

  test.each(INTERACTIVE_DISPATCH_ADAPTERS)(
    '$matrixKey: the declared cell and the dispatching adapter agree',
    ({ matrixKey, capabilities }) => {
      const cell = ENGINE_CAPABILITY_MATRICES[matrixKey].imageInput;
      expect(cell.state === 'session').toBe(
        capabilities.includes('image-input'),
      );
    },
  );

  test('the join covers every engine the matrix declares', () => {
    // Review LOW-1: the previous comment here claimed to catch an adapter
    // MISSING from the list, which it cannot — it filters that same list.
    // What it can check is the other side of the join: every engine with a
    // matrix entry has a dispatching adapter here, so adding an engine to
    // `ENGINE_CAPABILITY_MATRICES` without joining it reds rather than
    // passing vacuously.
    expect(
      INTERACTIVE_DISPATCH_ADAPTERS.map((entry) => entry.matrixKey).sort(),
    ).toEqual(Object.keys(ENGINE_CAPABILITY_MATRICES).sort());
    const declaringEngines = INTERACTIVE_DISPATCH_ADAPTERS.filter((entry) =>
      entry.capabilities.includes('image-input'),
    ).map((entry) => entry.matrixKey);
    expect(declaringEngines.sort()).toEqual([
      'acp',
      'claude',
      'codex',
      'station',
    ]);
  });
});
