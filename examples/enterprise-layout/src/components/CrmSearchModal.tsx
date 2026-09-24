/**
 * The Calendar's CRM search (#2402).
 *
 * It searches through the workspace's configured CRM provider,
 * `provider('crm')`, like every other CRM read, rather than the statically
 * imported default. Each result carries its own kind, and a selection is
 * routed by that kind: the person can switch between accounts and
 * opportunities after the modal opens.
 */
import { provider } from '../data';
import type { SearchCondition } from '../data/providers';
import { SearchModal, type SearchResult, type SearchType } from './SearchModal';

/** Searches the configured CRM provider for accounts or opportunities by name. */
export async function searchCrm(
  query: string,
  kind: SearchType,
): Promise<SearchResult[]> {
  const crm = provider('crm');
  const condition: SearchCondition = {
    field: 'name',
    operator: 'CONTAINS',
    value: query,
  };
  if (kind === 'account') {
    const accounts = await crm.searchAccounts(condition);
    return accounts.map((account) => ({
      id: account.id,
      name: account.name,
      website: account.website,
      kind: 'account',
    }));
  }
  const opportunities = await crm.searchOpportunities(condition);
  return opportunities.map((opportunity) => ({
    id: opportunity.id,
    name: opportunity.name,
    kind: 'opportunity',
  }));
}

export interface CrmSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAccount: (account: SearchResult) => void;
  onSelectOpportunity: (opportunity: SearchResult) => void;
}

export function CrmSearchModal({
  isOpen,
  onClose,
  onSelectAccount,
  onSelectOpportunity,
}: CrmSearchModalProps) {
  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      type="account"
      onSearch={searchCrm}
      onSelect={(item) =>
        item.kind === 'account'
          ? onSelectAccount(item)
          : onSelectOpportunity(item)
      }
    />
  );
}
