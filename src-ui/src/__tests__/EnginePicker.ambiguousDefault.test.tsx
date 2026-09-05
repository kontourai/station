/**
 * @vitest-environment jsdom
 *
 * UX audit 2026-09-05, finding A7 (fresh-home walkthrough of main a5d026640).
 *
 * `resolveBuiltinAgentEngineBinding` returns null when MORE THAN ONE engine
 * could run the built-in assistant — the choice is the user's, so nothing is
 * preselected. On that screen the primary read "Use this engine", was
 * enabled, and a click saved `builtinAgentEngineConnectionId: null` while
 * showing "Saving…"; the first-run chapter then advanced as if an engine had
 * been chosen and the Station agent stayed unrunnable ("Needs: No enabled
 * LLM provider connection is configured"). No row in this picker means
 * "null", so a null selection is "nothing chosen" and must not be savable.
 *
 * These tests drive the rendered picker, not the resolver: the defect lived
 * in the button's enabled state, which the resolver tests cannot see.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { EnginePicker } from '../components/EnginePicker';

let statusData: any = { providers: { configuredChatReady: false } };
let connectionsData: any[] = [];
let configData: any;
const mutate = vi.fn();
const reconnectMutate = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({ data: statusData }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: connectionsData }),
  useConfigQuery: () => ({ data: configData }),
  useUpdateConfigMutation: () => ({ mutate, isPending: false }),
  useReconnectACPConnectionMutation: () => ({ mutateAsync: reconnectMutate }),
  useQueryClient: () => ({ invalidateQueries }),
}));

function nativeConnection(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id,
    kind: 'agent' as const,
    type: id,
    name,
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready' as const, detected: true, configured: true },
    ...overrides,
  };
}

function renderPicker() {
  const onChosen = vi.fn();
  render(<EnginePicker onChosen={onChosen} onDismiss={() => {}} />);
  return { onChosen };
}

describe('UX audit A7: two capable engines and no default', () => {
  beforeEach(() => {
    statusData = { providers: { configuredChatReady: false } };
    connectionsData = [
      nativeConnection('claude', 'Claude Code'),
      nativeConnection('codex', 'Codex'),
    ];
    configData = {};
    mutate.mockClear();
    reconnectMutate.mockReset();
    invalidateQueries.mockClear();
  });

  test('both engines are offered and neither is preselected — the resolver has no answer here', () => {
    renderPicker();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => !radio.checked)).toBe(true);
  });

  test('"Use this engine" is disabled until a row is chosen, and a click on it saves nothing', () => {
    const { onChosen } = renderPicker();
    const primary = screen.getByRole('button', {
      name: 'Use this engine',
    }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);

    fireEvent.click(primary);
    expect(mutate).not.toHaveBeenCalled();
    expect(onChosen).not.toHaveBeenCalled();
  });

  test('choosing a row enables the primary and the click saves THAT engine, never null', () => {
    const { onChosen } = renderPicker();
    fireEvent.click(screen.getByLabelText(/Codex/));

    const primary = screen.getByRole('button', {
      name: 'Use this engine',
    }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);

    fireEvent.click(primary);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      builtinAgentEngineConnectionId: 'codex',
    });
    // `onChosen` is the mutation's onSuccess; the mocked mutate never
    // resolves, so the chapter must NOT have advanced on the click alone.
    expect(onChosen).not.toHaveBeenCalled();
  });

  test('"Decide later" stays available while nothing is chosen — disabling the primary must not trap the user', () => {
    renderPicker();
    const later = screen.getByRole('button', {
      name: 'Decide later',
    }) as HTMLButtonElement;
    expect(later.disabled).toBe(false);
  });

  test('the picker is announced as a modal dialog named by its title', () => {
    renderPicker();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('engine-picker-title');
  });
});
