/** @vitest-environment jsdom */

import type { SettingDefinition } from '@kontourai/station-contracts/settings-registry';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { BuiltinEngineRow } from '../views/settings/BuiltinEngineRow';

/**
 * archive#settings-revamp: this row lives inside
 * SettingsView's batched draft/Save/Discard page — choosing an engine must
 * update the draft (via `onChange`) rather than saving immediately
 * underneath the page, which would let the next Save silently revert it.
 *
 * archive#1194: and the row must show what the runtime is actually bound to,
 * not the raw config value — the two diverge for a saved choice the resolver
 * can no longer honour.
 */

const mutate = vi.fn();
let connectionsData: any[] = [];
let statusData: any = { providers: { configuredChatReady: false } };
let configData: any;

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: connectionsData }),
  useConfigQuery: () => ({ data: configData }),
  useUpdateConfigMutation: () => ({ mutate, isPending: false }),
  // archive#1549: the lazily-loaded EnginePicker this row opens now probes
  // not-yet-observed connections on open.
  useReconnectACPConnectionMutation: () => ({
    mutateAsync: vi.fn().mockResolvedValue(true),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({ data: statusData }),
}));

const definition = {
  key: 'builtinAgentEngineConnectionId',
  scope: 'station',
  descriptor: { kind: 'string' },
  nullable: true,
  label: 'Built-in agent engine',
  description: 'Engine connection the built-in default agents are bound to.',
} as unknown as SettingDefinition;

function codexConnection(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'codex-engine-a',
    kind: 'agent',
    type: 'codex',
    name: 'Codex',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready', detected: false, configured: true },
    ...overrides,
  };
}

function acpConnection(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'acp-kiro',
    kind: 'agent',
    type: 'acp',
    name: 'Kiro',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready', detected: false, configured: true },
    ...overrides,
  };
}

describe('BuiltinEngineRow', () => {
  test('an absent value shows the engine the resolver derives, marked as auto-detected', () => {
    connectionsData = [];
    statusData = { providers: { configuredChatReady: false } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    // Nothing pinned and nothing capable connected: the binding resolves to
    // Station, and that is what runs — "Auto-detected" alone said nothing
    // about which engine is actually in effect.
    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.getByText('Auto-detected')).toBeTruthy();
  });

  test('an absent value with one capable engine shows THAT engine — the auto-detected binding, not a placeholder', () => {
    connectionsData = [codexConnection()];
    statusData = { providers: { configuredChatReady: false } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Auto-detected')).toBeTruthy();
  });

  test('a saved choice Station has not yet observed says so, and does NOT claim it is incapable', () => {
    // The assert-then-retract defect this fixes: the resolver already fails
    // an unbindable choice safe to Station without touching the config, so
    // rendering the persisted id made Settings display "Kiro" while the
    // runtime was on Station.
    //
    // archive#1684: the `acp` matrix cell is now
    // `basis: 'runtime_observation'`, so an ACP connection with NO
    // `controlPlaneObservation` derives `observation-required`, not
    // `chat-only`. This test used to assert the incapable copy here; that
    // copy is a VERDICT Station has not reached about an unobserved
    // connection — exactly the unearned label this branch exists to remove
    // (`engineBinding.ts`'s archive#1549 branch). The observed-NO path keeps its
    // own coverage in the next test.
    connectionsData = [acpConnection()];
    statusData = { providers: { configuredChatReady: false } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value="acp-kiro"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Station')).toBeTruthy();
    expect(
      screen.getByText("Station hasn't checked what Kiro supports yet."),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Your saved choice (Kiro) can't run the built-in assistant.",
      ),
    ).toBeNull();
    // The engine that is NOT running must not be presented as the value.
    expect(screen.queryByText('Kiro')).toBeNull();
  });

  test('a saved choice Station HAS observed and that answered no shows Station and says it cannot run the assistant', () => {
    // The observed-NO half of the pair above, and this component's only
    // incapable-path assertion. `mcpHttp: false` is a real answer from a
    // real handshake (`ControlPlaneObservation`, engine-capability-matrix.ts),
    // so "can't run the built-in assistant" IS earned here.
    connectionsData = [
      acpConnection({
        controlPlaneObservation: {
          mcpHttp: false,
          observedAt: '2026-08-01T12:00:00.000Z',
        },
      }),
    ];
    statusData = { providers: { configuredChatReady: false } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value="acp-kiro"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Station')).toBeTruthy();
    expect(
      screen.getByText(
        "Your saved choice (Kiro) can't run the built-in assistant.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Station hasn't checked what Kiro supports yet."),
    ).toBeNull();
    expect(screen.queryByText('Kiro')).toBeNull();
  });

  test('a saved choice that has gone unready shows Station and names the different reason', () => {
    connectionsData = [codexConnection({ status: 'degraded' })];
    statusData = { providers: { configuredChatReady: false } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value="codex-engine-a"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Station')).toBeTruthy();
    expect(
      screen.getByText("Your saved choice (Codex) isn't ready right now."),
    ).toBeTruthy();
  });

  test('a saved choice whose connection is gone renders an explicit gap, never a bare id', () => {
    connectionsData = [];
    statusData = { providers: { configuredChatReady: false } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value="deleted-engine"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Station')).toBeTruthy();
    expect(
      screen.getByText('Your saved engine is no longer connected.'),
    ).toBeTruthy();
    expect(screen.queryByText('deleted-engine')).toBeNull();
  });

  test('an explicit Station choice shows Station with no caveat', () => {
    connectionsData = [codexConnection()];
    statusData = { providers: { configuredChatReady: true } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.queryByText(/saved choice/)).toBeNull();
    expect(screen.queryByText('Auto-detected')).toBeNull();
  });

  test('"Change…" stays live and opens an explanation when nothing capable is connected', async () => {
    connectionsData = [acpConnection()];
    statusData = { providers: { configuredChatReady: false } };
    configData = undefined;
    mutate.mockClear();

    render(
      <BuiltinEngineRow
        definition={definition}
        value={undefined}
        onChange={vi.fn()}
      />,
    );

    const change = screen.getByText('Change…') as HTMLButtonElement;
    expect(change.disabled).toBe(false);
    fireEvent.click(change);

    expect(
      await screen.findByTestId('engine-picker-none-capable'),
    ).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  test('the modal never claims it rebinds Voice — the server deliberately refuses to', () => {
    // `rebindBuiltinAgents` (station-runtime.ts) leaves `station-voice`
    // alone on purpose: Voice is speech-to-speech and never reads an engine
    // binding. archive#1441's copy said this reassigns "Station's default agent and
    // voice", promising a rebind that never happens.
    connectionsData = [codexConnection()];
    statusData = { providers: { configuredChatReady: false } };
    configData = undefined;

    render(
      <BuiltinEngineRow
        definition={definition}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Change…'));

    return screen.findByTestId('engine-picker').then(() => {
      expect(
        screen.getByText("Choose the built-in assistant's engine"),
      ).toBeTruthy();
      expect(screen.queryByText(/\bvoice\b/i)).toBeNull();
    });
  });

  test('a saved choice the resolver DOES honour renders that connection name', () => {
    connectionsData = [codexConnection()];
    statusData = { providers: { configuredChatReady: false } };
    render(
      <BuiltinEngineRow
        definition={definition}
        value="codex-engine-a"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  test('choosing an engine calls onChange with the id and fires NO network mutation', async () => {
    connectionsData = [codexConnection()];
    statusData = { providers: { configuredChatReady: false } };
    configData = undefined;
    mutate.mockClear();
    const onChange = vi.fn();

    render(
      <BuiltinEngineRow
        definition={definition}
        value={undefined}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('Change…'));
    const useEngineButton = await screen.findByText('Use this engine');
    fireEvent.click(useEngineButton);

    expect(onChange).toHaveBeenCalledWith('codex-engine-a');
    expect(mutate).not.toHaveBeenCalled();
  });

  test('after onChange fires, the row reflects the new draft value on re-render (what Save would carry)', async () => {
    connectionsData = [codexConnection()];
    statusData = { providers: { configuredChatReady: false } };
    configData = undefined;
    mutate.mockClear();
    let draftValue: unknown;
    const onChange = vi.fn((next: unknown) => {
      draftValue = next;
    });

    const { rerender } = render(
      <BuiltinEngineRow
        definition={definition}
        value={undefined}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('Change…'));
    const useEngineButton = await screen.findByText('Use this engine');
    fireEvent.click(useEngineButton);

    expect(draftValue).toBe('codex-engine-a');

    rerender(
      <BuiltinEngineRow
        definition={definition}
        value={draftValue as string}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('Codex')).toBeTruthy();
  });
});
