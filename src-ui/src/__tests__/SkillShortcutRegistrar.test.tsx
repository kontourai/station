/** @vitest-environment jsdom */

import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SkillShortcutRegistrar } from '../components/SkillShortcutRegistrar';
import {
  KeyboardShortcutsProvider,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';

const mocks = vi.hoisted(() => ({ skills: [] as any[], toast: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({ data: mocks.skills }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.toast }),
}));

let registered: ReturnType<
  ReturnType<typeof useShortcutRegistry>['getAllShortcuts']
>;
function Probe() {
  registered = useShortcutRegistry().getAllShortcuts();
  return null;
}

function Harness({ hasContext, onRun }: { hasContext: boolean; onRun: any }) {
  return (
    <KeyboardShortcutsProvider>
      <SkillShortcutRegistrar hasContext={hasContext} onRun={onRun} />
      <Probe />
    </KeyboardShortcutsProvider>
  );
}

describe('SkillShortcutRegistrar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
    mocks.skills = [];
    mocks.toast.mockReset();
  });

  // Only command skills are bindable: a chord that "runs" a skill with no
  // command word would have nothing to type into the composer.
  test('registers and deregisters as the command-skill list changes', () => {
    const onRun = vi.fn();
    mocks.skills = [
      { name: 'first-book', command: { enabled: true, global: true } },
    ];
    const view = render(<Harness hasContext onRun={onRun} />);
    expect(registered.map((item) => item.id)).toEqual(['skill.first-book.run']);

    mocks.skills = [
      { name: 'second-book', command: { enabled: true, global: true } },
    ];
    view.rerender(<Harness hasContext onRun={onRun} />);
    expect(registered.map((item) => item.id)).toEqual([
      'skill.second-book.run',
    ]);
  });

  test('does not bind a skill that is not a command', () => {
    mocks.skills = [
      { name: 'plain-skill' },
      { name: 'first-book', command: { enabled: true } },
    ];
    render(<Harness hasContext onRun={vi.fn()} />);
    expect(registered.map((item) => item.id)).toEqual(['skill.first-book.run']);
  });

  // The chord is stored under the skill's NAME slug, but it types the skill's
  // declared command WORD — renaming the word must not drop the chord.
  test('runs the declared command word through the supplied seam', () => {
    const onRun = vi.fn();
    mocks.skills = [
      {
        name: 'first-book',
        command: { enabled: true, name: 'ship', global: true },
      },
    ];
    const view = render(<Harness hasContext onRun={onRun} />);
    expect(registered.map((item) => item.id)).toEqual(['skill.first-book.run']);
    act(() => registered[0].handler());
    expect(onRun).toHaveBeenCalledWith({ cmd: '/ship', name: 'first-book' });

    view.rerender(<Harness hasContext={false} onRun={onRun} />);
    act(() => registered[0].handler());
    expect(mocks.toast).toHaveBeenCalledWith(
      'Open a chat before running a shortcut.',
      'warning',
    );
  });

  // The registrar registers an unbound base; the chord the user stored for the
  // skill is applied by the provider's override, keyed by the skill's slug.
  test('registers the chord stored for the skill in device settings', () => {
    deviceSettingsStore.set('skillShortcuts', {
      'first-book': { key: 'p', modifiers: ['cmd'] },
    });
    mocks.skills = [
      { name: 'first-book', command: { enabled: true, global: true } },
    ];
    render(<Harness hasContext onRun={vi.fn()} />);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      id: 'skill.first-book.run',
      key: 'p',
      modifiers: ['cmd'],
      disabled: false,
    });
  });
});
