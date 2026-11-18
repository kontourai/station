import {
  type CustomAppearance,
  parseCustomAppearance,
} from '@kontourai/station-contracts/custom-appearance';

function rule(selector: string, properties: Record<string, string>): string {
  const declarations = Object.entries(properties).map(
    ([name, value]) => `${name}: ${value} !important`,
  );
  return `${selector} {${declarations.join(';')}}`;
}

/** Typed image controls never open a URL path in the free-form CSS sandbox. */
export function customAppearanceVisualCss(
  appearance: CustomAppearance,
): string {
  const parsed = parseCustomAppearance(appearance);
  if (!parsed.ok || !parsed.value.visual) return '';
  const visual = parsed.value.visual;
  const rules: string[] = [];
  const tokens: Record<string, string> = {};
  if (visual.radius !== undefined) {
    for (const token of [
      '--radius-md',
      '--radius-lg',
      '--radius-xl',
      '--k-radius-control',
      '--k-radius-panel',
    ])
      tokens[token] = `${visual.radius}px`;
    rules.push(
      rule('[data-slot="button"], [data-surface="composer"]', {
        'border-radius': `${visual.radius}px`,
      }),
    );
  }
  if (visual.fontSize !== undefined) {
    for (const token of ['--text-base', '--text-md', '--k-text-md'])
      tokens[token] = `${visual.fontSize}px`;
    rules.push(
      rule('[data-surface="transcript"]', {
        'font-size': `${visual.fontSize}px`,
      }),
    );
  }
  if (Object.keys(tokens).length) rules.push(rule(':root', tokens));
  const background = visual.background;
  if (background) {
    const overlay = `color-mix(in srgb, var(--k-bg) ${background.dim * 100}%, transparent)`;
    const image = [
      'linear-gradient(',
      overlay,
      ',',
      overlay,
      `), url("${background.dataUrl}")`,
    ].join('');
    const surfaces = [
      '.main-content',
      '[data-region] .chat-dock__content-area',
      '[data-region] [data-surface="transcript"]',
    ];
    rules.push(
      rule(surfaces.join(', '), {
        'background-image': image,
        'background-size':
          background.size === 'tile' ? 'auto' : background.size,
        'background-position': background.position,
        'background-repeat':
          background.size === 'tile' ? 'repeat' : 'no-repeat',
      }),
    );
  }
  if (visual.panelOpacity !== undefined) {
    const surfaces = [
      '[data-surface="sidebar"]',
      '[data-surface="composer"]',
      '[data-surface="chat-header"]',
      '[data-region]',
    ];
    rules.push(
      rule(surfaces.join(', '), {
        'background-color': `color-mix(in srgb, var(--k-panel) ${visual.panelOpacity * 100}%, transparent)`,
      }),
    );
  }
  return rules.join('\n');
}
