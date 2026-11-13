import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import type { ProviderConnection } from '../../provider-settings/types';
import {
  deriveConnectionHealth,
  engineHealthInput,
  modelHealthInput,
} from '../connection-health';

/** An engine in the shape `/api/connections/agents` returns. */
function engine(overrides: Partial<AgentConnectionView> = {}) {
  return {
    id: 'muse',
    kind: 'agent',
    type: 'muse',
    name: 'Muse Code',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready', detected: true, configured: true },
    ...overrides,
  } as AgentConnectionView;
}

const OBSERVED = '2026-08-20T10:00:00.000Z';

/** A model connection in the shape `/api/connections/models` returns. */
function model(
  check: Record<string, unknown>,
  level = 'catalog-ready',
): ProviderConnection {
  return {
    id: 'anthropic-1',
    kind: 'model',
    type: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    status: 'ready',
    capabilities: ['llm'],
    config: {},
    prerequisites: [],
    readinessEvidence: {
      evidenceVersion: 1,
      level,
      observedAt: OBSERVED,
      freshness: 'fresh',
      summary: '',
      smoke: { status: 'not-tested', freshness: 'unknown', turnLimit: 1 },
      check,
    },
  } as unknown as ProviderConnection;
}

const signIn = {
  id: 'muse-auth',
  name: 'Muse Code login',
  description: 'Sign in to Muse Code.',
  status: 'missing',
  category: 'required',
} as const;

const failedSmoke = {
  evidenceVersion: 1,
  level: 'prerequisite-ready',
  observedAt: OBSERVED,
  freshness: 'fresh',
  summary: '',
  smoke: { status: 'failed', freshness: 'fresh', turnLimit: 1 },
} as unknown as AgentConnectionView['readinessEvidence'];

describe('deriveConnectionHealth', () => {
  test('policy outranks everything, and reads differently from Disabled', () => {
    const disallowed = deriveConnectionHealth(
      engineHealthInput(engine({ enabled: false, prerequisites: [signIn] })),
      { policyDisallowed: true },
    );
    expect(disallowed).toMatchObject({ verdict: 'off', label: 'Not allowed' });
    // Nothing the reader can turn on, so nothing to send them to.
    expect(disallowed.action).toBeUndefined();
    expect(disallowed.needsAttention).toBe(false);

    const disabled = deriveConnectionHealth(
      engineHealthInput(engine({ enabled: false, prerequisites: [signIn] })),
    );
    expect(disabled).toMatchObject({
      verdict: 'off',
      label: 'Disabled',
      action: { label: 'Enable' },
    });
  });

  test('a blocking prerequisite is setup with its own fix, before a failed check', () => {
    expect(
      deriveConnectionHealth(
        engineHealthInput(
          engine({
            status: 'missing_prerequisites',
            prerequisites: [signIn],
            setup: { state: 'configured', detected: true, configured: true },
            readinessEvidence: failedSmoke,
          }),
        ),
      ),
    ).toMatchObject({
      verdict: 'setup',
      label: 'Sign in required',
      action: { label: 'Sign in', id: 'sign-in' },
    });
  });

  test("a fresh failed check fails, with the resolver's own action", () => {
    const health = deriveConnectionHealth(
      engineHealthInput(engine({ readinessEvidence: failedSmoke })),
    );
    expect(health).toMatchObject({
      verdict: 'failing',
      label: 'Check failed',
      tone: 'negative',
      action: { label: 'Check connection', id: 'check-connection' },
    });
    expect(
      deriveConnectionHealth(
        modelHealthInput(model({ status: 'failed', checkedAt: OBSERVED })),
      ),
    ).toMatchObject({ verdict: 'failing', label: 'Check failed' });
  });

  test('an added engine the server reports failing is unreachable, not "Setup required"', () => {
    expect(
      deriveConnectionHealth(
        engineHealthInput(
          engine({
            status: 'error',
            setup: { state: 'configured', detected: true, configured: true },
          }),
        ),
      ),
    ).toMatchObject({ verdict: 'failing', label: 'Unreachable' });
  });

  test('a degraded engine is never ready: dispatch requires status ready', () => {
    for (const setup of [
      { state: 'configured', detected: true, configured: true },
      { state: 'ready', detected: true, configured: true },
    ] as const) {
      const health = deriveConnectionHealth(
        engineHealthInput(engine({ status: 'degraded', setup })),
      );
      expect(health).toMatchObject({ verdict: 'degraded', label: 'Limited' });
      expect(health.tone).toBe('caution');
    }
  });

  test('an untested model is setup; a retrying one is degraded; a passed one is ready', () => {
    expect(
      deriveConnectionHealth(
        modelHealthInput(
          model({ status: 'not-checked' }, 'prerequisite-ready'),
        ),
      ),
    ).toMatchObject({ verdict: 'setup', label: 'Saved — not verified' });
    expect(
      deriveConnectionHealth(
        modelHealthInput(
          model({ status: 'unreachable', retrying: true, checkedAt: OBSERVED }),
        ),
      ),
    ).toMatchObject({ verdict: 'degraded', label: 'Unreachable — retrying' });
    const ready = deriveConnectionHealth(
      modelHealthInput(model({ status: 'passed', checkedAt: OBSERVED })),
    );
    expect(ready).toEqual({
      verdict: 'ready',
      label: 'Ready',
      tone: 'positive',
      needsAttention: false,
    });
  });

  test('a ready engine is ready, with no reason or fix', () => {
    expect(deriveConnectionHealth(engineHealthInput(engine()))).toEqual({
      verdict: 'ready',
      label: 'Ready',
      tone: 'positive',
      needsAttention: false,
    });
  });

  test('the fix id is its label, so a "Set up" fix is never called something else', () => {
    const health = deriveConnectionHealth(
      engineHealthInput(
        engine({
          status: 'missing_prerequisites',
          setup: { state: 'configured', detected: true, configured: true },
        }),
      ),
    );
    expect(health.action).toEqual({ label: 'Set up', id: 'set-up' });
  });

  test('an engine needs attention whenever it is not dispatchable for a reason the reader can fix', () => {
    for (const health of [
      deriveConnectionHealth(engineHealthInput(engine({ status: 'degraded' }))),
      deriveConnectionHealth(
        engineHealthInput(engine({ readinessEvidence: failedSmoke })),
      ),
    ])
      expect(health.needsAttention).toBe(true);
    expect(
      deriveConnectionHealth(engineHealthInput(engine())).needsAttention,
    ).toBe(false);
  });

  test('a model needs attention only for something the reader must fix', () => {
    const attention = (connection: ProviderConnection) =>
      deriveConnectionHealth(modelHealthInput(connection)).needsAttention;
    // Resting: saved but untested, reachable without a catalog, retrying.
    expect(
      attention(model({ status: 'not-checked' }, 'prerequisite-ready')),
    ).toBe(false);
    expect(
      attention(model({ status: 'catalog-unavailable', checkedAt: OBSERVED })),
    ).toBe(false);
    expect(
      attention(
        model({ status: 'unreachable', retrying: true, checkedAt: OBSERVED }),
      ),
    ).toBe(false);
    // To fix: refused, unreachable past the grace window, a missing key, off.
    expect(attention(model({ status: 'failed', checkedAt: OBSERVED }))).toBe(
      true,
    );
    expect(
      attention(model({ status: 'unreachable', checkedAt: OBSERVED })),
    ).toBe(true);
    expect(
      attention({
        ...model({ status: 'not-checked' }),
        status: 'missing_prerequisites',
        prerequisites: [
          {
            id: 'anthropic-api-key',
            name: 'Anthropic API Key',
            status: 'missing',
            category: 'required',
          },
        ],
      } as ProviderConnection),
    ).toBe(true);
    expect(
      attention({
        ...model({ status: 'passed', checkedAt: OBSERVED }),
        enabled: false,
      }),
    ).toBe(true);
  });
});
