import '@kontourai/surface/trust-panel/element';
import type { LayoutComponentProps } from '@kontourai/station-sdk';
import {
  telemetry,
  useApiBase,
  useFlowRunsQuery,
  useNavigation,
} from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import './builder-delivery-viewer.css';

const PLUGIN = 'builder-delivery-viewer';

type Session = {
  slug: string;
  state: {
    status: string;
    phase: string;
    updated_at: string;
    next_action?: { summary?: string };
    flow_run?: { run_id?: string };
  };
  validation: Record<string, { valid: boolean; warning?: string }>;
  acceptance?: {
    criteria?: Array<{ id: string; status: string; description: string }>;
  } | null;
  claims?: {
    checks: PublishedClaim[];
    critiques: PublishedClaim[];
    gates: PublishedClaim[];
  };
  seal?: { available: boolean; companions: string[] };
  report?: unknown;
};

type PublishedClaim = {
  id: string;
  fieldOrBehavior?: string;
  value?: unknown;
  status?: string;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'surface-trust-panel': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}

function endpoint(base: string, project: string, suffix = '') {
  return `${base}/api/plugins/${PLUGIN}/projects/${encodeURIComponent(project)}/builder-sessions${suffix}`;
}

async function load<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || body.success === false)
    throw new Error(body.error ?? 'request failed');
  return body;
}

function TrustPanel({ report }: { report?: unknown }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (ref.current)
      (ref.current as HTMLElement & { report?: unknown }).report = report;
  }, [report]);
  return <surface-trust-panel ref={ref} heading="Surface trust report" />;
}

function claimValue(value: unknown) {
  if (value === undefined) return 'value unavailable';
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'structured value';
}

function ClaimList({
  empty,
  items,
}: {
  empty: string;
  items?: PublishedClaim[];
}) {
  if (!items?.length) return <p>{empty}</p>;
  return (
    <ul>
      {items.map((claim) => (
        <li key={claim.id}>
          <strong>{claim.fieldOrBehavior ?? claim.id}</strong>:{' '}
          {claim.status ?? 'status unavailable'} — {claimValue(claim.value)}
        </li>
      ))}
    </ul>
  );
}

export function BuilderDeliveryViewer(_props: LayoutComponentProps) {
  const { apiBase } = useApiBase();
  const navigation = useNavigation() as { selectedProject?: string | null };
  const project = navigation.selectedProject ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [PLUGIN, project],
    queryFn: () =>
      load<{ sessions: Session[]; truncated: boolean }>(
        endpoint(apiBase, project!),
      ),
    enabled: !!project,
  });
  const activeSelection =
    selected && list.data?.sessions.some((entry) => entry.slug === selected)
      ? selected
      : (list.data?.sessions[0]?.slug ?? null);
  const session = useQuery({
    queryKey: [PLUGIN, project, activeSelection],
    queryFn: () =>
      load<{ session: Session }>(
        endpoint(apiBase, project!, `/${encodeURIComponent(activeSelection!)}`),
      ),
    enabled: !!project && !!activeSelection,
  });
  const runs = useFlowRunsQuery(project);

  useEffect(() => {
    if (list.isSuccess)
      telemetry.track('plugin.builder_delivery_viewer.list', {
        outcome: 'loaded',
      });
    if (list.isError)
      telemetry.track('plugin.builder_delivery_viewer.list', {
        outcome: 'error',
      });
  }, [list.isError, list.isSuccess]);
  const item = session.data?.session;
  const explicitRunId = item?.state.flow_run?.run_id;
  const joined = explicitRunId
    ? runs.data?.find((run) => run.run_id === explicitRunId)
    : undefined;
  useEffect(() => {
    if (!item) return;
    telemetry.track('plugin.builder_delivery_viewer.join', {
      outcome: explicitRunId
        ? runs.isLoading
          ? 'loading'
          : runs.error
            ? 'error'
            : joined
              ? 'exact-match'
              : 'unmatched'
        : 'missing',
    });
  }, [explicitRunId, item, joined, runs.error, runs.isLoading]);

  if (!project)
    return (
      <p className="bdv-state">
        Select a project to inspect published Builder artifacts.
      </p>
    );
  if (list.isLoading)
    return <p className="bdv-state">Loading Builder sessions…</p>;
  if (list.error)
    return (
      <p className="bdv-state bdv-state--error">
        Builder artifacts unavailable: {String(list.error.message)}
      </p>
    );
  return (
    <div className="bdv" data-testid="builder-delivery-viewer">
      <aside aria-label="Builder sessions" className="bdv__rail">
        <h2>Builder sessions</h2>
        {list.data?.truncated && (
          <p className="bdv-state">
            Showing the first 100 sessions; additional sessions were not read.
          </p>
        )}
        {list.data?.sessions.length ? (
          list.data.sessions.map((entry) => (
            <button
              key={entry.slug}
              type="button"
              className={activeSelection === entry.slug ? 'is-selected' : ''}
              onClick={() => {
                telemetry.track('plugin.builder_delivery_viewer.selection', {
                  outcome: 'selected',
                });
                setSelected(entry.slug);
              }}
            >
              <strong>{entry.slug}</strong>
              <span>
                {entry.state.status} · {entry.state.phase}
              </span>
              <small>{entry.state.updated_at}</small>
            </button>
          ))
        ) : (
          <p className="bdv-state">
            No published Builder session state exists in this workspace.
          </p>
        )}
      </aside>
      <main className="bdv__detail">
        {session.isLoading && (
          <p className="bdv-state">Loading selected session…</p>
        )}
        {session.error && (
          <p className="bdv-state bdv-state--error">
            Session unavailable: {String(session.error.message)}
          </p>
        )}
        {item && (
          <>
            <h1>{item.slug}</h1>
            <p>
              Next action: {item.state.next_action?.summary ?? 'unavailable'}
            </p>
            <section>
              <h2>Artifact validation</h2>
              {Object.entries(item.validation).map(([name, result]) => (
                <p key={name}>
                  {name}:{' '}
                  {result.valid
                    ? 'valid'
                    : `unavailable — ${result.warning ?? 'invalid'}`}
                </p>
              ))}
            </section>
            <section>
              <h2>Flow run</h2>
              {!explicitRunId ? (
                <p>Not joinable: Builder state has no explicit Flow run ID.</p>
              ) : runs.isLoading ? (
                <p>Flow runs are loading; join status is not evaluated yet.</p>
              ) : runs.error ? (
                <p>
                  Flow runs unavailable; explicit run ID {explicitRunId} was not
                  evaluated: {String(runs.error.message)}
                </p>
              ) : joined ? (
                <p>
                  Joined exactly to {joined.run_id} ({joined.status}).
                </p>
              ) : (
                <p>
                  Not joinable: explicit run ID {explicitRunId} is not present
                  in this project.
                </p>
              )}
            </section>
            <section>
              <h2>Delivery seal companions</h2>
              <p>
                {item.seal?.available
                  ? item.seal.companions.length
                    ? item.seal.companions.join(', ')
                    : 'No published companion filenames found.'
                  : 'Delivery directory unavailable.'}
              </p>
            </section>
            <section>
              <h2>Acceptance criteria</h2>
              {item.acceptance?.criteria?.length ? (
                item.acceptance.criteria.map((criterion) => (
                  <p key={criterion.id}>
                    {criterion.id}: {criterion.status} — {criterion.description}
                  </p>
                ))
              ) : (
                <p>Acceptance artifact unavailable or invalid.</p>
              )}
            </section>
            <section>
              <h2>Published metadata</h2>
              <h3>Gate claims</h3>
              <ClaimList
                items={item.claims?.gates}
                empty="No published gate claims."
              />
              <h3>Evidence checks</h3>
              <ClaimList
                items={item.claims?.checks}
                empty="No published evidence checks."
              />
              <h3>Critique history</h3>
              <ClaimList
                items={item.claims?.critiques}
                empty="No published critique claims."
              />
            </section>
            {item.report ? (
              <TrustPanel report={item.report} />
            ) : (
              <p className="bdv-state">
                Surface trust report unavailable because the published trust
                bundle is invalid or missing.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export const components = {
  'builder-delivery-viewer-main': BuilderDeliveryViewer,
};

export default BuilderDeliveryViewer;
