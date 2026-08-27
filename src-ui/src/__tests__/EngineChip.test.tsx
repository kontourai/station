// @vitest-environment jsdom

import { engineId } from '@kontourai/station-contracts/agent-identity';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { EngineChip } from '../components/badges/EngineChip';
import { agentEngineDescriptor } from '../utils/engine';

describe('agentEngineDescriptor', () => {
  test('unbound Station agents resolve to Station', () => {
    expect(agentEngineDescriptor({ slug: 'code-reviewer' })).toEqual({
      name: 'Station',
    });
    expect(
      agentEngineDescriptor({ slug: 'layout:agent', source: 'local' }),
    ).toEqual({ name: 'Station' });
  });

  test('external Agent rows resolve from explicit engine attribution', () => {
    expect(
      agentEngineDescriptor({
        slug: 'opencode',
        name: 'OpenCode',
        source: 'local',
        engineId: engineId('opencode'),
        engineDisplayName: 'OpenCode',
        execution: { agentConnectionId: 'opencode-connection' },
      }),
    ).toEqual({ name: 'OpenCode' });
  });

  test('engine-managed Agent rows resolve to Station', () => {
    expect(
      agentEngineDescriptor({
        slug: 'station',
        name: 'Bedrock',
        source: 'local',
        engineId: engineId('station'),
      }),
    ).toEqual({ name: 'Station' });
  });

  describe('persisted Agent engine projection', () => {
    test('Claude binding resolves through explicit server attribution', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-claude-agent',
          name: 'My Claude Agent',
          engineId: engineId('claude-code'),
          engineDisplayName: 'Claude Code',
          execution: { agentConnectionId: 'claude-runtime' },
        }),
      ).toEqual({ name: 'Claude Code' });
    });

    test('Codex binding resolves through explicit server attribution', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-codex-agent',
          name: 'My Codex Agent',
          engineId: engineId('codex'),
          engineDisplayName: 'Codex',
          execution: { agentConnectionId: 'codex-runtime' },
        }),
      ).toEqual({ name: 'Codex' });
    });

    test('Station engine identity wins over the bound model connection name', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-bedrock-agent',
          name: 'My Bedrock Agent',
          engineId: engineId('station'),
          execution: { agentConnectionId: 'bedrock-runtime' },
        }),
      ).toEqual({ name: 'Station' });
    });

    test('no execution binding at all resolves to Station', () => {
      expect(
        agentEngineDescriptor({
          slug: 'plain-agent',
          name: 'Plain Agent',
        }),
      ).toEqual({ name: 'Station' });
      expect(
        agentEngineDescriptor({
          slug: 'plain-agent',
          name: 'Plain Agent',
          execution: {},
        }),
      ).toEqual({ name: 'Station' });
    });
  });

  describe('server-resolved engine identity — engineDisplayName (production shape)', () => {
    // enriched-agents.ts's buildAgentPayload resolves this server-side by
    // looking up the persisted agent's execution.agentConnectionId against
    // the real runtime connection list — the only place that knows a
    // plugin-contributed connection's actual runtimeId/displayName/
    // engineId (adapter-shape.ts lets a provider adapter declare any
    // of these). Always preferred over the client-side heuristics below.

    test('plugin-managed connection (custom id, engineId "station") resolves to Station', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-plugin-managed-agent',
          name: 'My Plugin Agent',
          engineId: engineId('station'),
          engineDisplayName: 'Acme Managed Runtime',
          execution: { agentConnectionId: 'acme-managed-runtime' },
        }),
      ).toEqual({ name: 'Station' });
    });

    test('plugin-connected connection (custom id, non-station engineId) resolves to its real display name', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-plugin-connected-agent',
          name: 'My Plugin Agent',
          engineId: engineId('acme'),
          engineDisplayName: 'Acme Cloud Agent',
          execution: { agentConnectionId: 'acme-cloud-agent' },
        }),
      ).toEqual({ name: 'Acme Cloud Agent' });
    });

    test('a resolved connection with no classified engineId still names the engine (never Station by default)', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-plugin-agent',
          name: 'My Plugin Agent',
          engineDisplayName: 'Acme Cloud Agent',
          execution: { agentConnectionId: 'acme-cloud-agent' },
        }),
      ).toEqual({ name: 'Acme Cloud Agent' });
    });

    test('ollama-runtime binding resolves to Station via engineDisplayName-carried engineId', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-ollama-agent',
          name: 'My Ollama Agent',
          engineId: engineId('station'),
          engineDisplayName: 'Ollama',
          execution: { agentConnectionId: 'ollama-runtime' },
        }),
      ).toEqual({ name: 'Station' });
    });
  });

  describe('incomplete engine attribution fails closed', () => {
    test('an unknown connection id with a non-station engineId and no engineDisplayName renders no chip', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-plugin-connected-agent',
          name: 'My Plugin Agent',
          engineId: engineId('acme'),
          execution: { agentConnectionId: 'acme-cloud-agent' },
        }),
      ).toBeNull();
    });

    test('an unknown connection id with engineId absent and no engineDisplayName renders no chip', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-plugin-agent',
          name: 'My Plugin Agent',
          execution: { agentConnectionId: 'acme-cloud-agent' },
        }),
      ).toBeNull();
    });

    test('a binding without explicit engine attribution renders no chip', () => {
      expect(
        agentEngineDescriptor({
          slug: 'my-ollama-agent',
          name: 'My Ollama Agent',
          execution: { agentConnectionId: 'ollama-runtime' },
        }),
      ).toBeNull();
    });
  });

  test('command-backed Agent rows carry connectionName + model', () => {
    expect(
      agentEngineDescriptor({
        slug: 'opencode-conn-2',
        source: 'acp',
        engineConnectionType: 'acp',
        connectionName: 'OpenCode',
        model: 'GLM-4.7',
      }),
    ).toEqual({ name: 'OpenCode', model: 'GLM-4.7' });
    // The explicit engine connection type is sufficient.
    expect(
      agentEngineDescriptor({
        slug: 'kiro-modes',
        source: 'acp',
        engineConnectionType: 'acp',
        connectionName: 'Kiro',
      }),
    ).toEqual({ name: 'Kiro', model: undefined });
  });

  test('an ACP-connected agent with no resolvable name falls back to "Custom engine"', () => {
    expect(
      agentEngineDescriptor({
        slug: 'kiro-modes',
        engineConnectionType: 'acp',
      }),
    ).toEqual({ name: 'Custom engine', model: undefined });
  });

  test('an ACP-connected agent suppresses a model suffix that duplicates the resolved name or connection id (MED-1)', () => {
    // acp-manager-view.ts falls back `model` to the connection name/id when
    // there's no live current model reported yet — that must never render
    // as a self-referential "Kiro · Kiro" chip.
    expect(
      agentEngineDescriptor({
        slug: 'kiro',
        source: 'acp',
        engineConnectionType: 'acp',
        connectionName: 'Kiro',
        model: 'Kiro',
      }),
    ).toEqual({ name: 'Kiro', model: undefined });
    expect(
      agentEngineDescriptor({
        slug: 'kiro',
        source: 'acp',
        engineConnectionType: 'acp',
        connectionName: 'Kiro',
        model: 'kiro',
      }),
    ).toEqual({ name: 'Kiro', model: undefined });
    // Falls back to the raw connection id (not just the resolved display
    // name) when no connectionName/name resolves — acp-manager-view.ts's
    // own fallback chain tries the id last.
    expect(
      agentEngineDescriptor({
        slug: 'kiro',
        source: 'acp',
        engineConnectionType: 'acp',
        execution: { agentConnectionId: 'kiro' },
        model: 'kiro',
      }),
    ).toEqual({ name: 'Custom engine', model: undefined });
    // A genuinely distinct model still renders.
    expect(
      agentEngineDescriptor({
        slug: 'opencode-conn-2',
        source: 'acp',
        engineConnectionType: 'acp',
        connectionName: 'OpenCode',
        model: 'GLM-4.7',
      }),
    ).toEqual({ name: 'OpenCode', model: 'GLM-4.7' });
  });
});

describe('EngineChip', () => {
  test('renders nothing when the caller could not resolve the agent (LOW-1)', () => {
    const { container } = render(<EngineChip engine={null} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders a "Station" chip — no longer a no-badge default case', () => {
    render(<EngineChip engine={{ name: 'Station' }} />);
    expect(screen.getByText('Station')).toBeTruthy();
  });

  test('renders "<engine> · <model>" for ACP-connected agents with a distinguishing model', () => {
    render(<EngineChip engine={{ name: 'OpenCode', model: 'GLM-4.7' }} />);
    expect(screen.getByText('OpenCode · GLM-4.7')).toBeTruthy();
  });

  test('never renders "External" or "ACP" — permanent regression guard', () => {
    render(<EngineChip engine={{ name: 'Claude Code' }} />);
    expect(screen.queryByText('External')).toBeNull();
    expect(screen.queryByText('ACP')).toBeNull();
  });
});
