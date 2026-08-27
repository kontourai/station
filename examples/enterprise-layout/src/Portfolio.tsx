import { useNavigation, useSendToChat } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { AGENT_SLUG, LAYOUT_SLUG } from './constants';
import {
  relTime,
  sortByAccessFrequency,
  useAccountAccess,
  useCalendarEvents,
  useMyAccounts,
  useMyOpportunities,
  useMyTasks,
} from './data';
import { isRecentlyVisited } from './utils';

const QUICK_ACTIONS = [
  {
    label: "📋 Prep for today's meetings",
    prompt: 'Summarize my meetings today and what I should prepare for each.',
  },
  {
    label: '📊 Account health check',
    prompt: 'Review my accounts and flag any that need attention.',
  },
  {
    label: '✅ Open tasks review',
    prompt: 'List my open tasks and suggest priorities.',
  },
  {
    label: '💡 Opportunity pipeline',
    prompt: 'Summarize my open opportunities and next steps.',
  },
];

function splitByRecency<T extends { id: string }>(
  items: T[],
): { recent: T[]; rest: T[] } {
  const recent = items.filter((i) => isRecentlyVisited(i.id));
  const rest = items.filter((i) => !isRecentlyVisited(i.id));
  return { recent, rest };
}

export function Portfolio() {
  const nav = useNavigation();
  const { sendToChat } = useSendToChat(AGENT_SLUG);
  const { record } = useAccountAccess();

  const accounts = useMyAccounts();
  const opportunities = useMyOpportunities();
  const tasks = useMyTasks();
  const today = useMemo(() => new Date(), []);
  const events = useCalendarEvents(today);

  const sortedAccounts = useMemo(
    () => sortByAccessFrequency(accounts.data ?? []),
    [accounts.data],
  );
  const { recent: recentAccounts, rest: otherAccounts } = useMemo(
    () => splitByRecency(sortedAccounts),
    [sortedAccounts],
  );

  const recentOpps = useMemo(
    () => (opportunities.data ?? []).slice(0, 5),
    [opportunities.data],
  );
  const openTasks = useMemo(
    () => (tasks.data ?? []).filter((t) => t.status === 'open').slice(0, 5),
    [tasks.data],
  );
  const todayEvents = useMemo(
    () => (events.data ?? []).filter((e) => !e.isCancelled).slice(0, 5),
    [events.data],
  );

  function goToCRM(accountId?: string) {
    const params = new URLSearchParams();
    if (accountId) params.set('accountId', accountId);
    nav.setLayoutTab(LAYOUT_SLUG, 'crm');
  }

  function handleAccountClick(accountId: string) {
    record(accountId);
    goToCRM(accountId);
  }

  return (
    <div className="workspace-dashboard">
      {/* Quick actions */}
      <section className="dashboard-section dashboard-section--actions">
        <h2 className="dashboard-section-title">Quick Actions</h2>
        <div className="dashboard-quick-actions">
          {QUICK_ACTIONS.map((qa) => (
            <button
              type="button"
              key={qa.label}
              className="dashboard-quick-action-btn"
              onClick={() => sendToChat(qa.prompt)}
            >
              {qa.label}
            </button>
          ))}
        </div>
      </section>

      {/* Accounts */}
      <section className="dashboard-section">
        <div className="dashboard-section-header">
          <h2 className="dashboard-section-title">My Accounts</h2>
          <button
            type="button"
            className="dashboard-section-link"
            onClick={() => goToCRM()}
          >
            View all →
          </button>
        </div>
        {accounts.isLoading ? (
          <div className="dashboard-loading">Loading accounts…</div>
        ) : (
          <div className="dashboard-accounts-table">
            {recentAccounts.length > 0 && (
              <>
                <div className="dashboard-accounts-group-label">
                  Recently visited
                </div>
                {recentAccounts.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className="dashboard-account-row dashboard-account-row--recent"
                    onClick={() => handleAccountClick(a.id)}
                  >
                    <span className="dashboard-account-name">{a.name}</span>
                    {a.territory && (
                      <span className="dashboard-account-meta">
                        {a.territory}
                      </span>
                    )}
                    {a.segment && (
                      <span className="dashboard-account-meta">
                        {a.segment}
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
            {otherAccounts.slice(0, 10).map((a) => (
              <button
                type="button"
                key={a.id}
                className="dashboard-account-row"
                onClick={() => handleAccountClick(a.id)}
              >
                <span className="dashboard-account-name">{a.name}</span>
                {a.territory && (
                  <span className="dashboard-account-meta">{a.territory}</span>
                )}
                {a.segment && (
                  <span className="dashboard-account-meta">{a.segment}</span>
                )}
              </button>
            ))}
            {accounts.data?.length === 0 && (
              <div className="dashboard-empty">No accounts found</div>
            )}
          </div>
        )}
      </section>

      <div className="dashboard-columns">
        {/* Today's meetings */}
        <section className="dashboard-section">
          <h2 className="dashboard-section-title">Today's Meetings</h2>
          {events.isLoading ? (
            <div className="dashboard-loading">Loading…</div>
          ) : todayEvents.length === 0 ? (
            <div className="dashboard-empty">No meetings today</div>
          ) : (
            <ul className="dashboard-list">
              {todayEvents.map((e) => (
                <li key={e.id} className="dashboard-list-item">
                  <span className="dashboard-list-item-title">{e.subject}</span>
                  <span className="dashboard-list-item-meta">
                    {e.start.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent opportunities */}
        <section className="dashboard-section">
          <h2 className="dashboard-section-title">Recent Opportunities</h2>
          {opportunities.isLoading ? (
            <div className="dashboard-loading">Loading…</div>
          ) : recentOpps.length === 0 ? (
            <div className="dashboard-empty">No opportunities</div>
          ) : (
            <ul className="dashboard-list">
              {recentOpps.map((o) => (
                <li key={o.id} className="dashboard-list-item">
                  <span className="dashboard-list-item-title">{o.name}</span>
                  <span className="dashboard-list-item-meta">{o.stage}</span>
                  {o.closeDate && (
                    <span className="dashboard-list-item-meta">
                      {relTime(o.closeDate)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Open tasks */}
        <section className="dashboard-section">
          <h2 className="dashboard-section-title">Open Tasks</h2>
          {tasks.isLoading ? (
            <div className="dashboard-loading">Loading…</div>
          ) : openTasks.length === 0 ? (
            <div className="dashboard-empty">No open tasks</div>
          ) : (
            <ul className="dashboard-list">
              {openTasks.map((t) => (
                <li key={t.id} className="dashboard-list-item">
                  <span className="dashboard-list-item-title">{t.subject}</span>
                  {t.dueDate && (
                    <span className="dashboard-list-item-meta">
                      {relTime(t.dueDate)}
                    </span>
                  )}
                  {t.priority && (
                    <span
                      className={`dashboard-list-item-badge dashboard-list-item-badge--${t.priority}`}
                    >
                      {t.priority}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
