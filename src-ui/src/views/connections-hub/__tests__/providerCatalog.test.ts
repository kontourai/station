import { describe, expect, test } from 'vitest';
import {
  buildProviderCatalog,
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

  test('distinguishes sign-in prerequisites from general setup', () => {
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
          id: 'aws-credentials',
          name: 'AWS credentials',
          description: 'Sign in with an AWS profile.',
          status: 'missing',
          category: 'required',
        },
      ],
    });

    expect(presentation).toMatchObject({
      brand: 'Amazon Bedrock',
      readiness: 'Sign in required',
      actionLabel: 'Sign in',
    });
  });

  test('deduplicates exact connection ids but preserves same-brand instances', () => {
    const catalog = buildProviderCatalog([
      {
        id: 'codex-work',
        kind: 'agent',
        type: 'codex',
        name: 'Work',
        enabled: true,
        status: 'ready',
        setup: { state: 'ready', detected: true, configured: false },
        href: '/connections/engines/codex-work',
      },
      {
        id: 'codex-work',
        kind: 'command',
        type: 'acp',
        name: 'Duplicate projection',
        enabled: true,
        status: 'available',
        setup: null,
        href: '/connections/acp',
      },
      {
        id: 'codex-personal',
        kind: 'agent',
        type: 'codex',
        name: 'Personal',
        enabled: true,
        status: 'degraded',
        setup: { state: 'ready', detected: true, configured: false },
        href: '/connections/engines/codex-personal',
      },
    ]);

    expect(catalog).toHaveLength(2);
    expect(catalog.map((item) => item.id)).toEqual([
      'codex-personal',
      'codex-work',
    ]);
    expect(catalog.every((item) => item.brand === 'Codex')).toBe(true);
    expect(catalog.map((item) => item.duplicateBrandIndex)).toEqual([1, 2]);
    expect(catalog[0]?.accessibleName).toContain('instance 1 of 2');
    expect(catalog[1]?.accessibleName).toContain('instance 2 of 2');
  });

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
      detail: 'Found on this computer — not yet connected to this Station.',
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

  test('keeps named OpenAI-compatible services visible as their own brands', () => {
    const catalog = buildProviderCatalog([
      {
        id: 'litellm-work',
        kind: 'model',
        type: 'openai-compat',
        name: 'LiteLLM',
        enabled: true,
        status: 'ready',
        setup: null,
        href: '/connections/providers/litellm-work',
      },
      {
        id: 'openrouter-personal',
        kind: 'model',
        type: 'openai-compat',
        name: 'OpenRouter',
        enabled: true,
        status: 'ready',
        setup: null,
        href: '/connections/providers/openrouter-personal',
      },
    ]);

    expect(catalog.map((item) => item.brand)).toEqual([
      'LiteLLM',
      'OpenRouter',
    ]);
  });
});
