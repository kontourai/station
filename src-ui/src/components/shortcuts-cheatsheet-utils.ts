import type { KeyboardShortcut } from '../contexts/KeyboardShortcutsContext';

// Shortcut ids follow a "<group>.<action>" convention (e.g. `dock.toggle`,
// `app.settings`). The cheatsheet groups by that prefix, but the raw prefix
// ("app", "dock") makes for unfriendly section headers — this maps each known
// namespace to a human label. Unmapped ids fall back to "Other".
const CATEGORY_LABELS: Record<string, string> = {
  app: 'General',
  'command-palette': 'General',
  nav: 'Navigation',
  dock: 'Chat & dock',
  theme: 'Appearance',
};

// Friendly display order; categories not listed here sort alphabetically after
// these, so unknown namespaces still render deterministically (not by Map order).
const CATEGORY_ORDER = ['General', 'Navigation', 'Chat & dock', 'Appearance'];

export function categoryLabel(id: string): string {
  const prefix = id.includes('.') ? id.slice(0, id.indexOf('.')) : id;
  return CATEGORY_LABELS[prefix] ?? CATEGORY_LABELS[id] ?? 'Other';
}

export interface ShortcutGroup {
  label: string;
  items: KeyboardShortcut[];
}

// Groups shortcuts under friendly category labels in a stable order. Item order
// within a group is preserved (registration order), so the surface is
// deterministic regardless of registry iteration order.
export function groupShortcuts(shortcuts: KeyboardShortcut[]): ShortcutGroup[] {
  const byLabel = new Map<string, KeyboardShortcut[]>();
  for (const shortcut of shortcuts) {
    const label = categoryLabel(shortcut.id);
    const items = byLabel.get(label) ?? [];
    items.push(shortcut);
    byLabel.set(label, items);
  }

  return Array.from(byLabel.entries())
    .sort(([a], [b]) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(([label, items]) => ({ label, items }));
}
