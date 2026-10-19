/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { useDeveloperFeatures } from '../../../hooks/useDeveloperFeatures';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { DeveloperFeatures } from '../DeveloperFeatures';

const previewKeys = [
  'experimentalFlowEnabled',
  'experimentalReadinessEnabled',
  'experimentalTrustEnabled',
] as const;
beforeEach(() =>
  deviceSettingsStore.resetMany(['developerToolsEnabled', ...previewKeys]),
);
afterEach(() => {
  cleanup();
  deviceSettingsStore.resetMany(['developerToolsEnabled', ...previewKeys]);
});

function PreviewStatus() {
  const features = useDeveloperFeatures();
  return (
    <output>
      {Object.entries(features)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .join(',') || 'none'}
    </output>
  );
}

test('Developer tools reveals three off-by-default independent opt-ins; disabling it withdraws previews without erasing choices', () => {
  render(
    <>
      <DeveloperFeatures />
      <PreviewStatus />
    </>,
  );
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('none');
  act(() => deviceSettingsStore.set('developerToolsEnabled', true));
  const flow = screen.getByRole('switch', { name: 'Flow delivery preview' });
  const readiness = screen.getByRole('switch', {
    name: 'Veritas readiness preview',
  });
  const trust = screen.getByRole('switch', { name: 'Trust preview' });
  for (const toggle of [flow, readiness, trust])
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(flow);
  expect(screen.getByRole('status').textContent).toBe('flow');
  expect(deviceSettingsStore.get('experimentalFlowEnabled')).toBe(true);
  expect(readiness.getAttribute('aria-checked')).toBe('false');
  expect(trust.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(readiness);
  expect(screen.getByRole('status').textContent).toBe('flow,readiness');
  fireEvent.click(trust);
  expect(screen.getByRole('status').textContent).toBe('flow,readiness,trust');
  act(() => deviceSettingsStore.set('developerToolsEnabled', false));
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('none');
  for (const key of previewKeys)
    expect(deviceSettingsStore.get(key)).toBe(true);
});
