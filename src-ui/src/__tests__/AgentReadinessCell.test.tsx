/**
 * @vitest-environment jsdom
 *
 * archive#3843 — the Agents row's fixing verb on a paired device.
 *
 * "Set up" sends the user to Connections, which a paired device can browse
 * perfectly well, so this is a remote-safe affordance: the verb stays, and it
 * stays the ONLY verb on the row (the contract
 * `tests/agents-readiness-board.spec.ts` counts). What changes is that the
 * action's accessible name says which machine the engine would be set up on —
 * because an engine is a CLI on the host, and a row that says only "Set up"
 * from a phone implies the phone.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  AgentReadinessCell,
  type ReadinessAgent,
} from '../components/AgentReadinessCell';

const CLI_MISSING: ReadinessAgent = {
  available: false,
  unavailableReason: "The 'claude' CLI is not installed.",
  unavailableFix: { kind: 'cli-missing' },
};

const MODEL_MISSING: ReadinessAgent = {
  available: false,
  unavailableReason: 'No model connection is configured.',
  unavailableFix: { kind: 'model-connection' },
};

function actions() {
  return screen.getAllByRole('button');
}

describe('AgentReadinessCell — the one verb, host-named', () => {
  test('on a paired device the Set up action names the host in its accessible name', () => {
    render(
      <AgentReadinessCell
        agent={CLI_MISSING}
        agentName="Claude Code"
        devicePresentation={{ deviceClass: 'paired', hostName: 'workshop' }}
        onFix={vi.fn()}
        part="action"
      />,
    );
    const button = screen.getByRole('button', {
      name: 'Set up Claude Code on workshop',
    });
    // The one-verb contract: the VISIBLE label is untouched, and there is
    // exactly one control on the row.
    expect(button.textContent).toBe('Set up');
    expect(actions()).toHaveLength(1);
    expect(button.getAttribute('title')).toBe('Set up Claude Code on workshop');
  });

  test('on the host the accessible name is unchanged and carries no tooltip', () => {
    render(
      <AgentReadinessCell
        agent={CLI_MISSING}
        agentName="Claude Code"
        devicePresentation={{ deviceClass: 'host', hostName: 'workshop' }}
        onFix={vi.fn()}
        part="action"
      />,
    );
    const button = screen.getByRole('button', { name: 'Set up Claude Code' });
    expect(button.textContent).toBe('Set up');
    expect(button.getAttribute('title')).toBeNull();
    expect(actions()).toHaveLength(1);
  });

  test('an unanswered projection reads exactly like the host — no machine is claimed', () => {
    render(
      <AgentReadinessCell
        agent={CLI_MISSING}
        agentName="Claude Code"
        onFix={vi.fn()}
        part="action"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Set up Claude Code' }),
    ).toBeTruthy();
  });

  test('a verb whose repair is not the host engine setup is not host-named', () => {
    // Connecting a model is a Station-side configuration, not a CLI on the
    // host's disk. Naming the host there would be a sentence about the wrong
    // thing.
    render(
      <AgentReadinessCell
        agent={MODEL_MISSING}
        agentName="Station"
        devicePresentation={{ deviceClass: 'paired', hostName: 'workshop' }}
        onFix={vi.fn()}
        part="action"
      />,
    );
    const button = screen.getByRole('button', { name: 'Connect Station' });
    expect(button.textContent).toBe('Connect');
    expect(button.getAttribute('title')).toBeNull();
  });
});

/**
 * archive#4521 (design ruling): a caution row's HEADER chip
 * must still read caution at a glance, so it keeps a short, chip-native
 * label ("Not set up") instead of the full server sentence — but the
 * DECISION of which states shorten to which label lives here, in
 * `agentReadinessCompactState`, not in a caller. `AgentsViewEditorPane`
 * consumes it only via `compact` and never re-derives it, which is what lets
 * a third short-label state added here reach the header with no caller
 * change.
 */
describe('AgentReadinessCell — the compact header form (station#4521)', () => {
  const UNMATERIALIZED = {
    available: false,
    unavailableReason: 'no definition',
    enable: { engineConnectionId: 'claude' },
  } as unknown as ReadinessAgent;

  function chip(agent: ReadinessAgent, compact: boolean) {
    const { container } = render(
      <AgentReadinessCell agent={agent} part="status" compact={compact} />,
    );
    const status = container.querySelector('.agent-readiness__status');
    expect(status).not.toBeNull();
    return status as HTMLElement;
  }

  // The full form for the same agent still carries the server's sentence —
  // the compact form is a DIFFERENT read, not a mutation of the shared
  // derivation every other consumer (the New Chat picker) still renders.
  test.each([
    [
      'a caution row shortens ONLY its label, keeping its caution tone',
      MODEL_MISSING,
      'Not set up',
      'Needs: No model connection is configured.',
      'caution',
    ],
    [
      'Ready passes through unchanged',
      { available: true },
      'Ready',
      'Ready',
      'positive',
    ],
    [
      'the enable "Not set up" passes through unchanged',
      UNMATERIALIZED,
      'Not set up',
      'Not set up',
      'neutral',
    ],
  ] as const)('%s', (_label, agent, compactLabel, fullLabel, tone) => {
    const compactChip = chip(agent, true);
    expect(compactChip.textContent).toBe(compactLabel);
    expect(compactChip.classList.contains(`tone-${tone}`)).toBe(true);

    const fullChip = chip(agent, false);
    expect(fullChip.textContent).toBe(fullLabel);
    expect(fullChip.classList.contains(`tone-${tone}`)).toBe(true);
  });
});
