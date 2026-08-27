/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { RegistryCatalogCard } from '../components/registry/RegistryCatalogItems';

const noopActions = {
  clearMessage: vi.fn(),
  select: vi.fn(),
  runAction: vi.fn(),
  runLayoutAction: vi.fn(),
  onUseLayout: vi.fn(),
};

describe('RegistryCatalogCard glyph (issue #691)', () => {
  test('renders the integration glyph — manifest icon precedence — on the integrations tab', () => {
    render(
      <RegistryCatalogCard
        tab="integrations"
        item={{
          id: 'survey-mcp',
          displayName: 'Survey Review Card',
          icon: '📋',
        }}
        installed={false}
        selected={false}
        layoutPending={false}
        actions={noopActions}
      />,
    );
    expect(screen.getByText('📋')).toBeTruthy();
  });

  test('falls back to deterministic initials on the integrations tab when no icon is declared', () => {
    render(
      <RegistryCatalogCard
        tab="integrations"
        item={{ id: 'docs', displayName: 'Docs Server' }}
        installed={false}
        selected={false}
        layoutPending={false}
        actions={noopActions}
      />,
    );
    expect(screen.getByText('DS')).toBeTruthy();
  });

  test('does not render the integration glyph on other registry tabs', () => {
    const { container } = render(
      <RegistryCatalogCard
        tab="agents"
        item={{ id: 'demo-agent', displayName: 'Demo Agent' }}
        installed={false}
        selected={false}
        layoutPending={false}
        actions={noopActions}
      />,
    );
    expect(container.querySelector('.page__card-icon')).toBeFalsy();
  });
});
