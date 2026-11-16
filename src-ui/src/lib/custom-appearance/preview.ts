/**
 * One preview at a time: apply the appearance in this tab, show the keep bar,
 * and report what rendered (docs/decisions/custom-appearance.md).
 *
 * The render report is what the agent gets back instead of seeing the page:
 * how many elements each hook selector matched, the contrast of the computed
 * roles in the mode on screen, and what the CSS guard removed.
 */
import {
  APPEARANCE_HOOKS,
  APPEARANCE_ROLE_PROPERTIES,
  type AppearanceMode,
  CUSTOM_APPEARANCE_PREVIEW_SECONDS,
  type CustomAppearance,
  type CustomAppearanceRenderReport,
  isAppearanceHex,
  rateAppearancePalette,
} from '@kontourai/station-contracts/custom-appearance';
import { contrastRatio } from '@kontourai/ui/contrast';
import {
  endCustomAppearancePreview,
  getCustomAppearanceSnapshot,
  startCustomAppearancePreview,
  withoutCustomCss,
} from './controller';
import { KEEP_BAR_TAG, type KeepBar, mountKeepBar } from './keep-bar';

let current: { bar: KeepBar; end: () => void } | null = null;

function computedHex(style: CSSStyleDeclaration, property: string) {
  const value = style.getPropertyValue(property).trim().toLowerCase();
  return isAppearanceHex(value) ? value : undefined;
}

type RoleValues = Record<string, string | undefined>;

/**
 * The computed roles on the root, keyed as the contrast rules name them, with
 * the custom CSS out of the cascade: the palette over the theme. Rating what
 * the CSS computes would let CSS that sets a role only when the page holds
 * some text (`:root:has([href^="…"])`) read that text back through the
 * report.
 */
function computedRoles(): RoleValues {
  return withoutCustomCss(() => {
    const style = getComputedStyle(document.documentElement);
    const values: RoleValues = {};
    for (const role of APPEARANCE_ROLE_PROPERTIES)
      values[role] = computedHex(style, role);
    values.accent = computedHex(style, '--k-action');
    values['accent-contrast'] = computedHex(style, '--k-action-contrast');
    return values;
  });
}

/**
 * The roles in both modes. The other mode is read by switching `data-theme`
 * and back inside one synchronous task, so nothing paints in between (a
 * root-theme observer sees two attribute records and re-reads an unchanged
 * value). A palette must not be keepable for one mode and unreadable in the
 * mode the person switches to later.
 */
function rolesByMode(): Record<AppearanceMode, RoleValues> {
  const root = document.documentElement;
  const shown = root.getAttribute('data-theme');
  const read = (mode: AppearanceMode) => {
    if (root.getAttribute('data-theme') !== mode)
      root.setAttribute('data-theme', mode);
    return computedRoles();
  };
  try {
    return { dark: read('dark'), light: read('light') };
  } finally {
    if (shown === null) root.removeAttribute('data-theme');
    else if (root.getAttribute('data-theme') !== shown)
      root.setAttribute('data-theme', shown);
  }
}

/** The changed pairs that fail in either mode, rated on the palette over the theme. */
function failingChanges(before: Record<AppearanceMode, RoleValues>) {
  const after = rolesByMode();
  return (['dark', 'light'] as const).flatMap((mode) => {
    const values = after[mode];
    const changed = (key: string) => values[key] !== before[mode][key];
    return rateAppearancePalette(mode, values, contrastRatio).filter(
      (r) => !r.pass && (changed(r.foreground) || changed(r.surface)),
    );
  });
}

/**
 * `before` is what was on screen before the preview. Only pairs the preview
 * changed are reported: a theme's own pair (Station's light status tones sit
 * just under 4.5:1 as text) is not the proposal's doing.
 */
export function measureCustomAppearance(
  proposalId: string,
  stripped: CustomAppearanceRenderReport['stripped'],
  before: RoleValues = {},
): Omit<CustomAppearanceRenderReport, 'reportedAt'> {
  const root = document.documentElement;
  const mode: AppearanceMode =
    root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const values = computedRoles();
  const changed = (key: string) => values[key] !== before[key];
  return {
    proposalId,
    mode,
    hooks: APPEARANCE_HOOKS.map((hook) => ({
      id: hook.id,
      selector: hook.selector,
      matched: Array.from(document.querySelectorAll(hook.selector)).filter(
        (element) => !element.closest(KEEP_BAR_TAG),
      ).length,
    })),
    contrast: rateAppearancePalette(mode, values, contrastRatio).filter(
      (result) => changed(result.foreground) || changed(result.surface),
    ),
    stripped: stripped.slice(0, 256),
  };
}

export interface PreviewOptions {
  fromAgent: boolean;
  /** Set for a proposal: the report names it. */
  proposalId?: string;
  seconds?: number;
  onKeep(): void;
  onDiscard(): void;
  onRevert?(): void;
  onReport?(report: Omit<CustomAppearanceRenderReport, 'reportedAt'>): void;
}

export function previewCustomAppearance(
  appearance: CustomAppearance,
  options: PreviewOptions,
): void {
  cancelCustomAppearancePreview();
  const before = computedRoles();
  const beforeByMode = rolesByMode();
  const applied = startCustomAppearancePreview(appearance);
  const end = () => {
    current = null;
    endCustomAppearancePreview();
  };
  let contrastFails = 0;
  const bar = mountKeepBar({
    name: appearance.name,
    blockedBy: () => {
      const snapshot = getCustomAppearanceSnapshot();
      if (snapshot.safe)
        return 'Custom appearance is off in this tab, so Keep is off.';
      if (snapshot.suspendedForDecision)
        return 'An approval is open, so this preview’s CSS is paused and Keep is off.';
      if (contrastFails > 0)
        return 'Some text in this preview is hard to read in light or dark mode, so Keep is off.';
      return null;
    },
    seconds: options.seconds ?? CUSTOM_APPEARANCE_PREVIEW_SECONDS,
    fromAgent: options.fromAgent,
    onKeep: () => {
      // The caller makes it active before the preview ends, so nothing flashes.
      current = null;
      options.onKeep();
      endCustomAppearancePreview();
    },
    onDiscard: () => {
      end();
      options.onDiscard();
    },
    onRevert: () => {
      end();
      options.onRevert?.();
    },
  });
  current = { bar, end };
  contrastFails = failingChanges(beforeByMode).length;
  const proposalId = options.proposalId;
  if (proposalId && options.onReport) {
    const report = options.onReport;
    // After the sheets apply and layout settles.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (current?.bar === bar)
          report(measureCustomAppearance(proposalId, applied.stripped, before));
      }),
    );
  }
}

export function cancelCustomAppearancePreview(): void {
  if (!current) return;
  const { bar, end } = current;
  bar.destroy();
  end();
}

/** The running preview's bar, or `null`. */
export function customAppearancePreviewBar(): KeepBar | null {
  return current?.bar ?? null;
}
