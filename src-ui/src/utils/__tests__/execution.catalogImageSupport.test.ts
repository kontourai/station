import {
  ENGINE_CAPABILITY_MATRICES,
  resolveComposerImageSupport,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { describe, expect, test } from 'vitest';
import { catalogModelImageSupport } from '../execution';

const connection = (models: unknown[]) =>
  ({
    id: 'opencode',
    runtimeCatalog: { source: 'live', models, builtInModels: [] },
    config: {},
  }) as never;

const model = (id: string, imageInput?: unknown) => ({
  id,
  name: id,
  originalId: id,
  ...(imageInput === undefined ? {} : { capabilities: { imageInput } }),
});

describe('catalogModelImageSupport', () => {
  const runtime = connection([
    model('opencode/sees', true),
    model('opencode/blind', false),
    model('opencode/silent'),
    model('opencode/odd', 'yes'),
  ]);

  test.each([
    ['opencode/sees', 'yes'],
    ['opencode/blind', 'no'],
    ['opencode/silent', 'unknown'],
    ['opencode/odd', 'unknown'],
    ['opencode/absent', 'unknown'],
  ])('%s maps to %s', (modelId, expected) => {
    expect(catalogModelImageSupport(runtime, modelId)).toBe(expected);
  });

  test('no model or no connection is unknown', () => {
    expect(catalogModelImageSupport(runtime, undefined)).toBe('unknown');
    expect(catalogModelImageSupport(undefined, 'opencode/sees')).toBe(
      'unknown',
    );
  });
});

describe('the composer answer for an OpenCode model', () => {
  const acp = ENGINE_CAPABILITY_MATRICES.acp;
  const inputs = (modelSupport: 'yes' | 'no' | 'unknown') => ({
    connectionCapabilities: ['image-input'],
    connectionLabel: 'OpenCode',
    observedImagePrompt: true,
    modelSupportVaries: true,
    modelLabel: 'opencode/blind',
    modelSupport,
  });

  test('yes attaches with no caveat', () => {
    expect(resolveComposerImageSupport(acp, inputs('yes'))).toEqual({
      attachable: true,
    });
  });

  test('no refuses before sending and names the model', () => {
    const answer = resolveComposerImageSupport(acp, inputs('no'));
    expect(answer.attachable).toBe(false);
    expect(answer.refusal).toContain('opencode/blind');
  });

  test('unknown keeps the attach-time caveat', () => {
    const answer = resolveComposerImageSupport(acp, inputs('unknown'));
    expect(answer.attachable).toBe(true);
    expect(answer.caveat).toContain("can't confirm opencode/blind");
  });
});
