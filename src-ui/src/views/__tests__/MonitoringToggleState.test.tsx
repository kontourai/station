/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MonitoringLogControls } from '../MonitoringLogControls';
import { MonitoringTimeControls } from '../MonitoringTimeControls';
import { EVENT_TYPE_GROUPS } from '../monitoring-utils';

/**
 * 6-, measured on the audited build: one toolbar carrying three toggle
 * conventions. `Auto Follow` exposed `aria-pressed="true"→"false"`, while
 * LIVE and the five event filters (AGENT / TOOL / REASONING / PLANNING /
 * HEALTH) exposed no pressed state at all — their only state was the CSS
 * class `live-mode-toggle active` / `event-filter active`, which is colour,
 * not information.
 *
 * Both assertions below are two-directional on purpose: a control that is
 * always `aria-pressed="true"` is as uninformative as one with no attribute.
 */
const timeProps = {
  clearTime: null,
  timeMode: 'relative' as const,
  relativeTime: '5m' as const,
  absoluteStart: '',
  absoluteEnd: '',
  elapsedLabel: '',
  showTimeControls: false,
  onToggleControls: vi.fn(),
  onTimeModeChange: vi.fn(),
  onRelativeSelect: vi.fn(),
  onAbsoluteStartChange: vi.fn(),
  onAbsoluteEndChange: vi.fn(),
  onAbsoluteEndNow: vi.fn(),
  onApplyAbsolute: vi.fn(),
  onToggleLiveMode: vi.fn(),
  onClearAll: vi.fn(),
};

const logProps = {
  onToggleEventType: vi.fn(),
  searchQuery: '',
  onSearchQueryChange: vi.fn(),
  onSearchKeyDown: vi.fn(),
  onSearchBlur: vi.fn(),
  showAutocomplete: false,
  autocompleteOptions: [],
  selectedIndex: 0,
  onAutocompleteSelect: vi.fn(),
};

describe('Monitoring toggle state', () => {
  test('LIVE reports its own pressed state in both directions', () => {
    const { rerender } = render(
      <MonitoringTimeControls {...timeProps} isLiveMode />,
    );
    const live = screen.getByRole('button', { name: /LIVE/ });
    expect(live.getAttribute('aria-pressed')).toBe('true');

    rerender(<MonitoringTimeControls {...timeProps} isLiveMode={false} />);
    expect(
      screen.getByRole('button', { name: /LIVE/ }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  test('an event filter reports pressed only while its whole group is selected', () => {
    const { rerender } = render(
      <MonitoringLogControls {...logProps} eventTypeFilter={[]} />,
    );
    const agent = screen.getByRole('button', { name: 'AGENT' });
    expect(agent.getAttribute('aria-pressed')).toBe('false');
    // `aria-pressed` tracks the same predicate the `active` class does, so
    // the two can never disagree about the same filter.
    expect(agent.className).not.toContain('active');

    rerender(
      <MonitoringLogControls
        {...logProps}
        eventTypeFilter={[...EVENT_TYPE_GROUPS.Agent]}
      />,
    );
    const pressed = screen.getByRole('button', { name: 'AGENT' });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(pressed.className).toContain('active');
    // A different group is untouched by the AGENT selection.
    expect(
      screen.getByRole('button', { name: 'TOOL' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });
});
