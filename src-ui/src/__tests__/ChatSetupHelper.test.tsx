/** @vitest-environment jsdom */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatSetupHelper } from '../components/chat-start/ChatSetupHelper';
import type { AgentData } from '../contexts/AgentsContext';

vi.mock('../components/EnginePicker', () => ({
  EnginePicker: ({
    title,
    onChosen,
  }: {
    title: string;
    onChosen: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onChosen}>
        Use this engine
      </button>
    </div>
  ),
}));

describe('Station assistant setup', () => {
  test('opens the shared AI chooser from setup and rechecks after a choice', async () => {
    const onRepair = vi.fn();
    const onCheck = vi.fn();
    const onModels = vi.fn();
    const station: AgentData = {
      slug: agentId('station'),
      name: 'Station',
      available: false,
      unavailableReason: 'No model connection is configured.',
      unavailableFix: { kind: 'model-connection' },
    };
    render(
      <ChatSetupHelper
        agents={[station]}
        connections={[]}
        busy={false}
        onRepair={onRepair}
        onCheck={onCheck}
        onModels={onModels}
        onSetup={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose AI for Station' }),
    );
    expect(
      await screen.findByRole('dialog', {
        name: 'Choose what powers the Station assistant',
      }),
    ).toBeTruthy();
    expect(onRepair).not.toHaveBeenCalled();
    expect(onModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use this engine' }));
    expect(onCheck).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
