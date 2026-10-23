/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { useLayoutSessionPanels } from '../useLayoutSessionPanels';

const envelopeKey = 'station-device-settings-v1';
afterEach(() => {
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
});
function Panel({
  layout,
  session = 'conversation',
}: {
  layout: string;
  session?: string;
}) {
  const { panels, update } = useLayoutSessionPanels(layout, session);
  return (
    <button
      type="button"
      onClick={() =>
        update({ side: `${layout}-pane`, lowerOpen: !panels.lowerOpen })
      }
    >
      {layout}:{panels.side ?? 'closed'}:{String(panels.lowerOpen)}
    </button>
  );
}

test('mounted layouts preserve each other across updates and reload without sharing a conversation panel choice', () => {
  const view = render(
    <>
      <Panel layout="research" />
      <Panel layout="sales" />
    </>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'research:closed:false' }),
  );
  expect(
    screen.getByRole('button', { name: 'research:research-pane:true' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'sales:closed:false' }),
  ).toBeTruthy();
  // Another tab writes before this tab receives its storage event. The next
  // local interaction must merge the persisted record, not the rendered copy.
  const envelope = JSON.parse(localStorage.getItem(envelopeKey)!);
  envelope.values.layoutPanels.layouts.sales = {
    sessions: {
      conversation: {
        side: 'remote-sales-pane',
        sideWidth: 600,
        lowerOpen: true,
        lowerHeight: 250,
        inbox: false,
        at: 10,
      },
    },
  };
  localStorage.setItem(envelopeKey, JSON.stringify(envelope));
  fireEvent.click(
    screen.getByRole('button', { name: 'research:research-pane:true' }),
  );
  expect(
    screen.getByRole('button', { name: 'sales:remote-sales-pane:true' }),
  ).toBeTruthy();
  view.unmount();
  act(() => deviceSettingsStore.reloadFromStorage());
  render(
    <>
      <Panel layout="research" />
      <Panel layout="sales" />
    </>,
  );
  expect(
    screen.getByRole('button', { name: 'research:research-pane:false' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'sales:remote-sales-pane:true' }),
  ).toBeTruthy();
  expect(
    deviceSettingsStore.get('layoutPanels').layouts.sales?.sessions.conversation
      ?.sideWidth,
  ).toBe(600);
});
