import { useMemo } from 'react';
import { CRM_BASE_URL } from './constants';
import type { AccountVM } from './data/viewmodels';
import { isRecentlyVisited } from './utils';

interface AccountListProps {
  accounts: AccountVM[];
  selectedId: string | null;
  onSelect: (account: AccountVM) => void;
  loading?: boolean;
  displayLimit?: number;
  onShowMore?: () => void;
}

function AccountPills({ account }: { account: AccountVM }) {
  return (
    <span className="account-pills">
      {account.territory && (
        <span className="account-pill account-pill--territory">
          {account.territory}
        </span>
      )}
      {account.segment && (
        <span className="account-pill account-pill--segment">
          {account.segment}
        </span>
      )}
    </span>
  );
}

export function AccountList({
  accounts,
  selectedId,
  onSelect,
  loading = false,
  displayLimit = 25,
  onShowMore,
}: AccountListProps) {
  const { recent, rest } = useMemo(() => {
    const recent = accounts.filter((a) => isRecentlyVisited(a.id));
    const rest = accounts.filter((a) => !isRecentlyVisited(a.id));
    return { recent, rest };
  }, [accounts]);

  const visibleRest = rest.slice(0, Math.max(0, displayLimit - recent.length));
  const hasMore = rest.length > visibleRest.length;

  if (loading) {
    return <div className="account-list-loading">Loading accounts…</div>;
  }

  if (accounts.length === 0) {
    return <div className="account-list-empty">No accounts found</div>;
  }

  function renderRow(account: AccountVM, isRecent = false) {
    const isSelected = account.id === selectedId;
    return (
      <div
        key={account.id}
        className={`account-list-row ${isSelected ? 'account-list-row--selected' : ''} ${isRecent ? 'account-list-row--recent' : ''}`}
      >
        <button
          type="button"
          className="account-list-row-select"
          aria-label={`Select ${account.name}`}
          onClick={() => onSelect(account)}
        />
        <div className="account-list-row-main">
          <a
            className="account-list-name"
            href={`${CRM_BASE_URL}/lightning/r/Account/${account.id}/view`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {account.name}
          </a>
          <AccountPills account={account} />
        </div>
        {account.owner && (
          <div className="account-list-owner">{account.owner.name}</div>
        )}
      </div>
    );
  }

  return (
    <div className="account-list">
      {recent.length > 0 && (
        <div className="account-list-group">
          <div className="account-list-group-label">Recently visited</div>
          {recent.map((a) => renderRow(a, true))}
        </div>
      )}
      {visibleRest.length > 0 && (
        <div className="account-list-group">
          {recent.length > 0 && (
            <div className="account-list-group-label">All accounts</div>
          )}
          {visibleRest.map((a) => renderRow(a))}
        </div>
      )}
      {hasMore && onShowMore && (
        <button
          type="button"
          className="account-list-show-more"
          onClick={onShowMore}
        >
          Show more ({rest.length - visibleRest.length} remaining)
        </button>
      )}
    </div>
  );
}
