import { INBOX_SCOPE_CURRENT_PROJECT } from '@kontourai/station-contracts/device-settings';
import { useId, useRef, useState } from 'react';
import { useDockSlotDevice } from '../../hooks/useIsMobile';
import { ActionOverflowMenu } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { SearchGlyph } from '../icons/Glyph';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { InboxPullRequestFilter, type useInboxScope } from './InboxScopeFilter';

export const INBOX_STATUSES = [
  'All statuses',
  'Needs attention',
  'Running',
  'Waiting',
  'Open',
  'Finished',
] as const;
export type InboxStatusFilter = (typeof INBOX_STATUSES)[number];

export function MobileInboxTools({
  scope,
  status,
  onStatus,
  onSearch,
  searchOpen,
  onSelect,
  onRefresh,
  onArrange,
  onBack,
}: {
  scope: ReturnType<typeof useInboxScope>;
  status: InboxStatusFilter;
  onStatus(value: InboxStatusFilter): void;
  onSearch(): void;
  searchOpen: boolean;
  onSelect(): void;
  onRefresh?: () => void;
  onArrange(): void;
  onBack?: () => void;
}) {
  const { viewportWidth } = useDockSlotDevice();
  const [filters, setFilters] = useState(false);
  const [query, setQuery] = useState('');
  const [station, setStation] = useState('all');
  const [project, setProject] = useState('all');
  const [draftStatus, setDraftStatus] = useState(status);
  const [draftPullRequest, setDraftPullRequest] = useState(
    scope.pullRequestFilter,
  );
  const trigger = useRef<HTMLElement | null>(null);
  const labelId = useId();
  const choices = [...scope.projectChoices.values()].filter(
    (option) =>
      (station === 'all' || option.station === station) &&
      option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const [scopeEdited, setScopeEdited] = useState(false);
  const openFilters = (button: HTMLElement) => {
    trigger.current = button;
    const activeProject = scope.projectChoices.get(scope.effectiveValue);
    setStation(
      activeProject?.station ??
        (scope.effectiveValue.startsWith('station:')
          ? scope.effectiveValue
          : 'all'),
    );
    setScopeEdited(false);
    setProject(
      scope.value === INBOX_SCOPE_CURRENT_PROJECT && !scope.followPageHidden
        ? scope.value
        : (activeProject?.key ??
            (scope.value.startsWith('project:') ? scope.value : 'all')),
    );
    setDraftStatus(status);
    setDraftPullRequest(scope.pullRequestFilter);
    setQuery('');
    setFilters(true);
  };
  const apply = () => {
    const selected = project === 'all' ? station : project;
    if (scopeEdited && selected !== scope.value) scope.onChange(selected);
    onStatus(draftStatus);
    scope.setPullRequestFilter(draftPullRequest);
    setFilters(false);
  };
  return (
    <>
      {viewportWidth > 350 && (
        <>
          <Button
            variant="ghost"
            className="app-toolbar__icon-btn mobile-inbox__direct-tool"
            aria-label="Search chats"
            aria-expanded={searchOpen}
            onClick={onSearch}
          >
            <SearchGlyph />
          </Button>
          <Button
            variant="ghost"
            className="app-toolbar__icon-btn mobile-inbox__direct-tool"
            aria-label="Filter chats"
            aria-haspopup="dialog"
            aria-expanded={filters}
            data-filtered={
              scope.effectiveValue !== 'all' ||
              status !== 'All statuses' ||
              !!scope.pullRequestFilter ||
              undefined
            }
            onClick={(e) => openFilters(e.currentTarget)}
          >
            <span className="mobile-inbox__filter-glyph" aria-hidden="true" />
          </Button>
        </>
      )}
      <ActionOverflowMenu
        label="Actions for Chats"
        triggerClassName="app-toolbar__icon-btn mobile-inbox__more"
        actions={[
          { key: 'search', label: 'Search chats', onSelect: onSearch },
          { key: 'filters', label: 'Filter chats', onSelect: openFilters },
          { key: 'select', label: 'Select conversations', onSelect: onSelect },
          { key: 'arrange', label: 'Arrange sections', onSelect: onArrange },
          ...(onRefresh
            ? [{ key: 'refresh', label: 'Refresh chats', onSelect: onRefresh }]
            : []),
          ...(onBack
            ? [{ key: 'chat', label: 'Back to chat', onSelect: onBack }]
            : []),
        ]}
      />
      {filters && (
        <ResponsiveDialogSurface
          layer="popover"
          ariaLabel="Filter chats"
          historyMode="entry"
          onClose={() => setFilters(false)}
          returnFocusTarget={trigger.current}
          insetSheetMinHeight={700}
          overlayClassName="composer-popover-overlay mobile-inbox-filters-overlay"
          panelClassName="composer-popover-panel mobile-inbox-filters"
        >
          <ResponsiveDialogHeader
            title="Filter chats"
            closeLabel="Close filters"
            onClose={() => setFilters(false)}
          />
          <div className="mobile-inbox-filters__body">
            {scope.showPullRequestFilter && (
              <InboxPullRequestFilter
                value={draftPullRequest}
                onChange={setDraftPullRequest}
              />
            )}
            <fieldset>
              <legend>Station</legend>
              <div className="mobile-inbox-filters__choices">
                {[
                  ['all', 'All Stations'],
                  ...[...scope.options].filter(([key]) =>
                    key.startsWith('station:'),
                  ),
                ].map(([key, label]) => (
                  <Button
                    key={key}
                    variant="ghost"
                    aria-pressed={station === key}
                    onClick={() => {
                      setScopeEdited(true);
                      setStation(key);
                      setProject('all');
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Project</legend>
              <input
                className="control control--input"
                type="search"
                aria-label="Find a project"
                placeholder="Find a project…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="mobile-inbox-filters__choices">
                <Button
                  variant="ghost"
                  aria-pressed={project === 'all'}
                  onClick={() => {
                    setScopeEdited(true);
                    setProject('all');
                  }}
                >
                  All projects
                </Button>
                {!scope.followPageHidden &&
                  (station === 'all' || station === 'station:local') && (
                    <Button
                      variant="ghost"
                      aria-pressed={project === INBOX_SCOPE_CURRENT_PROJECT}
                      onClick={() => {
                        setScopeEdited(true);
                        setProject(INBOX_SCOPE_CURRENT_PROJECT);
                      }}
                    >
                      Follow current project
                    </Button>
                  )}
                {project.startsWith('project:') &&
                  !scope.projectChoices.has(project) && (
                    <Button variant="ghost" aria-pressed>
                      {scope.options.get(project)}
                    </Button>
                  )}
                {choices.map((option) => (
                  <Button
                    key={option.key}
                    variant="ghost"
                    aria-pressed={project === option.key}
                    onClick={() => {
                      setScopeEdited(true);
                      setProject(option.key);
                    }}
                  >
                    {option.label}
                    {station === 'all' && scope.stationCount > 1
                      ? ` · ${scope.options.get(option.station)}`
                      : ''}
                  </Button>
                ))}
              </div>
            </fieldset>
            <fieldset aria-labelledby={labelId}>
              <legend id={labelId}>Status</legend>
              <div className="mobile-inbox-filters__choices">
                {INBOX_STATUSES.map((value) => (
                  <Button
                    key={value}
                    variant="ghost"
                    aria-pressed={draftStatus === value}
                    onClick={() => setDraftStatus(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </fieldset>
            <div className="mobile-inbox-filters__footer">
              <Button
                variant="ghost"
                onClick={() => {
                  setScopeEdited(true);
                  setStation('all');
                  setProject('all');
                  setDraftStatus('All statuses');
                  setDraftPullRequest('');
                  setQuery('');
                }}
              >
                Reset
              </Button>
              <Button variant="primary" onClick={apply}>
                Apply filters
              </Button>
            </div>
          </div>
        </ResponsiveDialogSurface>
      )}
    </>
  );
}
