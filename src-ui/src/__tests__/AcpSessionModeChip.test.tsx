// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { AcpSessionModeChip } from '../components/badges/AcpSessionModeChip';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

const MODES = [
  { id: 'build', name: 'Build' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning' },
];

describe('AcpSessionModeChip', () => {
  test('renders nothing when the engine advertised no modes', () => {
    const { container } = render(
      <AcpSessionModeChip modes={[]} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('shows the advertised current label, not a Station approval-mode name', () => {
    render(
      <AcpSessionModeChip
        modes={MODES}
        currentModeId="plan"
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /^Session mode: Plan\./ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^Approval mode:/ }),
    ).toBeNull();
  });

  test('selecting an advertised mode reports that id', async () => {
    const onChange = vi.fn();
    render(
      <AcpSessionModeChip
        modes={MODES}
        currentModeId="build"
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /^Session mode: Build\./ }),
    );
    await screen.findByRole('radiogroup', { name: 'Session mode' });
    fireEvent.click(screen.getByRole('radio', { name: /Plan/ }));
    expect(onChange).toHaveBeenCalledWith('plan');
  });
});
