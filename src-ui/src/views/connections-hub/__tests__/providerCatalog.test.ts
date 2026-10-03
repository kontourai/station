import { describe, expect, test } from 'vitest';
import {
  resolveProviderChoicePresentation,
  resolveProviderPresentation,
} from '../../provider-settings/providerCatalog';

describe('provider catalog presentation', () => {
  test.each([
    [
      {
        enabled: true,
        status: 'ready',
        setup: { state: 'ready', detected: true, configured: false },
      },
      'Ready',
      'Details',
    ],
    [
      {
        enabled: true,
        status: 'missing_prerequisites',
        setup: { state: 'configured', detected: false, configured: true },
      },
      'Setup required',
      'Set up',
    ],
    [
      {
        enabled: true,
        status: 'missing_prerequisites',
        setup: { state: 'available', detected: true, configured: false },
      },
      'Found, not connected',
      'Connect',
    ],
    [{ enabled: true, status: 'degraded', setup: null }, 'Limited', 'Review'],
    [{ enabled: false, status: 'ready', setup: null }, 'Disabled', 'Enable'],
    [
      { enabled: true, status: 'error', setup: null },
      'Unreachable',
      'Reconnect',
    ],
  ] as const)(
    'pins backend setup state %j to one readiness and action',
    (partial, readiness, action) => {
      expect(
        resolveProviderPresentation({
          id: 'provider',
          kind: 'agent',
          type: 'codex',
          name: 'Codex Work',
          href: '/connections/engines/provider',
          ...partial,
        }),
      ).toMatchObject({ readiness, actionLabel: action });
    },
  );

  /*
   * One unmet prerequisite, four remedies -- because the four are performed in
   * four different places, and a single "Sign in required" for all of them
   * names a remedy the user often cannot perform. Bedrock is the sharpest
   * case: its credential chain has no sign-in at all.
   *
   * The detail is the prerequisite's OWN description, not a generic sentence,
   * so the page states why THIS connection is unusable.
   */
  test.each([
    [
      'a CLI that is not installed',
      { id: 'muse-cli', name: 'Muse Code CLI' },
      'Setup required',
      'Set up',
    ],
    [
      'an engine that is not signed in',
      { id: 'muse-auth', name: 'Muse Code login' },
      'Sign in required',
      'Sign in',
    ],
    [
      'a provider with no API key saved',
      { id: 'anthropic-api-key', name: 'Anthropic API Key' },
      'API key required',
      'Add key',
    ],
    [
      'an ambient credential chain',
      { id: 'bedrock-credentials', name: 'Bedrock Credentials' },
      'Credentials required',
      'Set up',
    ],
  ] as const)(
    'names the remedy for %s',
    (_label, prerequisite, readiness, actionLabel) => {
      const presentation = resolveProviderPresentation({
        id: 'bedrock-work',
        kind: 'model',
        type: 'bedrock',
        name: 'Work Bedrock',
        enabled: true,
        status: 'missing_prerequisites',
        setup: { state: 'configured', detected: true, configured: true },
        href: '/connections/providers/bedrock-work',
        prerequisites: [
          {
            ...prerequisite,
            description: 'The reason this one is unusable.',
            status: 'missing',
            category: 'required',
          },
        ],
      });

      expect(presentation).toMatchObject({
        brand: 'Amazon Bedrock',
        readiness,
        actionLabel,
        detail: 'The reason this one is unusable.',
      });
    },
  );

  /*
   * The ordering guarantee, stated as a test: presence outranks credential.
   * The former derivation read this list as a set and matched `<cmd>-auth`
   * first, which is how a not-installed engine came to read "Sign in
   * required". Both orderings are asserted so the fix cannot be reverted by
   * re-sorting the producer.
   */
  test.each([
    ['presence first', ['muse-cli', 'muse-auth']],
    ['credential first', ['muse-auth', 'muse-cli']],
  ] as const)(
    'reports the presence failure when both are unmet (%s)',
    (_label, order) => {
      const byId = {
        'muse-cli': {
          id: 'muse-cli',
          name: 'Muse Code CLI',
          description: 'Required to launch the Muse Code runtime.',
        },
        'muse-auth': {
          id: 'muse-auth',
          name: 'Muse Code login',
          description:
            'Muse Code CLI must be installed before authentication can be verified.',
        },
      } as const;

      const presentation = resolveProviderPresentation({
        id: 'muse',
        kind: 'agent',
        type: 'muse',
        name: 'Muse Code',
        enabled: true,
        status: 'missing_prerequisites',
        setup: { state: 'available', detected: false, configured: false },
        href: '/connections/engines/muse',
        prerequisites: order.map((id) => ({
          ...byId[id],
          status: 'missing' as const,
          category: 'required' as const,
        })),
      });

      expect(presentation.readiness).toBe('Setup required');
    },
  );

  test('keeps read-only provider rows inspection-only', () => {
    expect(
      resolveProviderPresentation({
        id: 'plugin-provider',
        kind: 'command',
        type: 'acp',
        name: 'Plugin Provider',
        enabled: true,
        status: 'error',
        setup: null,
        href: '/connections/acp',
        readOnly: true,
      }),
    ).toMatchObject({
      readiness: 'Unreachable',
      actionLabel: 'Details',
    });
  });

  test.each([
    [
      false,
      { state: 'ready' as const, detected: true, configured: false },
      'Disabled',
    ],
    [
      true,
      { state: 'configured' as const, detected: true, configured: true },
      'Setup required',
    ],
    [
      true,
      { state: 'available' as const, detected: false, configured: false },
      'Setup required',
    ],
  ])(
    'gives disabled, setup state, and missing-prerequisite facts one precedence (%s, %j)',
    (enabled, setup, readiness) => {
      const presentation = resolveProviderPresentation({
        id: 'kiro',
        kind: 'command',
        type: 'acp',
        name: 'Kiro CLI',
        enabled,
        status: 'missing_prerequisites',
        setup,
        href: '/connections/acp',
        prerequisites: [
          {
            id: 'kiro-cli',
            name: 'Kiro CLI',
            description: 'Kiro executable required on PATH.',
            status: 'missing',
            category: 'required',
          },
        ],
      });
      expect(presentation.readiness).toBe(readiness);
      expect(
        resolveProviderChoicePresentation({
          id: 'kiro',
          kind: 'command',
          type: 'acp',
          name: 'Kiro CLI',
          enabled,
          status: 'missing_prerequisites',
          setup,
          href: '/connections/acp',
          prerequisites: [
            {
              id: 'kiro-cli',
              name: 'Kiro CLI',
              description: 'Kiro executable required on PATH.',
              status: 'missing',
              category: 'required',
            },
          ],
        }).badge,
      ).toBe(readiness);
    },
  );

  test('uses the same detected-but-unconnected wording in provider pickers and catalog cards', () => {
    expect(
      resolveProviderChoicePresentation({
        id: 'kiro',
        kind: 'command',
        type: 'acp',
        name: 'Kiro CLI',
        enabled: true,
        status: 'unknown',
        setup: null,
        discovery: 'detected-unconfigured',
        href: '/connections/acp',
      }),
    ).toEqual({
      badge: 'Found, not connected',
      detail: 'Found on the computer Station runs on — not yet connected.',
    });
  });

  test('keeps a registry description for an undetected provider that needs setup', () => {
    expect(
      resolveProviderChoicePresentation({
        id: 'kiro',
        kind: 'command',
        type: 'acp',
        name: 'Kiro CLI',
        enabled: true,
        status: 'unknown',
        setup: null,
        description: 'Connect Kiro through ACP',
        href: '/connections/acp',
      }),
    ).toEqual({
      badge: 'Setup required',
      detail: 'Connect Kiro through ACP',
    });
  });
});

test('a failed engine connection check does not render as Ready beside a live catalog', () => {
  const result = resolveProviderPresentation({
    id: 'codex',
    kind: 'agent',
    type: 'codex',
    name: 'Codex',
    enabled: true,
    status: 'ready',
    setup: { state: 'ready', detected: true, configured: true },
    prerequisites: [],
    href: '',
    readinessEvidence: {
      evidenceVersion: 1,
      level: 'catalog-ready',
      observedAt: '2026-10-03T00:00:00Z',
      freshness: 'fresh',
      summary: 'Connection check failed',
      smoke: { status: 'failed', freshness: 'fresh', turnLimit: 1 },
    },
  });
  expect(result.readiness).toBe('Check failed');
  expect(result.actionLabel).toBe('Check connection');
});
