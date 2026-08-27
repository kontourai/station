/**
 * @vitest-environment jsdom
 */

import { controlPlaneCapableEngineNames } from '@kontourai/station-contracts/engine-capability-matrix';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { EnginePicker } from '../components/EnginePicker';
import { isStationChatReady, readyEngineOptions } from '../utils/engineBinding';

let statusData: any = { providers: { configuredChatReady: false } };
let connectionsData: any[] = [];
let configData: any;
const mutate = vi.fn();

vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({ data: statusData }),
}));

/**
 * station#1549: the picker asks a not-yet-observed connection to probe when
 * the modal opens. Captured rather than stubbed away so the tests below can
 * assert BOTH directions — that it fires for an unobserved row, and (the
 * property that actually matters) that it never fires for a row whose answer
 * is already known.
 */
const reconnectMutate = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: connectionsData }),
  useConfigQuery: () => ({ data: configData }),
  useUpdateConfigMutation: () => ({
    mutate,
    isPending: false,
  }),
  useReconnectACPConnectionMutation: () => ({ mutateAsync: reconnectMutate }),
  useQueryClient: () => ({ invalidateQueries }),
}));

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

function codexConnection(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'codex-runtime',
    kind: 'agent' as const,
    type: 'codex',
    name: 'Codex',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready' as const, detected: false, configured: true },
    ...overrides,
  };
}

/**
 * The retired user-facing nouns (docs/glossary.md; the same two patterns
 * `scripts/noun-consistency-gate.mjs` enforces on `.tsx` UI strings). Kept
 * as module-level constants rather than inline literals so this file's own
 * assertions never read as retired-noun UI copy to that gate's text scan.
 */
const RETIRED_PROTOCOL_NOUN = /\bACP\b/;
const RETIRED_AGENT_NOUN = /External agents?/;

function expectNoRetiredNouns(): void {
  expect(screen.queryByText(RETIRED_PROTOCOL_NOUN)).toBeNull();
  expect(screen.queryByText(RETIRED_AGENT_NOUN)).toBeNull();
}

/**
 * A command-backed connection that has been OBSERVED and cannot run the
 * built-in assistant.
 *
 * The `controlPlaneObservation` is load-bearing as of station#1684 and is
 * deliberately part of the default. Before that change the `acp` matrix cell
 * named no delivery mechanism, so every ACP connection derived `chat-only`
 * from the matrix alone and the fixture needed no evidence. The cell now
 * names one with `basis: 'runtime_observation'`, so the answer is
 * per-connection: with no observation this connection would derive
 * `observation-required` ("not checked yet"), which is a THIRD state and not
 * what any test in this file is about — every one of them asserts the
 * incapable-engine copy, which is only true of a connection that was checked
 * and said no. That state is covered on its own in
 * `EnginePicker.observationRequired.test.tsx`.
 *
 * Pass `controlPlaneObservation: undefined` explicitly to get the unobserved
 * shape.
 */
function acpConnection(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'acp-kiro',
    kind: 'agent' as const,
    type: 'acp',
    name: 'Kiro',
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready' as const, detected: false, configured: true },
    controlPlaneObservation: {
      mcpHttp: false,
      observedAt: '2026-08-03T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('readyEngineOptions — station#1194 (matrix-driven, no per-engine branch)', () => {
  test('Claude Code AND Codex are badged "full" (each has a station-control delivery mechanism); an observed-incapable command-backed engine is "chat-only"', () => {
    // The predicate keys on the matrix's builtinStationControlDelivery cell
    // — the same field session-agent-resolution.ts exempts on — so Codex
    // flipped to "full" when #1195 shipped its 'url-token' delivery.
    // station#1684: the command-backed row's answer is no longer read off
    // the matrix alone; it is derived from the matrix PLUS this connection's
    // own observation, which here says the CLI does not advertise HTTP MCP.
    const options = readyEngineOptions({
      stationChatReady: false,
      connections: [claudeConnection(), codexConnection(), acpConnection()],
    });

    expect(options).toEqual([
      expect.objectContaining({
        connectionId: 'claude-runtime',
        name: 'Claude Code',
        capability: 'full',
      }),
      expect.objectContaining({
        connectionId: 'codex-runtime',
        name: 'Codex',
        capability: 'full',
      }),
      expect.objectContaining({
        connectionId: 'acp-kiro',
        name: 'Kiro',
        capability: 'chat-only',
      }),
    ]);
  });

  test('keeps Codex eligible when its live native projection uses codex-runtime as its adapter type', () => {
    // This is the exact shape published by native adapter discovery: the
    // public matrix identity belongs in config.engineId, not the private
    // runtime selector. Codex's #1195 declared delivery therefore needs no
    // runtime observation to be offered.
    expect(
      readyEngineOptions({
        stationChatReady: false,
        connections: [
          codexConnection({
            id: 'codex',
            type: 'codex-runtime',
            config: { engineId: 'codex' },
          }),
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        connectionId: 'codex',
        capability: 'full',
      }),
    ]);
  });

  test('Station is listed first, badged "full", only when its own chat is ready', () => {
    expect(
      readyEngineOptions({ stationChatReady: false, connections: [] }),
    ).toEqual([]);
    expect(
      readyEngineOptions({ stationChatReady: true, connections: [] }),
    ).toEqual([
      expect.objectContaining({
        connectionId: null,
        name: 'Station',
        capability: 'full',
      }),
    ]);
  });

  test('excludes disabled, non-ready, or non-agent-runtime connections', () => {
    const options = readyEngineOptions({
      stationChatReady: false,
      connections: [
        claudeConnection({ enabled: false }),
        codexConnection({ status: 'missing_prerequisites' }),
        acpConnection({ capabilities: [] }),
      ],
    });

    expect(options).toEqual([]);
  });
});

describe('isStationChatReady', () => {
  test("mirrors setupBannerVariant's own configuredChatReady/configured-chat-ready check", () => {
    expect(
      isStationChatReady({ providers: { configuredChatReady: true } }),
    ).toBe(true);
    expect(
      isStationChatReady({ recommendation: { code: 'configured-chat-ready' } }),
    ).toBe(true);
    expect(isStationChatReady({})).toBe(false);
  });
});

describe('EnginePicker component', () => {
  test('offers ONLY control-plane-capable engines — a ready chat-only engine is not a row (owner directive)', () => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [claudeConnection(), codexConnection(), acpConnection()];
    configData = undefined;

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    // Claude Code (#1157) and Codex (#1195) each have a reviewed
    // station-control delivery mechanism — both offered. Kiro's wire
    // channel has none: the assistant this modal binds could not operate
    // Station there, so it must not be selectable at all — not badged,
    // absent.
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByText('Kiro')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    // No per-row capability badge survives the filter: every offered row is
    // capable, so a badge could only ever read one value.
    expect(screen.queryByText(/^(Full|Chat only)$/)).toBeNull();
  });

  test('never renders retired nouns — engine names only, never "External"/"ACP"/"runtime"', () => {
    // What this case has always protected: a command-backed connection is
    // named by its OWN connection name, never by the protocol it speaks.
    // The capable-only filter moved WHERE such a connection is named — it
    // is no longer an offerable row — but it did not remove the naming, and
    // the surface that still names it must obey the same rule.
    statusData = { providers: { configuredChatReady: true } };
    connectionsData = [claudeConnection(), acpConnection()];
    configData = undefined;

    const offered = render(
      <EnginePicker onChosen={() => {}} onDismiss={() => {}} />,
    );

    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expectNoRetiredNouns();
    offered.unmount();

    // Same connection, on the surface that DOES have to name it: the
    // explanation shown when nothing capable is connected.
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [acpConnection()];

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    // station#1547 AC5 restored a second sentence that also names this
    // connection (what it CAN still do), so the panel now names it twice.
    // The rule under test is unchanged — every naming uses the connection's
    // own name, never "External"/"ACP"/"runtime" — so this asserts "named at
    // least once", not "named exactly once".
    expect(screen.getAllByText(/\bKiro\b/).length).toBeGreaterThan(0);
    expectNoRetiredNouns();
  });

  test('selecting an engine and confirming persists builtinAgentEngineConnectionId', () => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [codexConnection()];
    configData = undefined;
    mutate.mockClear();

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    fireEvent.click(screen.getByText('Use this engine'));

    expect(mutate).toHaveBeenCalledWith(
      { builtinAgentEngineConnectionId: 'codex-runtime' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  // station#settings-revamp slice 3 review finding 3.
  test('onSelect mode: confirming calls onSelect(id) and onChosen, and never fires the update-config mutation', () => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [codexConnection()];
    configData = undefined;
    mutate.mockClear();
    const onSelect = vi.fn();
    const onChosen = vi.fn();

    render(
      <EnginePicker
        onChosen={onChosen}
        onDismiss={() => {}}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByText('Use this engine'));

    expect(onSelect).toHaveBeenCalledWith('codex-runtime');
    expect(onChosen).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  test('dismiss calls onDismiss without persisting anything', () => {
    statusData = { providers: { configuredChatReady: true } };
    connectionsData = [];
    configData = undefined;
    const onDismiss = vi.fn();
    mutate.mockClear();

    render(<EnginePicker onChosen={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Decide later'));

    expect(onDismiss).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  test('a ready-but-incapable-only machine gets the explanation, not silence and not a bind', () => {
    // The reachable steady state the capable-only filter creates: an engine
    // is connected and ready, no Station model, and nothing on the machine
    // can run the assistant. Rendering null here would leave the "Change…"
    // button doing nothing and the user never learning why the assistant
    // never appeared.
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [acpConnection()];
    configData = undefined;
    const onDismiss = vi.fn();
    mutate.mockClear();

    render(<EnginePicker onChosen={() => {}} onDismiss={onDismiss} />);

    expect(screen.getByTestId('engine-picker-none-capable')).toBeTruthy();
    expect(
      screen.getByText('No connected engine can run the built-in assistant'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Kiro can chat, but it can't operate Station — creating agents, running jobs, changing settings — so it can't run the built-in assistant.",
      ),
    ).toBeTruthy();
    // Nothing to choose, and nothing is ever written from this state: an
    // engine becoming capable later (as Codex did at #1195) must find the
    // saved config exactly as the user left it.
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    fireEvent.click(screen.getByText('Got it'));
    expect(onDismiss).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  /**
   * station#1547 AC5. The sentence shipped once and was reverted at
   * 5a61adbf because it was false — no non-`station` agent received the docs
   * server, so the engine the panel is about was precisely the engine that
   * got nothing. It ships again only because the ACP adapter now grants
   * `station-docs` on every ACP session; these assertions and
   * `acp-adapter.test.ts`'s "station#1547 AC5" block are two halves of one
   * claim, and neither is worth anything alone.
   */
  test('station#1547 AC5: the single-incapable-engine panel says what that engine CAN still do', () => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [acpConnection()];
    configData = undefined;

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    expect(
      screen.getByText(
        "Kiro still gets Station's documentation, so it can explain how Station works, answer questions about it, and help you plan — it just can't create agents, run jobs, or change settings.",
      ),
    ).toBeTruthy();
    // The "can't operate it" half has to stay in the same breath: an
    // assistant that answers confidently while silently unable to act is the
    // assert-then-retract failure delivery-protocol §6 forbids.
    expect(
      screen.getByText(
        "Kiro can chat, but it can't operate Station — creating agents, running jobs, changing settings — so it can't run the built-in assistant.",
      ),
    ).toBeTruthy();
  });

  test('station#1547 AC5: the multi-incapable-engine panel says the same thing about all of them', () => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [
      acpConnection(),
      acpConnection({ id: 'opencode-conn', name: 'OpenCode' }),
    ];
    configData = undefined;

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    expect(screen.getByTestId('engine-picker-none-capable')).toBeTruthy();
    expect(
      screen.getByText(
        "They still get Station's documentation, so they can explain how Station works, answer questions about it, and help you plan — they just can't create agents, run jobs, or change settings.",
      ),
    ).toBeTruthy();
  });

  test('station#1547 AC5: with nothing connected, the claim is scoped to an engine that CANNOT run the assistant', () => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [];
    configData = undefined;

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    // Deliberately NOT "any engine you connect": a capable engine receives
    // documentation by way of the built-in assistant it can actually run,
    // not by the ACP grant, so the broader sentence would claim a delivery
    // path that does not exist for it. The panel says what ships.
    expect(
      screen.getByText(
        "An engine that can't run the built-in assistant still gets Station's documentation, so it can explain how Station works, answer questions about it, and help you plan — it just can't create agents, run jobs, or change settings.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/any engine you connect/i)).toBeNull();
  });

  test('the explanation names the capable engines from the capability matrix, never a written-out list', () => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [acpConnection()];
    configData = undefined;

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    // Derived, not transcribed: the assertion is built from the contract's
    // own list, so an engine gaining or losing a station-control delivery
    // mechanism moves the copy and this expectation together.
    const names = controlPlaneCapableEngineNames();
    expect(names.length).toBeGreaterThan(1);
    const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    expect(
      screen.getByText(
        `Engines that can run it today: ${list}. Add one in Connections, then come back here.`,
      ),
    ).toBeTruthy();
  });

  test('no engine connected at all also explains — the "Change…" button never opens an empty modal', () => {
    // #1359 retired the first-run gate that used to be this modal's only
    // caller, so "zero ready engines" is no longer a render race with a
    // gate: it is a deliberate click from Settings, and rendering nothing
    // would be a dead button.
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [];
    configData = undefined;
    mutate.mockClear();

    render(<EnginePicker onChosen={() => {}} onDismiss={() => {}} />);

    expect(screen.getByTestId('engine-picker-none-capable')).toBeTruthy();
    expect(
      screen.getByText(
        'You have no engine connected yet, so nothing can run the built-in assistant — the assistant that operates Station for you: creating agents, running jobs, changing settings.',
      ),
    ).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(mutate).not.toHaveBeenCalled();
  });
});
