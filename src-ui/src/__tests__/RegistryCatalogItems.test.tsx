/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  RegistryCatalogCard,
  RegistryCatalogDetail,
} from '../components/registry/RegistryCatalogItems';

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

// Shaped as GET /registry/integrations returns curated entries; the server
// shape is pinned in registry-mcp-subregistry.routes.test.ts.
const linear = {
  id: 'app-linear--linear',
  displayName: 'Linear',
  description: 'Find and manage issues.',
  version: '1.0.2',
  source: 'https://mcp.linear.app/mcp',
  catalogSourceName: 'Station curated',
  installed: false,
  mcpServer: {
    name: 'app.linear/linear',
    version: '1.0.2',
    schema:
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    remote: {
      transport: 'streamable-http' as const,
      url: 'https://mcp.linear.app/mcp',
    },
    authMode: 'dcr' as const,
    qualification: {
      state: 'qualified' as const,
      summary: 'Endpoint and version match the official MCP Registry entry.',
      checkedAt: '2026-10-28T13:00:00Z',
    },
    unavailable: [],
  },
};
const gmail = {
  id: 'ai-kontour-station--gmail',
  displayName: 'Gmail',
  version: 'mcp-v1',
  catalogSourceName: 'Station curated',
  installed: false,
  mcpServer: {
    name: 'ai.kontour.station/gmail',
    version: 'mcp-v1',
    schema:
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    remote: {
      transport: 'streamable-http' as const,
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
    },
    authMode: 'pre-registered-required' as const,
    qualification: {
      state: 'blocked' as const,
      checkedAt: '2026-10-28T13:00:00Z',
    },
    launchStage: 'developer-preview' as const,
    contentTrust: 'untrusted' as const,
    unavailable: [
      'Sign-in needs an OAuth client you register with the provider. Station cannot use one yet.',
    ],
  },
};

describe('MCP subregistry entries (#3483)', () => {
  test('a qualified entry shows its sign-in mode and offers Add', () => {
    const runAction = vi.fn();
    render(
      <RegistryCatalogDetail
        tab="integrations"
        item={linear}
        id={linear.id}
        installed={false}
        pending={false}
        checkingInstalled={false}
        actions={{ ...noopActions, runAction }}
      />,
    );
    const facts = screen.getByTestId('registry-mcp-facts');
    expect(within(facts).getByText('Station qualified')).toBeTruthy();
    expect(within(facts).getByText('OAuth sign-in')).toBeTruthy();
    expect(within(facts).getByText('https://mcp.linear.app/mcp')).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(add);
    expect(runAction).toHaveBeenCalledWith(linear, linear.id, false);
  });

  test('a blocked entry lists every reason and cannot be added', () => {
    const runAction = vi.fn();
    render(
      <RegistryCatalogDetail
        tab="integrations"
        item={gmail}
        id={gmail.id}
        installed={false}
        pending={false}
        checkingInstalled={false}
        actions={{ ...noopActions, runAction }}
      />,
    );
    const reasons = screen.getByRole('list', {
      name: 'Why it cannot be added',
    });
    expect(
      within(reasons)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(gmail.mcpServer.unavailable);
    for (const label of [
      'Checked, not available yet',
      'OAuth with your own client',
      'Developer Preview',
      'Untrusted content',
    ])
      expect(screen.getByText(label)).toBeTruthy();
    // A default the person can change, never a prohibition.
    expect(
      screen.getByText(/Asks before tools that send or change things/),
    ).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Unavailable' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(runAction).not.toHaveBeenCalled();
  });

  test('the card carries the qualification badge', () => {
    render(
      <RegistryCatalogCard
        tab="integrations"
        item={gmail}
        installed={false}
        selected={false}
        layoutPending={false}
        actions={noopActions}
      />,
    );
    expect(screen.getByText('Checked, not available yet')).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });
});
