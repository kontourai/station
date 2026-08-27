// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { OwnerChip } from '../components/badges/OwnerChip';
import {
  accountableHumanFromUser,
  ownerAttributionFromStation,
} from '../utils/ownerAttribution';

describe('ownerAttributionFromStation (station#2585)', () => {
  test('prefers the active saved Station name over Station identity', () => {
    expect(
      ownerAttributionFromStation(
        { id: 'saved-kontour', name: 'Kontour' },
        'Station v0.1.0 · abcdef0',
      ),
    ).toEqual({ id: 'saved-kontour', label: 'Kontour' });
  });

  test('falls back to Station identity when no saved Station name resolves', () => {
    expect(
      ownerAttributionFromStation(null, 'Station v0.1.0 · abcdef0'),
    ).toEqual({
      id: 'station:Station v0.1.0 · abcdef0',
      label: 'Station v0.1.0 · abcdef0',
    });
  });

  test('renders nothing rather than using an alias when Station identity is unavailable', () => {
    expect(ownerAttributionFromStation(null, null)).toBeNull();
  });

  test('never accepts the OS alias as a row label', () => {
    expect(accountableHumanFromUser({ name: 'Brian Anderson' })).toBe(
      'Brian Anderson',
    );
    expect(
      accountableHumanFromUser({ alias: 'os-login' } as { name?: string }),
    ).toBeNull();
  });
});

describe('OwnerChip', () => {
  test('renders nothing when there is no resolved owner', () => {
    const { container } = render(<OwnerChip owner={null} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders only the producer label, never its stable id', () => {
    render(
      <OwnerChip owner={{ id: 'station:private-id', label: 'Kontour' }} />,
    );
    expect(screen.getByText('via Kontour')).toBeTruthy();
    expect(screen.queryByText('station:private-id')).toBeNull();
  });
});
