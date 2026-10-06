/** @vitest-environment jsdom */
import type { SavedConnection } from '@kontourai/station-connect';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { StationSwitcherMenu } from '../components/header/StationSwitcherMenu';
import { navigationStore } from '../contexts/navigation-store';

const station: SavedConnection = {
  profileVersion: 4,
  id: 'one',
  name: 'Workstation',
  url: 'https://one.example.test',
  endpoints: [
    {
      endpointVersion: 1,
      id: 'one-endpoint',
      url: 'https://one.example.test',
      kind: 'manual',
      priority: 0,
    },
  ],
  selectedEndpointId: 'one-endpoint',
  accessMethods: [
    {
      accessVersion: 1,
      id: 'one-access',
      kind: 'direct-http',
      endpointId: 'one-endpoint',
    },
  ],
  selectedAccessMethodId: 'one-access',
  environmentId: null,
  authProtocolVersion: null,
  credentialRef: {
    credentialVersion: 1,
    kind: 'connection',
    id: 'one-credential',
  },
  capabilities: null,
  credentialState: 'saved',
};
const laptop: SavedConnection = {
  ...station,
  id: 'two',
  credentialRef: {
    credentialVersion: 1,
    kind: 'connection',
    id: 'two-credential',
  },
  name: 'Laptop',
  url: 'https://two.example.test',
  endpoints: [
    {
      endpointVersion: 1,
      id: 'two-endpoint',
      url: 'https://two.example.test',
      kind: 'manual',
      priority: 0,
    },
  ],
  selectedEndpointId: 'two-endpoint',
  accessMethods: [
    {
      accessVersion: 1,
      id: 'two-access',
      kind: 'direct-http',
      endpointId: 'two-endpoint',
    },
  ],
  selectedAccessMethodId: 'two-access',
};
const unregister: Array<() => void> = [];
afterEach(() => {
  cleanup();
  unregister.splice(0).forEach((remove) => remove());
});
function openMenu() {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  anchor.focus();
  const select = vi.fn(async (_connection: SavedConnection) => {});
  const close = vi.fn();
  const manage = vi.fn();
  render(
    <StationSwitcherMenu
      anchor={anchor}
      connections={[station, laptop]}
      activeConnectionId="one"
      activeStatus="connected"
      activeStatusLabel="Connected"
      onSelect={select}
      onClose={close}
      onManage={manage}
    />,
  );
  unregister.push(() => anchor.remove());
  return { select, close, manage };
}
test('marks the current Station, reports unchecked peers, and exposes management separately', () => {
  const { select, manage } = openMenu();
  expect(
    screen
      .getByRole('menuitemradio', { name: 'Workstation — Connected' })
      .getAttribute('aria-checked'),
  ).toBe('true');
  expect(
    screen
      .getByRole('menuitemradio', { name: 'Laptop — Not checked' })
      .getAttribute('aria-checked'),
  ).toBe('false');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Manage Stations' }));
  expect(manage).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});
test('waits for the registered unsaved-work decision before switching', async () => {
  let proceed: (() => void) | undefined;
  unregister.push(
    navigationStore.registerNavigationGuard(Symbol('dirty-editor'), (next) => {
      proceed = next;
    }),
  );
  const { select, close } = openMenu();
  fireEvent.click(
    screen.getByRole('menuitemradio', { name: 'Laptop — Not checked' }),
  );
  expect(proceed).toBeTypeOf('function');
  expect(select).not.toHaveBeenCalled();
  await act(async () => proceed?.());
  expect(select).toHaveBeenCalledExactlyOnceWith(laptop);
  expect(close).toHaveBeenCalledOnce();
});
test('cancelling an unsaved-work decision keeps the Station and permits another attempt', () => {
  let cancel: (() => void) | undefined;
  unregister.push(
    navigationStore.registerNavigationGuard(
      Symbol('dirty-editor'),
      (_next, cancelled) => {
        cancel = cancelled;
      },
    ),
  );
  const { select } = openMenu();
  fireEvent.click(
    screen.getByRole('menuitemradio', { name: 'Laptop — Not checked' }),
  );
  act(() => cancel?.());
  expect(select).not.toHaveBeenCalled();
  expect(
    screen
      .getByRole('menuitemradio', { name: 'Laptop — Not checked' })
      .hasAttribute('disabled'),
  ).toBe(false);
});
