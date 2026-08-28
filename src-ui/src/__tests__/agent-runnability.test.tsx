/**
* the New Chat picker, the Agents list, and Home's "Start direct chat"
 * card must not disagree about whether an Agent can run.
 *
 * They used to. Home named `flatList[0]` with no readiness question asked at
 * all, so it recommended "Claude Code · Default (recommended)" while the
 * picker one click away flagged that same row "⚠ Not set up", and the Agents
 * list said nothing either way. This suite runs ONE fixture set through all
 * three and pins that they cannot diverge — because there is now one
 * derivation, `agentRunnability`, and each of them calls it.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { agentReadinessState } from '../components/AgentReadinessCell';
import { agentRunnability } from '../components/agent-runnability';
import { selectProjectScopedChatAgents } from '../components/agent-selection-policy';
import {
  resolveNewChatAgentUnavailability,
  resolveNewChatDefaultSelection,
} from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { buildAgentsViewItems } from '../views/agent-editor/agentsViewHelpers';

const CONNECTIONS = [
  {
    id: 'codex',
    kind: 'agent',
    type: 'codex',
    status: 'ready',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {},
  },
  {
    id: 'kiro',
    kind: 'agent',
    type: 'acp',
    status: 'error',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {},
  },
] as any[];

/** Runnable: bound to a ready connection, and the server makes no complaint. */
const READY: AgentData = {
  slug: 'codex-agent',
  name: 'Codex Agent',
  execution: { agentConnectionId: 'codex' },
} as unknown as AgentData;

/** The engine identity with no Agent file yet — the server offers `enable`. */
const NOT_SET_UP: AgentData = {
  slug: 'claude',
  name: 'Claude Code',
  engineDefault: true,
  engineDisplayName: 'Claude Code',
  execution: { agentConnectionId: 'claude' },
  available: false,
  unavailableReason:
    "Agent 'claude' has no authored Agent definition, so Station cannot start new sessions.",
  unavailableFix: { kind: 'engine-disabled' },
  enable: { engineConnectionId: 'claude' },
} as unknown as AgentData;

/** Persisted, but its bound connection is down. No `enable` would fix it. */
const CONNECTION_DOWN: AgentData = {
  slug: 'kiro-agent',
  name: 'Kiro Agent',
  execution: { agentConnectionId: 'kiro' },
  available: false,
  unavailableReason: "Engine connection 'kiro' is unavailable.",
  unavailableFix: { kind: 'connection-broken' },
} as unknown as AgentData;

/**
 * No engine binding — which is not "unbound", it is Station's own engine
 * (archive#3662, `docs/design/agent-engine-unification.md` §7.1). The server
 * makes no complaint about it, so it runs.
 */
const STATION_ENGINE: AgentData = {
  slug: 'station',
  name: 'Station',
  engineId: 'station',
} as unknown as AgentData;

/**
 * The same shape the server DOES refuse: Station's engine with no managed
 * model resolvable. The refusal is the server's sentence, not a client guess.
 */
const STATION_ENGINE_NO_MODEL: AgentData = {
  slug: 'station-no-model',
  name: 'Station (no model)',
  engineId: 'station',
  available: false,
  unavailableReason: 'No chat-capable model connection is configured.',
  unavailableFix: { kind: 'model-connection' },
} as unknown as AgentData;

const FIXTURES = [
  READY,
  NOT_SET_UP,
  CONNECTION_DOWN,
  STATION_ENGINE,
  STATION_ENGINE_NO_MODEL,
];

describe('agentRunnability', () => {
  test('the verdict table the three consumers share', () => {
    expect(
      FIXTURES.map((agent) => [agent.slug, agentRunnability(agent).runnable]),
    ).toEqual([
      ['codex-agent', true],
      ['claude', false],
      ['kiro-agent', false],
      ['station', true],
      ['station-no-model', false],
    ]);
  });

  test("the server's own sentence is the reason, never a reconstructed one", () => {
    expect(agentRunnability(CONNECTION_DOWN)).toEqual({
      runnable: false,
      reason: "Engine connection 'kiro' is unavailable.",
    });
  });

  test('an Agent with no engine binding is a STATION-engine Agent (#3662)', () => {
// It used to derive "This agent is not bound to an engine connection."
// from an absent `agentConnectionId` — a fourth reading of the record,
// contradicting `agentEngineDescriptor` (which renders "Station" for
// exactly this shape) and the server's dispatch resolver (which routes
// exactly this shape to Station's engine). The seeded Station Agent has
// this shape, so that derivation refused the default Agent on every home.
    expect(agentRunnability(STATION_ENGINE)).toEqual({ runnable: true });
// And it is not blanket permission: the SERVER can still refuse it, and
// then its own sentence is the reason.
    expect(agentRunnability(STATION_ENGINE_NO_MODEL)).toEqual({
      runnable: false,
      reason: 'No chat-capable model connection is configured.',
    });
  });

  test('the picker offers the Station Agent on a home with NO engine connections', () => {
 // The live archive#3662 repro, as a fixture: a fresh home with a Ready model
// connection and no engine CLI on PATH. Every engine-connection list is
// empty; the only Agent is the seeded Station one; the picker showed
// "Nothing to chat with yet" while /api/system/status called the home
// chat-ready.
    const { chatReadyAgents } = selectProjectScopedChatAgents({
      agents: [STATION_ENGINE],
      agentConnections: [],
    });
    expect(chatReadyAgents.map((agent) => agent.slug)).toEqual(['station']);
  });

  test('it never re-derives readiness from the connection inventory (found live)', () => {
// The regression this pins: a client-side "…and its connection must be
// status:ready" clause labelled three working engines Not set up for the
// window before their connections finished connecting, and labelled ALL
// of them Not set up when the connections query 401'd (it resolves to []
// on failure). Only the server, which can see readiness, may make that
// claim — and it does, through `available`/`unavailableReason`.
    const boundToAnUnknownConnection = {
      slug: 'connecting',
      name: 'Connecting',
      execution: { agentConnectionId: 'not-in-any-inventory' },
    } as unknown as AgentData;
    expect(agentRunnability(boundToAnUnknownConnection)).toEqual({
      runnable: true,
    });
// The picker's DISPATCH question is separately, and strictly, stricter.
    const { chatReadyAgents } = selectProjectScopedChatAgents({
      agents: [boundToAnUnknownConnection],
      agentConnections: CONNECTIONS,
    });
    expect(chatReadyAgents).toEqual([]);
  });

  test('the enable signal is passed through, never inferred from prose', () => {
    expect(agentRunnability(NOT_SET_UP)).toMatchObject({
      runnable: false,
      enable: { engineConnectionId: 'claude' },
    });
// Same prose, no signal — no enable. Reason text is not authorization.
    const { enable: _dropped, ...withoutSignal } = NOT_SET_UP as any;
    expect(agentRunnability(withoutSignal)).not.toHaveProperty('enable');
  });
});

describe('the three consumers agree on one fixture set', () => {
  const runnableSlugs = FIXTURES.filter(
    (agent) => agentRunnability(agent).runnable,
  ).map((agent) => agent.slug);

  test('the picker treats exactly the runnable Agents as chat-ready', () => {
    const { chatReadyAgents } = selectProjectScopedChatAgents({
      agents: FIXTURES,
      agentConnections: CONNECTIONS,
    });
    expect(chatReadyAgents.map((agent) => agent.slug)).toEqual(runnableSlugs);
  });

  test('the Agents list renders exactly one server-derived readiness state', () => {
    const items = buildAgentsViewItems(FIXTURES, []);
 // DESIGN.md §2: exactly one state per row, and exactly three of them.
// An engine row with no Agent behind it is `Not set up`; anything else
// that cannot run says what it needs, in the server's own words. The row
// carries it once, in its trailing badge — `subtitle` is deliberately
// empty so the state is not printed twice.
    expect(items.every((item) => item.subtitle === '')).toBe(true);
    const flagged = FIXTURES.filter(
      (agent) => agentReadinessState(agent).label !== 'Ready',
    ).map((agent) => agent.slug);
    expect(flagged).toEqual(
      FIXTURES.map((agent) => agent.slug).filter(
        (slug) => !runnableSlugs.includes(slug),
      ),
    );
    expect(agentReadinessState(NOT_SET_UP).label).toBe('Not set up');
// And it prints the SAME reason the picker would speak.
    expect(agentReadinessState(CONNECTION_DOWN).label).toContain(
      "Needs: Engine connection 'kiro' is unavailable.",
    );
  });

  test('a duplicate engine binding does not displace the readiness state', () => {
// The server decides which row is canonical; the list only renders that
// verdict. Two rows reading identically for one engine is the state this
// marker exists to stop.
    const items = buildAgentsViewItems(
      [
        READY,
        {
          ...READY,
          slug: 'codex-agent',
          name: 'Codex Agent',
          secondaryEngineBinding: { engineDisplayName: 'Codex' },
        } as unknown as AgentData,
      ],
      [],
      undefined,
      { onChat: () => {}, onFix: () => {} },
    );
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        undefined,
        items.map((item) =>
          createElement('span', { key: item.id }, item.badge, item.trailing),
        ),
      ),
    );
    expect(markup.match(/Ready/g)?.length).toBe(2);
  });

  test('Home never recommends an Agent the picker calls Not set up', () => {
// The order is the defect's own shape: the unrunnable engine row came
// first, so `flatList[0]` recommended it.
    const { agent } = resolveNewChatDefaultSelection({
      flatList: [NOT_SET_UP, CONNECTION_DOWN, READY],
      agentConnections: CONNECTIONS,
      modelConnections: [],
      acpConnections: [],
    });
    expect(agent?.slug).toBe('codex-agent');
    expect(resolveNewChatAgentUnavailability(agent!)).toBeUndefined();
  });

  test('with nothing runnable, Home recommends NOTHING (it renders the set-up CTA)', () => {
// The earlier version of this test blessed a `?? flatList[0]` fallback,
// which put the contradiction back exactly where it hurts most: a fresh
// install where nothing is set up yet would have Home name an Agent the
// picker refuses one click later. When no Agent can run, the honest card
// is a call to action, not a recommendation.
    const { agent } = resolveNewChatDefaultSelection({
      flatList: [NOT_SET_UP, CONNECTION_DOWN],
      agentConnections: CONNECTIONS,
      modelConnections: [],
      acpConnections: [],
    });
    expect(agent).toBeUndefined();
  });

  test('an empty catalog is the same answer, not a special case', () => {
    const { agent } = resolveNewChatDefaultSelection({
      flatList: [],
      agentConnections: CONNECTIONS,
      modelConnections: [],
      acpConnections: [],
    });
    expect(agent).toBeUndefined();
  });
});
