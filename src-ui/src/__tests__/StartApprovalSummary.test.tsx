// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';

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
    expect(chip.textContent).toContain('Permissions: Engine settings');
    expect(chip.getAttribute('title')).toBe(
      'Your Codex settings decide. Unset, Codex asks before network use or writes outside this folder and temp.',
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
