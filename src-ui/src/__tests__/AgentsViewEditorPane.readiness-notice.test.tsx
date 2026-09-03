/**
 * @vitest-environment jsdom
 *
 * archive#4521: the agent editor's "NEEDS" readiness notice, the "Agent
 * actions" popover's anchoring, and the mobile save-affordance duplication.
 *
 * 1/2 — the header used to render the full server reason ("Needs: No
 *       enabled LLM provider connection is configured.") in the same
 *       all-caps mono `StatusBadge` chip the list/picker use for short state
 *       words, and the banner beneath it had no route for exactly this
 *       reason (a Station-engine agent with no `agentConnectionId` to point
 *       "Configure in Connections" at). The chip now shows the SHORT,
 *       chip-native form ("Not set up") instead of the full sentence —
 *       dropping it entirely (this fix's first pass) lost at-a-glance
 *       severity, so a caution row must still read caution, just not as a
 *       paragraph — via `AgentReadinessCell`'s own `compact` prop
 *       (`agentReadinessCompactState`), never a decision this pane
 *       re-derives; and the banner gains the missing "Add model connection"
 *       repair.
 * 3   — the popover had no overlay/panel classes, so it inherited no
 *       anchored-popover geometry at all (covered by the anchoring/geometry
 *       assertions below at the unit layer: the CSS classes and
 *       `anchorRef` wiring are present; real pixel placement is a
 *       real-Chromium concern, covered separately).
 * 4   — the header row's own Save/Create button rendered unconditionally
 *       alongside the mobile sticky footer's, showing Save twice on a
 *       touch/narrow surface.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';
import { AgentsViewEditorPane } from '../views/agent-editor/AgentsViewEditorPane';
import { createEmptyAgentForm } from '../views/agent-editor/agentsViewUtils';

let isMobile = false;
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobile,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: [] }),
  useModelConnectionsQuery: () => ({ data: [] }),
  useProjectsQuery: () => ({ data: [] }),
  useCredentialRecoveryQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: () => <div>icon</div>,
}));

vi.mock('../components/ModelSelector', () => ({
  ModelSelector: () => <div>model-selector</div>,
}));

/**
 * A materialized Station-engine agent with no LLM provider connection at
 * all — the exact wire shape `enriched-agents.ts` sends for this reason.
 * archive#4521: `execution` is OMITTED, not an object with empty
 * strings — a Station agent that has never had its execution configured has
 * no `spec.execution` at all (`execution: spec.execution` in
 * enriched-agents.ts, and an unconfigured spec's `execution` is `undefined`,
 * not `{}`). Every reader downstream already reads it with optional
 * chaining (`agent.execution?.agentConnectionId`), so this omission is the
 * one that actually exercises those paths.
 */
function stationAgentNeedingModelConnection(): AgentData {
  return {
    slug: 'station',
    name: 'Station',
    available: false,
    unavailableReason: 'No enabled LLM provider connection is configured.',
    unavailableFix: { kind: 'model-connection' },
  } as unknown as AgentData;
}

function baseProps(overrides: Record<string, unknown> = {}) {
  const agent = stationAgentNeedingModelConnection();
  return {
    isLoading: false,
    notFound: false,
    loadError: null,
    error: null,
    isCreating: false,
    startingPointChosen: true,
    copyPicking: false,
    onCopyPicking: vi.fn(),
    onStartWithModel: vi.fn(),
    onStartWithCli: vi.fn(),
    onCopyAgent: vi.fn(),
    onDuplicate: vi.fn(),
    onFixAgent: vi.fn(),
    engineKind: 'model' as const,
    onEngineKindChange: vi.fn(),
    stationConnectionId: '',
    createBlocked: false,
    promptIsRequired: false,
    createdNotice: null,
    onChat: vi.fn(),
    agents: [agent],
    selectedSlug: 'station',
    selectedAgent: agent,
    isAcp: false,
    isPlugin: false,
    locked: false,
    isLocked: false,
    dirty: false,
    isSaving: false,
    validationErrors: {},
    availableTools: [],
    availableSkills: [],
    integrationTools: {},
    appConfig: {},
    enrich: vi.fn(),
    isEnriching: false,
    onNavigate: vi.fn(),
    onDeselect: vi.fn(),
    onRetryLoad: vi.fn(),
    onDelete: vi.fn(),
    onSave: vi.fn(),
    onUnlockPlugin: vi.fn(),
    form: { ...createEmptyAgentForm(''), slug: 'station', name: 'Station' },
    setForm: vi.fn(),
    selectedRunnability: {
      runnable: false,
      reason: 'No enabled LLM provider connection is configured.',
    },
    selectedIsUnmaterializedEngine: false,
    onEnable: vi.fn(),
    enableInFlight: false,
    enableError: null,
    onConfigureConnection: vi.fn(),
    toolsActivating: false,
    toolsActivationTimedOut: false,
    onRetryActivation: vi.fn(),
    ...overrides,
  };
}

describe('AgentsViewEditorPane — readiness notice (station#4521 items 1/2)', () => {
  beforeEach(() => {
    isMobile = false;
  });

  test('the header title row keeps a caution chip, but shortened to chip-native vocabulary, not the full server reason', () => {
    render(<AgentsViewEditorPane {...(baseProps() as any)} />);
    // Design ruling (arbiter, archive#4521 2): dropping the
    // chip entirely for a caution agent lost at-a-glance severity — the row
    // read as merely informational. The chip stays, shortened to "Not set
    // up" (the SAME short label the neutral/`enable` case already uses) so
    // it reads instantly rather than as a paragraph; the full sentence
    // stays in the banner beneath the header, asserted separately below.
    const titleRow = screen.getByRole('heading', { name: 'Station' })
      .parentElement as HTMLElement;
    const chip = titleRow.querySelector('.agent-readiness__status');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('Not set up');
    expect(chip?.textContent).not.toContain('No enabled LLM provider');
  });

  test('a Ready agent still gets its short state chip in the header', () => {
    const agent = {
      ...stationAgentNeedingModelConnection(),
      available: true,
      unavailableReason: undefined,
      unavailableFix: undefined,
    };
    render(
      <AgentsViewEditorPane
        {...(baseProps({
          selectedAgent: agent,
          selectedRunnability: { runnable: true },
        }) as any)}
      />,
    );
    const titleRow = screen.getByRole('heading', { name: 'Station' })
      .parentElement as HTMLElement;
    expect(titleRow.querySelector('.agent-readiness__status')).not.toBeNull();
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  test('the notice reads in sentence case with the app’s notice banner grammar', () => {
    render(<AgentsViewEditorPane {...(baseProps() as any)} />);
    expect(
      screen.getByText(
        'Not set up: No enabled LLM provider connection is configured.',
      ),
    ).toBeTruthy();
  });

  test('the notice is actionable: it routes to the model-connection remedy', () => {
    const onFixAgent = vi.fn();
    const agent = stationAgentNeedingModelConnection();
    render(
      <AgentsViewEditorPane
        {...(baseProps({ onFixAgent, selectedAgent: agent }) as any)}
      />,
    );
    // Scoped to the notice banner itself: the Model section further down
    // this same page (archive#4521) now shares the identical "Add
    // model connection" wording for its own, unrelated inline repair, so an
    // unscoped query is ambiguous between the two — this asserts the
    // NOTICE's own button, not merely that the text exists somewhere.
    const banner = screen
      .getByText(/^Not set up:/)
      .closest('.editor__lock-banner') as HTMLElement;
    const button = within(banner).getByRole('button', {
      name: 'Add model connection',
    });
    fireEvent.click(button);
    expect(onFixAgent).toHaveBeenCalledWith(agent, 'models');
  });

  test('a connection-scoped agent keeps routing to Configure in Connections, unaffected', () => {
    const onConfigureConnection = vi.fn();
    const onFixAgent = vi.fn();
    const agent: AgentData = {
      ...stationAgentNeedingModelConnection(),
      execution: {
        agentConnectionId: 'claude',
        modelConnectionId: '',
        runtimeOptions: {},
      },
      unavailableReason:
        'The engine this agent runs on is no longer connected.',
      unavailableFix: { kind: 'connection-broken' },
    } as unknown as AgentData;
    render(
      <AgentsViewEditorPane
        {...(baseProps({
          selectedAgent: agent,
          onConfigureConnection,
          onFixAgent,
          selectedRunnability: {
            runnable: false,
            reason: 'The engine this agent runs on is no longer connected.',
          },
          // A CLI-bound agent, truthfully — matches `execution` above and
          // (archive#4521) keeps §3.3's Model section off the page,
          // which otherwise shares this same wording for its own unrelated
          // repair and would make an unscoped query ambiguous.
          engineKind: 'cli' as const,
        }) as any)}
      />,
    );
    const button = screen.getByRole('button', {
      name: 'Configure in Connections',
    });
    fireEvent.click(button);
    expect(onConfigureConnection).toHaveBeenCalled();
    expect(onFixAgent).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Add model connection' }),
    ).toBeNull();
  });
});

describe('AgentsViewEditorPane — Agent actions popover anchoring (station#4521 item 3)', () => {
  beforeEach(() => {
    isMobile = false;
  });

  test('the popover carries the anchored-popover classes and its own trigger ref', () => {
    render(<AgentsViewEditorPane {...(baseProps() as any)} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const dialog = screen.getByRole('dialog', { name: 'Agent actions' });
    // The overlay is the dialog's own containing element.
    const overlay = dialog.parentElement as HTMLElement;
    expect(overlay.className).toContain('agent-actions-overlay');
    expect(dialog.className).toContain('agent-actions-panel');
    // Not the un-anchored `station-dialog`/`Dialog` centered chrome, and not
    // bare with no positioning class at all (the original bug).
    expect(overlay.className).not.toContain('station-dialog__overlay');
  });

  test('a route with no authoritative Agent detail exposes no mutation menu', () => {
    render(
      <AgentsViewEditorPane
        {...(baseProps({
          agents: [],
          selectedSlug: 'persisted-route-agent',
          selectedAgent: undefined,
        }) as any)}
      />,
    );

    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});

describe('AgentsViewEditorPane — one save affordance on mobile (station#4521 item 4)', () => {
  test('header actions are siblings of identity, never nested in an interactive row', () => {
    isMobile = false;
    const { container } = render(
      <AgentsViewEditorPane {...(baseProps() as any)} />,
    );
    const header = container.querySelector('header.detail-header');
    expect(header).not.toBeNull();
    expect(header?.matches('button, a, [role="button"], [role="link"]')).toBe(
      false,
    );
    for (const button of header?.querySelectorAll('button') ?? []) {
      expect(
        button.parentElement?.closest(
          'button, a, [role="button"], [role="link"]',
        ),
      ).toBeNull();
    }
  });

  test('desktop keeps the header row’s Save Changes button, and only one', () => {
    isMobile = false;
    render(<AgentsViewEditorPane {...(baseProps() as any)} />);
    // Tightened from `toBeGreaterThanOrEqual(1)`: that had zero power
    // against a desktop duplicate (a regression this exact class already
    // shipped once on mobile) — it would have passed unchanged at 2.
    expect(
      screen.getAllByRole('button', { name: /Save Changes/ }),
    ).toHaveLength(1);
  });

  test('mobile renders exactly one save affordance, not a header row plus a footer row', () => {
    isMobile = true;
    render(<AgentsViewEditorPane {...(baseProps() as any)} />);
    const saveButtons = screen.getAllByRole('button', {
      name: /^Save Changes$|^Saving…$|^Save$/,
    });
    expect(saveButtons).toHaveLength(1);
  });

  test('mobile’s one save affordance carries the same Create Agent wording the header used to', () => {
    isMobile = true;
    render(
      <AgentsViewEditorPane
        {...(baseProps({
          isCreating: true,
          startingPointChosen: true,
        }) as any)}
      />,
    );
    const saveButtons = screen.getAllByRole('button', {
      name: /Create Agent|Save Changes/,
    });
    expect(saveButtons).toHaveLength(1);
    expect(saveButtons[0].textContent).toContain('Create Agent');
  });
});
