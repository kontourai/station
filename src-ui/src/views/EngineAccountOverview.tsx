import type {
  EngineAccountProviderMoney,
  EngineAccountUsageHistory,
  EngineAccountUsageMetadata,
} from '@kontourai/station-contracts/engine-accounts';
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
  const [activityScope, setActivityScope] = useState<'account' | 'engine'>(
    'engine',
  );
  const [days, setDays] = useState<7 | 30>(7);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!canManage) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [canManage]);
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
  const activity = useEngineActivityQuery(
    engine,
    days,
    scope,
    canReadActivity,
    activityScope === 'account' ? ref : undefined,
  );
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
            {canManage && usage.data?.planLabel && (
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
                  <strong>{remainingPercent(window.usedPercent)}% left</strong>
                </div>
                <meter
                  min={0}
                  max={100}
                  value={100 - window.usedPercent}
                  aria-label={`${window.label}: ${remainingPercent(window.usedPercent)}% remaining`}
                />
                {window.resetsAt && (
                  <small>
                    {resetCountdown(window.resetsAt, now)} · Resets{' '}
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
        {canManage &&
          !usage.isError &&
          !usage.isLoading &&
          usage.data?.metadata && (
            <AccountMetadata metadata={usage.data.metadata} />
          )}
      </section>
      {canManage && usage.data?.history && (
        <AllowanceHistory history={usage.data.history} days={days} now={now} />
      )}
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
        <label>
          Activity for
          <select
            value={activityScope}
            onChange={(event) =>
              setActivityScope(
                event.target.value === 'engine' ? 'engine' : 'account',
              )
            }
          >
            <option value="account">Selected account</option>
            <option value="engine">All engine accounts</option>
          </select>
        </label>
        <small>
          {activityScope === 'engine'
            ? 'This Station · this engine · all accounts'
            : 'This Station · selected profile · attributed runs'}
        </small>
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
function resetCountdown(at: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(at) - now) / 60000));
  if (!Number.isFinite(minutes)) return 'Reset time unavailable';
  if (!minutes) return 'Reset time passed; refresh allowance';
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60);
  return `Reset in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
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
function providerMoney(
  value: EngineAccountProviderMoney | undefined,
): string | undefined {
  return value
    ? new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: value.currency,
        minimumFractionDigits: value.exponent,
        maximumFractionDigits: value.exponent,
      }).format(value.amountMinor / 10 ** value.exponent)
    : undefined;
}
const yesNo = (value: boolean | undefined) =>
  value === undefined ? undefined : value ? 'Yes' : 'No';

function AccountMetadata({
  metadata,
}: {
  metadata: EngineAccountUsageMetadata;
}) {
  const {
    identity,
    credits,
    extraUsage,
    resetCredits,
    models,
    spending,
    limitDetails,
    weeklyBreakdown,
    memberDashboardAvailable,
    capture,
  } = metadata;
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
                  [
                    'Extra usage disabled by user',
                    yesNo(extraUsage.userDisabled),
                  ],
                  ['Credits previously enabled', yesNo(extraUsage.everEnabled)],
                  ['Extra usage currency', extraUsage.currency],
                  ['Extra usage decimal places', extraUsage.decimalPlaces],
                  ['Extra usage disabled reason', extraUsage.disabledReason],
                ] satisfies FactRow[])
              : []),
            ...(spending
              ? ([
                  ['Provider spend', providerMoney(spending.used)],
                  ['Spend limit', providerMoney(spending.limit)],
                  ['Spending balance', providerMoney(spending.balance)],
                  ['Spending cap', providerMoney(spending.cap)],
                  [
                    'Spending used',
                    spending.usedPercent === undefined
                      ? undefined
                      : `${spending.usedPercent}%`,
                  ],
                  ['Spending enabled', yesNo(spending.enabled)],
                  ['Spend severity', spending.severity],
                  [
                    'Credit purchase available',
                    yesNo(spending.canPurchaseCredits),
                  ],
                  ['Spending setting can change', yesNo(spending.canToggle)],
                  ['Spending disabled reason', spending.disabledReason],
                ] satisfies FactRow[])
              : []),
            ...(memberDashboardAvailable !== undefined
              ? ([
                  [
                    'Provider member dashboard',
                    yesNo(memberDashboardAvailable),
                  ],
                ] satisfies FactRow[])
              : []),
          ]}
        />
        {!identity && !credits && !extraUsage && !resetCredits && !spending && (
          <Empty variant="compact" label="Account details unavailable" />
        )}
        {spending?.disclaimer && <small>{spending.disclaimer}</small>}
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
      {!!weeklyBreakdown?.rows.length && (
        <details>
          <summary>Weekly usage breakdown</summary>
          <Facts
            rows={[
              [
                'As of',
                weeklyBreakdown.asOf
                  ? new Date(weeklyBreakdown.asOf).toLocaleString()
                  : undefined,
              ],
              [
                'Window started',
                weeklyBreakdown.windowStartedAt
                  ? new Date(weeklyBreakdown.windowStartedAt).toLocaleString()
                  : undefined,
              ],
              ...weeklyBreakdown.rows.map(
                (row): FactRow => [
                  row.label,
                  row.usedPercent === undefined
                    ? undefined
                    : `${row.usedPercent}%`,
                ],
              ),
            ]}
          />
        </details>
      )}
      {!!limitDetails?.length && (
        <details>
          <summary>Provider limit details</summary>
          {limitDetails.map((limit, index) => (
            <Facts
              key={index}
              rows={[
                ['Limit kind', limit.kind],
                ['Group', limit.group],
                ['Active', yesNo(limit.active)],
                [
                  'Used',
                  limit.usedPercent === undefined
                    ? undefined
                    : `${limit.usedPercent}%`,
                ],
                ['Severity', limit.severity],
                [
                  'Reset time',
                  limit.resetsAt
                    ? new Date(limit.resetsAt).toLocaleString()
                    : undefined,
                ],
                ['Model', limit.model],
                ['Model ID', limit.modelId],
                ['Surface', limit.surface],
              ]}
            />
          ))}
        </details>
      )}
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
            [
              'Credential source',
              capture.credentialStorage === 'secure-store'
                ? 'Selected secure-store namespace'
                : capture.credentialStorage === 'file'
                  ? 'Selected credential file'
                  : undefined,
            ],
            [
              'Storage',
              'Live reading; history retains allowance observations only',
            ],
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

const percentFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
function remainingPercent(usedPercent: number): string {
  const remaining = 100 - usedPercent;
  return remaining > 0 && remaining < 0.1
    ? '<0.1'
    : percentFormatter.format(remaining);
}
function historyWindowKey(
  window: EngineAccountUsageHistory['observations'][number]['windows'][number],
): string {
  return JSON.stringify([
    window.id,
    window.label,
    window.durationSeconds ?? null,
  ]);
}
function historyDuration(seconds: number | undefined): string {
  if (seconds === undefined) return 'duration unknown';
  const [value, unit]: [number, string] =
    seconds >= 86400
      ? [seconds / 86400, 'd']
      : seconds >= 3600
        ? [seconds / 3600, 'h']
        : seconds >= 60
          ? [seconds / 60, 'm']
          : [seconds, 's'];
  return `${percentFormatter.format(value)}${unit}`;
}
function AllowanceHistory({
  history,
  days,
  now,
}: {
  history: EngineAccountUsageHistory;
  days: 7 | 30;
  now: number;
}) {
  const [selected, setSelected] = useState('');
  const [tableOpen, setTableOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const points = history.observations.filter(
    (point) => Date.parse(point.fetchedAt) >= now - days * 86400000,
  );
  const windows = new Map(
    [...points]
      .reverse()
      .flatMap((point) =>
        point.windows.map(
          (window) => [historyWindowKey(window), window] as const,
        ),
      ),
  );
  const labelCounts = new Map<string, number>();
  for (const window of windows.values())
    labelCounts.set(window.label, (labelCounts.get(window.label) ?? 0) + 1);
  const labels = new Map(
    [...windows].map(
      ([key, window]) =>
        [
          key,
          (labelCounts.get(window.label) ?? 0) > 1
            ? `${window.label} · ${historyDuration(window.durationSeconds)}`
            : window.label,
        ] as const,
    ),
  );
  const optionCounts = new Map<string, number>();
  for (const label of labels.values())
    optionCounts.set(label, (optionCounts.get(label) ?? 0) + 1);
  for (const [index, [key, label]] of [...labels].entries())
    if ((optionCounts.get(label) ?? 0) > 1)
      labels.set(key, `${label} · series ${index + 1}`);
  const id = windows.has(selected) ? selected : windows.keys().next().value;
  const observations = points.map((point) => ({
    fetchedAt: point.fetchedAt,
    window:
      point.status === 'ok'
        ? point.windows.find((window) => historyWindowKey(window) === id)
        : undefined,
  }));
  return (
    <section
      className="engine-account-overview__activity"
      aria-label="Allowance history"
    >
      <div className="engine-account-overview__activity-heading">
        <h3>Allowance history</h3>
        {windows.size > 0 && (
          <label>
            Limit
            <select
              value={id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {[...labels].map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {history.status === 'unavailable' ? (
        <p role="status">
          History could not be saved. Current limits are still available.
        </p>
      ) : !observations.length ? (
        <Empty
          variant="compact"
          label="History starts here"
          description="Refresh this account to capture allowance observations."
        />
      ) : (
        <>
          <figure>
            <figcaption>
              {labels.get(id ?? '') ?? 'Allowance'} · remaining at each
              observation · {days} days
            </figcaption>
            <svg
              className="engine-account-overview__history-chart"
              viewBox={`0 0 ${Math.max(1, observations.length)} 100`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${labels.get(id ?? '') ?? 'Allowance'} remaining history, ${observations.length} hourly observations`}
            >
              {observations.map((point, index) => {
                const remaining = point.window
                  ? 100 - point.window.usedPercent
                  : 0;
                return (
                  <rect
                    key={point.fetchedAt}
                    x={index}
                    y={100 - Math.max(2, remaining)}
                    width={0.8}
                    height={Math.max(2, remaining)}
                    data-unreported={!point.window || undefined}
                  >
                    <title>{`${new Date(point.fetchedAt).toLocaleString()}: ${point.window ? `${remainingPercent(point.window.usedPercent)}% remaining` : 'Not reported'}`}</title>
                  </rect>
                );
              })}
            </svg>
            <div className="engine-account-overview__axis">
              <span>
                {new Date(observations[0]!.fetchedAt).toLocaleDateString()}
              </span>
              <span>
                {new Date(observations.at(-1)!.fetchedAt).toLocaleDateString()}
              </span>
            </div>
          </figure>
          <details onToggle={(event) => setTableOpen(event.currentTarget.open)}>
            <summary>View observations</summary>
            {tableOpen && (
              <div className="engine-account-overview__history-table">
                <table>
                  <caption>
                    Last {history.retentionDays} days at capture. Gaps are
                    unreported; closed profiles are not automatically purged.
                  </caption>
                  <thead>
                    <tr>
                      <th>Observed</th>
                      <th>Remaining</th>
                      <th>Reset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...observations]
                      .reverse()
                      .slice(0, visibleCount)
                      .map((point) => (
                        <tr key={point.fetchedAt}>
                          <td>{new Date(point.fetchedAt).toLocaleString()}</td>
                          <td>
                            {point.window
                              ? `${remainingPercent(point.window.usedPercent)}%`
                              : 'Not reported'}
                          </td>
                          <td>
                            {point.window?.resetsAt
                              ? new Date(point.window.resetsAt).toLocaleString()
                              : 'Not reported'}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {visibleCount < observations.length && (
                  <Button
                    onClick={() => setVisibleCount((count) => count + 50)}
                  >
                    Show older observations
                  </Button>
                )}
              </div>
            )}
          </details>
        </>
      )}
      <small>Hourly snapshots · captured on page refresh</small>
    </section>
  );
}
function Activity({ data, engine }: { data: UsageRollup; engine: string }) {
  const [currency, setCurrency] = useState('USD');
  const [metric, setMetric] = useState<
    'auto' | 'tokens' | 'reported' | 'estimated'
  >('auto');
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
  const amountLabel = (amount: number, currency: string) =>
    currency === 'USD'
      ? `$${amount.toFixed(2)}`
      : `${currency} ${amount.toFixed(2)}`;
  const costTotal = (items: Array<{ amount: number; currency: string }>) => {
    const totals = new Map<string, number>();
    for (const item of items)
      totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amount);
    return (
      [...totals]
        .map(([currency, amount]) => amountLabel(amount, currency))
        .join(' · ') || '—'
    );
  };
  const costSource =
    metric === 'reported' || metric === 'estimated'
      ? metric
      : reported.length
        ? 'reported'
        : 'estimated';
  const chartCosts = costSource === 'reported' ? reported : estimates;
  const currencies = [...new Set(chartCosts.map((item) => item.currency))];
  const chartCurrency = currencies.includes(currency)
    ? currency
    : (currencies[0] ?? 'USD');
  const costAvailable =
    metric !== 'tokens' && (metric !== 'auto' || chartCosts.length > 0);
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
    const amounts = (cost ? [cost] : (buckets ?? [])).filter(
      (item) => item.currency === chartCurrency,
    );
    return costAvailable
      ? amounts.length
        ? amounts.reduce((sum, item) => sum + item.amount, 0)
        : undefined
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
          <strong>{costTotal(reported)}</strong>
        </div>
        <div>
          <span>Estimated cost</span>
          <strong>{costTotal(estimates)}</strong>
        </div>
      </div>
      <fieldset aria-label="Trend measure">
        {(['tokens', 'reported', 'estimated'] as const).map((value) => (
          <Button
            key={value}
            aria-pressed={
              metric === value ||
              (metric === 'auto' &&
                (costAvailable ? costSource === value : value === 'tokens'))
            }
            onClick={() => setMetric(value)}
          >
            {value === 'tokens'
              ? 'Tokens'
              : value === 'reported'
                ? 'Reported cost'
                : 'Estimated cost'}
          </Button>
        ))}
      </fieldset>
      {costAvailable && currencies.length > 1 && (
        <label>
          Currency
          <select
            value={chartCurrency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {currencies.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      )}
      {costAvailable && !chartCosts.length && (
        <small>No {costSource} cost observations in this period.</small>
      )}
      <figure>
        <figcaption>
          Daily {costAvailable ? `${costSource} cost` : 'tokens'}
        </figcaption>
        {costAvailable && <small>{chartCurrency}</small>}
        <div
          className="engine-account-overview__chart"
          role="img"
          aria-label={`${engine} daily ${costAvailable ? `${costSource} cost` : 'tokens'} from ${data.window.from} to ${data.window.to}`}
        >
          {chartRows.map(({ day }, index) => (
            <span
              key={day}
              title={`${day}: ${values[index] === undefined ? 'Not reported' : costAvailable ? amountLabel(values[index]!, chartCurrency) : values[index]?.toLocaleString()}`}
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
