/**
 * @vitest-environment jsdom
 *
 * The Calendar's CRM search (#2402): it reads the workspace's configured CRM
 * provider rather than the statically imported default, and routes each
 * result by its own kind, since the person can switch between accounts and
 * opportunities after the modal opens. There is no campaign search: no CRM
 * provider serves campaigns.
 */
import { _setProviderFunctions } from '@kontourai/station-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CrmSearchModal } from '../components/CrmSearchModal';
import { crmProvider } from '../data/providers/crm';

const configuredCrm = {
  searchAccounts: vi.fn(async () => [
    { id: 'acct-1', name: 'Acme Corp', website: 'acme.test' },
  ]),
  searchOpportunities: vi.fn(async () => [
    { id: 'opp-1', name: 'Acme Renewal' },
  ]),
};

beforeEach(() => {
  _setProviderFunctions({
    getProvider: <T,>(layout: string, type: string) => {
      if (layout === 'enterprise' && type === 'crm')
        return configuredCrm as unknown as T;
      throw new Error(`No provider configured for ${layout}/${type}`);
    },
    hasProvider: () => true,
    getActiveProviderId: () => 'configured/crm',
    registerProvider: () => {},
    configureProvider: () => {},
  });
});

afterEach(() => vi.clearAllMocks());

function renderSearch() {
  const onSelectAccount = vi.fn();
  const onSelectOpportunity = vi.fn();
  render(
    <CrmSearchModal
      isOpen
      onClose={vi.fn()}
      onSelectAccount={onSelectAccount}
      onSelectOpportunity={onSelectOpportunity}
    />,
  );
  return { onSelectAccount, onSelectOpportunity };
}

async function searchAndPick(query: string, resultName: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: query } });
  fireEvent.click(
    await screen.findByRole(
      'button',
      { name: new RegExp(resultName) },
      {
        timeout: 2000,
      },
    ),
  );
}

describe('Calendar CRM search', () => {
  test('searches accounts through the configured CRM provider, not the static default', async () => {
    const staticSearch = vi.spyOn(crmProvider, 'searchAccounts');
    const { onSelectAccount, onSelectOpportunity } = renderSearch();

    await searchAndPick('acme', 'Acme Corp');

    expect(configuredCrm.searchAccounts).toHaveBeenCalledWith({
      field: 'name',
      operator: 'CONTAINS',
      value: 'acme',
    });
    expect(staticSearch).not.toHaveBeenCalled();
    expect(onSelectAccount).toHaveBeenCalledExactlyOnceWith({
      id: 'acct-1',
      name: 'Acme Corp',
      website: 'acme.test',
      kind: 'account',
    });
    expect(onSelectOpportunity).not.toHaveBeenCalled();
  });

  test('routes an opportunity picked after switching type as an opportunity', async () => {
    const { onSelectAccount, onSelectOpportunity } = renderSearch();

    fireEvent.click(screen.getByRole('button', { name: 'Opportunities' }));
    await searchAndPick('renewal', 'Acme Renewal');

    expect(configuredCrm.searchOpportunities).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'renewal' }),
    );
    expect(onSelectOpportunity).toHaveBeenCalledExactlyOnceWith({
      id: 'opp-1',
      name: 'Acme Renewal',
      kind: 'opportunity',
    });
    expect(onSelectAccount).not.toHaveBeenCalled();
  });

  test('offers no campaign search', () => {
    renderSearch();
    expect(screen.queryByRole('button', { name: 'Campaigns' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Accounts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Opportunities' })).toBeTruthy();
  });
});
