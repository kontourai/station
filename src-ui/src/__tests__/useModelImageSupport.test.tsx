// @vitest-environment jsdom

/**
 * archive#3344  `useModelImageSupport` is the whole reason
 * "the Bedrock catalog has no row for this model" stopped meaning "this model
 * cannot see images" — and nothing exercised it directly. Collapsing its
 * three states back to a boolean passed the entire suite, so the tri-state it
 * exists to express had no test power at all.
 *
 * Each branch is asserted against the catalog shape
 * `GET /api/models/capabilities` actually returns (the
 * `ListFoundationModels` projection in `routes/connections/models.ts`).
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useModelImageSupport } from '../contexts/ModelCapabilitiesContext';

const catalog = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock('@kontourai/station-sdk', () => ({
  useModelCapabilitiesQuery: () => ({ data: catalog.data }),
}));

describe('useModelImageSupport', () => {
  beforeEach(() => {
    catalog.data = [];
  });

  test("'yes' when a matched row declares an image input modality", () => {
    catalog.data = [
      {
        modelId: 'anthropic.claude-vision-v1',
        inputModalities: ['TEXT', 'IMAGE'],
        supportsImages: true,
      },
    ];
    const { result } = renderHook(() =>
      useModelImageSupport('anthropic.claude-vision-v1'),
    );
    expect(result.current).toBe('yes');
  });

  test("'no' only when a matched row lists its modalities and images are not among them", () => {
    catalog.data = [
      {
        modelId: 'cohere.embed-text-v1',
        inputModalities: ['TEXT'],
        supportsImages: false,
      },
    ];
    const { result } = renderHook(() =>
      useModelImageSupport('cohere.embed-text-v1'),
    );
    expect(result.current).toBe('no');
  });

  test("'unknown' when the catalog has no row for this model", () => {
    catalog.data = [
      { modelId: 'anthropic.claude-vision-v1', inputModalities: ['IMAGE'] },
    ];
// A Claude Code / Codex / ACP / Ollama model id: real, and absent from a
// catalog that only knows Bedrock. This is the case that used to read as
// a refusal.
    const { result } = renderHook(() => useModelImageSupport('gpt-5-codex'));
    expect(result.current).toBe('unknown');
  });

  test("'unknown' when the catalog is empty — no AWS credentials, not a refusal", () => {
    catalog.data = [];
    const { result } = renderHook(() =>
      useModelImageSupport('anthropic.claude-vision-v1'),
    );
    expect(result.current).toBe('unknown');
  });

  test("'unknown' when a matched row declines to list any modality", () => {
    catalog.data = [{ modelId: 'mystery-model', inputModalities: [] }];
    const { result } = renderHook(() => useModelImageSupport('mystery-model'));
    expect(result.current).toBe('unknown');
  });

// The shape the browser fixture actually serves, and the shape any producer
// that has not filled the field in serves. `inputModalities` is typed as
// required but crosses the wire; reading `.length` off it unchecked threw
// inside a hook the composer calls on every render, which blanked the whole
// app rather than answering the question wrongly.
  test("'unknown' when a matched row omits inputModalities entirely", () => {
    catalog.data = [{ modelId: 'model-default' }];
    const { result } = renderHook(() => useModelImageSupport('model-default'));
    expect(result.current).toBe('unknown');
  });

  test("'unknown' when inputModalities is not an array at all", () => {
    catalog.data = [{ modelId: 'model-default', inputModalities: null }];
    const { result } = renderHook(() => useModelImageSupport('model-default'));
    expect(result.current).toBe('unknown');
  });

  test("'unknown' with no model selected", () => {
    const { result } = renderHook(() => useModelImageSupport(undefined));
    expect(result.current).toBe('unknown');
  });

  test('a cross-region inference prefix still matches its catalog row', () => {
    catalog.data = [
      {
        modelId: 'anthropic.claude-vision-v1',
        inputModalities: ['TEXT', 'IMAGE'],
        supportsImages: true,
      },
    ];
    const { result } = renderHook(() =>
      useModelImageSupport('us.anthropic.claude-vision-v1'),
    );
    expect(result.current).toBe('yes');
  });
});
