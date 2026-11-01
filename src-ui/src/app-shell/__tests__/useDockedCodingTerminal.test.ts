/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  type RegionArrangement,
  removeRegionPane,
  updateRegion,
} from '../../regions/region-model';
import { useDockedCodingTerminal } from '../useDockedCodingTerminal';

const { state } = vi.hoisted(() => ({
  state: {
    regions: undefined as unknown as RegionArrangement,
    chatDockProjectSlug: null as string | null,
  },
}));

const model = {
  get regions() {
    return state.regions;
  },
  readRegions: () => state.regions,
  removePane: vi.fn((region: 'left' | 'right' | 'bottom', surface: string) => {
    state.regions = removeRegionPane(state.regions, region, surface);
    return true;
  }),
  setRegion: vi.fn(
    (
      region: 'left' | 'right' | 'bottom',
      patch: Partial<RegionArrangement['right']>,
    ) => {
      state.regions = updateRegion(state.regions, region, patch);
    },
  ),
};

vi.mock('../../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => model,
}));
vi.mock('../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    chatDockProjectSlug: state.chatDockProjectSlug,
  }),
}));

const withTerminal = (visible: boolean, panes = ['coding:terminal']) =>
  updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'right', {
    panes,
    occupant: panes.at(-1) ?? null,
    visible,
  });

beforeEach(() => {
  state.chatDockProjectSlug = null;
  model.removePane.mockClear();
  model.setRegion.mockClear();
});

test("a shown dock region holding this Project's Terminal is docked; hidden or another Project's is not", () => {
  state.regions = withTerminal(true);
  expect(
    renderHook(() => useDockedCodingTerminal('a')).result.current.docked,
  ).toBe(true);
  state.regions = withTerminal(false);
  expect(
    renderHook(() => useDockedCodingTerminal('a')).result.current.docked,
  ).toBe(false);
  state.regions = withTerminal(true);
  state.chatDockProjectSlug = 'b';
  expect(
    renderHook(() => useDockedCodingTerminal('a')).result.current.docked,
  ).toBe(false);
});

test('moving it back hides a region it leaves empty and keeps one with other panes', () => {
  state.regions = withTerminal(true);
  renderHook(() => useDockedCodingTerminal('a')).result.current.undock();
  expect(state.regions.right.panes).toEqual([]);
  expect(state.regions.right.visible).toBe(false);

  state.regions = withTerminal(true, ['coding:diff', 'coding:terminal']);
  renderHook(() => useDockedCodingTerminal('a')).result.current.undock();
  expect(state.regions.right.panes).toEqual(['coding:diff']);
  expect(state.regions.right.visible).toBe(true);
});
