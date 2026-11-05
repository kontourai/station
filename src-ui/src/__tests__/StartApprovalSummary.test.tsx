// @vitest-environment jsdom

import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DialogHistoryHostBoundary } from '../components/DialogHistoryHost';
import type { AgentData } from '../contexts/AgentsContext';
import { ManagedPolicyContext } from '../contexts/ManagedPolicyContext';
import { approvalModeChipLabel } from '../utils/approvalMode';

const agents: AgentData[] = [];

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agents,
}));
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => null,
}));
vi.mock('../contexts/AccountPreferencesContext', () => ({
  useAccountPreferences: () => ({ status: 'local', data: undefined }),
}));

const { StartApprovalSummary } = await import(
  '../components/chat-start/StartApprovalSummary'
);

function agentOn(engine: string): AgentData {
  return {
    slug: engine,
    name: engine,
    execution: { agentConnectionId: engine },
  } as unknown as AgentData;
}

describe('StartApprovalSummary on the engine default', () => {
  test("a Codex start says what Codex's own settings mean when nothing is picked", () => {
    const agent = agentOn('codex');
    agents.splice(0, agents.length, agent);
    render(<StartApprovalSummary agent={agent} onPick={vi.fn()} />);

    const chip = screen.getByRole('button', { name: /^Permissions: / });
    expect(chip.textContent).toContain('Permissions Default');
    expect(chip.getAttribute('title')).toBe(
      'Codex settings apply until you pick one. If unset, it asks to go online or write outside temp and the chat’s own folder.',
    );
  });

  test('another engine keeps the unconfirmed-mode explanation', () => {
    const agent = agentOn('claude');
    agents.splice(0, agents.length, agent);
    render(<StartApprovalSummary agent={agent} onPick={vi.fn()} />);

    expect(
      screen
        .getByRole('button', { name: /^Permissions: / })
        .getAttribute('title'),
    ).toBe('The engine has not reported its active approval mode yet.');
  });
});

/**
 * #4518 (verifier finding on the Home "Start work" composer): an Agent default
 * of Auto under a ceiling of Ask starts the chat at Ask, so the chip and the
 * open picker both show Ask, not the disabled Auto.
 */
describe('StartApprovalSummary under a managed ceiling', () => {
  const ask: ManagedPolicySummary = {
    organization: 'Acme',
    supportUrl: null,
    lockedSettings: [],
    limits: { maxApprovalMode: 'ask' },
  };

  test('an inherited default above the ceiling is shown lowered, and the picker selects the lowered mode', async () => {
    const agent = {
      slug: 'codex',
      name: 'codex',
      execution: { agentConnectionId: 'codex', approvalMode: 'auto' },
    } as unknown as AgentData;
    agents.splice(0, agents.length, agent);
    render(
      <DialogHistoryHostBoundary>
        <ManagedPolicyContext.Provider value={ask}>
          <StartApprovalSummary agent={agent} onPick={vi.fn()} />
        </ManagedPolicyContext.Provider>
      </DialogHistoryHostBoundary>,
    );
    const chip = screen.getByRole('button', { name: /^Permissions: / });
    expect(chip.textContent).toContain(approvalModeChipLabel('ask'));
    expect(chip.textContent).not.toContain(approvalModeChipLabel('auto'));
    expect(chip.getAttribute('title')).toContain("lowered by Acme's policy");

    fireEvent.click(chip);
    const radios = (await screen.findAllByRole('radio')) as HTMLInputElement[];
    const radio = (value: string) =>
      radios.find((input) => input.value === value)!;
    expect(radio('ask').checked).toBe(true);
    expect(radio('auto').checked).toBe(false);
    expect(radio('auto').disabled).toBe(true);
  });

  test('without a ceiling the same default is shown as it is', () => {
    const agent = {
      slug: 'codex',
      name: 'codex',
      execution: { agentConnectionId: 'codex', approvalMode: 'auto' },
    } as unknown as AgentData;
    agents.splice(0, agents.length, agent);
    render(<StartApprovalSummary agent={agent} onPick={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /^Permissions: / }).textContent,
    ).toContain(approvalModeChipLabel('auto'));
  });
});
