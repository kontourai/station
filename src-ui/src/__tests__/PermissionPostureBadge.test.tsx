// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { PermissionPostureBadge } from '../components/badges/PermissionPostureBadge';
import { permissionPostureLabel } from '../utils/sessionDisplay';

describe('permissionPostureLabel (station#1424)', () => {
  test('read-only-attached renders "Read only"', () => {
    expect(permissionPostureLabel('read-only-attached')).toBe('Read only');
  });
});

describe('PermissionPostureBadge', () => {
  test('renders nothing when there is no posture to flag', () => {
    const { container } = render(<PermissionPostureBadge posture={null} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders the human-readable label for read-only-attached', () => {
    render(<PermissionPostureBadge posture="read-only-attached" />);
    expect(screen.getByText('Read only')).toBeTruthy();
  });
});
