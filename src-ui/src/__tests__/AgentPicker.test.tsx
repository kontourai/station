/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AgentPicker } from '../components/scheduler/AgentPicker';

vi.mock('../contexts/AgentsContext', () => ({
  useAgentsLoaded: () => true,
  useAgents: () => [
    { slug: 'alpha', name: 'Alpha', model: 'model-a' },
    { slug: 'beta', name: 'Beta', model: 'model-b' },
  ],
}));

describe('AgentPicker', () => {
  test('uses non-submitting native buttons for its trigger and options', () => {
    const onChange = vi.fn();
    render(
      <form>
        <AgentPicker value="alpha" onChange={onChange} />
      </form>,
    );

    const trigger = screen.getByRole('button', { name: /Alpha/ });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');

    fireEvent.click(trigger);
    const option = screen.getByRole('button', { name: /Beta/ });
    expect(option.tagName).toBe('BUTTON');
    expect(option.getAttribute('type')).toBe('button');

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('beta');
  });
});
