import {
  createConformanceReport,
  inertInstallLimitation,
  type LifecycleEvent,
  probeHostConformance,
} from '@kontourai/conduit';
import { describe, expect, it, vi } from 'vitest';
import {
  conformAgentHooks,
  createStationFrameworkConduitAdapter,
} from '../conduit-framework-adapter.js';

describe('Station Conduit framework projection', () => {
  it.each(['strands', 'voltagent'] as const)(
    'passes shared conformance for %s with Station-owned gaps',
    async (framework) => {
      const results = await probeHostConformance(
        createStationFrameworkConduitAdapter(framework),
      );
      expect(results.every((result) => result.status === 'pass')).toBe(true);
    },
  );

  it.each(['strands', 'voltagent'] as const)(
    'reports %s with inert install evidence, never the caller install I/O',
    async (framework) => {
      // Conduit 0.8 refuses to probe a hand-built adapter
      // (UnsafeConformanceProbeError, `no-inert-install`); only a
      // factory-built adapter takes the I/O-free path the published
      // docs/conformance report records as `installEvidence: "inert"`.
      const report = await createConformanceReport([
        {
          adapter: createStationFrameworkConduitAdapter(framework),
          evidenceScope: 'host-bound',
          adapterVersion: 'test',
          hostId: `station-${framework}`,
          hostVersion: 'test',
        },
      ]);
      expect(report.schemaVersion).toBe('3');
      const [entry] = report.adapters;
      expect(entry?.installEvidence).toBe('inert');
      expect(entry?.limitations).toContain(inertInstallLimitation);
      expect(entry?.results.every((result) => result.status === 'pass')).toBe(
        true,
      );
    },
  );

  it.each(['strands', 'voltagent'] as const)(
    'declares the IAgentHooks lifecycle for %s, with stop approximated rather than native',
    (framework) => {
      // An honesty label, not an implementation detail: Conduit's
      // createConformanceReport reads `capabilities()` into the published
      // docs/conformance/station-runtime-conformance.{json,md} matrix. IAgentHooks
      // has no native stop hook, so claiming 'native' would overstate it.
      const { lifecycle } =
        createStationFrameworkConduitAdapter(framework).capabilities();
      expect(lifecycle).toEqual({
        'session-start': 'unavailable',
        'before-model': 'unavailable',
        'before-tool': 'native',
        'after-tool': 'native',
        stop: 'approximated',
      });
    },
  );

  it.each(['strands', 'voltagent'] as const)(
    'projects only the phases Station hooks deliver for %s',
    async (framework) => {
      const adapter = createStationFrameworkConduitAdapter(framework);
      const deny = { decision: 'deny', reason: 'policy' } as const;
      const project = (phase: LifecycleEvent['phase']) =>
        adapter.project({ phase, sessionId: 'session', context: {} }, deny);

      for (const phase of ['session-start', 'before-model'] as const) {
        await expect(project(phase)).resolves.toEqual({
          decision: 'observe',
          reason: 'lifecycle phase unavailable',
        });
      }
      for (const phase of ['before-tool', 'after-tool', 'stop'] as const) {
        await expect(project(phase)).resolves.toEqual(deny);
      }
    },
  );

  it.each(['strands', 'voltagent'] as const)(
    'strips model context on every delivered phase for %s',
    async (framework) => {
      // The framework host admits context injection, but Station's
      // IAgentHooks seam does not deliver it; echoing modelContext would
      // claim an influence this projection cannot exert.
      const adapter = createStationFrameworkConduitAdapter(framework);
      for (const phase of ['before-tool', 'after-tool', 'stop'] as const) {
        const projected = await adapter.project(
          { phase, sessionId: 'session', context: {} },
          { decision: 'allow', modelContext: 'injected' },
        );
        expect(projected.decision).toBe('allow');
        expect(projected.modelContext).toBeUndefined();
      }
    },
  );

  it.each(['strands', 'voltagent'] as const)(
    'preserves Station hook ownership for %s',
    async (framework) => {
      const beforeToolCall = vi.fn().mockResolvedValue(false);
      const afterToolCall = vi.fn();
      const afterInvocation = vi.fn().mockResolvedValue(undefined);
      const hooks = conformAgentHooks(framework, {
        beforeToolCall,
        afterToolCall,
        afterInvocation,
      });
      const invocation = { agentSlug: 'agent', conversationId: 'conversation' };
      const tool = { toolName: 'write', toolCallId: 'call', toolArgs: {} };

      await expect(hooks?.beforeToolCall?.(tool, invocation)).resolves.toBe(
        false,
      );
      hooks?.afterToolCall?.(tool, { output: 'ok' }, invocation);
      await hooks?.afterInvocation?.({ invocation, toolCallCount: 1 });

      expect(beforeToolCall).toHaveBeenCalledOnce();
      expect(afterToolCall).toHaveBeenCalledOnce();
      expect(afterInvocation).toHaveBeenCalledOnce();
    },
  );

  it('passes a ToolCallDenial through unchanged so the reason survives (station#1834)', async () => {
    const denial = {
      allowed: false as const,
      reason: 'No approval channel for this unattended run.',
    };
    const hooks = conformAgentHooks('voltagent', {
      beforeToolCall: vi.fn().mockResolvedValue(denial),
    });

    await expect(
      hooks?.beforeToolCall?.(
        { toolName: 'write', toolCallId: 'call', toolArgs: {} },
        { agentSlug: 'agent' },
      ),
    ).resolves.toBe(denial);
  });

  it('degrades to the unchanged direct path when integration is disabled', () => {
    expect(conformAgentHooks('voltagent', undefined)).toBeUndefined();
  });
});
