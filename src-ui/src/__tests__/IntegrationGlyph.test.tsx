/**
 * @vitest-environment jsdom
 */

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AgentIcon } from '../components/icons/AgentIcon';
import { BrandIcon, resolveBrandKey } from '../components/icons/BrandIcon';
import { IntegrationGlyph } from '../components/icons/IntegrationGlyph';

describe('IntegrationGlyph (issue #691)', () => {
  test.each([
    ['Station', 'station'],
    ['Claude Code', 'claude'],
    ['Codex', 'codex'],
    ['Pi', 'pi'],
    ['Kiro', 'kiro'],
    ['OpenCode', 'opencode'],
    ['Muse Code', 'muse'],
    ['Cursor', 'cursor'],
    ['Goose', 'goose'],
    ['Qwen', 'qwen'],
  ])('uses the shared bundled %s mark for its exact EngineId', (name, key) => {
    const { container } = render(<BrandIcon name={name} engineId={key} />);
    expect(
      container
        .querySelector('[data-brand-key]')
        ?.getAttribute('data-brand-key'),
    ).toBe(key);
    expect(container.querySelector('svg, img')).not.toBeNull();
  });

  test.each([
    ['Muse Code', 'muse', '/provider-icons/muse.svg'],
    ['Cursor Agent', 'cursor', '/provider-icons/cursor.svg'],
    ['Goose', 'goose', '/provider-icons/goose.svg'],
    ['Qwen Code', 'qwen', '/provider-icons/qwen.svg'],
  ])('uses the reviewed static asset for %s', (name, engineId, source) => {
    const { container } = render(<BrandIcon name={name} engineId={engineId} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(source);
  });

  test.each([
    'API server',
    'Claude Code',
    'Anthropic Claude',
    'Pipelines',
    'Alpine',
    'Museum guide',
    'Recursive cursor state',
    'Gooseberry',
    'QWERTY',
  ])(
    'does not mistake incidental brand-like text in %s for an engine',
    (name) => {
      expect(resolveBrandKey(name)).toBeUndefined();
    },
  );

  test('supports an explicit local brand token without displaying it as text', () => {
    const { container } = render(
      <IntegrationGlyph
        id="custom-runtime"
        displayName="Custom runtime"
        icon="brand:kiro"
      />,
    );
    expect(container.querySelector('[data-brand-key="kiro"]')).not.toBeNull();
    expect(container.textContent).not.toContain('brand:kiro');
  });

  test('an explicit brand token takes precedence over discovered local artwork', () => {
    const { container } = render(
      <IntegrationGlyph
        id="custom-runtime"
        displayName="Custom runtime"
        icon="brand:kiro"
        iconUrl="/integrations/custom-runtime/icon"
      />,
    );
    expect(
      container.querySelector('[data-brand-key="kiro"] svg'),
    ).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  test('uses a same-origin integration asset and falls back if it fails to load', () => {
    const { container } = render(
      <IntegrationGlyph
        id="docs"
        displayName="Docs Server"
        iconUrl="/integrations/docs/icon"
      />,
    );
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/integrations/docs/icon');
    fireEvent.error(image!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('DS');
  });

  test('renders the manifest icon when present', () => {
    const { container } = render(
      <IntegrationGlyph
        id="survey-mcp"
        displayName="Survey Review Card"
        icon="📋"
      />,
    );
    expect(container.textContent).toBe('📋');
  });

  test('falls back to deterministic initials derived from displayName when no icon is declared', () => {
    const { container } = render(
      <IntegrationGlyph id="docs" displayName="Docs Server" />,
    );
    expect(container.textContent).toBe('DS');
  });

  test('falls back to id-derived initials when displayName is absent', () => {
    const { container } = render(<IntegrationGlyph id="survey-mcp" />);
    expect(container.textContent).toBe('SM');
  });

  test('renders the same initials on repeated renders for the same input (determinism)', () => {
    const first = render(<IntegrationGlyph id="database-server" />);
    const second = render(<IntegrationGlyph id="database-server" />);
    expect(first.container.textContent).toBe(second.container.textContent);
  });

  test.each([
    ['/a', 'a slash-rooted asset path'],
    ['https://evil.example/logo.png', 'an https URL'],
  ])(
    'never hot-links %s (%s) as an <img> — falls back to initials (review-flagged, issue #691)',
    (icon) => {
      const { container } = render(
        <IntegrationGlyph id="docs" displayName="Docs Server" icon={icon} />,
      );
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe('DS');
    },
  );

  test('a numeric icon from a malformed disk manifest does not crash and falls back to initials', () => {
    const { container } = render(
      <IntegrationGlyph
        id="docs"
        displayName="Docs Server"
        icon={123 as unknown as string}
      />,
    );
    expect(container.textContent).toBe('DS');
  });

  test('an object icon from a malformed disk manifest does not crash and falls back to initials', () => {
    const { container } = render(
      <IntegrationGlyph
        id="docs"
        displayName="Docs Server"
        icon={{ evil: true } as unknown as string}
      />,
    );
    expect(container.textContent).toBe('DS');
  });

  test('preserves an existing local agent image without permitting a remote hotlink', () => {
    const local = render(
      <AgentIcon
        agent={{
          name: 'Local agent',
          icon: 'data:image/png;base64,iVBORw0KGgo=',
        }}
      />,
    );
    expect(local.container.querySelector('img')?.getAttribute('src')).toContain(
      'data:image/png;base64,',
    );

    const remote = render(
      <AgentIcon
        agent={{
          name: 'Remote agent',
          icon: 'https://tracking.example/icon.png',
        }}
      />,
    );
    expect(remote.container.querySelector('img')).toBeNull();
    expect(remote.container.textContent).toBe('RA');
  });

  test('rejects browser-normalized backslash hotlinks', () => {
    const { container } = render(
      <AgentIcon
        agent={{
          name: 'Unsafe local-looking agent',
          icon: '/\\tracking.example/icon.png',
        }}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('UL');
  });

  test('retries when a failed image source changes on rerender', () => {
    const { container, rerender } = render(
      <IntegrationGlyph
        id="first"
        displayName="First"
        iconUrl="/integrations/first/icon"
      />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(
      <IntegrationGlyph
        id="second"
        displayName="Second"
        iconUrl="/integrations/second/icon"
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/integrations/second/icon',
    );
  });
});
