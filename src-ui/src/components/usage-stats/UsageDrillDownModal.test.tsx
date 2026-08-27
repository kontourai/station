/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { UsageDrillDownModal } from './UsageDrillDownModal';

function renderModel(modelStats: Record<string, unknown>, id = 'model') {
  return render(
    <UsageDrillDownModal
      agents={[]}
      id={id}
      models={[]}
      onClose={vi.fn()}
      type="model"
      usageStats={{ byAgent: {}, byModel: { [id]: modelStats } }}
    />,
  );
}

function statValue(label: string): string | undefined {
  const card = screen.getByText(label).parentElement;
  return card?.querySelector('.usage-stat-value')?.textContent ?? undefined;
}

describe('UsageDrillDownModal — cache-honest model usage (station#4196)', () => {
  test('renders the 212x known answer as an explicitly backed prompt total and per-turn figure', () => {
    renderModel({
      messages: 3,
      inputTokens: 135,
      outputTokens: 600,
      cost: 0.012,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      cacheProvider: 'claude',
      cacheInclusivity: 'disjoint',
      cacheProviderAttribution: 'single',
    });

    expect(statValue('Input Tokens (uncached)')).toBe('135');
    expect(statValue('Cache Read Tokens')).toBe('18,400');
    expect(statValue('Cache Write Tokens')).toBe('10,100');
    expect(statValue('Prompt Total')).toBe('28,635');
    expect(statValue('Prompt Total/Turn')).toBe('9,545');
  });

  test('shows an unverified provider cache component without inventing a prompt sum', () => {
    renderModel({
      messages: 1,
      inputTokens: 3_000,
      outputTokens: 500,
      cost: 0,
      cacheReadTokens: 900,
      cacheProvider: 'codex',
      cacheInclusivity: 'unverified',
      cacheProviderAttribution: 'single',
    });

    expect(statValue('Input Tokens')).toBe('3,000');
    expect(statValue('Cache Read Tokens')).toBe('900');
    expect(screen.queryByText('Prompt Total')).toBeNull();
    expect(screen.queryByText('Prompt Total/Turn')).toBeNull();
    expect(screen.queryByText('Input Tokens (uncached)')).toBeNull();
  });

  test('keeps indeterminate-provider components visible but refuses prompt totals and the uncached qualifier', () => {
    renderModel({
      messages: 3,
      inputTokens: 150,
      outputTokens: 603,
      cost: 0,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      cacheProviderAttribution: 'indeterminate',
    });

    expect(statValue('Input Tokens')).toBe('150');
    expect(statValue('Cache Read Tokens')).toBe('18,400');
    expect(statValue('Cache Write Tokens')).toBe('10,100');
    expect(screen.queryByText('Input Tokens (uncached)')).toBeNull();
    expect(screen.queryByText('Prompt Total')).toBeNull();
    expect(screen.queryByText('Prompt Total/Turn')).toBeNull();
  });

  test('renders a reported cache zero but leaves an absent cache component unrendered', () => {
    renderModel({
      messages: 1,
      inputTokens: 10,
      outputTokens: 1,
      cost: 0,
      cacheReadTokens: 0,
      cacheProvider: 'claude',
      cacheInclusivity: 'disjoint',
      cacheProviderAttribution: 'single',
    });

    expect(statValue('Cache Read Tokens')).toBe('0');
    expect(screen.queryByText('Cache Write Tokens')).toBeNull();
  });
});
