import type { SettingsSectionId } from './settings-catalog';

/**
 * Where a settings deep link lands, and the two query parameters that carry
 * WHICH control it lands on (#2144 slice 5).
 *
 * One definition, three consumers: the command palette's navigation, the
 * agent-facing registry artifact (`scripts/gen-settings-registry.ts`), and
 * `docs/reference/settings-deep-links.md`, which documents this exact shape
 * for agents. `SettingsView` reads `view`/`highlight` back off the URL; the
 * names here are that reader's names.
 *
 * Its own module rather than a member of `settings-catalog.ts` for two
 * reasons, both load-bearing. The palette imports the catalog LAZILY (it is
 * a large route-owned inventory and the entry bundle has a ceiling), so a
 * value import of the catalog from the palette would pull the whole thing
 * eagerly; this module is a constant and two functions. And the generator
 * runs under `tsx` from the `scripts/` TypeScript project, which has no
 * `jsx` or `vite/client` configuration — the catalog module transitively
 * reaches both, this one reaches neither. The `SettingsSectionId` import
 * above is type-only and erases.
 */
export const SETTINGS_DEEP_LINK_PATH = '/settings';

export interface SettingsDeepLinkTarget {
  readonly view: SettingsSectionId;
  readonly highlight: string;
}

export function settingsDeepLinkParams(
  target: SettingsDeepLinkTarget,
): Record<string, string> {
  return { view: target.view, highlight: target.highlight };
}

/** The same link as a string, for consumers that cannot call `navigate`. */
export function settingsDeepLinkUrl(target: SettingsDeepLinkTarget): string {
  return `${SETTINGS_DEEP_LINK_PATH}?${new URLSearchParams(
    settingsDeepLinkParams(target),
  ).toString()}`;
}
