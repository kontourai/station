import { describe, expect, test } from 'vitest';
import {
  connectionIdForAdapter,
  engineIdForAdapter,
} from '../../../providers/adapter-identity.js';
import {
  acpRuntimeCatalogStatus,
  hasRequiredMissing,
  mergeRuntimeConfig,
  sanitizeRuntimeConfig,
} from '../connection-service-helpers.js';

describe('connection service pure helpers', () => {
  test('keeps required-prerequisite and engine identity rules explicit', () => {
    expect(
      hasRequiredMissing([
        { id: 'optional', category: 'optional', status: 'missing' },
      ] as any),
    ).toBe(false);
    expect(
      hasRequiredMissing([
        { id: 'required', category: 'required', status: 'missing' },
      ] as any),
    ).toBe(true);
    expect(
      engineIdForAdapter({
        provider: 'bedrock',
        metadata: { executionClass: 'managed' },
      } as any),
    ).toBe('station');
    expect(
      engineIdForAdapter({
        provider: 'codex',
        metadata: { engineId: 'codex' },
      } as any),
    ).toBe('codex');
  });

  test('preserves safe claude/codex configuration sanitization', () => {
    expect(
      sanitizeRuntimeConfig('claude', {
        provideSkills: ['safe', '..', 'safe'],
        useAppHome: true,
      }),
    ).toEqual({ provideSkills: ['safe'], useAppHome: true });
    expect(
      sanitizeRuntimeConfig('codex', {
        provideSkills: ['ignored'],
        useAppHome: 'true',
      }),
    ).toEqual({ useAppHome: false });
    expect(
      mergeRuntimeConfig(
        'codex',
        { defaultModel: 'base' } as any,
        { config: { defaultModel: 'override' } } as any,
      ),
    ).toEqual({ defaultModel: 'override', useAppHome: false });
  });

  test('derives public connection identity only at the Adapter seam', () => {
    expect(
      connectionIdForAdapter({
        provider: 'claude',
        metadata: {
          connectionId: 'claude',
          engineId: 'claude',
        },
      } as any),
    ).toBe('claude');
    expect(
      connectionIdForAdapter({
        provider: 'muse',
        metadata: { engineId: 'plugin-engine' },
      } as any),
    ).toBe('plugin-engine');
  });
});

describe('acpRuntimeCatalogStatus (#3054)', () => {
  test('projects a live catalog from the real handshake shape', () => {
    // Copied from a live /acp/connections record (OpenCode, 2026-08-17):
    // ACP select options are { value, name } objects.
    const status = acpRuntimeCatalogStatus({
      id: 'opencode',
      status: 'available',
      handshakeObservedAt: '2026-08-17T12:26:09.688Z',
      configOptions: [
        { category: 'mode', currentValue: 'plan', options: [] },
        {
          category: 'model',
          currentValue: 'opencode/big-pickle',
          options: [
            {
              value: 'zai-coding-plan/glm-4.7',
              name: 'Z.AI Coding Plan/GLM-4.7',
            },
            { value: 'opencode/big-pickle', name: 'Big Pickle' },
          ],
        },
      ],
    } as never);
    expect(status).toEqual({
      source: 'live',
      fetchedAt: '2026-08-17T12:26:09.688Z',
      reason: null,
      models: [
        {
          id: 'zai-coding-plan/glm-4.7',
          name: 'Z.AI Coding Plan/GLM-4.7',
          originalId: 'zai-coding-plan/glm-4.7',
        },
        {
          id: 'opencode/big-pickle',
          name: 'Big Pickle',
          originalId: 'opencode/big-pickle',
        },
      ],
      builtInModels: [],
    });
  });

  test('tolerates bare-string options and drops empty values', () => {
    const status = acpRuntimeCatalogStatus({
      id: 'kiro',
      handshakeObservedAt: '2026-08-17T12:26:10.514Z',
      configOptions: [
        { category: 'model', options: ['model-a', '', { name: 'nameless' }] },
      ],
    } as never);
    expect(status.source).toBe('live');
    expect(status.models).toEqual([
      { id: 'model-a', name: 'model-a', originalId: 'model-a' },
    ]);
  });

  test('a handshake with no model catalog is source none with the observed reason', () => {
    const status = acpRuntimeCatalogStatus({
      id: 'kiro',
      handshakeObservedAt: '2026-08-17T12:26:10.514Z',
      configOptions: [],
    } as never);
    expect(status.source).toBe('none');
    expect(status.reason).toContain('advertised no model catalog');
  });

  test('no handshake yet is source none with the no-observation reason', () => {
    const status = acpRuntimeCatalogStatus(undefined);
    expect(status.source).toBe('none');
    expect(status.reason).toContain('No successful initialize handshake');
    expect(status.models).toEqual([]);
  });
});
