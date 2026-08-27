import { SortHeader, useSortableTable } from './components/SortableTable';
import { CRM_BASE_URL } from './constants';
import { relTime } from './data';
import type { AccountVM, OpportunityVM, TaskVM } from './data/viewmodels';

interface AccountDetailProps {
  account: AccountVM | null | undefined;
  opportunities: OpportunityVM[];
  tasks: TaskVM[];
  isLoading?: boolean;
  onCreateOpportunity?: () => void;
  onCreateTask?: () => void;
  onLogActivity?: () => void;
}

function OpportunitiesTable({
  opportunities,
  onCreateOpportunity,
}: {
  opportunities: OpportunityVM[];
  onCreateOpportunity?: () => void;
}) {
  const { sorted, sortKey, sortDir, toggle } = useSortableTable(
    opportunities,
    'name',
    'asc',
  );

  return (
    <div className="account-detail-section">
      <div className="account-detail-section-header">
        <h3 className="account-detail-section-title">Opportunities</h3>
        {onCreateOpportunity && (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={onCreateOpportunity}
          >
            + New
          </button>
        )}
      </div>
      {sorted.length === 0 ? (
        <div className="account-detail-empty">No opportunities</div>
      ) : (
        <table className="account-detail-table">
          <thead>
            <tr>
              <SortHeader
                label="Name"
                sortKey="name"
                active={sortKey === 'name'}
                dir={sortDir}
                onClick={toggle}
              />
              <SortHeader
                label="Stage"
                sortKey="stage"
                active={sortKey === 'stage'}
                dir={sortDir}
                onClick={toggle}
              />
              <SortHeader
                label="Amount"
                sortKey="amount"
                active={sortKey === 'amount'}
                dir={sortDir}
                onClick={toggle}
              />
              <SortHeader
                label="Close Date"
                sortKey="closeDate"
                active={sortKey === 'closeDate'}
                dir={sortDir}
                onClick={toggle}
              />
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((opp) => (
              <tr key={opp.id}>
                <td>
                  <a
                    href={`${CRM_BASE_URL}/lightning/r/Opportunity/${opp.id}/view`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="account-detail-link"
                  >
                    {opp.name}
                  </a>
                </td>
                <td>
                  {opp.stage && (
                    <span
                      className={`opp-stage-badge opp-stage-badge--${opp.stage.toLowerCase().replace(/\s+/g, '-')}`}
                    >
                      {opp.stage}
                    </span>
                  )}
                </td>
                <td>
                  {opp.amount != null ? `$${opp.amount.toLocaleString()}` : '—'}
                </td>
                <td>{opp.closeDate ? relTime(opp.closeDate) : '—'}</td>
                <td>{opp.owner?.name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TasksTable({
  tasks,
  onCreateTask,
}: {
  tasks: TaskVM[];
  onCreateTask?: () => void;
}) {
  const { sorted, sortKey, sortDir, toggle } = useSortableTable(
    tasks,
    'subject',
    'asc',
  );

  return (
    <div className="account-detail-section">
      <div className="account-detail-section-header">
        <h3 className="account-detail-section-title">Tasks</h3>
        {onCreateTask && (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={onCreateTask}
          >
            + New
          </button>
        )}
      </div>
      {sorted.length === 0 ? (
        <div className="account-detail-empty">No tasks</div>
      ) : (
        <table className="account-detail-table">
          <thead>
            <tr>
              <SortHeader
                label="Subject"
                sortKey="subject"
                active={sortKey === 'subject'}
                dir={sortDir}
                onClick={toggle}
              />
              <SortHeader
                label="Status"
                sortKey="status"
                active={sortKey === 'status'}
                dir={sortDir}
                onClick={toggle}
              />
              <SortHeader
                label="Due"
                sortKey="dueDate"
                active={sortKey === 'dueDate'}
                dir={sortDir}
                onClick={toggle}
              />
              <th>Type</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((task) => (
              <tr key={task.id}>
                <td>{task.subject}</td>
                <td>
                  <span
                    className={`task-status-badge task-status-badge--${task.status}`}
                  >
                    {task.status}
                  </span>
                </td>
                <td>{task.dueDate ? relTime(task.dueDate) : '—'}</td>
                <td>{task.activityType ?? '—'}</td>
                <td>{task.priority ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function AccountDetail({
  account,
  opportunities,
  tasks,
  isLoading = false,
  onCreateOpportunity,
  onCreateTask,
  onLogActivity,
}: AccountDetailProps) {
  if (isLoading) {
    return <div className="account-detail-loading">Loading…</div>;
  }

  if (!account) {
    return (
      <div className="account-detail-empty-state">
        <p>Select an account to view details</p>
      </div>
    );
  }

  return (
    <div className="account-detail">
      <div className="account-detail-header">
        <div className="account-detail-header-main">
          <h2 className="account-detail-name">
            <a
              href={`${CRM_BASE_URL}/lightning/r/Account/${account.id}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className="account-detail-link"
            >
              {account.name}
            </a>
          </h2>
          <div className="account-detail-meta">
            {account.territory && (
              <span className="account-detail-meta-item">
                <span className="account-detail-meta-label">Territory:</span>{' '}
                {account.territory}
              </span>
            )}
            {account.segment && (
              <span className="account-detail-meta-item">
                <span className="account-detail-meta-label">Segment:</span>{' '}
                {account.segment}
              </span>
            )}
            {account.owner && (
              <span className="account-detail-meta-item">
                <span className="account-detail-meta-label">Owner:</span>{' '}
                {account.owner.name}
              </span>
            )}
            {account.website && (
              <span className="account-detail-meta-item">
                <a
                  href={account.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="account-detail-link"
                >
                  {account.website}
                </a>
              </span>
            )}
          </div>
        </div>
        {onLogActivity && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onLogActivity}
          >
            Log Activity
          </button>
        )}
      </div>

      <OpportunitiesTable
        opportunities={opportunities}
        onCreateOpportunity={onCreateOpportunity}
      />
      <TasksTable tasks={tasks} onCreateTask={onCreateTask} />
    </div>
  );
}
