// @vitest-environment jsdom

import { authenticatedFetch } from '@kontourai/station-sdk';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ResponsiveDialogSurface } from '../components/ResponsiveDialogSurface';
import { SessionModelPicker } from '../components/session/SessionModelPicker';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { resetModelPickerPreferencesCacheForTests } from '../settings/modelPickerPreferences';

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch: vi.fn(),
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(authenticatedFetch).mockReset();
  resetModelPickerPreferencesCacheForTests();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

function renderPicker(overrides: Record<string, unknown> = {}) {
  const props = {
    models: [
      {
        id: 'gpt-5.6',
        name: 'GPT-5.6',
        capabilities: {
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high', 'xhigh'],
        },
      },
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        capabilities: {
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high', 'xhigh'],
        },
      },
    ],
    currentModel: 'gpt-5.6',
    defaultModel: 'gpt-5.5',
    runtimeOptions: { effort: 'high' },
    onSelect: vi.fn(),
    onReset: vi.fn(),
    onRuntimeOptionChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SessionModelPicker {...props} />);
  return props;
}

function renderNestedPicker(onOuterClose = vi.fn()) {
  function Harness() {
    const [pickerOpen, setPickerOpen] = useState(true);
    return (
      <ResponsiveDialogSurface ariaLabel="New Chat" onClose={onOuterClose}>
        <button type="button">Outer dialog control</button>
        {pickerOpen && (
          <SessionModelPicker
            models={[
              {
                id: 'gpt-5.6',
                name: 'GPT-5.6',
                capabilities: {
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'high'],
                },
              },
            ]}
            currentModel="gpt-5.6"
            runtimeOptions={{ effort: 'high' }}
            onSelect={vi.fn()}
            onReset={vi.fn()}
            onRuntimeOptionChange={vi.fn()}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </ResponsiveDialogSurface>
    );
  }

  render(<Harness />);
}

describe('SessionModelPicker', () => {
  test('distinguishes an unreachable cached catalog from a live empty catalog', () => {
    const { rerender } = render(
      <SessionModelPicker
        models={[]}
        stale
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onRuntimeOptionChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Models unavailable while this Station is unreachable'),
    ).toBeTruthy();

    rerender(
      <SessionModelPicker
        models={[]}
        stale={false}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onRuntimeOptionChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText('This engine reported no selectable models'),
    ).toBeTruthy();
  });

  test('selects a model and provider-supported effort directly', () => {
    const props = renderPicker();

    fireEvent.click(screen.getByRole('option', { name: /GPT-5.5/ }));
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Thinking effort' }),
      {
        target: { value: 'xhigh' },
      },
    );

    expect(props.onSelect).toHaveBeenCalledWith({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      capabilities: {
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'xhigh'],
      },
    });
    expect(props.onRuntimeOptionChange).toHaveBeenCalledWith('effort', 'xhigh');
  });

  test('removes the effort override when model default is selected', () => {
    const props = renderPicker();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Thinking effort' }),
      { target: { value: '' } },
    );
    expect(props.onRuntimeOptionChange).toHaveBeenCalledWith(
      'effort',
      undefined,
    );
  });

  test('does not invent effort controls when a model did not report them', () => {
    renderPicker({
      models: [{ id: 'provider-default', name: 'Provider default' }],
      currentModel: 'provider-default',
    });

    expect(
      screen.queryByRole('combobox', { name: 'Thinking effort' }),
    ).toBeNull();
  });

  test('renders one provider-reported Auto mode control', () => {
    const props = renderPicker({
      models: [
        {
          id: 'claude-opus',
          name: 'Claude Opus',
          capabilities: { supportsAutoMode: true },
        },
      ],
      currentModel: 'claude-opus',
      runtimeOptions: {},
    });

    const autoMode = screen.getByRole('checkbox', { name: 'Auto mode' });
    expect(screen.getAllByRole('checkbox', { name: 'Auto mode' })).toHaveLength(
      1,
    );
    expect((autoMode as HTMLInputElement).checked).toBe(true);
    fireEvent.click(autoMode);
    expect(props.onRuntimeOptionChange).toHaveBeenCalledWith('autoMode', false);
  });

  test('explains an unreported catalog without presenting fake choices', () => {
    renderPicker({ models: [], currentModel: undefined, runtimeId: undefined });

    expect(
      screen.getByText('This engine reported no selectable models'),
    ).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Model not reported')).toBeNull();
  });

  test('offers an explicit session reset', () => {
    const props = renderPicker({ defaultSourceLabel: 'agent default' });
    fireEvent.click(screen.getByRole('button', { name: 'Use agent default' }));
    expect(props.onReset).toHaveBeenCalledOnce();
  });

  test('owns Escape when nested in a parent dialog', () => {
    const onOuterClose = vi.fn();
    renderNestedPicker(onOuterClose);

    fireEvent.keyDown(screen.getByPlaceholderText('Search models…'), {
      key: 'Escape',
    });

    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New Chat' })).toBeTruthy();
    expect(onOuterClose).not.toHaveBeenCalled();
  });

  test('keeps the nested dialog lifecycle while its catalog is loading', () => {
    const onOuterClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ResponsiveDialogSurface ariaLabel="New Chat" onClose={onOuterClose}>
          {open && (
            <SessionModelPicker
              models={[]}
              loading
              onSelect={vi.fn()}
              onReset={vi.fn()}
              onRuntimeOptionChange={vi.fn()}
              onClose={() => setOpen(false)}
            />
          )}
        </ResponsiveDialogSurface>
      );
    }
    render(<Harness />);

    const picker = screen.getByRole('dialog', { name: 'Choose model' });
    expect(screen.getByLabelText('Loading models')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close model picker' }),
    );
    fireEvent.keyDown(picker, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New Chat' })).toBeTruthy();
    expect(onOuterClose).not.toHaveBeenCalled();
  });

  test('restores focus after the nested picker closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <ResponsiveDialogSurface ariaLabel="New Chat" onClose={vi.fn()}>
          <button type="button" onClick={() => setOpen(true)}>
            Configure model
          </button>
          {open && (
            <SessionModelPicker
              models={[{ id: 'gpt-5.6', name: 'GPT-5.6' }]}
              onSelect={vi.fn()}
              onReset={vi.fn()}
              onRuntimeOptionChange={vi.fn()}
              onClose={() => setOpen(false)}
            />
          )}
        </ResponsiveDialogSurface>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Configure model' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(screen.getByPlaceholderText('Search models…'), {
      key: 'Escape',
    });

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('keeps phone focus inside the picker without opening the keyboard', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    renderNestedPicker();

    const picker = screen.getByRole('dialog', {
      name: 'Choose model',
    });
    const close = screen.getByRole('button', { name: 'Close model picker' });
    const search = screen.getByPlaceholderText('Search models…');
    const focusable = Array.from(
      picker.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    const last = focusable.at(-1)!;
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(search);

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  test('switches providers and keeps duplicate model names unambiguous', () => {
    const props = renderPicker({
      currentProviderId: 'codex-work',
      providers: [
        { id: 'codex-work', name: 'Codex · Work', available: true },
        { id: 'bedrock-prod', name: 'Bedrock · Prod', available: true },
        {
          id: 'litellm-local',
          name: 'LiteLLM · Local',
          available: false,
          detail: 'Setup required',
        },
      ],
      models: [
        {
          id: 'gpt-5.6',
          name: 'GPT-5.6',
          providerId: 'codex-work',
          providerName: 'Codex · Work',
          providerType: 'codex',
        },
        {
          id: 'gpt-5.6',
          name: 'GPT-5.6',
          providerId: 'bedrock-prod',
          providerName: 'Bedrock · Prod',
          providerType: 'bedrock',
        },
      ],
    });

    expect(
      screen.getByRole('button', { name: 'LiteLLM · Local' }),
    ).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Bedrock · Prod' }));
    const bedrockModel = screen.getByRole('option', {
      name: /GPT-5.6Bedrock · Prod · gpt-5.6/,
    });
    expect(
      screen.queryByRole('option', {
        name: /GPT-5.6Codex · Work · gpt-5.6/,
      }),
    ).toBeNull();
    fireEvent.click(bedrockModel);
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'bedrock-prod',
        providerType: 'bedrock',
      }),
    );
  });

  test('composes capability filters and only treats the canonical tool-calls surface as tool calling', () => {
    renderPicker({
      models: [
        {
          id: 'reasoner',
          name: 'Reasoner',
          capabilities: { supportsEffort: true, contextWindow: 200_000 },
          supportsVision: true,
          toolSurface: ['tool-calls'],
        },
        { id: 'no-surface', name: 'No surface', toolSurface: null },
        { id: 'empty-surface', name: 'Empty surface', toolSurface: [] },
        { id: 'abort-only', name: 'Abort only', toolSurface: ['abort'] },
        { id: 'plain', name: 'Plain' },
      ],
    });
    expect(screen.getByText(/200k/)).toBeTruthy();
    expect(screen.queryByText('Vision')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Plain/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Vision' }));
    expect(screen.getByRole('option', { name: /Reasoner/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Plain/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tool calling' }));
    expect(screen.getByRole('option', { name: /Reasoner/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /No surface/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Empty surface/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Abort only/ })).toBeNull();
  });

  // The picker used to fetch Bedrock's pricing endpoint and render the result
  // beside the selected model whatever its provider, so an OpenAI or Ollama
  // route could display an Amazon price. Nothing sources a per-route price yet,
  // so the picker must show none rather than borrow one.
  test('renders no price and requests no pricing for a selected Bedrock model', async () => {
    renderPicker({
      models: [
        { id: 'bedrock-model', name: 'Bedrock model', providerType: 'bedrock' },
      ],
      currentModel: 'bedrock-model',
    });

    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Bedrock model/ }),
      ).toBeTruthy(),
    );
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/\/M/)).toBeNull();
    expect(screen.queryByText(/Cost:/)).toBeNull();
  });

  test('searches across providers and persists a device-local favorite', () => {
    renderPicker({
      currentProviderId: 'codex-work',
      providers: [
        { id: 'codex-work', name: 'Codex · Work', available: true },
        { id: 'bedrock-prod', name: 'Bedrock · Prod', available: true },
      ],
      models: [
        {
          id: 'gpt-5.6',
          name: 'GPT-5.6',
          providerId: 'codex-work',
          providerName: 'Codex · Work',
        },
        {
          id: 'claude-sonnet',
          name: 'Claude Sonnet',
          providerId: 'bedrock-prod',
          providerName: 'Bedrock · Prod',
        },
      ],
    });

    fireEvent.change(screen.getByPlaceholderText('Search models…'), {
      target: { value: 'bedrock' },
    });
    expect(screen.getByRole('option', { name: /Claude Sonnet/ })).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Add Claude Sonnet (Bedrock · Prod) to favorites',
      }),
    );
    expect(
      screen.getByRole('button', {
        name: 'Remove Claude Sonnet (Bedrock · Prod) from favorites',
      }),
    ).toBeTruthy();
    // archive#settings-revamp (archive#1359 convergence): model-picker
    // preferences now live in the registry-driven envelope's
    // `modelPickerPreferences` entry, not the retired
    // `station.device-settings` root.
    expect(
      deviceSettingsStore.get('modelPickerPreferences').favorites,
    ).toContain('bedrock-prod\u001fclaude-sonnet');
  });

  // #1208 review: nothing exercised the render seam. Removing the grouping
  // from the picker left every helper test green.
  test('renders routes the reviewed identity unites as one named group', () => {
    const sonnet = {
      canonicalId: 'anthropic:claude-sonnet-4-5',
      verifiedAgainst: 'reviewed 2026-08-31',
    };
    renderPicker({
      currentModel: undefined,
      models: [
        { id: 'gpt-5.6', name: 'GPT-5.6' },
        {
          id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5',
          providerName: 'Anthropic',
          canonicalModelIdentity: sonnet,
        },
        {
          id: 'sonnet',
          name: 'sonnet',
          providerName: 'Claude Code',
          canonicalModelIdentity: sonnet,
        },
      ],
    });
    const group = screen.getByRole('group', { name: 'Claude Sonnet 4.5' });
    expect(group.tagName).toBe('FIELDSET');
    expect(
      within(group)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining('Claude Sonnet 4.5'),
      expect.stringContaining('sonnet'),
    ]);
    expect(within(group).queryByRole('option', { name: /GPT-5.6/ })).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeTruthy();
  });

  test('a lone identified route is a plain row, not a group of one', () => {
    renderPicker({
      currentModel: undefined,
      models: [
        {
          id: 'sonnet',
          name: 'sonnet',
          canonicalModelIdentity: {
            canonicalId: 'anthropic:claude-sonnet-4-5',
            verifiedAgainst: 'reviewed 2026-08-31',
          },
        },
      ],
    });
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('option', { name: /sonnet/ })).toBeTruthy();
  });

  test('arrow keys cross a group boundary in visual order', () => {
    const sonnet = {
      canonicalId: 'anthropic:claude-sonnet-4-5',
      verifiedAgainst: 'reviewed 2026-08-31',
    };
    renderPicker({
      currentModel: undefined,
      models: [
        { id: 'gpt-5.6', name: 'GPT-5.6' },
        {
          id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5',
          canonicalModelIdentity: sonnet,
        },
        { id: 'sonnet', name: 'sonnet', canonicalModelIdentity: sonnet },
        { id: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    });
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('GPT-5.6'),
      expect.stringContaining('Claude Sonnet 4.5'),
      expect.stringContaining('sonnet'),
      expect.stringContaining('GPT-5.5'),
    ]);
    // The boundary must actually exist: the middle two sit inside the group,
    // the outer two do not. Without this the test passes on a flat list.
    expect(
      options.map((option) => option.closest('fieldset') !== null),
    ).toEqual([false, true, true, false]);
    options[0]!.focus();
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[2]);
    fireEvent.keyDown(options[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[3]);
    fireEvent.keyDown(options[3]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(options[2]);
  });

  test('moves between model options with arrow, Home, and End keys', () => {
    renderPicker({ currentModel: undefined });
    const first = screen.getByRole('option', { name: /GPT-5.6/ });
    const last = screen.getByRole('option', { name: /GPT-5.5/ });

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(last);
  });

  // archive#1806: the Thinking effort <select> and the Adaptive
  // thinking/Fast mode/Auto mode checkboxes rendered as bare, unstyled
  // native controls inside an otherwise fully themed surface. The select
  // must carry the app's shared themed-select class (`editor-select`,
  // `editor-controls.css`), and every checkbox must render through the
  // app's existing themed `Checkbox` component (`cb`/`cb__box`/`cb__input`,
  // `components/Checkbox.tsx`) — real, accessible, keyboard-operable form
  // controls, not bespoke divs.
  test("themes the Thinking effort select and every checkbox with the app's shared controls", () => {
    renderPicker({
      models: [
        {
          id: 'claude-opus',
          name: 'Claude Opus',
          capabilities: {
            supportsEffort: true,
            supportedEffortLevels: ['low', 'high'],
            supportsAdaptiveThinking: true,
            supportsFastMode: true,
            supportsAutoMode: true,
          },
        },
      ],
      currentModel: 'claude-opus',
      runtimeOptions: { effort: 'high' },
    });

    const select = screen.getByRole('combobox', { name: 'Thinking effort' });
    expect(select.className).toContain('editor-select');

    for (const name of ['Adaptive thinking', 'Fast mode', 'Auto mode']) {
      const checkbox = screen.getByRole('checkbox', { name });
      expect(checkbox.className).toContain('cb__input');
      // The themed control's visible box sibling — proves this rendered
      // through the shared `Checkbox` component, not a bare `<input>`.
      expect(checkbox.nextElementSibling?.className).toContain('cb__box');
      expect((checkbox as HTMLInputElement).type).toBe('checkbox');
    }
  });

  // archive#1806: the selected-model check glyph used to fall into the
  // grid's implicit placement (sharing only the model-name row), pinning it
  // to the top of the two-line name+id cell instead of centering against
  // the option's full height. It must render through a class the CSS can
  // explicitly span both rows and center on.
  test('renders the selected-model check glyph through its centering class', () => {
    renderPicker();

    const activeOption = screen.getByRole('option', { name: /GPT-5.6/ });
    const check = activeOption.querySelector(
      '.session-model-picker__model-check',
    );
    expect(check).not.toBeNull();
  });
});
