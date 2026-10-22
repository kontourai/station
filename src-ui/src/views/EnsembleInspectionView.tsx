import type { EnsembleInspectionInput } from '@kontourai/station-contracts/ensemble';
import { useInspectEnsemble } from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../components/Button';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useNavigationActions } from '../contexts/NavigationContext';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { CliSessionGroupsPanel } from './CliSessionGroupsPanel';
import { EnsembleCliGroupForm } from './EnsembleCliGroupForm';
import { EnsemblePresetUpload } from './EnsemblePresetUpload';
import { layoutEnsembleInspection } from './ensemble-inspection-layout';
import './EnsembleInspectionView.css';

export function EnsembleInspectionView() {
  const scope = useHostRequestAuthorityScope();
  const { navigate } = useNavigationActions();
  return (
    <section className="ensemble-inspection" aria-label="Ensemble inspection">
      <Button
        variant="secondary"
        onClick={() => navigate('/agents', { tab: null })}
      >
        Agents
      </Button>
      <h1>Inspect an Ensemble</h1>
      <p>
        Read configuration from a preset on This Station. Inspection does not
        authenticate, discover models or launch members.
      </p>
      {scope && (
        <EnsemblePresetUpload
          key={`upload:${scope.apiBase}:${scope.authorityKey}`}
          scope={scope}
        />
      )}
      {scope ? (
        <InspectionForm
          key={`${scope.apiBase}:${scope.authorityKey}`}
          scope={scope}
        />
      ) : (
        <p role="alert">Current Station authority is unavailable.</p>
      )}
      {scope && (
        <CliSessionGroupsPanel
          key={`groups:${scope.apiBase}:${scope.authorityKey}`}
          scope={scope}
        />
      )}
    </section>
  );
}

function InspectionForm({
  scope,
}: {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const inspection = useInspectEnsemble(scope);
  const { navigate } = useNavigationActions();
  const [path, setPath] = useState('');
  const [groupDraftDirty, setGroupDraftDirty] = useState(false);
  const { guard, DiscardModal } = useUnsavedGuard(groupDraftDirty);
  const [source, setSource] = useState<{ hash: string; memberIds: string[] }>();
  const [bindings, setBindings] = useState<EnsembleInspectionInput['bindings']>(
    {},
  );
  const result = scope.isCurrent() ? inspection.data : undefined;
  const geometry = result && layoutEnsembleInspection(result.facts);
  const failure =
    inspection.error instanceof StationHttpError &&
    inspection.error.status === 403
      ? 'Inspection denied. Use the current locally granted operator on a personal Station.'
      : inspection.error instanceof StationHttpError &&
          inspection.error.status === 409
        ? 'Inspection is stale. Reload the source and select the receiver bindings again.'
        : 'Inspection unavailable. Check current Station authority, the source file and exact receiver IDs.';
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const selected = Object.fromEntries(
            Object.entries(bindings).filter(
              ([, binding]) => binding.agent || binding.projectSlug,
            ),
          );
          inspection.mutate(
            {
              path,
              bindings: selected,
              ...(source ? { expectedPresetHash: source.hash } : {}),
            },
            {
              onSuccess: (data) =>
                setSource({
                  hash: data.source.sha256,
                  memberIds: data.facts
                    .filter((fact) => fact.id.startsWith('member:'))
                    .flatMap((fact) => (fact.memberId ? [fact.memberId] : [])),
                }),
            },
          );
        }}
      >
        <label>
          Preset path on This Station
          <input
            value={path}
            maxLength={4096}
            required
            autoComplete="off"
            spellCheck={false}
            disabled={inspection.isPending}
            onChange={(event) => {
              const nextPath = event.target.value;
              guard(() => {
                setGroupDraftDirty(false);
                setPath(nextPath);
                setSource(undefined);
                setBindings({});
                inspection.reset();
              });
            }}
          />
        </label>
        {source?.memberIds.map((id) => (
          <fieldset key={id} disabled={inspection.isPending || groupDraftDirty}>
            <legend>Receiver binding for {id}</legend>
            <label>
              Agent ID
              <input
                value={bindings[id]?.agent ?? ''}
                maxLength={64}
                autoComplete="off"
                onChange={(event) => {
                  setBindings({
                    ...bindings,
                    [id]: {
                      agent: event.target.value,
                      projectSlug: bindings[id]?.projectSlug ?? '',
                    },
                  });
                  inspection.reset();
                }}
              />
            </label>
            <label>
              Project ID
              <input
                value={bindings[id]?.projectSlug ?? ''}
                maxLength={128}
                autoComplete="off"
                onChange={(event) => {
                  setBindings({
                    ...bindings,
                    [id]: {
                      projectSlug: event.target.value,
                      agent: bindings[id]?.agent ?? '',
                    },
                  });
                  inspection.reset();
                }}
              />
            </label>
          </fieldset>
        ))}
        <Button
          type="submit"
          pending={inspection.isPending}
          disabled={!scope.isCurrent() || !path || groupDraftDirty}
          pendingLabel="Inspecting…"
        >
          Inspect configuration
        </Button>
        {source && (
          <Button
            variant="secondary"
            type="button"
            disabled={inspection.isPending}
            onClick={() => {
              guard(() => {
                setGroupDraftDirty(false);
                setSource(undefined);
                setBindings({});
                inspection.reset();
              });
            }}
          >
            Reload source
          </Button>
        )}
      </form>
      {inspection.isError && <p role="alert">{failure}</p>}
      {source && result && scope.isCurrent() && (
        <EnsembleCliGroupForm
          key={`${path}:${source.hash}`}
          scope={scope}
          path={path}
          hash={source.hash}
          memberIds={source.memberIds}
          onDirtyChange={setGroupDraftDirty}
        />
      )}
      <DiscardModal />
      {result && (
        <>
          <h2>{result.source.name}</h2>
          <p>
            Source <code>{result.source.sha256}</code> · Environment{' '}
            {result.environmentId} · Observed {result.observedAt}
          </p>
          <p>{result.limits}</p>
          <section
            className="ensemble-inspection__table"
            aria-label="Scrollable Ensemble configuration and provenance"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll this wide table.
            tabIndex={0}
          >
            <table>
              <caption>Ensemble configuration and provenance</caption>
              <thead>
                <tr>
                  {[
                    'Category',
                    'Member / setting',
                    'Value',
                    'Origin',
                    'State',
                    'Owner / receipt',
                  ].map((heading) => (
                    <th scope="col" key={heading}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.facts.map((fact) => (
                  <tr key={fact.id} id={`ensemble-fact-${fact.id}`}>
                    <td>{fact.category}</td>
                    <th scope="row">
                      {fact.memberId && `${fact.memberId}: `}
                      {fact.label}
                    </th>
                    <td>{fact.value}</td>
                    <td>{fact.origin}</td>
                    <td>{fact.state}</td>
                    <td>
                      {fact.owner.href ? (
                        <a
                          href={fact.owner.href}
                          onClick={(event) => {
                            const target = fact.owner.href;
                            if (
                              target &&
                              !event.metaKey &&
                              !event.ctrlKey &&
                              !event.shiftKey &&
                              event.button === 0
                            ) {
                              event.preventDefault();
                              navigate(target);
                            }
                          }}
                        >
                          {fact.owner.label}
                        </a>
                      ) : (
                        fact.owner.label
                      )}
                      {fact.owner.receipt?.startsWith('resolution:') ? (
                        <a href={`#ensemble-resolution-${fact.memberId}`}>
                          Resolution receipt
                        </a>
                      ) : (
                        fact.owner.receipt && <code>{fact.owner.receipt}</code>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {result.resolutions.map(({ memberId, receipt }) => (
            <details key={memberId} id={`ensemble-resolution-${memberId}`}>
              <summary>Resolution receipt for {memberId}</summary>
              <pre>{JSON.stringify(receipt, null, 2)}</pre>
            </details>
          ))}
          {geometry && (
            <figure>
              <figcaption>
                Configuration diagram. Lines connect members to inspected
                settings; they are not routing or runtime edges. The table
                contains every value and owner link.
              </figcaption>
              <div className="ensemble-inspection__diagram">
                <svg
                  width={geometry.width}
                  height={geometry.height}
                  role="img"
                  aria-label="Member configuration relationships; full details in the configuration table"
                >
                  {geometry.edges.map((edge) => (
                    <path
                      key={`${edge.from.fact.id}:${edge.to.fact.id}`}
                      d={`M${edge.from.x + 110},${edge.from.y + 40} L${edge.to.x + 110},${edge.to.y + 40}`}
                    />
                  ))}
                  {geometry.nodes.map(({ fact, x, y }) => (
                    <g key={fact.id} transform={`translate(${x},${y})`}>
                      <rect width="220" height="80" rx="4" />
                      <text x="8" y="20">
                        {fact.label.slice(0, 26)}
                      </text>
                      <text x="8" y="40">
                        {fact.state} · {fact.origin}
                      </text>
                      <text x="8" y="60">
                        {fact.memberId ?? fact.category}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
            </figure>
          )}
        </>
      )}
    </>
  );
}
