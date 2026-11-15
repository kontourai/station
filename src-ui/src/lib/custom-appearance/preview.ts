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
  startCustomAppearancePreview,
} from './controller';
import { KEEP_BAR_TAG, type KeepBar, mountKeepBar } from './keep-bar';

let current: { bar: KeepBar; end: () => void } | null = null;

function computedHex(style: CSSStyleDeclaration, property: string) {
  const value = style.getPropertyValue(property).trim().toLowerCase();
  return isAppearanceHex(value) ? value : undefined;
}

export function measureCustomAppearance(
  proposalId: string,
  stripped: CustomAppearanceRenderReport['stripped'],
): Omit<CustomAppearanceRenderReport, 'reportedAt'> {
  const root = document.documentElement;
  const mode: AppearanceMode =
    root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const style = getComputedStyle(root);
  const values: Record<string, string | undefined> = {};
  for (const role of APPEARANCE_ROLE_PROPERTIES)
    values[role] = computedHex(style, role);
  values.accent = computedHex(style, '--k-action');
  values['accent-contrast'] = computedHex(style, '--k-action-contrast');
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
    contrast: rateAppearancePalette(mode, values, contrastRatio),
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
  const applied = startCustomAppearancePreview(appearance);
  const end = () => {
    current = null;
    endCustomAppearancePreview();
  };
  const bar = mountKeepBar({
    name: appearance.name,
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
  const proposalId = options.proposalId;
  if (proposalId && options.onReport) {
    const report = options.onReport;
    // After the sheets apply and layout settles.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (current?.bar === bar)
          report(measureCustomAppearance(proposalId, applied.stripped));
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
