/**
 * A custom palette as CSS: one block per mode, keyed on the resolved
 * `data-theme`, every value `!important` so it applies on top of whatever
 * is in force (Station's tokens, a named color theme's sheet, white-label
 * branding and a device accent, which are inline but not important).
 *
 * Values are re-validated here (hex only, known roles): the input may come
 * from the pre-paint cache, which is device storage.
 */
import {
  APPEARANCE_MODES,
  APPEARANCE_ROLE_PROPERTIES,
  type CustomAppearance,
  isAppearanceHex,
} from '@kontourai/station-contracts/custom-appearance';
import { accentContrastColor, accentHoverFill } from '../accent-contrast';

export function customPaletteCss(palette: CustomAppearance['palette']): string {
  const blocks: string[] = [];
  for (const mode of APPEARANCE_MODES) {
    const entry = palette[mode];
    if (!entry) continue;
    const lines: string[] = [];
    for (const role of APPEARANCE_ROLE_PROPERTIES) {
      const value = entry.roles?.[role];
      if (isAppearanceHex(value)) lines.push(`${role}: ${value} !important;`);
    }
    const accent = entry.accent;
    if (isAppearanceHex(accent)) {
      const contrast = accentContrastColor(accent);
      const hover = accentHoverFill(accent);
      for (const property of [
        '--k-brand',
        '--k-action',
        '--k-focus',
        '--accent-primary',
      ])
        lines.push(`${property}: ${accent} !important;`);
      if (contrast)
        for (const property of [
          '--k-brand-contrast',
          '--k-action-contrast',
          '--text-on-accent',
        ])
          lines.push(`${property}: ${contrast} !important;`);
      if (hover) lines.push(`--accent-hover-fill: ${hover} !important;`);
    }
    if (lines.length > 0)
      blocks.push(`:root[data-theme="${mode}"] {\n  ${lines.join('\n  ')}\n}`);
  }
  return blocks.join('\n');
}
