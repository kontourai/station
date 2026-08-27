import { useNavigation, useSendToChat } from '@kontourai/station-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountDetail } from './AccountDetail';
import { AccountList } from './AccountList';
import { AGENT_SLUG } from './constants';
import {
  sortByAccessFrequency,
  useMyAccounts,
  useMyTerritories,
  useSearchAccounts,
  useTerritoryAccounts,
} from './data';
import type { AccountVM } from './data/viewmodels';
import { FilterBar } from './FilterBar';
import { useCRMDetailPanel } from './hooks/useCRMDetailPanel';
import {
  CreateOpportunityModal,
  CreateTaskModal,
  LogActivityModal,
} from './OpportunityModal';
import { useCRMFilters } from './useCRMFilters';
import { recordAccountAccess } from './utils';

type SidebarMode = 'my' | 'search';

export function CRM() {
  const _nav = useNavigation();
  const { sendToChat } = useSendToChat(AGENT_SLUG);

  // Sidebar mode: my accounts vs search
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('my');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sidebarMode === 'search') searchInputRef.current?.focus();
  }, [sidebarMode]);
  const [selectedTerritoryId, setSelectedTerritoryId] = useState<string | null>(
    null,
  );

  // Selected account
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null,
  );

  // Modal state
  const [showCreateOpp, setShowCreateOpp] = useState(false);
  const [showLogActivity, setShowLogActivity] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);

  // Data
  const myAccounts = useMyAccounts();
  const territories = useMyTerritories();
  const searchResults = useSearchAccounts(
    sidebarMode === 'search' ? searchQuery : '',
  );
  const territoryAccounts = useTerritoryAccounts(selectedTerritoryId);

  // Detail panel
  const detail = useCRMDetailPanel(selectedAccountId);

  // Determine the account list to filter
  const baseAccounts = useMemo<AccountVM[]>(() => {
    if (sidebarMode === 'search') return searchResults.data ?? [];
    if (selectedTerritoryId) return territoryAccounts.data ?? [];
    return myAccounts.data ?? [];
  }, [
    sidebarMode,
    searchResults.data,
    selectedTerritoryId,
    territoryAccounts.data,
    myAccounts.data,
  ]);

  const sortedAccounts = useMemo(
    () =>
      sidebarMode === 'my' ? sortByAccessFrequency(baseAccounts) : baseAccounts,
    [sidebarMode, baseAccounts],
  );

  const filters = useCRMFilters(sortedAccounts);

  const isLoading =
    (sidebarMode === 'my' && myAccounts.isLoading) ||
    (sidebarMode === 'search' && searchResults.isLoading) ||
    (!!selectedTerritoryId && territoryAccounts.isLoading);

  function handleSelectAccount(account: AccountVM) {
    recordAccountAccess(account.id);
    setSelectedAccountId(account.id);
  }

  const handleSendToChat = useCallback(
    (prompt: string) => sendToChat(prompt),
    [sendToChat],
  );

  return (
    <div className="workspace-container workspace-container--crm">
      {/* Left sidebar */}
      <div className="workspace-sidebar">
        {/* Mode toggle */}
        <div className="crm-mode-toggle">
          <button
            type="button"
            className={`crm-mode-btn ${sidebarMode === 'my' ? 'crm-mode-btn--active' : ''}`}
            onClick={() => {
              setSidebarMode('my');
              setSearchQuery('');
            }}
          >
            My Accounts
          </button>
          <button
            type="button"
            className={`crm-mode-btn ${sidebarMode === 'search' ? 'crm-mode-btn--active' : ''}`}
            onClick={() => setSidebarMode('search')}
          >
            Search
          </button>
        </div>

        {/* Territory selector (my mode only) */}
        {sidebarMode === 'my' && (territories.data?.length ?? 0) > 0 && (
          <div className="crm-territory-select">
            <select
              className="crm-territory-dropdown"
              value={selectedTerritoryId ?? ''}
              onChange={(e) => setSelectedTerritoryId(e.target.value || null)}
            >
              <option value="">All my accounts</option>
              {territories.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Search input (search mode) */}
        {sidebarMode === 'search' && (
          <div className="crm-search-input-wrap">
            <input
              ref={searchInputRef}
              type="text"
              className="crm-search-input"
              placeholder="Search accounts…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        )}

        {/* Filter bar */}
        <FilterBar
          geos={filters.allGeos}
          sizes={filters.allSizes}
          selectedGeos={filters.selectedGeos}
          selectedSizes={filters.selectedSizes}
          nameFilter={filters.nameFilter}
          expanded={filters.filterExpanded}
          activeFilters={filters.activeFilters}
          onNameChange={filters.setNameFilter}
          onGeoToggle={(geo) =>
            filters.setSelectedGeos((prev) =>
              prev.includes(geo)
                ? prev.filter((g) => g !== geo)
                : [...prev, geo],
            )
          }
          onSizeToggle={(size) =>
            filters.setSelectedSizes((prev) =>
              prev.includes(size)
                ? prev.filter((s) => s !== size)
                : [...prev, size],
            )
          }
          onRemoveFilter={filters.removeFilter}
          onClearAll={filters.clearFilters}
          onToggleExpanded={() => filters.setFilterExpanded((x) => !x)}
        />

        {/* Account list */}
        <AccountList
          accounts={filters.filteredAccounts}
          selectedId={selectedAccountId}
          onSelect={handleSelectAccount}
          loading={isLoading}
          displayLimit={filters.displayLimit}
          onShowMore={() => filters.setDisplayLimit((n) => n + 25)}
        />
      </div>

      {/* Right panel */}
      <div className="workspace-panel">
        {selectedAccountId ? (
          <>
            <AccountDetail
              account={detail.account}
              opportunities={detail.opportunities}
              tasks={detail.tasks}
              isLoading={detail.isLoading}
              onCreateOpportunity={() => setShowCreateOpp(true)}
              onCreateTask={() => setShowCreateTask(true)}
              onLogActivity={() => setShowLogActivity(true)}
            />

            {/* AI quick actions for selected account */}
            {detail.account && (
              <div className="crm-ai-actions">
                <button
                  type="button"
                  className="crm-ai-action-btn"
                  onClick={() =>
                    handleSendToChat(
                      `Summarize the account "${detail.account!.name}" including recent opportunities and tasks.`,
                    )
                  }
                >
                  💬 Summarize account
                </button>
                <button
                  type="button"
                  className="crm-ai-action-btn"
                  onClick={() =>
                    handleSendToChat(
                      `What are the next best actions for account "${detail.account!.name}"?`,
                    )
                  }
                >
                  🎯 Next best actions
                </button>
                <button
                  type="button"
                  className="crm-ai-action-btn"
                  onClick={() =>
                    handleSendToChat(
                      `Draft a follow-up email for account "${detail.account!.name}".`,
                    )
                  }
                >
                  ✉️ Draft follow-up
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="workspace-panel-empty">
            <p>Select an account to view details</p>
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateOpportunityModal
        isOpen={showCreateOpp}
        account={detail.account ?? null}
        onClose={() => setShowCreateOpp(false)}
      />
      <LogActivityModal
        isOpen={showLogActivity}
        account={detail.account ?? null}
        opportunities={detail.opportunities}
        onClose={() => setShowLogActivity(false)}
      />
      <CreateTaskModal
        isOpen={showCreateTask}
        account={detail.account ?? null}
        onClose={() => setShowCreateTask(false)}
      />
    </div>
  );
}
