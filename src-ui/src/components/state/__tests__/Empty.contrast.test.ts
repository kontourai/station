import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const UI_PACKAGE = resolve(process.cwd(), 'node_modules/@kontourai/ui');
const TOKENS = readFileSync(resolve(UI_PACKAGE, 'tokens/tokens.css'), 'utf8');
const STYLES = readFileSync(resolve(UI_PACKAGE, 'react/styles.css'), 'utf8');

type Rgb = readonly [number, number, number];

function declarations(block: string) {
  return Object.fromEntries(
    [...block.matchAll(/(--k-[\w-]+):\s*(#[\da-fA-F]{6})/g)].map(
      ([, key, value]) => [key, value.toLowerCase()],
    ),
  );
}

function tokenSet(theme: 'dark' | 'light') {
  const selector = theme === 'dark' ? ':root' : '[data-theme="light"]';
  const match = new RegExp(
    `${selector.replace(/[[]]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(TOKENS);
  expect(match, `${selector} token block must exist`).not.toBeNull();
  return declarations(match![1]);
}

function rgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = rgb(hex).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [a, b] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (a + 0.05) / (b + 0.05);
}

describe('shared Empty primitive contrast', () => {
  test('uses the Kit text tokens and both normal-text roles clear AA on the resolved surface in each theme', () => {
    // Empty is re-exported by Station but its CSS is intentionally supplied by
    // @kontourai/ui. Read the package files, rather than restating their
    // colours here, so a Kit token downgrade reddens this test with its actual
    // WCAG ratio before it reaches every Empty consumer.
    expect(STYLES).toMatch(
      /\.empty__label\s*\{[\s\S]*?color:\s*var\(--k-text\)/,
    );
    expect(STYLES).toMatch(
      /\.empty__description\s*\{[\s\S]*?color:\s*var\(--k-text-muted\)/,
    );

    for (const theme of ['dark', 'light'] as const) {
      const tokens = tokenSet(theme);
      for (const [role, token] of [
        ['label', '--k-text'],
        ['description', '--k-text-muted'],
      ] as const) {
        const ratio = contrast(tokens[token], tokens['--k-bg']);
        expect(
          ratio,
          `${theme} Empty ${role} contrast is ${ratio.toFixed(2)}:1 on --k-bg`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
