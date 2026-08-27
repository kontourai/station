/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ProvenanceBadge } from '../components/ProvenanceBadge';

describe('ProvenanceBadge', () => {
  test('no provenance renders nothing', () => {
    const { container } = render(<ProvenanceBadge />);
    expect(container.textContent).toBe('');
  });

  test('source: file renders nothing', () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ source: 'file' }} />,
    );
    expect(container.textContent).toBe('');
  });

  test('source: default renders a subtle Default chip', () => {
    render(<ProvenanceBadge provenance={{ source: 'default' }} />);
    expect(screen.getByText('Default')).toBeTruthy();
  });

  test('source: env renders "Set by operator: {envVar}"', () => {
    render(
      <ProvenanceBadge
        provenance={{ source: 'env', envVar: 'STATION_FEATURES' }}
      />,
    );
    expect(screen.getByText('Set by operator: STATION_FEATURES')).toBeTruthy();
  });

  // station#1557: there is no "Overridden by {var}" chip any more. It claimed
  // the stored value did not apply, and for its single instance (`region`)
  // that was the opposite of what the resolver did.
  test('a stored value renders no badge, whatever the environment holds', () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ source: 'file' }} />,
    );
    expect(container.textContent).toBe('');
  });

  test('no rendering path produces an override claim', () => {
    for (const provenance of [
      { source: 'file' as const },
      { source: 'default' as const },
      { source: 'env' as const, envVar: 'AWS_REGION' },
    ]) {
      const { container } = render(<ProvenanceBadge provenance={provenance} />);
      expect(container.textContent).not.toMatch(/overrid/i);
    }
  });
});
