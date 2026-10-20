// @vitest-environment jsdom
/**
 * The public SDK host services through Station's real adapter: a plugin-style
 * consumer imports ONLY `@kontourai/station-sdk`, and everything it reaches
 * (the shortcut registry, the dialogs, the clipboard, the external opener, the
 * device facts) is the shell's own implementation, not a test double.
 */
import {
  type SDKShortcut,
  type SDKShortcutRegistration,
  useHost,
  useHostFacts,
  useShortcut,
  useShortcutScope,
} from '@kontourai/station-sdk';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const inputs = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useProjectLayoutsQuery: () => ({ data: [] }),
  useProjectLayoutQuery: () => ({ data: undefined }),
  useConversationsQuery: () => ({ data: [] }),
}));
vi.mock('../../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.test' }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({}),
}));
vi.mock('../../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
  useCreateChatSession: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
  useLaunchChat: () => vi.fn(),
}));
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => inputs.isMobile,
}));

import {
  KeyboardShortcutsProvider,
  useKeyboardShortcuts,
  useShortcutRegistry,
} from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { ToastProvider, toastStore } from '../../contexts/ToastContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { SDKAdapter } from '../SDKAdapter';

const isMac = navigator.platform.toUpperCase().includes('MAC');
/** The keydown the dispatcher reads as `cmd+<key>` on this platform. */
function pressPrimary(key: string, target: Window | Element = window) {
  fireEvent.keyDown(target, { key, metaKey: isMac, ctrlKey: !isMac });
}

let registry: ReturnType<typeof useShortcutRegistry> | null = null;
let actions: ReturnType<typeof useKeyboardShortcuts> | null = null;
function RegistryProbe() {
  registry = useShortcutRegistry();
  actions = useKeyboardShortcuts();
  return null;
}

function Shell({
  children,
  pluginName = 'acme-tools',
}: {
  children: ReactNode;
  pluginName?: string;
}) {
  return (
    <ToastProvider>
      <NavigationProvider>
        <KeyboardShortcutsProvider>
          <RegistryProbe />
          <SDKAdapter
            layout={{ slug: 'acme', name: 'Acme', tabs: [] }}
            boundPluginName={pluginName}
          >
            {children}
          </SDKAdapter>
        </KeyboardShortcutsProvider>
      </NavigationProvider>
    </ToastProvider>
  );
}

const results: Record<string, SDKShortcutRegistration> = {};
function PluginShortcut(props: SDKShortcut) {
  results[props.id] = useShortcut(props);
  return null;
}

function registryIds() {
  return registry?.getAllShortcuts().map((shortcut) => shortcut.id) ?? [];
}

beforeEach(() => {
  registry = null;
  actions = null;
  for (const key of Object.keys(results)) delete results[key];
  inputs.isMobile = false;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const toast of toastStore.getSnapshot()) toastStore.dismiss(toast.id);
});

describe('useShortcut through the real adapter and registry', () => {
  test('a plugin shortcut fires, is listed in the host registry, and is suppressed under a modal', () => {
    const run = vi.fn();
    render(
      <Shell>
        <PluginShortcut
          id="openPicker"
          keys={{ key: 'j', modifiers: ['cmd', 'shift'] }}
          description="Open the Acme picker"
          run={run}
        />
      </Shell>,
    );

    expect(results.openPicker).toEqual({
      ok: true,
      registryId: 'plugin.acme-tools.openPicker',
    });
    const listed = registry
      ?.getAllShortcuts()
      .find((shortcut) => shortcut.id === 'plugin.acme-tools.openPicker');
    expect(listed).toMatchObject({
      key: 'j',
      modifiers: ['cmd', 'shift'],
      description: 'Open the Acme picker',
      priority: 0,
    });
    expect(registry?.getDisplay('plugin.acme-tools.openPicker')).not.toBe('');

    fireEvent.keyDown(window, {
      key: 'j',
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });
    expect(run).toHaveBeenCalledTimes(1);

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    fireEvent.keyDown(window, {
      key: 'j',
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });
    modal.remove();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('unmounting the plugin removes its shortcut from the registry', () => {
    const view = render(
      <Shell>
        <PluginShortcut
          id="gone"
          keys={{ key: 'g', modifiers: ['alt'] }}
          description="Temporary"
          run={() => {}}
        />
      </Shell>,
    );
    expect(registryIds()).toContain('plugin.acme-tools.gone');
    view.rerender(<Shell>{null}</Shell>);
    expect(registryIds()).not.toContain('plugin.acme-tools.gone');
  });

  test('a reserved kernel chord is refused, never registered, and never reaches the plugin', () => {
    const paletteRun = vi.fn();
    const run = vi.fn();
    function KernelPalette() {
      useKeyboardShortcut(
        'command-palette',
        'k',
        ['cmd'],
        'Palette',
        paletteRun,
      );
      return null;
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <Shell>
        <PluginShortcut
          id="hijack"
          keys={{ key: 'K', modifiers: ['cmd'] }}
          description="Steal the palette"
          run={run}
        />
        <KernelPalette />
      </Shell>,
    );

    expect(results.hijack).toMatchObject({ ok: false, reason: 'reserved' });
    expect(registryIds()).not.toContain('plugin.acme-tools.hijack');
    pressPrimary('k');
    expect(run).not.toHaveBeenCalled();
    expect(paletteRun).toHaveBeenCalledTimes(1);
  });

  test('off a Mac, ctrl+<reserved key> is the same chord and is refused too', async () => {
    const { effectiveChordSignature } = await import(
      '../../contexts/KeyboardShortcutsContext'
    );
    expect(
      effectiveChordSignature({ key: 'k', modifiers: ['ctrl'] }, false),
    ).toBe(effectiveChordSignature({ key: 'k', modifiers: ['cmd'] }, false));
    expect(
      effectiveChordSignature({ key: 'k', modifiers: ['ctrl'] }, true),
    ).not.toBe(effectiveChordSignature({ key: 'k', modifiers: ['cmd'] }, true));
  });

  test('a plugin chord the user later gives a reserved shortcut is skipped at dispatch', () => {
    const paletteRun = vi.fn();
    const run = vi.fn();
    function KernelPalette() {
      useKeyboardShortcut(
        'command-palette',
        'k',
        ['cmd'],
        'Palette',
        paletteRun,
      );
      return null;
    }
    render(
      <Shell>
        <PluginShortcut
          id="jump"
          keys={{ key: 'j', modifiers: ['cmd'] }}
          description="Jump"
          run={run}
        />
        <KernelPalette />
      </Shell>,
    );
    expect(results.jump?.ok).toBe(true);
    pressPrimary('j');
    expect(run).toHaveBeenCalledTimes(1);

    act(() => {
      actions?.setBinding('command-palette', { key: 'j', modifiers: ['cmd'] });
    });
    pressPrimary('j');
    expect(run).toHaveBeenCalledTimes(1);
    expect(paletteRun).toHaveBeenCalledTimes(1);
  });

  test('a plugin cannot reach a kernel id: dotted ids are refused and every id is namespaced', () => {
    const settingsRun = vi.fn();
    function KernelSettings() {
      useKeyboardShortcut(
        'app.settings',
        ',',
        ['cmd'],
        'Settings',
        settingsRun,
      );
      return null;
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <Shell pluginName="app">
        <KernelSettings />
        <PluginShortcut
          id="app.settings"
          keys={{ key: 'p', modifiers: ['cmd', 'alt'] }}
          description="Impersonate"
          run={() => {}}
        />
        <PluginShortcut
          id="settings"
          keys={{ key: 'p', modifiers: ['cmd', 'shift'] }}
          description="Lookalike"
          run={() => {}}
        />
      </Shell>,
    );
    expect(results['app.settings']).toMatchObject({
      ok: false,
      reason: 'invalid-id',
    });
    expect(results.settings).toEqual({
      ok: true,
      registryId: 'plugin.app.settings',
    });
    const settings = registry
      ?.getAllShortcuts()
      .find((shortcut) => shortcut.id === 'app.settings');
    expect(settings).toMatchObject({ key: ',', description: 'Settings' });
  });

  test('a modifier-less plugin key does not swallow typing in a field', () => {
    const run = vi.fn();
    render(
      <Shell>
        <PluginShortcut
          id="next"
          keys={{ key: 'n', modifiers: [] }}
          description="Next"
          run={run}
        />
        <textarea aria-label="composer" />
      </Shell>,
    );
    fireEvent.keyDown(screen.getByLabelText('composer'), { key: 'n' });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('useShortcutScope gates a shortcut whose `when` names the scope', () => {
    const run = vi.fn();
    function Scoped({ active }: { active: boolean }) {
      useShortcutScope('editor', active);
      results.scoped = useShortcut({
        id: 'save',
        keys: { key: 's', modifiers: ['cmd', 'alt'] },
        description: 'Save',
        when: 'editor',
        run,
      });
      return null;
    }
    const press = () =>
      fireEvent.keyDown(window, {
        key: 's',
        altKey: true,
        metaKey: isMac,
        ctrlKey: !isMac,
      });
    const view = render(
      <Shell>
        <Scoped active={false} />
      </Shell>,
    );
    press();
    expect(run).not.toHaveBeenCalled();
    view.rerender(
      <Shell>
        <Scoped active />
      </Shell>,
    );
    press();
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      registry
        ?.getAllShortcuts()
        .find((shortcut) => shortcut.id === 'plugin.acme-tools.save')?.when,
    ).toBe('scope:acme-tools/editor');
  });
});

describe('useHost through the real adapter', () => {
  let host: ReturnType<typeof useHost> | null = null;
  function HostProbe() {
    host = useHost();
    return null;
  }
  beforeEach(() => {
    host = null;
  });

  test('clipboard.writeText resolves true only for a write that happened', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <Shell>
        <HostProbe />
      </Shell>,
    );
    await expect(host!.clipboard.writeText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    writeText.mockRejectedValueOnce(new Error('denied'));
    await expect(host!.clipboard.writeText('again')).resolves.toBe(false);
  });

  test('openExternal opens http(s) and refuses any other scheme visibly', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <Shell>
        <HostProbe />
      </Shell>,
    );
    await expect(host!.openExternal('javascript:alert(1)')).resolves.toBe(
      false,
    );
    await expect(host!.openExternal('file:///etc/passwd')).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(
      toastStore
        .getSnapshot()
        .some((toast) => toast.message.includes('http or https')),
    ).toBe(true);

    await expect(host!.openExternal('https://example.com/pr/1')).resolves.toBe(
      true,
    );
    expect(open).toHaveBeenCalledWith(
      'https://example.com/pr/1',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('prompt renders the shell dialog and resolves the entered text', async () => {
    render(
      <Shell>
        <HostProbe />
      </Shell>,
    );
    let answer!: Promise<string | null>;
    act(() => {
      answer = host!.prompt({
        title: 'Rename file',
        label: 'New name',
        initial: 'notes.md',
      });
    });
    await screen.findByRole('dialog', { name: 'Rename file' });
    // Modal chrome: the registry's modal guard keys on this attribute.
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
    const input = screen.getByLabelText('New name') as HTMLInputElement;
    expect(input.value).toBe('notes.md');
    fireEvent.change(input, { target: { value: '  todo.md  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(answer).resolves.toBe('todo.md');
    expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull();
  });

  test('prompt resolves null on cancel, on supersession and on unmount', async () => {
    const view = render(
      <Shell>
        <HostProbe />
      </Shell>,
    );
    let first!: Promise<string | null>;
    let second!: Promise<string | null>;
    act(() => {
      first = host!.prompt({ title: 'First' });
    });
    act(() => {
      second = host!.prompt({ title: 'Second' });
    });
    await expect(first).resolves.toBeNull();
    await screen.findByRole('dialog', { name: 'Second' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second).resolves.toBeNull();

    let third!: Promise<string | null>;
    act(() => {
      third = host!.prompt({ title: 'Third' });
    });
    view.unmount();
    await expect(third).resolves.toBeNull();
  });

  test('confirm renders the shell confirm dialog and resolves the decision', async () => {
    render(
      <Shell>
        <HostProbe />
      </Shell>,
    );
    let decision!: Promise<string>;
    act(() => {
      decision = host!.confirm({ title: 'Delete branch?', message: 'Gone.' });
    });
    await screen.findByText('Delete branch?');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(decision).resolves.toBe('confirmed');
  });
});

describe('useHostFacts through the real adapter', () => {
  test('returns the shell device facts and re-renders when they change', async () => {
    function FactsProbe() {
      const facts = useHostFacts();
      return (
        <output data-testid="facts">{String(facts.device.isMobile)}</output>
      );
    }
    const view = render(
      <Shell>
        <FactsProbe />
      </Shell>,
    );
    expect(screen.getByTestId('facts').textContent).toBe('false');
    inputs.isMobile = true;
    view.rerender(
      <Shell>
        <FactsProbe />
      </Shell>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('facts').textContent).toBe('true'),
    );
  });
});
