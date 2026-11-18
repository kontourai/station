import {
  type CustomAppearance,
  parseCustomAppearance,
} from '@kontourai/station-contracts/custom-appearance';

/** Validate before interpolating any values into the typed appearance sheet. */
export function customAppearanceVisualCss(
  appearance: CustomAppearance,
): string {
  const parsed = parseCustomAppearance(appearance);
  if (!parsed.ok || !parsed.value.visual) return '';
  const { radius, fontSize, background, panelOpacity } = parsed.value.visual;
  const rules: string[] = [];
  if (radius !== undefined) {
    const size = `${radius}px !important`;
    rules.push(
      `:root {
        --radius-md: ${size};
        --radius-lg: ${size};
        --radius-xl: ${size};
        --k-radius-control: ${size};
        --k-radius-panel: ${size};
      }`,
      `[data-slot="button"], [data-surface="composer"] { border-radius: ${size}; }
      `,
    );
  }
  if (fontSize !== undefined) {
    const size = `${fontSize}px !important`;
    rules.push(`
      :root { --text-base: ${size}; --text-md: ${size}; --k-text-md: ${size}; }
      [data-surface="transcript"] { font-size: ${size}; }
    `);
  }
  if (background) {
    const { size, position, dim, dataUrl } = background;
    const overlay = `color-mix(in srgb, var(--k-bg) ${dim * 100}%, transparent)`;
    rules.push(
      `.main-content, [data-region] .chat-dock__content-area,`,
      `[data-region] [data-surface="transcript"] {`,
      `background-image: linear-gradient(${overlay}, ${overlay}), url("${dataUrl}") !important;`,
      `background-size: ${size === 'tile' ? 'auto' : size} !important;`,
      `background-position: ${position} !important;`,
      `background-repeat: ${size === 'tile' ? 'repeat' : 'no-repeat'} !important;}`,
    );
  }
  if (panelOpacity !== undefined) {
    rules.push(
      `[data-surface="sidebar"], [data-surface="composer"], [data-surface="chat-header"], [data-region] {`,
      `background-color: color-mix(in srgb, var(--k-panel) ${panelOpacity * 100}%, transparent) !important;}`,
    );
  }
  return rules.join('');
}
