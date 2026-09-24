/**
 * @vitest-environment jsdom
 *
 * #2436 (owner request): an Agent's default approval posture is edited in the
 * Engine section and survives every save, including an unrelated one.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { AgentEditorApprovalDefault } from '../views/agent-editor/AgentEditorApprovalDefault';
import {
  buildAgentPayload,
  formFromAgent,
} from '../views/agent-editor/agentsViewUtils';
import type { AgentFormData } from '../views/agent-editor/types';

function Harness({
  initial,
  onForm,
}: {
  initial: AgentFormData;
  onForm: (form: AgentFormData) => void;
}) {
  const [form, setForm] = useState(initial);
  onForm(form);
  return (
    <AgentEditorApprovalDefault form={form} setForm={setForm} locked={false} />
  );
}

const agent = (execution: Record<string, unknown>) =>
  formFromAgent({
    slug: 'builder',
    name: 'Builder',
    prompt: 'Build.',
    execution: { agentConnectionId: 'claude', ...execution },
  } as never);

describe('AgentEditorApprovalDefault', () => {
  test('a knob engine offers the default; choosing full access says what it means and reaches the save payload', () => {
    let latest: AgentFormData | undefined;
    render(<Harness initial={agent({})} onForm={(form) => (latest = form)} />);
    const select = screen.getByLabelText('Default approval mode');
    expect((select as HTMLSelectElement).value).toBe('');

    fireEvent.change(select, { target: { value: 'never' } });

    expect(latest?.execution.approvalMode).toBe('never');
    expect(screen.getByText(/starts at full access/)).toBeTruthy();
    expect(buildAgentPayload(latest!).execution).toMatchObject({
      approvalMode: 'never',
    });
  });

  test("clearing it follows this Station's default", () => {
    let latest: AgentFormData | undefined;
    render(
      <Harness
        initial={agent({ approvalMode: 'ask' })}
        onForm={(form) => (latest = form)}
      />,
    );
    fireEvent.change(screen.getByLabelText('Default approval mode'), {
      target: { value: '' },
    });
    expect(latest?.execution.approvalMode).toBeUndefined();
  });

  test('an unrelated save keeps it (the execution payload is a whitelist)', () => {
    const form = agent({ approvalMode: 'auto' });
    expect(
      buildAgentPayload({ ...form, name: 'Renamed' }).execution,
    ).toMatchObject({ approvalMode: 'auto' });
  });

  test('an engine with no approval control shows nothing', () => {
    const { container } = render(
      <Harness
        initial={agent({ agentConnectionId: 'some-acp-runtime' })}
        onForm={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
