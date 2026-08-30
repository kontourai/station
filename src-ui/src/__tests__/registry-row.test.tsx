/** @vitest-environment jsdom */

import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { renderSettingRow } from '../views/settings/registry-row';

function stringDef(
  overrides: Partial<SettingDefinition> = {},
): SettingDefinition {
  return {
    key: 'terminalShell' as any,
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Terminal shell',
    description: 'Shell used when Station spawns a terminal session.',
    ...overrides,
  } as SettingDefinition;
}

describe('renderSettingRow', () => {
  test('string kind renders a text input with the current value', () => {
    render(
      renderSettingRow({
        definition: stringDef(),
        value: '/bin/zsh',
        onChange: vi.fn(),
      }),
    );
    const input = screen.getByLabelText('Terminal shell') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('/bin/zsh');
    expect(input.classList.contains('editor-input')).toBe(true);
  });

  test('boolean kind renders a Toggle', () => {
    const def = stringDef({
      key: 'mcpUiHost' as any,
      descriptor: { kind: 'boolean' },
      label: 'MCP UI host',
    });
    render(
      renderSettingRow({ definition: def, value: true, onChange: vi.fn() }),
    );
    const toggle = screen.getByRole('switch', { name: 'MCP UI host' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  // archive#1840: the control shows the EFFECTIVE value. An un-overridden
  // default-on setting (`value === undefined`, `defaultValue: true` — e.g.
  // mcpUiHost) used to render an OFF switch beside copy describing an active
  // feature; the DEFAULT chip, not a contradicting control, carries the
  // default-vs-overridden distinction.
  describe('un-overridden values render the registry default (station#1840)', () => {
    test('boolean: undefined value with defaultValue true renders checked', () => {
      const def = stringDef({
        key: 'mcpUiHost' as any,
        descriptor: { kind: 'boolean' },
        label: 'MCP UI host',
        defaultValue: true,
      });
      render(
        renderSettingRow({
          definition: def,
          value: undefined,
          onChange: vi.fn(),
        }),
      );
      const toggle = screen.getByRole('switch', { name: 'MCP UI host' });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });

    test('boolean: an explicit false override beats a true default', () => {
      const def = stringDef({
        key: 'mcpUiHost' as any,
        descriptor: { kind: 'boolean' },
        label: 'MCP UI host',
        defaultValue: true,
      });
      render(
        renderSettingRow({ definition: def, value: false, onChange: vi.fn() }),
      );
      const toggle = screen.getByRole('switch', { name: 'MCP UI host' });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });

    test('boolean: undefined value with no declared default renders off', () => {
      const def = stringDef({
        key: 'disableDefaultSkillRegistries' as any,
        descriptor: { kind: 'boolean' },
        label: 'Disable default skill registries',
      });
      render(
        renderSettingRow({
          definition: def,
          value: undefined,
          onChange: vi.fn(),
        }),
      );
      const toggle = screen.getByRole('switch', {
        name: 'Disable default skill registries',
      });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });

    test('enum: undefined value renders the registry default, not the first option', () => {
      const def = stringDef({
        key: 'runtime' as any,
        descriptor: { kind: 'enum', values: ['voltagent', 'strands'] },
        label: 'Agent framework',
        defaultValue: 'strands',
      });
      render(
        renderSettingRow({
          definition: def,
          value: undefined,
          onChange: vi.fn(),
        }),
      );
      const select = screen.getByLabelText(
        'Agent framework',
      ) as HTMLSelectElement;
      expect(select.value).toBe('strands');
    });

    test('persisted internal settings fail closed instead of rendering a row', () => {
      const def = stringDef({
        key: 'runtime' as any,
        descriptor: { kind: 'enum', values: ['voltagent', 'strands'] },
        label: 'Station engine framework (internal)',
        userFacing: false,
      });
      const { container } = render(
        renderSettingRow({
          definition: def,
          value: 'voltagent',
          onChange: vi.fn(),
        }),
      );
      expect(container.firstChild).toBeNull();
    });

    test('number: undefined value keeps the input empty and shows the default as the placeholder', () => {
      const def = stringDef({
        key: 'defaultMaxTurns' as any,
        descriptor: { kind: 'number', min: 1, integer: true },
        label: 'Default max turns',
        defaultValue: 200,
      });
      render(
        renderSettingRow({
          definition: def,
          value: undefined,
          onChange: vi.fn(),
        }),
      );
      const input = screen.getByLabelText(
        'Default max turns',
      ) as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('200');
    });

    test('number: an explicit placeholder wins over a stringified default', () => {
      const def = stringDef({
        key: 'defaultMaxOutputTokens' as any,
        descriptor: { kind: 'number', min: 1, integer: true },
        label: 'Default max output tokens',
        placeholder: 'no cap',
        defaultValue: 123,
      });
      render(
        renderSettingRow({
          definition: def,
          value: undefined,
          onChange: vi.fn(),
        }),
      );
      const input = screen.getByLabelText(
        'Default max output tokens',
      ) as HTMLInputElement;
      expect(input.placeholder).toBe('no cap');
    });
  });

  test('number kind renders a number input honoring min/max and a placeholder for an absent value', () => {
    const def = stringDef({
      key: 'defaultMaxOutputTokens' as any,
      descriptor: { kind: 'number', min: 1, integer: true },
      label: 'Default max output tokens',
      placeholder: 'no cap',
    });
    render(
      renderSettingRow({
        definition: def,
        value: undefined,
        onChange: vi.fn(),
      }),
    );
    const input = screen.getByLabelText(
      'Default max output tokens',
    ) as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('no cap');
    expect(input.min).toBe('1');
    expect(input.classList.contains('editor-input')).toBe(true);
  });

  test('enum kind renders a select with every option', () => {
    const def = stringDef({
      key: 'logLevel' as any,
      descriptor: { kind: 'enum', values: ['debug', 'info', 'warn'] },
      label: 'Log level',
    });
    render(
      renderSettingRow({
        definition: def,
        value: 'info',
        onChange: vi.fn(),
      }),
    );
    const select = screen.getByLabelText('Log level') as HTMLSelectElement;
    expect(select.value).toBe('info');
    expect(select.classList.contains('editor-select')).toBe(true);
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'debug',
      'info',
      'warn',
    ]);
  });

  // archive#1557: provenance no longer disables anything. It says where the
  // value came from; it never claims an edit would be ignored.
  test('a declared env fallback does not disable the control', () => {
    const provenance: SettingProvenanceEntry = { source: 'file' };
    render(
      renderSettingRow({
        definition: stringDef({ envFallback: 'MY_ENV' }),
        value: 'x',
        provenance,
        onChange: vi.fn(),
      }),
    );
    const input = screen.getByLabelText('Terminal shell') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(screen.queryByText(/overrid/i)).toBeNull();
  });

  test('a deferred composite key renders nothing', () => {
    const def = stringDef({
      key: 'agentConnections' as any,
      descriptor: { kind: 'composite' },
      label: 'Agent connections',
    });
    const { container } = render(
      renderSettingRow({ definition: def, value: {}, onChange: vi.fn() }),
    );
    expect(container.textContent).toBe('');
  });

  test('approvalGuardian delegates to its custom composite editor, not a generic control', async () => {
    const def = stringDef({
      key: 'approvalGuardian' as any,
      descriptor: { kind: 'composite' },
      label: 'Approval guardian',
      description: 'Optional AI review layer for approval-bound tool calls.',
    });
    render(renderSettingRow({ definition: def, value: {}, onChange: vi.fn() }));
    expect(await screen.findByText('Approval guardian')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  // archive#settings-revamp: onChange write-path
  // coverage per kind — the render-only tests above never exercised what
  // each control actually SENDS back through onChange.
  describe('onChange write paths', () => {
    test('string: clearing the input calls onChange(null), not onChange("")', () => {
      const onChange = vi.fn();
      render(
        renderSettingRow({
          definition: stringDef(),
          value: '/bin/zsh',
          onChange,
        }),
      );
      const input = screen.getByLabelText('Terminal shell') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      expect(onChange).toHaveBeenCalledWith(null);
      expect(onChange).not.toHaveBeenCalledWith('');
    });

    test('string: typing calls onChange with the raw string', () => {
      const onChange = vi.fn();
      render(
        renderSettingRow({ definition: stringDef(), value: '', onChange }),
      );
      const input = screen.getByLabelText('Terminal shell') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '/bin/bash' } });
      expect(onChange).toHaveBeenCalledWith('/bin/bash');
    });

    test('number: clearing the input calls onChange(null), never NaN, 0, or ""', () => {
      const def = stringDef({
        key: 'defaultMaxTurns' as any,
        descriptor: { kind: 'number', min: 1, integer: true },
        label: 'Default max turns',
      });
      const onChange = vi.fn();
      render(renderSettingRow({ definition: def, value: 42, onChange }));
      const input = screen.getByLabelText(
        'Default max turns',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      expect(onChange).toHaveBeenCalledWith(null);
      expect(onChange).not.toHaveBeenCalledWith(Number.NaN);
      expect(onChange).not.toHaveBeenCalledWith(0);
      expect(onChange).not.toHaveBeenCalledWith('');
    });

    test('number: typing a value calls onChange with a real Number, not a string', () => {
      const def = stringDef({
        key: 'defaultMaxTurns' as any,
        descriptor: { kind: 'number', min: 1, integer: true },
        label: 'Default max turns',
      });
      const onChange = vi.fn();
      render(renderSettingRow({ definition: def, value: undefined, onChange }));
      const input = screen.getByLabelText(
        'Default max turns',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '25' } });
      expect(onChange).toHaveBeenCalledWith(25);
      const [[calledWith]] = onChange.mock.calls;
      expect(typeof calledWith).toBe('number');
    });

    test('boolean: toggling calls onChange with the flipped value', () => {
      const def = stringDef({
        key: 'mcpUiHost' as any,
        descriptor: { kind: 'boolean' },
        label: 'MCP UI host',
      });
      const onChange = vi.fn();
      render(renderSettingRow({ definition: def, value: true, onChange }));
      fireEvent.click(screen.getByRole('switch', { name: 'MCP UI host' }));
      expect(onChange).toHaveBeenCalledWith(false);
    });

    test('enum: selecting an option calls onChange with the chosen value', () => {
      const def = stringDef({
        key: 'logLevel' as any,
        descriptor: { kind: 'enum', values: ['debug', 'info', 'warn'] },
        label: 'Log level',
      });
      const onChange = vi.fn();
      render(renderSettingRow({ definition: def, value: 'info', onChange }));
      fireEvent.change(screen.getByLabelText('Log level'), {
        target: { value: 'warn' },
      });
      expect(onChange).toHaveBeenCalledWith('warn');
    });

    test('a row whose value comes from the environment still forwards an edit', () => {
      // The user-visible consequence of archive#1557: storing a value is how you
      // take over from the environment fallback, so the edit must land.
      const provenance: SettingProvenanceEntry = {
        source: 'env',
        envVar: 'MY_ENV',
      };
      const onChange = vi.fn();
      render(
        renderSettingRow({
          definition: stringDef({ envFallback: 'MY_ENV' }),
          value: 'x',
          provenance,
          onChange,
        }),
      );
      const input = screen.getByLabelText('Terminal shell') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'y' } });
      expect(onChange).toHaveBeenCalledWith('y');
    });
  });
});
