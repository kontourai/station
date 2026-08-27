// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  data: undefined as any,
  error: undefined as Error | undefined,
  isFetchedAfterMount: false,
  isLoading: false,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useModelsQuery: () => state,
}));

import { useModelsCatalog } from '../contexts/ModelsContext';

describe('useModelsCatalog loading boundary', () => {
  test('distinguishes initial loading from paused or failed settled empty data', () => {
    state.isLoading = true;
    let result = renderHook(() => useModelsCatalog()).result;
    expect(result.current).toMatchObject({
      models: [],
      modelsLoading: true,
      isLiveConfirmed: false,
    });
    state.isLoading = false;
    state.error = new Error('offline');
    result = renderHook(() => useModelsCatalog()).result;
    expect(result.current).toMatchObject({
      models: [],
      modelsLoading: false,
      isLiveConfirmed: false,
    });
    state.error = undefined;
  });
});
