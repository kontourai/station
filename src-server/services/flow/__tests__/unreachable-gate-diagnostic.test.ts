import type { FlowDefinition, FlowRunState } from '@kontourai/flow';
import { describe, expect, test } from 'vitest';
import {
  type CommandEvidenceRoutingPolicy,
  DefaultCommandEvidenceRoutingPolicy,
} from '../../evidence/command-evidence-routing-policy.js';
import {
  FLOW_RUN_LOCATION_ALLOCATION_COLLISION,
  FlowRunInvalidError,
  type FlowRunService,
} from '../flow-run-service.js';
import {
  attachFlowRunForSessionStart,
  type FlowAttachWarning,
} from '../orchestration-flow-gate.js';
import {
  describeUnreachableGateClaims,
  detectUnreachableGateClaims,
  type GateReachabilityDiagnostic,
  type UnreachableGateClaims,
} from '../unreachable-gate-diagnostic.js';

/** Historical shape retained as an inert test fixture, not runnable inventory. */
function shippedStationDelivery(): FlowDefinition {
  return {
    id: 'historical-delivery-fixture',
    version: '1',
    steps: [{ id: 'verify', next: null }],
    gates: {
      'verify-gate': {
        step: 'verify',
        expects: [
          {
            id: 'static-gates-green',
            kind: 'trust.bundle',
            required: true,
            description: 'Static checks pass.',
            bundle_claim: { claimType: 'quality.static-checks' },
          },
        ],
      },
    },
  };
}

function unproducibleDefinition(): FlowDefinition {
  return {
    id: 'unproducible-delivery',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          {
            id: 'nothing-produces-this',
            kind: 'trust.bundle',
            required: true,
            description: 'A claim no command pattern can produce.',
            bundle_claim: { claimType: 'governance.unproducible' },
          },
        ],
      },
    },
  };
}

function expectConclusiveDiagnostic(
  diagnostic: GateReachabilityDiagnostic | null,
): UnreachableGateClaims {
  if (diagnostic === null || diagnostic.kind !== undefined) {
    throw new Error('Expected a conclusive unreachable-gates diagnostic.');
  }
  return diagnostic;
}

function attachWarningHarness(definition: FlowDefinition) {
  const state = {
    run_id: 'session-warning-once',
    definition_id: definition.id,
    definition_version: definition.version,
    subject: 'session:warning-once',
    status: 'active',
    current_step: 'ship',
    gate_outcomes: [],
    transitions: [],
    exceptions: [],
    next_action: 'await evidence',
    updated_at: '2026-08-10T00:00:00.000Z',
  } satisfies FlowRunState;
  let started = false;
  const flowRunService: Pick<
    FlowRunService,
    'detectWorkspace' | 'startRun' | 'getRun'
  > = {
    async detectWorkspace(_cwd) {
      return {
        initialized: true,
        definitions: [
          { id: definition.id, path: `${definition.id}.json`, valid: true },
        ],
      };
    },
    async startRun(_cwd, _options) {
      if (started) {
        throw new FlowRunInvalidError(
          'run already exists',
          FLOW_RUN_LOCATION_ALLOCATION_COLLISION,
        );
      }
      started = true;
      return { runId: state.run_id, dir: '/flow-run', state };
    },
    async getRun(_cwd, _runId) {
      return {
        runId: state.run_id,
        dir: '/flow-run',
        definition,
        state,
        manifest: { evidence: [] },
        openGates: [{ id: 'ship-gate', step: 'ship' }],
      };
    },
  };
  const warnings: FlowAttachWarning[] = [];

  return {
    warnings,
    attach: async (policy: CommandEvidenceRoutingPolicy) =>
      attachFlowRunForSessionStart({
        flowRunService,
        input: {
          provider: 'codex',
          threadId: 'warning-once',
          cwd: '/workspace',
          metadata: { flowDefinition: definition.id },
        },
        routingPolicy: policy,
        emitWarning: (warning) => warnings.push(warning),
      }),
  };
}

describe('detectUnreachableGateClaims', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  test('reports a disjoint definition and names both sets', () => {
    const definition = unproducibleDefinition();

    const diagnostic = detectUnreachableGateClaims(definition, policy);
    expect(diagnostic).toMatchObject({
      definitionId: 'unproducible-delivery',
      severity: 'all',
      expectedClaimTypes: ['governance.unproducible'],
      unreachableGates: [
        {
          gateId: 'ship-gate',
          unproducibleClaimTypes: ['governance.unproducible'],
        },
      ],
    });
    expect(expectConclusiveDiagnostic(diagnostic).routableClaimTypes).toContain(
      'quality.static-checks',
    );

    const message = describeUnreachableGateClaims(
      diagnostic as NonNullable<typeof diagnostic>,
    );
    expect(message).toContain('governance.unproducible');
    expect(message).toContain('quality.static-checks');
    expect(message).toContain('ship-gate');
  });

  test('reports the unreachable SUBSET when only one gate is stranded', () => {
    // The likelier regression: the definition still looks healthy in
    // aggregate — most of its claims route — while one gate can never be
    // satisfied. An all-or-nothing intersection check misses this entirely.
    const definition = {
      id: 'partly-routable',
      version: '1',
      steps: [
        { id: 'build', next: 'ship' },
        { id: 'ship', next: null },
      ],
      gates: {
        'build-gate': {
          step: 'build',
          expects: [
            {
              id: 'tests',
              kind: 'trust.bundle' as const,
              required: true,
              description: 'Tests pass.',
              bundle_claim: { claimType: 'quality.tests' },
            },
          ],
        },
        'ship-gate': {
          step: 'ship',
          expects: [
            {
              id: 'unproducible',
              kind: 'trust.bundle' as const,
              required: true,
              description: 'A claim no command pattern produces.',
              bundle_claim: { claimType: 'governance.unproducible' },
            },
          ],
        },
      },
    } satisfies FlowDefinition;

    const diagnostic = detectUnreachableGateClaims(definition, policy);
    expect(diagnostic).toMatchObject({
      severity: 'partial',
      unreachableGates: [
        {
          gateId: 'ship-gate',
          unproducibleClaimTypes: ['governance.unproducible'],
        },
      ],
    });
    // The reachable gate must not be named as stranded.
    expect(
      expectConclusiveDiagnostic(diagnostic).unreachableGates.map(
        (gate) => gate.gateId,
      ),
    ).not.toContain('build-gate');
    expect(
      describeUnreachableGateClaims(
        diagnostic as NonNullable<typeof diagnostic>,
      ),
    ).toContain('ship-gate (governance.unproducible)');
  });

  test('a gate is reachable when ANY of its expected claim types routes', () => {
    const definition = {
      id: 'one-of-two',
      version: '1',
      steps: [{ id: 'ship', next: null }],
      gates: {
        'ship-gate': {
          step: 'ship',
          expects: [
            {
              id: 'unproducible',
              kind: 'trust.bundle' as const,
              required: true,
              description: 'Unproducible.',
              bundle_claim: { claimType: 'governance.unproducible' },
            },
            {
              id: 'tests',
              kind: 'trust.bundle' as const,
              required: true,
              description: 'Tests pass.',
              bundle_claim: { claimType: 'quality.tests' },
            },
          ],
        },
      },
    } satisfies FlowDefinition;

    expect(detectUnreachableGateClaims(definition, policy)).toBe(null);
  });

  test('stays silent when the definition expects no trust.bundle claims', () => {
    const definition = {
      id: 'gateless',
      version: '1',
      steps: [{ id: 'ship', next: null }],
      gates: {},
    } satisfies FlowDefinition;

    expect(detectUnreachableGateClaims(definition, policy)).toBe(null);
  });

  test.each<[string, unknown]>([
    ['missing', { route: () => null }],
    ['non-callable', { route: () => null, routableClaimTypes: ['claim'] }],
    [
      'throwing',
      {
        route: () => null,
        routableClaimTypes: () => {
          throw new Error('secret-policy-error: governance.hidden');
        },
      },
    ],
    [
      'malformed synchronous result',
      { route: () => null, routableClaimTypes: () => ['claim', 1] },
    ],
    [
      'async result outside the synchronous interface',
      { route: () => null, routableClaimTypes: async () => ['claim'] },
    ],
  ])(
    'reports a fixed redacted diagnostic when the capability is %s',
    (_case, policy) => {
      const diagnostic = detectUnreachableGateClaims(
        shippedStationDelivery(),
        policy as unknown as CommandEvidenceRoutingPolicy,
      );
      expect(diagnostic).toEqual({
        kind: 'reachability-not-evaluable',
        severity: 'not-evaluable',
        reason: 'routable-claim-types-unavailable',
      });
      const rendered = describeUnreachableGateClaims(
        diagnostic as NonNullable<typeof diagnostic>,
      );
      expect(rendered).toBe(
        'Flow gate reachability is not evaluable because the command-evidence routing policy cannot provide a valid routable claim-type inventory.',
      );
      expect(JSON.stringify({ diagnostic, rendered })).not.toContain(
        'secret-policy-error',
      );
      expect(JSON.stringify({ diagnostic, rendered })).not.toContain(
        'governance.hidden',
      );
    },
  );

  test.each([
    ['blank', ''],
    ['padded', ' quality.tests'],
    ['control-bearing', 'quality.\ntests'],
    ['noncanonical', 'Quality.Tests'],
    ['oversized', 'a'.repeat(129)],
  ])(
    'rejects a %s claim type before it can reach a warning payload',
    (_case, claimType) => {
      const diagnostic = detectUnreachableGateClaims(shippedStationDelivery(), {
        route: () => null,
        routableClaimTypes: () => [claimType],
      });
      expect(diagnostic).toEqual({
        kind: 'reachability-not-evaluable',
        severity: 'not-evaluable',
        reason: 'routable-claim-types-unavailable',
      });
      if (claimType.length > 0) {
        expect(JSON.stringify(diagnostic)).not.toContain(claimType);
      }
    },
  );

  test('rejects duplicate and over-limit claim inventories without retaining their values', () => {
    const duplicate = detectUnreachableGateClaims(shippedStationDelivery(), {
      route: () => null,
      routableClaimTypes: () => ['quality.tests', 'quality.tests'],
    });
    const oversized = 'a'.repeat(1024 * 1024);
    const huge = detectUnreachableGateClaims(shippedStationDelivery(), {
      route: () => null,
      routableClaimTypes: () => [oversized],
    });
    const overLimit = detectUnreachableGateClaims(shippedStationDelivery(), {
      route: () => null,
      routableClaimTypes: () =>
        Array.from({ length: 1025 }, (_entry, index) => `claim${index}`),
    });

    for (const diagnostic of [duplicate, huge, overLimit]) {
      expect(diagnostic).toEqual({
        kind: 'reachability-not-evaluable',
        severity: 'not-evaluable',
        reason: 'routable-claim-types-unavailable',
      });
      expect(JSON.stringify(diagnostic)).not.toContain(oversized);
    }
  });

  test('returns a fresh frozen fixed diagnostic on every unevaluable result', () => {
    const policy = { route: () => null };
    const first = detectUnreachableGateClaims(shippedStationDelivery(), policy);
    if (first === null || first.kind !== 'reachability-not-evaluable') {
      throw new Error('Expected a fixed not-evaluable diagnostic.');
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { reason: string }).reason = 'poisoned';
    }).toThrow(TypeError);

    const second = detectUnreachableGateClaims(
      shippedStationDelivery(),
      policy,
    );
    expect(second).not.toBe(first);
    expect(second).toEqual({
      kind: 'reachability-not-evaluable',
      severity: 'not-evaluable',
      reason: 'routable-claim-types-unavailable',
    });
  });

  test('does not invoke an accessor or coercion while validating a policy capability', () => {
    let accessorRead = false;
    const policy = {
      route: () => null,
      get routableClaimTypes() {
        accessorRead = true;
        throw new Error('secret-accessor-error');
      },
    };
    const hostileClaim = {
      toString() {
        throw new Error('secret-claim-coercion');
      },
    };

    expect(
      detectUnreachableGateClaims(
        shippedStationDelivery(),
        policy as unknown as CommandEvidenceRoutingPolicy,
      ),
    ).toMatchObject({ kind: 'reachability-not-evaluable' });
    expect(accessorRead).toBe(false);
    expect(
      detectUnreachableGateClaims(shippedStationDelivery(), {
        route: () => null,
        routableClaimTypes: () => [hostileClaim],
      } as unknown as CommandEvidenceRoutingPolicy),
    ).toMatchObject({ kind: 'reachability-not-evaluable' });
  });

  test('preserves the conclusive all-unreachable result for an empty valid inventory', () => {
    expect(
      detectUnreachableGateClaims(unproducibleDefinition(), {
        route: () => null,
        routableClaimTypes: () => [],
      }),
    ).toMatchObject({ severity: 'all' });
  });

  test('the attach caller publishes one unevaluable warning and no warning for a healthy policy', async () => {
    const unevaluable = attachWarningHarness(shippedStationDelivery());
    const unavailablePolicy = { route: () => null };
    await unevaluable.attach(unavailablePolicy);
    await unevaluable.attach(unavailablePolicy);

    expect(unevaluable.warnings).toHaveLength(1);
    expect(unevaluable.warnings[0]).toEqual({
      code: 'flow.unreachable-gate-claims',
      message:
        'Flow gate reachability is not evaluable because the command-evidence routing policy cannot provide a valid routable claim-type inventory.',
      details: {
        runId: 'session-warning-once',
        kind: 'reachability-not-evaluable',
        severity: 'not-evaluable',
        reason: 'routable-claim-types-unavailable',
      },
    });

    const healthy = attachWarningHarness(shippedStationDelivery());
    await healthy.attach(new DefaultCommandEvidenceRoutingPolicy());
    expect(healthy.warnings).toEqual([]);
  });
});
