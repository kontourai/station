import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrastRatio } from '../lib/accent-contrast';

const STATION_CSS = readFileSync(
  resolve(process.cwd(), 'src-ui/src/index.css'),
  'utf8',
);
const KIT_TOKENS = readFileSync(
  resolve(process.cwd(), 'node_modules/@kontourai/ui/tokens/tokens.css'),
  'utf8',
);

function hexValues(source: string, token: string): string[] {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`${escaped}:\\s*(#[0-9a-f]{6})`, 'gi'))]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

describe('positive status contrast (station#923)', () => {
  test('the old shared pair reproduces the channel-specific dark-theme failure', () => {
    const [darkPositive, lightPositive] = hexValues(KIT_TOKENS, '--k-positive');
    const [darkBrandForeground, lightBrandForeground] = hexValues(
      KIT_TOKENS,
      '--k-brand-contrast',
    );

    expect(contrastRatio(darkPositive!, darkBrandForeground!)!).toBeCloseTo(
      10.43,
      2,
    );
    expect(contrastRatio(darkPositive!, '#ffffff')!).toBeCloseTo(1.92, 2);
    expect(contrastRatio(lightPositive!, lightBrandForeground!)!).toBeCloseTo(
      4.81,
      2,
    );
  });

  test('the shared quiet-success pair clears AA in both themes', () => {
    const [darkBackground, lightBackground] = hexValues(
      STATION_CSS,
      '--success-bg',
    );
    const [darkForeground, lightForeground] = hexValues(
      STATION_CSS,
      '--success-text',
    );
    const toneRule = STATION_CSS.match(/\.tone-positive\s*{[^}]+}/)?.[0];

    expect(toneRule).toContain('background: var(--success-bg)');
    expect(toneRule).toContain('color: var(--success-text)');
    expect(contrastRatio(darkBackground!, darkForeground!)!).toBeCloseTo(
      8.84,
      2,
    );
    expect(contrastRatio(lightBackground!, lightForeground!)!).toBeCloseTo(
      5.01,
      2,
    );
    expect(
      contrastRatio(darkBackground!, darkForeground!)!,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(lightBackground!, lightForeground!)!,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
