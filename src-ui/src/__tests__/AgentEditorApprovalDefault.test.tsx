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
    // setting, not full access and not always confinement (`approval-posture.ts`
    // applicableMode: ACP engines are lowered to `auto`), so the hint must
    // promise neither "no sandbox" nor "still runs inside" confinement.
    expect(
      screen.getByText(
        /gets a narrower setting: workspace confinement where the engine supports it, otherwise automatic approval/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/still runs inside/)).toBeNull();
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
