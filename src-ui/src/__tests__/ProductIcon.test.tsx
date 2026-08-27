/**
 * @vitest-environment jsdom
 */

import {
  ProductIcon,
  type ProductIconSlug,
  productIcons,
} from '@kontourai/ui/react';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

const ALL_PRODUCTS: ProductIconSlug[] = [
  'station',
  'surface',
  'flow',
  'veritas',
  'survey',
  'console',
  'flow-agents',
];

describe('ProductIcon (@kontourai/ui)', () => {
  test('exposes all seven suite product marks', () => {
    for (const product of ALL_PRODUCTS) {
      expect(productIcons[product]).toBeTruthy();
    }
  });

  test('renders a currentColor stroke svg with the 24x24 viewBox', () => {
    const { container } = render(<ProductIcon product="flow" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('fill')).toBe('none');
  });

  test('size prop drives width/height (default 24)', () => {
    const def = render(<ProductIcon product="veritas" />);
    const defSvg = def.container.querySelector('svg');
    expect(defSvg?.getAttribute('width')).toBe('24');
    expect(defSvg?.getAttribute('height')).toBe('24');

    const sized = render(<ProductIcon product="veritas" size={16} />);
    const sizedSvg = sized.container.querySelector('svg');
    expect(sizedSvg?.getAttribute('width')).toBe('16');
    expect(sizedSvg?.getAttribute('height')).toBe('16');
  });

  test('is decorative (aria-hidden) without a title, labelled with one', () => {
    const decorative = render(<ProductIcon product="surface" />);
    const decoSvg = decorative.container.querySelector('svg');
    expect(decoSvg?.getAttribute('aria-hidden')).toBe('true');
    expect(decoSvg?.getAttribute('role')).toBeNull();

    const labelled = render(<ProductIcon product="surface" title="Surface" />);
    const labSvg = labelled.container.querySelector('svg');
    expect(labSvg?.getAttribute('role')).toBe('img');
    expect(labSvg?.getAttribute('aria-label')).toBe('Surface');
    expect(labSvg?.querySelector('title')?.textContent).toBe('Surface');
  });

  test('passes className through', () => {
    const { container } = render(
      <ProductIcon product="console" className="my-mark" />,
    );
    expect(container.querySelector('svg.my-mark')).toBeTruthy();
  });
});
