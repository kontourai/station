/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

let runtimeConnectionsMock: Array<{ id: string; name: string }> = [];

vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({
    data: runtimeConnectionsMock,
  }),
}));

vi.mock('../components/ModelSelector', () => ({
  ModelSelector: ({
    value,
    placeholder,
  }: {
    value: string;
    placeholder?: string;
  }) => (
    <input
      aria-label="Default Model"
      defaultValue={value}
      placeholder={placeholder}
      readOnly
    />
  ),
}));

vi.mock('../utils/execution', () => ({
  preferredChatRuntime: (connections: Array<{ id: string; name: string }>) =>
    connections[0] ?? null,
  runtimeCatalogVisibleModels: (
    runtime: { id: string; name: string } | null,
  ) =>
    runtime
      ? [
          {
            id: 'runtime-model',
            name: 'Runtime Model',
            originalId: 'runtime-model',
          },
        ]
      : [],
}));

const navigateMock = vi.fn();
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

import { fireEvent } from '@testing-library/react';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { AgentDefaultsSection } from '../views/settings/AgentDefaultsSection';

const baseProps = {
  validationErrors: {},
  validationWarnings: {},
  onChange: vi.fn(),
  region: 'us-east-1',
  regionError: undefined,
  onRegionChange: vi.fn(),
  // Pass-through by default (the "not dirty" case) — tests below that need
  // the intercepting behavior render `GuardedHarness` instead.
  guard: (callback: () => void) => callback(),
};

/**
 * `SettingsView.tsx`'s real shape: `useUnsavedGuard(dirty)`'s `guard` passed
 * straight into `AgentDefaultsSection`, with `<DiscardModal />` rendered
 * alongside it — station#settings-revamp slice 5 review finding HIGH 1's
 * repro ("dirty the Defaults model field, click 'Open Agents' → unsaved edit
 * silently discarded") reproduced and proven fixed against the REAL hook,
 * not a mock of it.
 */
function GuardedHarness({ dirty }: { dirty: boolean }) {
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  return (
    <>
      <AgentDefaultsSection
        {...baseProps}
        config={{ defaultModel: '' }}
        showRegion
        guard={guard}
      />
      <DiscardModal />
    </>
  );
}

describe('AgentDefaultsSection', () => {
  test('uses generic default-model hint when no runtime-backed options are available', () => {
    runtimeConnectionsMock = [];

    render(
      <AgentDefaultsSection
        {...baseProps}
        config={{ defaultModel: '' }}
        showRegion
      />,
    );

    expect(
      screen.getByText(
        "Default model for new chats and agents that don't specify one.",
      ),
    ).toBeTruthy();
  });

  test('mentions the preferred runtime when runtime-backed model options are available', () => {
    runtimeConnectionsMock = [{ id: 'codex', name: 'Codex Runtime' }];

    render(
      <AgentDefaultsSection
        {...baseProps}
        config={{ defaultModel: '' }}
        showRegion
      />,
    );

    expect(
      screen.getByText(
        "Default model for new chats and agents that don't specify one. Options currently come from Codex Runtime.",
      ),
    ).toBeTruthy();
  });

  test('hides the region field when disabled', () => {
    render(
      <AgentDefaultsSection
        {...baseProps}
        config={{ defaultModel: '' }}
        showRegion={false}
      />,
    );

    expect(screen.queryByLabelText('Default Region')).toBeNull();
  });

  test('shows the region field when enabled', () => {
    render(
      <AgentDefaultsSection
        {...baseProps}
        config={{ defaultModel: '' }}
        showRegion
      />,
    );

    expect(screen.getByLabelText('Default Region')).toBeTruthy();
  });

  test('does not label the instructions field as a global override', () => {
    render(
      <AgentDefaultsSection
        {...baseProps}
        config={{ defaultModel: '' }}
        showRegion
      />,
    );

    expect(screen.getByText('Default Agent Instructions')).toBeTruthy();
    expect(screen.queryByText('Global System Instructions')).toBeNull();
  });

  // station#settings-revamp slice 5 review finding HIGH 1.
  describe('unsaved-guard wiring for the "Open Agents" cross-links', () => {
    test('both Default model and Default region captions navigate to /agents when the page is not dirty', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty={false} />);

      const links = screen.getAllByRole('button', { name: 'Open Agents' });
      expect(links).toHaveLength(2);

      fireEvent.click(links[0]);
      expect(navigateMock).toHaveBeenCalledWith('/agents');
      expect(screen.queryByText('Unsaved Changes')).toBeNull();

      navigateMock.mockClear();
      fireEvent.click(links[1]);
      expect(navigateMock).toHaveBeenCalledWith('/agents');
      expect(screen.queryByText('Unsaved Changes')).toBeNull();
    });

    test('default-model caption: a dirty page intercepts navigation with the discard-confirmation modal instead of silently navigating away', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      const links = screen.getAllByRole('button', { name: 'Open Agents' });
      fireEvent.click(links[0]);

      expect(navigateMock).not.toHaveBeenCalled();
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
      expect(
        screen.getByText('You have unsaved changes. Discard them?'),
      ).toBeTruthy();
    });

    test('region caption: a dirty page intercepts navigation with the discard-confirmation modal instead of silently navigating away', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      const links = screen.getAllByRole('button', { name: 'Open Agents' });
      fireEvent.click(links[1]);

      expect(navigateMock).not.toHaveBeenCalled();
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });

    test('confirming discard from a dirty page completes the deferred navigation', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getAllByRole('button', { name: 'Open Agents' })[0],
      );
      expect(navigateMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(navigateMock).toHaveBeenCalledWith('/agents');
    });
  });
});
