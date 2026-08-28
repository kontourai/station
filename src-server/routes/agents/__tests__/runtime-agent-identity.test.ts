import { describe, expect, it } from 'vitest';
import { ReservedAgentIdentityError } from '../../../domain/agent-registry.js';
import { createRegistryAwareHasAgent } from '../../../providers/adapters/station-agent-adapter.js';
import {
  publicAgentIdFromRuntimeKey,
  publicIdentityAgentSetView,
  runtimeAgentKey,
} from '../runtime-agent-identity.js';

describe('runtimeAgentKey', () => {
  it('maps the public station slug to the internal default key', () => {
    expect(runtimeAgentKey('station')).toBe('default');
  });

  it('passes every other public id through unchanged', () => {
    expect(runtimeAgentKey('vibe-probe')).toBe('vibe-probe');
    expect(runtimeAgentKey('claude')).toBe('claude');
  });

  it('refuses the reserved internal key as a public identity', () => {
    expect(() => runtimeAgentKey('default')).toThrow(
      ReservedAgentIdentityError,
    );
  });
});

describe('publicAgentIdFromRuntimeKey', () => {
  it('projects the internal default key back to the public slug', () => {
    expect(publicAgentIdFromRuntimeKey('default')).toBe('station');
    expect(publicAgentIdFromRuntimeKey('vibe-probe')).toBe('vibe-probe');
  });
});

describe('publicIdentityAgentSetView', () => {
  // archive#1992 regression: the runtime keys the built-in default agent as
  // 'default' while callers (orchestration metadata, delegateTask) present
  // the public slug 'station'. The registry-declared default agent also has
  // no persisted file, so the loader fallback cannot rescue an untranslated
  // active-set miss — this view is the only thing standing between a healthy
  // default agent and "Unknown Station agent: station".
  const activeAgents = new Map<string, unknown>([
    ['default', {}],
    ['vibe-probe', {}],
  ]);

  it("resolves 'station' through the internal 'default' entry", () => {
    const view = publicIdentityAgentSetView(activeAgents);
    expect(view.has('station')).toBe(true);
  });

  it('resolves ordinary slugs directly', () => {
    const view = publicIdentityAgentSetView(activeAgents);
    expect(view.has('vibe-probe')).toBe(true);
    expect(view.has('missing')).toBe(false);
  });

  it("does not expose the reserved internal key 'default'", () => {
    const view = publicIdentityAgentSetView(activeAgents);
    expect(view.has('default')).toBe(false);
  });

  it("composes with createRegistryAwareHasAgent so 'station' passes the adapter gate without a persisted file", async () => {
    const hasAgent = createRegistryAwareHasAgent(
      publicIdentityAgentSetView(activeAgents),
      async (agentId: string) => {
        // Mirrors ConfigLoader.loadAgent for a registry-declared default
        // agent: no file on disk, so the loader throws.
        throw new Error(`Agent not found: ${agentId}`);
      },
    );
    await expect(hasAgent('station')).resolves.toBe(true);
    await expect(hasAgent('default')).resolves.toBe(false);
    await expect(hasAgent('missing')).resolves.toBe(false);
  });
});
