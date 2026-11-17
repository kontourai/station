import {
  type CustomAppearance,
  parseCustomAppearance,
} from '@kontourai/station-contracts/custom-appearance';

/** Typed image controls never open a URL path in the free-form CSS sandbox. */
export function customAppearanceVisualCss(
  appearance: CustomAppearance,
): string {
  const parsed = parseCustomAppearance(appearance);
  if (!parsed.ok || !parsed.value.visual) return '';
  const visual = parsed.value.visual;
  const rules: string[] = [];
  const tokens: string[] = [];
  if (visual.radius !== undefined) {
    for (const token of [
      '--radius-md',
      '--radius-lg',
      '--radius-xl',
      '--k-radius-control',
      '--k-radius-panel',
    ])
      tokens.push(`${token}: ${visual.radius}px !important`);
    rules.push(
      `[data-slot="button"], [data-surface="composer"] {border-radius: ${visual.radius}px !important}`,
    );
  }
  if (visual.fontSize !== undefined) {
    for (const token of ['--text-base', '--text-md', '--k-text-md'])
      tokens.push(`${token}: ${visual.fontSize}px !important`);
    rules.push(
      `[data-surface="transcript"] {font-size: ${visual.fontSize}px !important}`,
    );
  }
  if (tokens.length) rules.push(`:root {${tokens.join(';')}}`);
  const background = visual.background;
  if (background) {
    const dim = background.dim * 100;
    // All interpolated values were admitted above; data URLs contain only raster base64.
    rules[rules.length] = `.main-content {
      background-image: linear-gradient(
        color-mix(in srgb, var(--k-bg) ${dim}%, transparent),
        color-mix(in srgb, var(--k-bg) ${dim}%, transparent)
      ), url("${background.dataUrl}") !important;
      background-size: ${background.size === 'tile' ? 'auto' : background.size} !important;
      background-position: ${background.position} !important;
      background-repeat: ${background.size === 'tile' ? 'repeat' : 'no-repeat'} !important}`;
  }
  if (visual.panelOpacity !== undefined) {
    const opacity = visual.panelOpacity * 100;
    rules[rules.length] = `[data-surface="sidebar"], [data-surface="composer"],
      [data-surface="chat-header"], [data-region] {
      background-color: color-mix(in srgb, var(--k-panel) ${opacity}%, transparent) !important}`;
  }
  return rules.join('\n');
}
