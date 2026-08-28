/**
 * @vitest-environment jsdom
 *
 * archive#1549 — the `observation-required` picker state.
 *
 * THIS FILE NO LONGER MOCKS THE MATRIX (archive#1684). Slice 1 had to: no
 * shipped cell carried a `runtime_observation` basis, so no real connection
 * could reach this state, and a `resolveEngineCapabilityMatrix` mock
 * supplied the one thing would later ship. Slice 2 shipped it — the
 * real `acp` cell now declares `mechanism: 'http-header-token'` with
 * `basis: 'runtime_observation'` — so the mock became a SHADOW of production
 * data, which is worse than no test at all: with it in place, reverting the
 * cell would leave every assertion below green.
 *
 * Everything here now runs production code end to end —
 * `ENGINE_CAPABILITY_MATRICES`, `resolveEngineCapabilityMatrix`,
 * `engineControlPlaneCapability`, `resolveBuiltinAgentEngineBinding`,
 * `readyEngineOptions`, and the picker component — and the only inputs are
 * the connection fixtures below and the observations attached to them.
 */

import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { EnginePicker } from '../components/EnginePicker';
import { builtinEngineDisplay } from '../utils/engineBinding';

let statusData: any = { providers: { configuredChatReady: false } };
let connectionsData: any[] = [];
let configData: any;
const mutate = vi.fn();
const reconnectMutate = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({ data: statusData }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: connectionsData }),
  useConfigQuery: () => ({ data: configData }),
  useUpdateConfigMutation: () => ({ mutate, isPending: false }),
  useReconnectACPConnectionMutation: () => ({ mutateAsync: reconnectMutate }),
  useQueryClient: () => ({ invalidateQueries }),
}));

function commandBackedConnection(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'kiro-1',
    kind: 'agent' as const,
    type: 'acp',
    name: 'Kiro',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready' as const, detected: true, configured: true },
    ...overrides,
  };
}

function claudeConnection(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'claude-runtime',
    kind: 'agent' as const,
    type: 'claude',
    name: 'Claude Code',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready' as const, detected: false, configured: true },
    ...overrides,
  };
}

const OBSERVED_YES = { mcpHttp: true, observedAt: '2026-08-02T00:00:00.000Z' };
const OBSERVED_NO = { mcpHttp: false, observedAt: '2026-08-02T00:00:00.000Z' };

function renderPicker() {
  return render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);
}

describe('station#1549: the observation-required picker state', () => {
  beforeEach(() => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [];
    configData = {};
    mutate.mockClear();
    reconnectMutate.mockReset();
    invalidateQueries.mockClear();
  });

  test('an unobserved connection is LISTED with its own name and explained in place — never silently dropped', () => {
    connectionsData = [commandBackedConnection()];
    renderPicker();

    // Opening the picker triggers the probe immediately, so the honest
    // sub-line while it is in flight says so — and names the CONNECTION,
    // never the protocol it speaks.
    expect(screen.getByTestId('engine-picker-pending-kiro-1')).toBeTruthy();
    expect(screen.getByText('Checking what Kiro supports…')).toBeTruthy();
  });

  test('a probe that settles WITHOUT producing an observation falls back to the honest not-checked-yet copy — the row never spins forever', async () => {
    // The failure path matters: a probe can fail (CLI missing, spawn error),
    // and a row left saying "Checking…" indefinitely would be a lie of a
    // different kind — it implies an answer is coming.
    reconnectMutate.mockRejectedValue(new Error('spawn failed'));
    connectionsData = [commandBackedConnection()];
    renderPicker();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText(
        'Not checked yet — Station verifies what Kiro supports when it connects.',
      ),
    ).toBeTruthy();
    // …and the refresh was asked for, so an observation that DID land is
    // picked up rather than waiting for the next 60s cadence.
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['connections', 'runtimes'],
    });
  });

  test('EVERY pending row settles, not just the last one probed — one mutation observer must not swallow the others', async () => {
    // Review finding. `mutate(id, { onSettled })` keeps ONE options slot and
    // ONE current mutation per observer, so a second call in the same effect
    // pass overwrites the first's callbacks and detaches its observer: with
    // two unobserved connections only the LAST row would ever stop saying
    // "Checking…", and the other would assert an answer was coming forever.
    reconnectMutate.mockRejectedValue(new Error('spawn failed'));
    connectionsData = [
      commandBackedConnection({ id: 'first', name: 'First' }),
      commandBackedConnection({ id: 'second', name: 'Second' }),
    ];
    renderPicker();

    expect(screen.getByText('Checking what First supports…')).toBeTruthy();
    expect(screen.getByText('Checking what Second supports…')).toBeTruthy();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText(
        'Not checked yet — Station verifies what First supports when it connects.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Not checked yet — Station verifies what Second supports when it connects.',
      ),
    ).toBeTruthy();
    expect(reconnectMutate).toHaveBeenCalledTimes(2);
  });

  test('an unobserved connection is NOT selectable — no radio is offered for an answer Station does not have', () => {
    connectionsData = [commandBackedConnection(), claudeConnection()];
    renderPicker();

    // Claude is capable and gets a radio; the unobserved row does not.
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(
      screen
        .getByTestId('engine-picker-pending-kiro-1')
        .querySelector('input[type="radio"]'),
    ).toBeNull();
  });

  test('an unobserved connection is never optimistically bound — the confirm button carries the capable engine, not the unobserved one', () => {
    connectionsData = [commandBackedConnection(), claudeConnection()];
    renderPicker();

    fireEvent.click(screen.getByText('Use this engine'));
    expect(mutate).toHaveBeenCalledWith(
      { builtinAgentEngineConnectionId: 'claude-runtime' },
      expect.anything(),
    );
  });

  test('opening the picker probes the unobserved connection — once, and only the unobserved one', () => {
    connectionsData = [commandBackedConnection(), claudeConnection()];
    const view = renderPicker();

    expect(reconnectMutate).toHaveBeenCalledTimes(1);
    expect(reconnectMutate.mock.calls[0][0]).toBe('kiro-1');

    // A re-render must not re-spawn. A probe is a real child process; firing
    // it per render would turn an explanation into a spawn loop.
    view.rerender(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);
    expect(reconnectMutate).toHaveBeenCalledTimes(1);
  });

  test('a connection whose answer is already known is never probed — in EITHER direction', () => {
    connectionsData = [
      commandBackedConnection({
        id: 'yes-1',
        name: 'Observed Yes',
        controlPlaneObservation: OBSERVED_YES,
      }),
      commandBackedConnection({
        id: 'no-1',
        name: 'Observed No',
        controlPlaneObservation: OBSERVED_NO,
      }),
    ];
    renderPicker();
    expect(reconnectMutate).not.toHaveBeenCalled();
  });

  test('an observed YES resolves in place: a normal selectable row, no pending copy', () => {
    connectionsData = [
      commandBackedConnection({ controlPlaneObservation: OBSERVED_YES }),
    ];
    renderPicker();

    expect(screen.queryByTestId('engine-picker-pending-kiro-1')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByText('Kiro')).toBeTruthy();
  });

  test('an observed NO is plain chat-only — #1283 shipped copy, unchanged, and no not-checked-yet row', () => {
    connectionsData = [
      commandBackedConnection({ controlPlaneObservation: OBSERVED_NO }),
    ];
    renderPicker();

    expect(screen.getByTestId('engine-picker-none-capable')).toBeTruthy();
    expect(
      screen.getByText(
        "Kiro can chat, but it can't operate Station — creating agents, running jobs, changing settings — so it can't run the built-in assistant.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('engine-picker-pending-kiro-1')).toBeNull();
  });

  test('an UNOBSERVED connection never appears in the "can chat, but can\'t operate Station" verdict — that sentence is a judgement Station has not made', () => {
    connectionsData = [commandBackedConnection()];
    renderPicker();

    expect(screen.getByTestId('engine-picker-none-capable')).toBeTruthy();
    expect(screen.queryByText(/can chat, but it can't operate Station/)).toBe(
      null,
    );
    // The honest row is there instead, and the panel says "yet".
    expect(screen.getByTestId('engine-picker-pending-kiro-1')).toBeTruthy();
    expect(
      screen.getByText(
        'No connected engine can run the built-in assistant yet',
      ),
    ).toBeTruthy();
  });

  test('an OBSERVED-capable connection is the resolved default and is what confirm saves — the picker must not drop the observation when it re-derives the binding', () => {
    // Review finding, and the highest-severity one: `resolveBuiltinAgentEngineBinding`
    // re-derives capability from (matrix, observation) rather than trusting
    // the caller's filter. Dropping the observation on the way in made the
    // picker OFFER a row it then refused to resolve — the user's own verified
    // engine rendered unselected, and confirming without touching the radio
    // saved `null` (Station) over a working binding.
    connectionsData = [
      commandBackedConnection({ controlPlaneObservation: OBSERVED_YES }),
    ];
    configData = { builtinAgentEngineConnectionId: 'kiro-1' };
    renderPicker();

    const radio = screen.getByRole('radio') as HTMLInputElement;
    expect(radio.checked).toBe(true);

    fireEvent.click(screen.getByText('Use this engine'));
    expect(mutate).toHaveBeenCalledWith(
      { builtinAgentEngineConnectionId: 'kiro-1' },
      expect.anything(),
    );
  });

  test('the unchosen sensible default also sees the observation — a single observed-capable engine is auto-selected', () => {
    connectionsData = [
      commandBackedConnection({ controlPlaneObservation: OBSERVED_YES }),
    ];
    configData = {};
    renderPicker();
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(true);
  });

  test('nothing is persisted from the pending state — rendering it fires no config mutation', () => {
    connectionsData = [commandBackedConnection()];
    renderPicker();
    expect(mutate).not.toHaveBeenCalled();
  });

  test('Settings does not report an unobserved saved choice as incapable', () => {
    // The pre-archive#1549 copy ("Your saved choice (Kiro) can't run the built-in
    // assistant.") is a verdict. Applied to a connection Station has never
    // met it is simply false, and it would push the user to change a setting
    // that is about to start working on its own.
    const display = builtinEngineDisplay({
      value: engineConnectionId('kiro-1'),
      stationChatReady: false,
      connections: [commandBackedConnection()],
    });
    expect(display.name).toBe('Station');
    expect(display.note).toBe("Station hasn't checked what Kiro supports yet.");

    const observed = builtinEngineDisplay({
      value: engineConnectionId('kiro-1'),
      stationChatReady: false,
      connections: [
        commandBackedConnection({ controlPlaneObservation: OBSERVED_NO }),
      ],
    });
    expect(observed.note).toBe(
      "Your saved choice (Kiro) can't run the built-in assistant.",
    );
  });
});
