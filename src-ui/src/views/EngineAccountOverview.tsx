import type {
  EngineAccountProviderMoney,
  EngineAccountUsageMetadata,
} from '@kontourai/station-contracts/engine-accounts';
import {
  type EngineAccount,
  useCreateEngineAccountMutation,
  useEngineAccountLoginMutation,
  useEngineAccountLoginQuery,
  useEngineAccountsQuery,
  useEngineAccountUsageQuery,
} from '@kontourai/station-sdk/engine-accounts';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { ResponsiveSurfaceActions } from '../components/ResponsiveDialogSurface';
import { FactList } from '../components/resource-hub/FactList';
import { Meter } from '../components/resource-hub/Meter';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../components/state';
import type { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useCoarseNow } from '../hooks/useCoarseNow';
import { openExternalLink } from '../platform/openExternalLink';
import { describeStationFailure } from '../utils/stationFailure';
import { useEngineAccountAccess } from './engine-detail/useEngineAccountAccess';
import './EngineAccountOverview.css';

export function EngineAccountOverview({
  connectionId,
  engine,
}: {
  connectionId: string;
  engine: 'claude' | 'codex';
}) {
  const { scope, authority, canManage, canLogin } = useEngineAccountAccess();
  if (!scope) return <p>Connect to this Station to view accounts.</p>;
  if (authority.isLoading)
    return <SkeletonBlock count={2} label="Loading account access" />;
  if (authority.isError || !authority.data)
    return (
      <ErrorState
        variant="compact"
        title="Account access could not be checked"
        description={describeReadFailure(authority.error)}
        action={<Button onClick={() => void authority.refetch()}>Retry</Button>}
      />
    );
  return (
    <AccountPage
      key={`${scope.apiBase}:${scope.authorityKey}:${connectionId}`}
      connectionId={connectionId}
      engine={engine}
      scope={scope}
      canManage={canManage}
      canLogin={canLogin}
    />
  );
}

function AccountPage({
  connectionId,
  engine,
  scope,
  canManage,
  canLogin,
}: {
  connectionId: string;
  engine: 'claude' | 'codex';
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  canManage: boolean;
  canLogin: boolean;
}) {
  const [selected, setSelected] = useState<string | null | undefined>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState('');
  const now = useCoarseNow(undefined, {
    intervalMs: 60_000,
    enabled: canManage,
  });
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
  const create = useCreateEngineAccountMutation(connectionId, scope);
  const refresh = () => {
    void accounts.refetch();
    if (canManage) void usage.refetch();
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
      aria-label={`${engine === 'codex' ? 'Codex' : 'Claude'} accounts`}
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
              <Meter
                key={window.id}
                label={window.label}
                usedPercent={window.usedPercent}
              >
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
              </Meter>
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
      onError: (error) => setFailure(describeStationFailure(error).body),
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
  return <FactList facts={rows.map(([label, value]) => ({ label, value }))} />;
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
