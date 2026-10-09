// @vitest-environment jsdom

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import type { NewChatModelChoice } from '../../../utils/modelCapabilities';
import { StartModelPicker } from '../StartMenus';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../../../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSshEnvironmentsQuery: () => ({ data: [], isSuccess: true }),
  usePeerCredentialsQuery: () => ({ data: [], isSuccess: true }),
}));

beforeEach(() => {
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const models = [
  {
    id: 'fast-model',
    name: 'Fast model',
    capabilities: { supportsEffort: true, supportedEffortLevels: ['low'] },
  },
  { id: 'deep-model', name: 'Deep model' },
];

/** The Home and dock start composers' chip menu: open until it closes. */
function Harness({
  choice,
  onSelect = vi.fn(),
  onReset = vi.fn(),
  onRuntimeOptionChange = vi.fn(),
}: {
  choice?: NewChatModelChoice;
  onSelect?: () => void;
  onReset?: () => void;
  onRuntimeOptionChange?: () => void;
}) {
  const [open, setOpen] = useState(true);
  if (!open) return <p>picker closed</p>;
  return (
    <StartModelPicker
      anchor={null}
      layer="dialog"
      models={models}
      loading={false}
      modelConnections={[]}
      choice={choice}
      defaultModel={{ id: 'deep-model', source: 'project default' }}
      onSelect={onSelect}
      onReset={onReset}
      onRuntimeOptionChange={onRuntimeOptionChange}
      onClose={() => setOpen(false)}
    />
  );
}

describe('StartModelPicker', () => {
  test('choosing a Model applies it and closes the picker', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole('option', { name: /Fast model/ }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fast-model' }),
    );
    await waitFor(() => expect(screen.getByText('picker closed')).toBeTruthy());
  });

  test('the reset names the default source, and resetting closes the picker', async () => {
    const onReset = vi.fn();
    const onRuntimeOptionChange = vi.fn();
    render(
      <Harness
        choice={{ modelId: 'fast-model', providerOptions: {} }}
        onReset={onReset}
        onRuntimeOptionChange={onRuntimeOptionChange}
      />,
    );
    // An effort change is not a finished choice: the picker stays.
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Thinking effort' }),
      { target: { value: 'low' } },
    );
    expect(onRuntimeOptionChange).toHaveBeenCalledWith('effort', 'low');
    expect(screen.queryByText('picker closed')).toBeNull();

    expect(
      screen.queryByRole('button', { name: /session override/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Use project default' }),
    );
    expect(onReset).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('picker closed')).toBeTruthy());
  });
});

test('the Station control remains inside the picker dismissal and focus boundary', async () => {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StartModelPicker
        anchor={null}
        layer="dialog"
        models={models}
        loading={false}
        modelConnections={[]}
        profile={{ slug: agentId('reviewer'), name: 'Reviewer' }}
        onEnvironmentChange={vi.fn()}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onRuntimeOptionChange={vi.fn()}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  const station = await screen.findByRole('combobox', {
    name: 'Execution Station',
  });
  fireEvent.pointerDown(station);
  expect(onClose).not.toHaveBeenCalled();
  expect(
    screen.getByRole('dialog', { name: 'Choose model' }).contains(station),
  ).toBe(true);
});
