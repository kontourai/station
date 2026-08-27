/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { IntegrationEditorPanel } from '../views/integrations/IntegrationEditorPanel';

describe('IntegrationEditorPanel', () => {
  test('renders persisted-but-not-live state as a warning and reflects persisted disabled state', () => {
    render(
      <IntegrationEditorPanel
        editForm={{ id: 'demo-server', kind: 'mcp', enabled: false }}
        isNew={false}
        locked={false}
        message={{
          type: 'warning',
          text: 'Saved. Not yet live — restart required.',
        }}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onToggleEnabled={vi.fn()}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Saved. Not yet live — restart required.').className,
    ).toContain('plugins__message--warning');
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
  });
  test('shows failed health verbatim and stages tool changes behind Apply', () => {
    const onToggleTool = vi.fn();
    const onApplyTools = vi.fn();
    render(
      <IntegrationEditorPanel
        editForm={{
          id: 'demo-server',
          kind: 'mcp',
          enabled: true,
          displayName: 'Demo Server',
          transport: 'stdio',
          command: 'demo',
          probe: {
            ok: false,
            error: 'verbatim connection failure',
            toolCount: 0,
            checkedAt: '2026-08-14T18:00:00.000Z',
          },
          tools: [{ name: 'demo_write' }],
          disabledTools: [],
        }}
        isNew={false}
        locked={false}
        message={null}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        pendingDisabledTools={['demo_write']}
        onToggleTool={onToggleTool}
        onApplyTools={onApplyTools}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('verbatim connection failure')).toBeTruthy();
    expect(screen.getByText('Disabled · pending')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /demo_write/i }));
    expect(onToggleTool).toHaveBeenCalledWith('demo_write');
    fireEvent.click(screen.getByRole('button', { name: 'Apply tool changes' }));
    expect(onApplyTools).toHaveBeenCalledTimes(1);
  });
  test('uses shared section rhythm for the form editor pane', () => {
    const { container } = render(
      <IntegrationEditorPanel
        editForm={{
          id: 'demo-server',
          displayName: 'Demo Server',
          description: 'Test server',
          kind: 'mcp',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'demo-server'],
          env: { API_KEY: 'secret' },
          connected: false,
        }}
        isNew={false}
        locked={false}
        message={{ type: 'success', text: 'Saved' }}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );

    expect(screen.getByText('Editor Mode')).toBeTruthy();
    expect(screen.getByText('Basics')).toBeTruthy();
    expect(screen.getByText('Connection')).toBeTruthy();
    expect(screen.getByText('Environment Variables')).toBeTruthy();
    expect(container.querySelectorAll('.agent-editor__section')).toHaveLength(
      5,
    );
  });

  test('shows the raw editor section when switched to raw mode', () => {
    const onSwitchToRaw = vi.fn();

    render(
      <IntegrationEditorPanel
        editForm={{
          id: 'demo-server',
          displayName: 'Demo Server',
          description: 'Test server',
          kind: 'mcp',
          transport: 'stdio',
          command: 'npx',
          args: [],
          env: {},
          connected: true,
        }}
        isNew={false}
        locked={false}
        message={null}
        viewMode="raw"
        rawJson='{"mcpServers":{}}'
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={onSwitchToRaw}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );

    expect(screen.getByText('Raw Configuration')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      '{"mcpServers":{}}',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
    expect(onSwitchToRaw).toHaveBeenCalled();
  });
  test('shows configured secret names without retaining material', () => {
    render(
      <IntegrationEditorPanel
        editForm={{
          id: 'secure',
          kind: 'mcp',
          transport: 'stdio',
          secretEnvKeys: ['API_TOKEN'],
        }}
        isNew={false}
        locked={false}
        message={null}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(
      'API_TOKEN secret value',
    ) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Set — enter to replace');
    expect(input.autocomplete).toBe('new-password');
  });

  test('uses tool-server terminology for new entries', () => {
    render(
      <IntegrationEditorPanel
        editForm={{
          id: '',
          displayName: '',
          description: '',
          kind: 'mcp',
          transport: 'stdio',
          command: '',
          args: [],
          env: {},
          connected: false,
        }}
        isNew
        locked={false}
        message={null}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );

    expect(screen.getByText('New Tool Server')).toBeTruthy();
    expect(
      screen.getByText('Disabled until you explicitly enable it'),
    ).toBeTruthy();
  });

  // Audit CI-R7: `station-docs`/`station-control` persist as `kind: 'mcp'`,
  // so the panel's `kind === 'builtin'` test was false for them and it
  // offered a Delete the runtime silently undid on its next start. The
  // built-in fact is now server-derived (`builtin`).
  test('a runtime-registered built-in is tagged and cannot be deleted', () => {
    render(
      <IntegrationEditorPanel
        editForm={{
          id: 'station-docs',
          kind: 'mcp',
          builtin: true,
          enabled: true,
          displayName: 'Station Docs',
        }}
        isNew={false}
        locked={false}
        message={null}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onToggleEnabled={vi.fn()}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );

    expect(screen.getByText('Built in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(
      screen.getByText(
        /Built into Station and re-created every time it starts/,
      ),
    ).toBeTruthy();
  });

  test('a user-added tool server keeps its Delete', () => {
    render(
      <IntegrationEditorPanel
        editForm={{ id: 'audit-echo', kind: 'mcp', enabled: true }}
        isNew={false}
        locked={false}
        message={null}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByText('Built in')).toBeNull();
  });

  // CI-R15: the live catalogue is empty until a session opens a client, so a
  // server could report "1 tool" that no surface could ever name.
  test('names the tools the last probe saw when the live catalogue is empty', () => {
    render(
      <IntegrationEditorPanel
        editForm={{
          id: 'audit-echo',
          kind: 'mcp',
          enabled: true,
          tools: [],
          probe: {
            ok: true,
            toolCount: 2,
            toolNames: ['echo', 'reverse'],
            checkedAt: '2026-08-22T18:00:00.000Z',
          },
        }}
        isNew={false}
        locked={false}
        message={null}
        viewMode="form"
        rawJson=""
        rawError={null}
        savePending={false}
        reconnectPending={false}
        onReconnect={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSwitchToForm={vi.fn()}
        onSwitchToRaw={vi.fn()}
        onRawJsonChange={vi.fn()}
        onUpdate={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );

    expect(screen.getByText('echo')).toBeTruthy();
    expect(screen.getByText('reverse')).toBeTruthy();
  });
});
