// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { AcpSessionModeChip } from '../components/badges/AcpSessionModeChip';
import { ManagedPolicyContext } from '../contexts/ManagedPolicyContext';

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

  test('captions the chip "Mode" like its Agent and Model neighbours', () => {
    render(
      <AcpSessionModeChip
        modes={MODES}
        currentModeId="build"
        onChange={vi.fn()}
      />,
    );
    const chip = screen.getByRole('button', { name: /^Session mode: Build\./ });
    // The caption is the rail's shared caption element, not free text: the
    // Agent/Model/Approval chips render the same class above their value.
    const caption = within(chip).getByText('Mode');
    expect(caption.className).toBe('chat-input__chip-caption');
    expect(within(chip).getByText('Build')).toBeTruthy();
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

/** #4518: a recognized ACP full-access mode is above a ceiling below Full access. */
describe('AcpSessionModeChip under a managed ceiling of Auto', () => {
  test('a known full-access mode is disabled and marked Managed; others stay offered', async () => {
    const onChange = vi.fn();
    render(
      <ManagedPolicyContext.Provider
        value={{
          organization: 'Acme',
          supportUrl: null,
          lockedSettings: [],
          limits: { maxApprovalMode: 'auto' },
        }}
      >
        <AcpSessionModeChip
          modes={[
            { id: 'default', name: 'Default' },
            { id: 'bypassPermissions', name: 'Bypass Permissions' },
          ]}
          currentModeId="default"
          onChange={onChange}
        />
      </ManagedPolicyContext.Provider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /^Session mode: Default\./ }),
    );
    const group = await screen.findByRole('radiogroup', {
      name: 'Session mode',
    });
    const bypass = within(group).getByRole('radio', {
      name: /Bypass Permissions/,
    }) as HTMLInputElement;
    expect(bypass.disabled).toBe(true);
    expect(within(group).getByText('Managed')).toBeTruthy();
    expect(
      (
        within(group).getByRole('radio', {
          name: /^Default/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(bypass);
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Acme's policy manages approval modes/),
    ).toBeTruthy();
  });
});
