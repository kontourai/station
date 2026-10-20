import type { ShortcutModifier } from '@kontourai/station-contracts/device-settings';

/**
 * Kernel shortcuts no plugin may bind or shadow: the command palette, Settings
 * and the shortcut list are how a user gets out of, and back in control of, a
 * misbehaving plugin. The call sites register these exact bindings, so the
 * default chord has one source. A plugin chord equal to a reserved default, or
 * to a reserved shortcut's current (possibly user-rebound) chord, is refused
 * at registration and skipped at dispatch. Data only, in its own module, so a
 * test that mocks the shortcut registry still renders these call sites.
 */
export const KERNEL_RESERVED_SHORTCUTS = {
  commandPalette: {
    id: 'command-palette',
    binding: { key: 'k', modifiers: ['cmd'] },
  },
  settings: { id: 'app.settings', binding: { key: ',', modifiers: ['cmd'] } },
  shortcuts: { id: 'app.shortcuts', binding: { key: '/', modifiers: ['cmd'] } },
} as const satisfies Record<
  string,
  {
    id: string;
    binding: { key: string; modifiers: readonly ShortcutModifier[] };
  }
>;
