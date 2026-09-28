/**
 * Contract: no engine default starts spec-less. An engine-default alias row
 * in the New Chat picker is unavailable until the user enables the engine by
 * creating an authored Agent for it; that authored Agent (and the
 * runtime-owned `station` identity) is what starts.
 *
 * archive#3027 history: the original gate was claude-only, which bricked the
 * default Claude agent while every other engine default started spec-less —
 * an asymmetry this suite pinned with a shrink-only KNOWN_UNSTARTABLE
 * allowlist. The symmetric fix removed the allowlist and flipped the
 * contract: every provider now refuses a spec-less default and accepts a
 * resolved one. The gate is provider-INDEPENDENT — kiro/opencode dispatch at
 * runtime with provider 'acp', so any provider name-list would silently miss
 * them. The gate takes no provider input at all, so that independence holds
 * by construction rather than by a per-provider table here.
 */
import { sessionDeliveryChannels } from '@kontourai/station-contracts/engine-capability-matrix';
import { describe, expect, test } from 'vitest';
import { sessionAgentStartUnavailableReason } from '../session-agent-resolution';

describe('no engine default starts spec-less (contract)', () => {
  test('a spec-less engine default refuses and names the enable remedy', () => {
    const reason = sessionAgentStartUnavailableReason({
      agentSlug: 'kiro',
      // An engine-default alias has no authored spec — the exact state
      // `enriched-agents.ts` computes for every non-station default.
      hasResolvedAgent: false,
    });
    expect(reason).not.toBeNull();
    // The refusal must tell the user how to get a startable agent, not
    // just that this row is dead.
    expect(reason).toMatch(/creating an Agent/i);
  });

  test('a resolved authored Agent starts', () => {
    expect(
      sessionAgentStartUnavailableReason({
        agentSlug: 'kiro',
        hasResolvedAgent: true,
      }),
    ).toBeNull();
  });

  test('station itself always resolves', () => {
    expect(
      sessionAgentStartUnavailableReason({
        agentSlug: 'station',
        // enriched-agents grants station the runtime-owned spec.
        hasResolvedAgent: true,
      }),
    ).toBeNull();
  });
});

/**
 * Every provider id a Station runtime registers an adapter for. There is no
 * exported list — adapters are constructed one by one in
 * `src-server/runtime/bootstrap/station-runtime.ts` (bedrock, claude, codex,
 * muse, ollama) and `runtime-initialize.ts` (acp, station-agent) — so this
 * list is maintained by hand alongside those construction sites.
 */
const REGISTERED_ADAPTER_PROVIDERS = [
  'acp',
  'bedrock',
  'claude',
  'codex',
  'muse',
  'ollama',
  'station-agent',
] as const;

/**
 * The providers `resolveSessionAgentForStart` exempts from the authored-spec
 * gate: `sessionDeliveryChannels` is undefined for them, because they have
 * no session-delivery concept — Station's own engine and the managed model
 * runtimes load authored specs themselves. This list may only SHRINK (with
 * the matrix entry that gates the provider) — never grow silently: a
 * provider gaining a matrix entry becomes gated and must be removed here,
 * and a NEW registered adapter absent from the matrix fails this suite until
 * its author consciously chooses gated (add a matrix entry) or exempt (add
 * it here, with the reasoning).
 */
const GATE_EXEMPT_PROVIDERS = ['bedrock', 'ollama', 'station-agent'] as const;

describe('the orchestration-layer gate exemption set is pinned (shrink-only)', () => {
  test('exactly {bedrock, ollama, station-agent} are exempt among registered adapters', () => {
    const exempt = REGISTERED_ADAPTER_PROVIDERS.filter(
      (provider) => sessionDeliveryChannels(provider) === undefined,
    );
    expect(exempt).toEqual([...GATE_EXEMPT_PROVIDERS]);
  });
});
