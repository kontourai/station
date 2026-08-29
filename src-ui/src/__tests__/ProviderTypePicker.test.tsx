/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ProviderTypePicker } from '../views/provider-settings/ProviderTypePicker';
import { resolveProviderChoicePresentation } from '../views/provider-settings/providerCatalog';

describe('ProviderTypePicker', () => {
  test('groups presets above raw connection types', () => {
    render(<ProviderTypePicker onAdd={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText('Popular')).toBeTruthy();
    expect(screen.getByText('More')).toBeTruthy();
    expect(screen.getByRole('button', { name: /OpenRouter/ })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^OpenAI-Compatible/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Other OpenAI-compatible/ }),
    ).toBeNull();
  });

  test('preset click resolves to its primitive type with prefilled config', () => {
    const onAdd = vi.fn();
    render(<ProviderTypePicker onAdd={onAdd} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /OpenRouter/ }));
    expect(onAdd).toHaveBeenCalledWith('openai-compat', 'OpenRouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
    });
  });

  test('raw type click passes no prefill', () => {
    const onAdd = vi.fn();
    render(<ProviderTypePicker onAdd={onAdd} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^Ollama/ }));
    expect(onAdd).toHaveBeenCalledWith('ollama', 'Ollama');
  });

  test('groups engine choices (agents, registered commands) and a truthfully labeled custom engine under one Engines group', () => {
    const onChooseAgent = vi.fn();
    const onChooseCommand = vi.fn();
    const agent = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'unknown',
      prerequisites: [],
      setup: { state: 'available' },
    } as never;
    const agentPresentation = resolveProviderChoicePresentation({
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      status: 'unknown',
      prerequisites: [],
      setup: { state: 'available', detected: false, configured: false },
      href: '',
    });
    const command = {
      id: 'kiro',
      name: 'Kiro CLI',
      description: 'A detected local provider',
      installed: false,
      detected: true,
    } as never;
    const commandPresentation = resolveProviderChoicePresentation({
      id: 'kiro',
      kind: 'command',
      type: 'acp',
      name: 'Kiro CLI',
      enabled: true,
      status: 'unknown',
      setup: null,
      discovery: 'detected-unconfigured',
      description: 'A detected local provider',
      href: '',
    });

    render(
      <ProviderTypePicker
        onAdd={vi.fn()}
        onCancel={vi.fn()}
        agentChoices={[agent]}
        commandChoices={[command]}
        onChooseAgent={onChooseAgent}
        onChooseCommand={onChooseCommand}
      />,
    );

    // One group, one noun — the picker's cross-reference to the Engines tab
    // no longer splits agents and registered commands under different
    // chrome ("Coding providers" / "Local and command providers").
    expect(screen.getByText('Engines')).toBeTruthy();
    expect(screen.queryByText('Coding providers')).toBeNull();
    expect(screen.queryByText('Local and command providers')).toBeNull();

    expect(screen.getByRole('button', { name: /Codex/ }).textContent).toContain(
      agentPresentation.badge,
    );
    expect(
      screen.getByRole('button', { name: /Kiro CLI/ }).textContent,
    ).toContain('Found, not connected');
    expect(
      screen.getByRole('button', { name: /Kiro CLI/ }).textContent,
    ).toContain(commandPresentation.detail);

    // The trailing custom choice creates an ACP engine connection (routes
    // through the same `onChooseCommand('custom')` as every command choice
    // above), so it is labeled truthfully as an engine, not a provider.
    expect(screen.queryByText('Custom provider')).toBeNull();
    expect(screen.getByText('Custom engine')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Custom engine/ }));

    expect(onChooseAgent).toHaveBeenCalledWith(agent);
    expect(onChooseCommand).toHaveBeenNthCalledWith(1, command);
    expect(onChooseCommand).toHaveBeenNthCalledWith(2, 'custom');
  });

  test('cancel and overlay clicks dismiss without adding', () => {
    const onAdd = vi.fn();
    const onCancel = vi.fn();
    render(<ProviderTypePicker onAdd={onAdd} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
