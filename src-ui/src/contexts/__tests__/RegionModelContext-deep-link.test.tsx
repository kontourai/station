// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

let model: ReturnType<typeof useRegionModel>;
function Probe() {
  model = useRegionModel();
  return null;
}
afterEach(cleanup);
test('a legacy session URL delivers one Chat intent and consumption cannot replay it', async () => {
  act(() =>
    navigationStore.navigate(
      '/?surface=activity&session=record-1&messageSession=record-1&messageDirection=sent&messageRequest=request-1',
    ),
  );
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() =>
    expect(model.surfaceIntents.chat?.session).toBe('record-1'),
  );
  const intent = model.surfaceIntents.chat!;
  expect(intent.messageAnchor).toEqual({
    direction: 'sent',
    requestKey: 'request-1',
  });
  expect(model.surfaceIntents.activity).toBeUndefined();
  act(() => model.consumeSurfaceIntent('chat', intent.token));
  expect(model.surfaceIntents.chat).toBeUndefined();
  act(() => model.showSurface('chat'));
  expect(model.surfaceIntents.chat).toBeUndefined();
});
