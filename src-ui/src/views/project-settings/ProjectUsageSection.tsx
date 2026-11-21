import {
  projectUsageTotals,
  type UsageRollupRow,
} from '@kontourai/station-contracts/usage-rollup';
import { useUsageRollupQuery } from '@kontourai/station-sdk/usage-rollup-query';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';

const DAYS = 30;

/** Input plus output tokens, or `undefined` when neither was reported. */
function rowTokens(row: UsageRollupRow): number | undefined {
  if (row.inputTokens === undefined && row.outputTokens === undefined)
    return undefined;
  return (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString();
}

/** One-currency costs only; anything else is shown as mixed. */
function formatCost(row: UsageRollupRow): string {
  const single = row.reportedCost ?? row.estimatedCost;
  if (single) return `${single.amount.toFixed(4)} ${single.currency}`;
  const buckets = row.reportedCostBuckets ?? row.estimatedCostBuckets;
  if (buckets?.length === 1)
    return `${buckets[0]!.amount.toFixed(4)} ${buckets[0]!.currency}`;
  return buckets?.length ? 'Mixed currencies' : '—';
}

function UsageTable({
  caption,
  rows,
  label,
}: {
  caption: string;
  rows: readonly UsageRollupRow[];
  label: (row: UsageRollupRow) => string;
}) {
  return (
    <table className="project-settings__usage-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Tokens</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">{label(row)}</th>
            <td>{formatTokens(rowTokens(row))}</td>
            <td>{formatCost(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * #5068: what this Project's Sessions used over the last 30 days on this
 * Station, by Task (the Project chats' share, its coordinator's, is its own row) and by model.
 */
export function ProjectUsageSection({ slug }: { slug: string }) {
  const scope = useHostRequestAuthorityScope();
  // A held render (`isPlaceholderData`) is the previous Project's or
  // grouping's rows while this one loads; it is dimmed and labelled below.
  const { isPlaceholderData: taskRowsHeld, ...byTask } = useUsageRollupQuery(
    {
      days: DAYS,
      groupBy: 'task',
      projectSlug: slug,
      localOnly: true,
      pageSize: 100,
    },
    { requestScope: scope ?? undefined, requireRequestScope: true },
  );
  const { isPlaceholderData: modelRowsHeld, ...byModel } = useUsageRollupQuery(
    {
      days: DAYS,
      groupBy: 'model',
      projectSlug: slug,
      localOnly: true,
      pageSize: 100,
    },
    { requestScope: scope ?? undefined, requireRequestScope: true },
  );
  const showingPreviousData = taskRowsHeld || modelRowsHeld;
  const taskRows = byTask.data?.rows ?? [];
  const modelRows = byModel.data?.rows ?? [];
  const { total, coordinator } = projectUsageTotals(taskRows);
  const incomplete = (byTask.data?.coverage ?? []).some(
    (item) => item.state !== 'complete',
  );
  const ordered = [...taskRows].sort(
    (a, b) => Number(!!a.taskId) - Number(!!b.taskId),
  );
  const loading = byTask.isLoading || byModel.isLoading;
  const failed = byTask.error ?? byModel.error;

  return (
    <PageSection
      id="section-usage"
      className="project-settings__section"
      title="Usage"
      description="Tokens this Project's Sessions used on this Station in the last 30 days."
    >
      {loading ? (
        <SkeletonBlock count={2} label="Loading usage" />
      ) : failed && taskRows.length === 0 ? (
        <ErrorState
          variant="compact"
          title="Couldn't load usage"
          description={userFacingErrorMessage(failed)}
          action={
            <Button
              onClick={() => {
                void byTask.refetch();
                void byModel.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : taskRows.length === 0 ? (
        <Empty
          label="Nothing reported yet"
          description="Usage appears after a Session in this Project reports it."
        />
      ) : (
        <div
          className={`content-stack${showingPreviousData ? ' project-settings__usage--stale' : ''}`}
          aria-busy={showingPreviousData || undefined}
        >
          {showingPreviousData && (
            <p className="project-settings__usage-note" role="status">
              Showing the previous figures while this Project updates.
            </p>
          )}
          <dl className="project-settings__usage-totals">
            <div>
              <dt>Project total</dt>
              <dd>{formatTokens(total)}</dd>
            </div>
            <div>
              <dt>Project chats</dt>
              <dd>{formatTokens(coordinator)}</dd>
            </div>
          </dl>
          {incomplete && (
            <p className="project-settings__usage-note">
              Some engines did not report usage, so totals may be low.
            </p>
          )}
          <UsageTable
            caption="By Task"
            rows={ordered}
            label={(row) =>
              row.taskId ? `Task ${row.taskId.slice(0, 8)}` : 'Project chats'
            }
          />
          {byModel.error ? (
            <ErrorState
              variant="compact"
              title="Couldn't load usage by model"
              description={userFacingErrorMessage(byModel.error)}
              action={
                <Button onClick={() => void byModel.refetch()}>Retry</Button>
              }
            />
          ) : (
            <UsageTable
              caption="By model"
              rows={modelRows}
              label={(row) => row.model ?? 'Model not reported'}
            />
          )}
        </div>
      )}
    </PageSection>
  );
}
