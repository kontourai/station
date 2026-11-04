/** @vitest-environment jsdom */
/**
 * #4521: with the managed policy's `limits.telemetry: false`, Settings shows
 * the policy's sentence instead of usage-sharing choices that could never
 * take effect (the server refuses a raise).
 */
import type { TelemetryPublisherStatus } from '@kontourai/station-contracts/product-telemetry';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TelemetryTierSettings } from '../TelemetryTierSettings';

afterEach(cleanup);

const denial =
  "Acme's policy manages usage sharing: it is turned off. For help, visit https://help.example/station";
const managed: TelemetryPublisherStatus = {
  tier: 'off',
  reason: 'managed',
  userChoice: 'full',
  managedDenial: denial,
};

test('shows the managed sentence and offers no sharing choice', () => {
  render(
    <TelemetryTierSettings
      config={{ telemetryTier: { kontour: 'full', operator: 'full' } } as never}
      onChange={vi.fn()}
      publishers={{ kontour: managed, operator: managed }}
      advancedContent={<p>Collector settings</p>}
    />,
  );
  expect(
    screen.getByRole('region', { name: 'Usage sharing is managed' })
      .textContent,
  ).toContain(denial);
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  // Endpoint settings stay reachable under Advanced.
  expect(screen.getByText('Collector settings')).toBeTruthy();
});

test('control: without the managed reason the choices render', () => {
  render(
    <TelemetryTierSettings
      config={{ telemetryTier: { kontour: 'lite', operator: 'lite' } } as never}
      onChange={vi.fn()}
      publishers={{
        kontour: { tier: 'lite', reason: 'user' },
        operator: { tier: 'lite', reason: 'user' },
      }}
    />,
  );
  expect(
    screen.queryByRole('region', { name: 'Usage sharing is managed' }),
  ).toBeNull();
  expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
});
