import {
  ENGINE_CAPABILITY_MATRICES,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { ProviderDurabilityProfile } from '@kontourai/station-contracts/provider';
import { describe, expect, test, vi } from 'vitest';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { BedrockAdapter } from '../adapters/bedrock-adapter.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { MuseAdapter } from '../adapters/muse-adapter.js';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';
import { StationAgentAdapter } from '../adapters/station-agent-adapter.js';

const eventBus = new EventBus();
const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new AcpAdapter({ getConnections: async () => [] }),
  new MuseAdapter(),
  new BedrockAdapter(),
  new OllamaAdapter(),
  new StationAgentAdapter({
    apiBase: 'http://127.0.0.1:13575',
    hasAgent: () => true,
    eventBus,
    approvalRegistry: new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    ),
  }),
];

// Public profile shape: omission must fail instead of silently becoming unsupported.
const fields = {
  steerPlacement: true,
  crashContinuation: true,
  toolReplay: true,
  pendingApprovals: true,
  contextCarriage: true,
  fork: true,
  compaction: true,
  partialOutput: true,
  usage: true,
} satisfies Record<keyof ProviderDurabilityProfile, true>;

describe('built-in adapter durability conformance', () => {
  test.each(adapters)(
    '$provider declares the complete profile with disclosed limits',
    (adapter) => {
      const profile = adapter.metadata.durability;
      expect(profile).toBeDefined();
      expect(Object.keys(profile ?? {}).sort()).toEqual(
        Object.keys(fields).sort(),
      );
      expect(['station', 'engine', 'unknown']).toContain(
        profile?.compaction.owner,
      );
      for (const cell of Object.values(profile ?? {})) {
        expect(['native', 'emulated', 'none']).toContain(cell.state);
        expect(cell.detail.trim().length).toBeGreaterThan(0);
      }
    },
  );

  test('editor and dispatch declarations agree for every interactive engine', () => {
    const interactive = adapters.filter(
      (adapter) => !['bedrock', 'ollama'].includes(adapter.provider),
    );
    expect(
      interactive.map((adapter) => adapter.metadata.engineId).sort(),
    ).toEqual(Object.keys(ENGINE_CAPABILITY_MATRICES).sort());
    for (const adapter of interactive) {
      expect(adapter.metadata.durability).toEqual(
        ENGINE_CAPABILITY_MATRICES[adapter.metadata.engineId ?? ''].durability,
      );
    }
    expect(
      Object.keys(UNKNOWN_EXTERNAL_ENGINE_MATRIX.durability).sort(),
    ).toEqual(Object.keys(fields).sort());
  });
});
