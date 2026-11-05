/**
 * @vitest-environment jsdom
 *
 * #2436 (owner request): an Agent's default approval posture is edited in the
 * Engine section and survives every save, including an unrelated one.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// #3290: the editor reads the ACP connection list to tell an engine whose
// approval rules Station sets from one that decides for itself.
const acpConnections = vi.hoisted(() => ({
  current: [] as Array<{ id: string; name: string; command: string }>,
}));
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: acpConnections.current }),
}));

import { ManagedPolicyContext } from '../contexts/ManagedPolicyContext';
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
  beforeEach(() => {
    acpConnections.current = [];
  });

  test('a knob engine offers the default; choosing full access says what it means and reaches the save payload', () => {
    let latest: AgentFormData | undefined;
    render(<Harness initial={agent({})} onForm={(form) => (latest = form)} />);
    const select = screen.getByLabelText('Default approval mode');
    expect((select as HTMLSelectElement).value).toBe('');

    fireEvent.change(select, { target: { value: 'never' } });

    expect(latest?.execution.approvalMode).toBe('never');
    expect(screen.getByText(/starts at full access/)).toBeTruthy();
    // A start without a full-access grant (a webhook start) gets a narrower
    // setting whose exact shape depends on the engine (`approval-posture.ts`
    // applicableMode; Claude Code may fall back to Auto with no confinement),
    // so the hint promises none of it.
    expect(
      screen.getByText(
        /gets a narrower setting, so some actions may still ask/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/still runs inside/i)).toBeNull();
    expect(screen.queryByText(/workspace confinement/i)).toBeNull();
    expect(screen.queryByText(/no sandbox/i)).toBeNull();
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

  test('#3290: an ACP connection that launches OpenCode offers the default', () => {
    acpConnections.current = [
      { id: 'my-opencode', name: 'OpenCode', command: '/usr/bin/opencode' },
    ];
    render(
      <Harness
        initial={agent({ agentConnectionId: 'my-opencode' })}
        onForm={() => {}}
      />,
    );
    expect(screen.getByLabelText('Default approval mode')).toBeTruthy();
  });

  test('#3290: an ACP connection merely named opencode that decides for itself shows nothing', () => {
    acpConnections.current = [
      { id: 'opencode', name: 'Kiro', command: 'kiro-cli' },
    ];
    const { container } = render(
      <Harness
        initial={agent({ agentConnectionId: 'opencode' })}
        onForm={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

/** #4518: the managed approval ceiling in the Agent's default picker. */
describe('AgentEditorApprovalDefault under a managed ceiling of Auto', () => {
  const renderUnder = (initial: AgentFormData) =>
    render(
      <ManagedPolicyContext.Provider
        value={{
          organization: 'Acme',
          supportUrl: 'https://help.acme.example',
          lockedSettings: [],
          limits: { maxApprovalMode: 'auto' },
        }}
      >
        <Harness initial={initial} onForm={() => {}} />
      </ManagedPolicyContext.Provider>,
    );
  const option = (value: string) =>
    screen
      .getAllByRole('option')
      .find((entry) => (entry as HTMLOptionElement).value === value) as
      | HTMLOptionElement
      | undefined;

  test('Full access is disabled and marked Managed, under the policy sentence', () => {
    renderUnder(agent({}));
    expect(option('never')?.disabled).toBe(true);
    expect(option('never')?.textContent).toMatch(/ \(Managed\)$/);
    expect(option('auto')?.disabled).toBe(false);
    expect(
      screen.getByText(/Acme's policy manages approval modes/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get help' })).toBeTruthy();
  });

  test('a Full access default saved before the policy stays selected so an unrelated save can resend it', () => {
    renderUnder(agent({ approvalMode: 'never' }));
    expect(option('never')?.disabled).toBe(false);
  });
});
