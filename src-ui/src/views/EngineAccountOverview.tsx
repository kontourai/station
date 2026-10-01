import type { EngineAccountUsageMetadata } from '@kontourai/station-contracts/engine-accounts';
import type { UsageRollup } from '@kontourai/station-contracts/usage-rollup';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  type EngineAccount,
  useCreateEngineAccountMutation,
  useEngineAccountLoginMutation,
  useEngineAccountLoginQuery,
  useEngineAccountsQuery,
  useEngineAccountUsageQuery,
  useEngineActivityQuery,
} from '@kontourai/station-sdk/engine-accounts';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { ResponsiveSurfaceActions } from '../components/ResponsiveDialogSurface';
import { Empty, SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { openExternalLink } from '../platform/openExternalLink';
import './EngineAccountOverview.css';

export function EngineAccountOverview({
  connectionId,
  engine,
}: {
  connectionId: string;
  engine: 'claude' | 'codex';
}) {
  const scope = useHostRequestAuthorityScope();
  const authority = useQuery({
    queryKey: ['engine-account-authority', scope?.apiBase, scope?.authorityKey],
    queryFn: ({ signal }) => {
      if (!scope) throw new Error('Connect to this Station.');
      return getAuthorityObservation(scope.apiBase, {
        requestScope: scope,
        signal,
      });
    },
    enabled: !!scope,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (!scope) return <p>Connect to this Station to view accounts.</p>;
  if (authority.isLoading)
    return <SkeletonBlock count={2} label="Loading account access" />;
  if (authority.isError || !authority.data)
    return (
      <div role="alert">
        Account access could not be checked.{' '}
        <Button onClick={() => void authority.refetch()}>Retry</Button>
      </div>
    );
  const grant = authority.data.grant;
  const canManage =
    grant.kind === 'operator' || grant.grantedScopes.includes('access:manage');
  const canLogin =
    grant.kind === 'operator' || grant.grantedScopes.includes('engine:login');
  const canReadActivity = canManage;
  return (
    <AccountPage
      key={`${scope.apiBase}:${scope.authorityKey}:${connectionId}`}
      connectionId={connectionId}
      engine={engine}
      scope={scope}
      canManage={canManage}
      canLogin={canLogin}
      canReadActivity={canReadActivity}
    />
  );
}

function AccountPage({
  connectionId,
  engine,
  scope,
  canManage,
  canLogin,
  canReadActivity,
}: {
  connectionId: string;
  engine: 'claude' | 'codex';
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  canManage: boolean;
  canLogin: boolean;
  canReadActivity: boolean;
}) {
  const [selected, setSelected] = useState<string | null | undefined>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState('');
  const [days, setDays] = useState<7 | 30>(7);
  const accounts = useEngineAccountsQuery(
    connectionId,
    scope,
    canManage || canLogin,
  );
  const ref =
    selected === undefined ||
    !accounts.data?.accounts.some((account) => account.ref === selected)
      ? (accounts.data?.activeProfileRef ?? null)
      : selected;
  const account = accounts.data?.accounts.find((a) => a.ref === ref);
  const usage = useEngineAccountUsageQuery(
    connectionId,
    ref,
    scope,
    !!account && canManage,
  );
  const activity = useEngineActivityQuery(engine, days, scope, canReadActivity);
  const create = useCreateEngineAccountMutation(connectionId, scope);
  const refresh = () => {
    void accounts.refetch();
    if (canManage) void usage.refetch();
    if (canReadActivity) void activity.refetch();
  };
  if (!canManage && !canLogin)
    return (
      <section className="engine-account-overview">
        <p>Account access is disabled for this device.</p>
      </section>
    );
  if (accounts.isLoading)
    return <SkeletonBlock count={3} label="Loading engine accounts" />;
  if (accounts.isError || !accounts.data)
    return (
      <section className="engine-account-overview" role="alert">
        <p>Accounts could not be loaded.</p>
        <Button onClick={() => void accounts.refetch()}>Retry</Button>
      </section>
    );
  return (
    <section
      className="engine-account-overview"
      aria-label={`${engine === 'codex' ? 'Codex' : 'Claude'} account and usage`}
    >
      <div className="engine-account-overview__toolbar">
        <label>
          Account{' '}
          <select
            value={ref ?? ''}
            onChange={(event) => {
              setSelected(event.target.value || null);
              setNotice('');
            }}
          >
            {accounts.data.accounts.map((a) => (
              <option key={a.ref ?? 'default'} value={a.ref ?? ''}>
                {a.label}
                {a.ref === accounts.data?.activeProfileRef ? ' · in use' : ''}
              </option>
            ))}
          </select>
        </label>
        <ResponsiveSurfaceActions className="engine-account-overview__actions">
          <Button
            onClick={refresh}
            disabled={accounts.isFetching || usage.isFetching}
          >
            Refresh
          </Button>
          {canManage && (
            <Button onClick={() => setAdding(!adding)}>
              {adding ? 'Cancel' : 'Add account'}
            </Button>
          )}
        </ResponsiveSurfaceActions>
      </div>
      {adding && (
        <form
          className="engine-account-overview__add"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || create.isPending) return;
            create.mutate(
              { ref: `account-${randomCorrelationId()}`, label: name.trim() },
              {
                onSuccess: (profile) => {
                  setSelected(profile.ref);
                  setAdding(false);
                  setName('');
                  void accounts.refetch();
                  setNotice('Account added. Sign in to connect it.');
                },
              },
            );
          }}
        >
          <label>
            Account name
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Personal or Work"
            />
          </label>
          <Button type="submit" pending={create.isPending}>
            Add
          </Button>
          {create.isError && (
            <p role="alert">The account could not be added. Try again.</p>
          )}
        </form>
      )}
      {account && (
        <div className="engine-account-overview__account">
          <div>
            <strong>
              {account.authState === 'authenticated'
                ? 'Signed in'
                : account.authState === 'unauthenticated'
                  ? 'Signed out'
                  : 'Status unavailable'}
            </strong>
            {usage.data?.status === 'ok' && usage.data.planLabel && (
              <span className="engine-account-overview__plan">
                {usage.data.planLabel}
              </span>
            )}
            {account.ref !== accounts.data.activeProfileRef && (
              <small>Viewing only. Runs use the account marked in use.</small>
            )}
          </div>
          <AccountLogin
            key={ref ?? 'default'}
            account={account}
            connectionId={connectionId}
            scope={scope}
            allowed={canLogin && account.ref !== null}
            onCompleted={() => {
              refresh();
              setNotice('Signed in.');
            }}
          />
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <section
        className="engine-account-overview__limits"
        aria-label="Account usage limits"
      >
        <h3>Allowance</h3>
        {!canManage ? (
          <p>Limit access requires credential-management permission.</p>
        ) : usage.isLoading ? (
          <SkeletonBlock count={1} label="Loading allowance" />
        ) : usage.isError ? (
          <p role="alert">
            Limits could not be loaded.{' '}
            <Button onClick={() => void usage.refetch()}>Retry</Button>
          </p>
        ) : usage.data?.status === 'ok' ? (
          <>
            {usage.data.windows.map((window) => (
              <div className="engine-account-overview__limit" key={window.id}>
                <div>
                  <span>{window.label}</span>
                  <strong>{Math.max(0, 100 - window.usedPercent)}% left</strong>
                </div>
                <meter
                  min={0}
                  max={100}
                  value={100 - window.usedPercent}
                  aria-label={`${window.label}: ${100 - window.usedPercent}% remaining`}
                />
                {window.resetsAt && (
                  <small>
                    {resetCountdown(window.resetsAt, usage.data?.fetchedAt)} ·
                    Resets{' '}
                    {new Date(window.resetsAt).toLocaleString(undefined, {
                      weekday: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </small>
                )}
                {(window.model || window.meteredFeature) && (
                  <small>
                    {[window.model, window.meteredFeature]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                )}
                {(window.allowed !== undefined ||
                  window.limitReached !== undefined) && (
                  <small>
                    {window.limitReached
                      ? 'Limit reached'
                      : window.allowed === false
                        ? 'Unavailable'
                        : window.allowed === true
                          ? 'Available'
                          : 'Availability not reported'}
                  </small>
                )}
              </div>
            ))}
            {usage.data.exhausted && (
              <p role="status">
                Allowance reached. Wait for a reset or use another account.
              </p>
            )}
            <small>
              Checked{' '}
              {new Date(usage.data.fetchedAt).toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </small>
          </>
        ) : (
          <p>
            Limits unavailable
            {usage.data?.status === 'unknown' ? `. ${usage.data.reason}` : '.'}
          </p>
        )}
        {!usage.isError && !usage.isLoading && usage.data?.metadata && (
          <AccountMetadata metadata={usage.data.metadata} />
        )}
      </section>
      <div className="engine-account-overview__activity">
        <div className="engine-account-overview__activity-heading">
          <h3>Activity</h3>
          <fieldset aria-label="Activity period">
            {([7, 30] as const).map((value) => (
              <Button
                key={value}
                aria-pressed={days === value}
                onClick={() => setDays(value)}
              >
                {value} days
              </Button>
            ))}
          </fieldset>
        </div>
        <small>This Station · this engine · all accounts</small>
        {!canReadActivity ? (
          <p>Activity requires credential-management permission.</p>
        ) : activity.isLoading ? (
          <SkeletonBlock count={2} label="Loading activity" />
        ) : activity.isError ? (
          <p role="alert">
            Activity could not be loaded.{' '}
            <Button onClick={() => void activity.refetch()}>Retry</Button>
          </p>
        ) : activity.data ? (
          <Activity data={activity.data} engine={engine} />
        ) : null}
      </div>
    </section>
  );
}
function AccountLogin({
  account,
  connectionId,
  scope,
  allowed,
  onCompleted,
}: {
  account: EngineAccount;
  connectionId: string;
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  allowed: boolean;
  onCompleted: () => void;
}) {
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState('');
  const query = useEngineAccountLoginQuery(
    connectionId,
    account.ref,
    scope,
    allowed,
  );
  const mutation = useEngineAccountLoginMutation(
    connectionId,
    account.ref,
    scope,
  );
  const completed = useRef<string | undefined>(undefined);
  const login = query.data;
  const active =
    !!login &&
    ['starting', 'awaiting-code', 'awaiting-approval', 'verifying'].includes(
      login.phase,
    );
  useEffect(() => {
    if (login?.phase === 'completed' && completed.current !== login.startedAt) {
      completed.current = login.startedAt;
      onCompleted();
    }
  }, [login, onCompleted]);
  const act = (action: Parameters<typeof mutation.mutate>[0]) =>
    mutation.mutate(action, {
      onError: (error) => setFailure(error.message),
      onSettled: () => {
        mutation.reset();
        void query.refetch();
      },
    });
  if (!allowed && account.ref === null && account.authState === 'authenticated')
    return null;
  if (!allowed)
    return (
      <small>
        {account.ref === null
          ? 'Add an account to sign in here.'
          : 'Sign-in access is disabled for this device.'}
      </small>
    );
  if (query.isError)
    return (
      <div role="alert">
        Sign-in status unavailable.{' '}
        <Button onClick={() => void query.refetch()}>Check status</Button>
      </div>
    );
  if (active)
    return (
      <div className="engine-account-overview__login" aria-live="polite">
        {failure && (
          <p role="alert">
            {failure}{' '}
            <Button
              onClick={() => {
                setFailure('');
                void query.refetch();
              }}
            >
              Check status
            </Button>
          </p>
        )}
        <ResponsiveSurfaceActions className="engine-account-overview__login-actions">
          {login.verificationUri && (
            <Button
              onClick={() => {
                try {
                  const uri = new URL(login.verificationUri!);
                  if (
                    uri.protocol === 'https:' &&
                    !uri.username &&
                    !uri.password
                  )
                    void openExternalLink(uri.href).catch(() =>
                      setFailure(
                        'The sign-in page could not be opened. Try opening it again.',
                      ),
                    );
                } catch {
                  setFailure('The sign-in link is invalid. Start again.');
                }
              }}
            >
              Open {account.login === 'browser-code' ? 'Claude' : 'OpenAI'}{' '}
              sign-in
            </Button>
          )}
          <Button
            onClick={() => act({ kind: 'cancel' })}
            pending={mutation.isPending}
          >
            Cancel
          </Button>
        </ResponsiveSurfaceActions>
        {login.userCode && (
          <div>
            <span>Verification code</span>
            <code>{login.userCode}</code>
          </div>
        )}
        {login.phase === 'awaiting-approval' && (
          <small>
            Open the sign-in page, enter this code, and approve access.
          </small>
        )}
        {login.phase === 'awaiting-code' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!code.trim() || mutation.isPending) return;
              const value = code.trim();
              setCode('');
              act({ kind: 'code', code: value });
            }}
          >
            <label>
              Code from Claude
              <input
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={2048}
                required
              />
            </label>
            <Button type="submit" pending={mutation.isPending}>
              Finish sign-in
            </Button>
          </form>
        )}
        {(login.phase === 'starting' || login.phase === 'verifying') && (
          <small>
            {login.phase === 'starting'
              ? 'Starting sign-in…'
              : 'Checking sign-in…'}
          </small>
        )}
      </div>
    );
  return (
    <div>
      {failure && (
        <p role="alert">
          {failure}{' '}
          <Button
            onClick={() => {
              setFailure('');
              void query.refetch();
            }}
          >
            Check status
          </Button>
        </p>
      )}
      {login?.phase === 'failed' && <p role="alert">{login.reason}</p>}
      {account.authState === 'unauthenticated' && (
        <Button
          disabled={
            !!failure ||
            mutation.isPending ||
            query.isLoading ||
            account.login === 'unavailable'
          }
          pending={mutation.isPending}
          onClick={() => act({ kind: 'start' })}
        >
          Sign in
        </Button>
      )}
      {account.authState === 'unknown' && (
        <small>Check account status before signing in.</small>
      )}
      {account.login === 'unavailable' &&
        account.authState !== 'authenticated' && (
          <small>Update the engine to enable sign-in.</small>
        )}
    </div>
  );
}
function resetCountdown(at: string, checkedAt: string | undefined): string {
  if (!checkedAt) return 'Reset time unavailable';
  const minutes = Math.max(
    0,
    Math.ceil((Date.parse(at) - Date.parse(checkedAt)) / 60000),
  );
  if (!Number.isFinite(minutes)) return 'Reset time unavailable';
  if (!minutes) return 'Reset due at last check';
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60);
  return `Reset in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`} at last check`;
}

type FactRow = [string, string | number | undefined];

function Facts({ rows }: { rows: FactRow[] }) {
  return (
    <dl className="engine-account-overview__facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? 'Not reported'}</dd>
        </div>
      ))}
    </dl>
  );
}
const yesNo = (value: boolean | undefined) =>
  value === undefined ? undefined : value ? 'Yes' : 'No';

function AccountMetadata({
  metadata,
}: {
  metadata: EngineAccountUsageMetadata;
}) {
  const { identity, credits, extraUsage, resetCredits, models, capture } =
    metadata;
  return (
    <>
      {identity?.email && <small>{identity.email}</small>}
      <details>
        <summary>Account & credits</summary>
        <Facts
          rows={[
            ...(identity
              ? ([
                  ['Account ID', identity.accountId],
                  ['User ID', identity.userId],
                ] satisfies FactRow[])
              : []),
            ...(credits
              ? ([
                  ['Credit balance', credits.balance],
                  ['Credits available', yesNo(credits.available)],
                  ['Unlimited credits', yesNo(credits.unlimited)],
                  ['Overage limit reached', yesNo(credits.overageLimitReached)],
                  [
                    'Approx. local messages',
                    credits.approximateLocalMessages?.join('–'),
                  ],
                  [
                    'Approx. cloud messages',
                    credits.approximateCloudMessages?.join('–'),
                  ],
                ] satisfies FactRow[])
              : []),
            ...(resetCredits
              ? ([
                  ['Reset credits', resetCredits.available],
                  ['Applicable reset credits', resetCredits.applicable],
                ] satisfies FactRow[])
              : []),
            ...(extraUsage
              ? ([
                  ['Extra usage enabled', yesNo(extraUsage.enabled)],
                  ['Extra usage consumed (provider units)', extraUsage.used],
                  [
                    'Monthly extra limit (provider units)',
                    extraUsage.monthlyLimit,
                  ],
                  [
                    'Extra usage used',
                    extraUsage.usedPercent === undefined
                      ? undefined
                      : `${extraUsage.usedPercent}%`,
                  ],
                  ['Extra usage limit reached', yesNo(extraUsage.limitReached)],
                ] satisfies FactRow[])
              : []),
          ]}
        />
        {!identity && !credits && !extraUsage && !resetCredits && (
          <small>No account or credit details were returned.</small>
        )}
        {!!models?.length && (
          <Facts
            rows={models.map((model) => [
              model.id,
              [
                model.available === undefined
                  ? 'Availability not reported'
                  : model.available
                    ? 'Available'
                    : 'Unavailable',
                model.availableAt
                  ? `Available ${new Date(model.availableAt).toLocaleString()}`
                  : '',
                model.creditsWouldEnable ? 'Credits would enable' : '',
              ]
                .filter(Boolean)
                .join(' · '),
            ])}
          />
        )}
      </details>
      <details>
        <summary>
          Data captured
          {capture.unhandledFields.length || capture.truncated
            ? ' · incomplete'
            : ''}
        </summary>
        <Facts
          rows={[
            [
              'Source',
              capture.source === 'codex-wham-usage'
                ? 'OpenAI account usage'
                : 'Anthropic OAuth usage',
            ],
            ['Storage', 'Live reading; no quota history stored'],
            [
              'Unmapped fields',
              capture.unhandledFields.length
                ? capture.unhandledFields.join(', ')
                : 'None in this response',
            ],
            [
              'Excluded fields',
              capture.excludedFields.length
                ? capture.excludedFields.join(', ')
                : 'None in this response',
            ],
            [
              'Shape audit',
              capture.truncated
                ? 'Incomplete: response exceeded audit bounds'
                : 'Completed for this response',
            ],
          ]}
        />
        <small>
          Field names identify gaps; unrecognized values and credentials stay
          private. Empty fields, value validation and other provider endpoints
          are outside this audit.
        </small>
      </details>
    </>
  );
}

function Activity({ data, engine }: { data: UsageRollup; engine: string }) {
  const rows = data.rows.filter((row) => row.provider === engine);
  if (!rows.length)
    return (
      <Empty
        variant="compact"
        label={
          data.coverage.some((c) => c.state !== 'complete')
            ? 'Activity unavailable'
            : 'Activity will appear here'
        }
        description={
          data.coverage.some((c) => c.state !== 'complete')
            ? 'No activity was returned. Some sources could not be read.'
            : 'Runs through this Station are recorded here.'
        }
      />
    );
  const tokens = rows.reduce(
    (sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
    0,
  );
  const reported = rows.flatMap((row) =>
    row.reportedCost ? [row.reportedCost] : (row.reportedCostBuckets ?? []),
  );
  const estimates = rows.flatMap((row) =>
    row.estimatedCost ? [row.estimatedCost] : (row.estimatedCostBuckets ?? []),
  );
  const dollars = (items: Array<{ amount: number; currency: string }>) =>
    !items.length
      ? '—'
      : items.every((item) => item.currency === 'USD')
        ? `$${items.reduce((sum, item) => sum + item.amount, 0).toFixed(2)}`
        : 'Mixed currencies';
  const costSource = reported.length ? 'reported' : 'estimated';
  const chartCosts = costSource === 'reported' ? reported : estimates;
  const costAvailable =
    chartCosts.length > 0 &&
    chartCosts.every((item) => item.currency === 'USD');
  const firstDay = Date.parse(data.window.from);
  const dayCount = Math.min(
    30,
    Math.round((Date.parse(data.window.to) - firstDay) / 86400000) + 1,
  );
  const chartRows = Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(firstDay + index * 86400000)
      .toISOString()
      .slice(0, 10);
    return { day, row: rows.find((row) => row.day === day) };
  });
  const values = chartRows.map(({ row }) => {
    if (!row) return undefined;
    const cost =
      costSource === 'reported' ? row.reportedCost : row.estimatedCost;
    const buckets =
      costSource === 'reported'
        ? row.reportedCostBuckets
        : row.estimatedCostBuckets;
    return costAvailable
      ? (cost?.amount ??
          buckets
            ?.filter((b) => b.currency === 'USD')
            .reduce((sum, b) => sum + b.amount, 0))
      : row.inputTokens === undefined && row.outputTokens === undefined
        ? undefined
        : (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  });
  const peak = Math.max(...values.map((value) => value ?? 0), 1);
  const partial = data.coverage.some(
    (c) =>
      c.droppedReceiptCount ||
      c.state === 'offline' ||
      c.state === 'stale' ||
      c.state === 'unknown' ||
      c.state === 'partial' ||
      c.providers?.some((p) => p.provider === engine && p.state !== 'complete'),
  );
  return (
    <>
      <div className="engine-account-overview__metrics">
        <div>
          <span>Tokens</span>
          <strong>
            {rows.some(
              (row) =>
                row.inputTokens !== undefined || row.outputTokens !== undefined,
            )
              ? tokens.toLocaleString()
              : '—'}
          </strong>
        </div>
        <div>
          <span>Reported cost</span>
          <strong>{dollars(reported)}</strong>
        </div>
        <div>
          <span>Estimated cost</span>
          <strong>{dollars(estimates)}</strong>
        </div>
      </div>
      <figure>
        <figcaption>
          Daily {costAvailable ? `${costSource} cost` : 'tokens'}
        </figcaption>
        <div
          className="engine-account-overview__chart"
          role="img"
          aria-label={`${engine} daily ${costAvailable ? `${costSource} cost` : 'tokens'} from ${data.window.from} to ${data.window.to}`}
        >
          {chartRows.map(({ day }, index) => (
            <span
              key={day}
              title={`${day}: ${values[index] === undefined ? 'Not reported' : costAvailable ? `$${values[index]?.toFixed(4)}` : values[index]?.toLocaleString()}`}
              data-unreported={values[index] === undefined || undefined}
              style={{
                height: `${Math.max(2, ((values[index] ?? 0) / peak) * 100)}%`,
              }}
            />
          ))}
        </div>
        <div className="engine-account-overview__axis">
          <span>{data.window.from}</span>
          <span>{data.window.to}</span>
        </div>
      </figure>
      <details>
        <summary>Token breakdown & capture coverage</summary>
        <small>
          Totals include reported values only. Missing token categories and
          turns remain gaps.
        </small>
        <Facts
          rows={[
            ...(
              [
                'inputTokens',
                'outputTokens',
                'cacheReadTokens',
                'cacheWriteTokens',
              ] as const
            ).map((key, index): [string, string | undefined] => [
              [
                'Input tokens',
                'Output tokens',
                'Cache read tokens',
                'Cache write tokens',
              ][index]!,
              rows.some((row) => row[key] !== undefined)
                ? rows
                    .reduce((sum, row) => sum + (row[key] ?? 0), 0)
                    .toLocaleString()
                : undefined,
            ]),
            [
              'Usage receipts',
              rows
                .reduce((sum, row) => sum + row.receiptCount, 0)
                .toLocaleString(),
            ],
            [
              'Pricing',
              [...new Set(rows.map((row) => row.pricingStatus))].join(', '),
            ],
            [
              'Estimate sources',
              [
                ...new Set(
                  estimates
                    .map((item) => item.pricingSnapshotSource)
                    .filter(Boolean),
                ),
              ].join(', ') || undefined,
            ],
            [
              'Pricing snapshots',
              [
                ...new Set(estimates.map((item) => item.pricingSnapshotId)),
              ].join(', ') || undefined,
            ],
          ]}
        />
        {data.coverage.map((coverage, index) => (
          <Facts
            key={`${coverage.stationId}:${index}`}
            rows={[
              ['Capture status', coverage.state],
              ['Source freshness', coverage.freshness],
              ['Source observed through', coverage.observedThrough],
              ['Source observed turns', coverage.observedTurnCount],
              ['Source turns with usage', coverage.usageReportedTurnCount],
              ['Source reason', coverage.reason],
              ['Dropped receipts', coverage.droppedReceiptCount],
              ...(coverage.providers
                ?.filter((provider) => provider.provider === engine)
                .flatMap((provider): FactRow[] => [
                  ['Provider capture', provider.state],
                  ['Observed turns', provider.observedTurnCount],
                  ['Turns with usage', provider.usageReportedTurnCount],
                  ['Freshness', provider.freshness],
                  ['Observed through', provider.observedThrough],
                  ['Reason', provider.reason],
                ]) ?? []),
            ]}
          />
        ))}
      </details>
      {partial && <small>Some activity is missing.</small>}
      <small>
        Reported and estimated costs are separate. Subscription allowance is not
        a bill.
      </small>
    </>
  );
}
