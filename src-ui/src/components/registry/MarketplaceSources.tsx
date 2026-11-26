import type { RegistrySource } from '@kontourai/station-contracts/catalog';
import {
  useRegistrySourceActionMutation,
  useRegistrySourcesQuery,
} from '@kontourai/station-sdk';
import { Badge } from '@kontourai/ui/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { describeStationFailure } from '../../utils/stationFailure';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SkeletonList } from '../state';
import {
  countLabel,
  coverageLabel,
  distinctLabels,
  isBrowsable,
  kindTone,
  locationHint,
  overlappingSources,
  statusTone,
  suppliedKinds,
  suppliesAny,
  trustTier,
} from './marketplaceSourceModel';

type CatalogKind = RegistrySource['kind'];
type OnSelect = (
  id: string,
  kind?: CatalogKind,
  supplied?: readonly CatalogKind[],
) => void;

function relative(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString();
}

const NOTHING_RECOGNIZED =
  'Nothing Station recognizes yet. It looks for SKILL.md skills, a Station manifest, Claude Code marketplaces and MCP definitions.';

function DetectedKinds({ source }: { source: RegistrySource }) {
  const detection = source.detection;
  if (!detection) {
    const coverage = coverageLabel(source);
    return coverage ? (
      <ul
        className="marketplaces__kinds"
        aria-label="What this source provides"
      >
        <li className="marketplaces__kind">
          <Badge
            value={coverage}
            tone={source.itemCount === undefined ? 'neutral' : 'active'}
          />
        </li>
      </ul>
    ) : null;
  }
  if (detection.state === 'nothing-recognized')
    return <p className="marketplaces__note">{NOTHING_RECOGNIZED}</p>;
  if (detection.kinds.length === 0) return null;
  return (
    <ul className="marketplaces__kinds" aria-label="What this source provides">
      {detection.kinds.map((kind) => (
        <li
          key={kind.kind}
          className="marketplaces__kind"
          title={kind.managedDenial ?? kind.note}
        >
          <Badge
            value={countLabel(kind.kind, kind.count)}
            tone={kindTone(kind)}
          />
          {kind.managedDenial !== undefined ? (
            <span> · blocked by policy</span>
          ) : !kind.installable ? (
            <span> · recognized, not installable</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Freshness({ source }: { source: RegistrySource }) {
  const detection = source.detection;
  const checked = relative(detection?.checkedAt ?? source.checkedAt);
  const changed = relative(detection?.changedAt);
  const revision = detection?.revision?.slice(0, 7);
  const parts = [
    checked ? `Checked ${checked}` : undefined,
    revision ? `revision ${revision}` : undefined,
    changed ? `changed upstream ${changed}` : undefined,
  ].filter(Boolean);
  if (parts.length === 0 && source.lastSuccessfulAt)
    parts.push(
      `Last successful catalog ${relative(source.lastSuccessfulAt) ?? ''}`,
    );
  return parts.length > 0 ? (
    <p className="marketplaces__meta">{parts.join(' · ')}</p>
  ) : null;
}

/**
 * Discover first: which source to browse, adding one, and a button that opens
 * the sources in a dialog, so managing them never pushes the catalog down.
 * `manage="inline"` keeps the collapsible list in place for a compact picker.
 */
export function MarketplaceSources({
  selected,
  onSelect,
  kinds,
  manage = 'inline',
}: {
  selected: string;
  /**
   * `kind` is the source's primary catalog kind; `supplied` lists every
   * catalog kind it supplies, so a view can keep its tab when it is one.
   */
  onSelect: OnSelect;
  kinds?: readonly CatalogKind[];
  manage?: 'inline' | 'dialog';
}) {
  const sources = useRegistrySourcesQuery();
  const mutation = useRegistrySourceActionMutation();
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState('');
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [added, setAdded] = useState<RegistrySource | null>(null);
  const [managing, setManaging] = useState(false);
  const result = useRef<HTMLParagraphElement>(null);
  const all = sources.data ?? [];
  const visible = all.filter((source) => suppliesAny(source, kinds));
  const labels = distinctLabels(all);
  // The form is replaced by the result: move focus into it, so it is
  // announced and focus does not fall back to the page.
  useEffect(() => {
    if (added) result.current?.focus();
  }, [added]);
  const closeDialog = () => {
    setOpen(false);
    setAdded(null);
    setLocation('');
    setRef('');
    setName('');
  };
  const browsable = added ? isBrowsable(added) : false;
  return (
    <section className="marketplaces" aria-label="Discover sources">
      <div className="marketplaces__toolbar">
        <label>
          Browse marketplace
          <select
            className="choice-trigger"
            value={selected}
            onChange={(event) => {
              const source = all.find(
                (candidate) => candidate.id === event.target.value,
              );
              onSelect(
                event.target.value,
                source?.kind,
                source ? suppliedKinds(source) : undefined,
              );
            }}
          >
            <option value="all">All sources</option>
            {visible.map((source) => (
              <option key={source.id} value={source.id}>
                {labels.get(source.id) ?? source.displayName}
                {locationHint(source) ? ` — ${locationHint(source)}` : ''}
                {!source.enabled ? ' (disabled)' : ''}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          onClick={() => {
            mutation.reset();
            setAdded(null);
            setOpen(true);
          }}
        >
          Add source
        </Button>
        {manage === 'dialog' && (
          <Button variant="secondary" onClick={() => setManaging(true)}>
            Manage sources ({visible.length})
          </Button>
        )}
      </div>
      {sources.error && (
        <p role="alert">
          Connected sources could not be loaded. Check your connection and
          operator access.
          <Button variant="secondary" onClick={() => void sources.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {manage === 'inline' && (
        <MarketplaceSourceManager
          selected={selected}
          onSelect={onSelect}
          kinds={kinds}
        />
      )}
      {managing && (
        <Dialog
          title="Manage sources"
          closeLabel="Close manage sources"
          onClose={() => setManaging(false)}
          footer={
            <Button variant="secondary" onClick={() => setManaging(false)}>
              Close
            </Button>
          }
        >
          <MarketplaceSourceManager
            selected={selected}
            onSelect={onSelect}
            kinds={kinds}
            presentation="list"
          />
        </Dialog>
      )}
      {open && (
        <Dialog
          title={
            added
              ? `Added ${labels.get(added.id) ?? added.displayName}`
              : 'Add source'
          }
          closeLabel="Close add source"
          onClose={closeDialog}
          footer={
            added ? (
              browsable ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    onSelect(added.id, added.kind, suppliedKinds(added));
                    closeDialog();
                  }}
                >
                  Browse this source
                </Button>
              ) : (
                <Button variant="primary" onClick={closeDialog}>
                  Done
                </Button>
              )
            ) : (
              <>
                <Button variant="secondary" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={mutation.isPending || !location.trim()}
                  onClick={() =>
                    mutation.mutate(
                      {
                        action: 'add',
                        source: {
                          location: location.trim(),
                          ...(ref.trim() ? { ref: ref.trim() } : {}),
                          ...(name.trim() ? { displayName: name.trim() } : {}),
                        },
                      },
                      {
                        onSuccess: (source) => {
                          if (source) setAdded(source);
                          else closeDialog();
                        },
                      },
                    )
                  }
                >
                  {mutation.isPending ? 'Reading source…' : 'Add source'}
                </Button>
              </>
            )
          }
        >
          {added ? (
            // A live region: the outcome is announced as well as focused.
            <div className="marketplaces__form" role="status">
              <p ref={result} tabIndex={-1} className="marketplaces__result">
                {added.detection?.state === 'detected'
                  ? 'Station read this source and found:'
                  : added.detection?.state === 'nothing-recognized'
                    ? NOTHING_RECOGNIZED
                    : (added.detection?.reason ??
                      'Station could not read this source yet. Refresh it once it is available.')}
              </p>
              <DetectedKinds source={added} />
              <p className="marketplaces__note">
                {browsable
                  ? 'Nothing is installed yet. Choose items from the catalog and approve each one when you install it.'
                  : 'There is nothing to install from it yet. It stays in Manage sources, where you can refresh or remove it.'}
              </p>
            </div>
          ) : (
            <div className="marketplaces__form">
              <p>
                Station reads the source and lists what it contains (skills,
                plugins and agents) from its files. You don't pick a type.
              </p>
              <label>
                Location
                <input
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="https://github.com/owner/repository or /path/on/this/station"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                Ref (optional)
                <input
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder="main, v1.2.0 or a commit"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                />
                <span className="marketplaces__hint">
                  A branch, tag or commit of a GitHub repository. Leave empty
                  for its default branch.
                </span>
              </label>
              <label>
                Name (optional)
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                />
              </label>
              <p className="marketplaces__note">
                Public GitHub repositories, folders and files on this Station,
                and HTTPS catalog addresses are supported. Credential-bearing
                addresses are not.
              </p>
              {mutation.error && (
                <p role="alert">
                  {describeStationFailure(mutation.error).body}
                </p>
              )}
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}

/**
 * Every connected source as a card: trust, what it provides, freshness.
 * `details` collapses it behind a summary; `list` shows it open (in a dialog).
 */
export function MarketplaceSourceManager({
  selected,
  onSelect,
  kinds,
  presentation = 'details',
}: {
  selected: string;
  onSelect: OnSelect;
  kinds?: readonly CatalogKind[];
  presentation?: 'details' | 'list';
}) {
  const sources = useRegistrySourcesQuery();
  const mutation = useRegistrySourceActionMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const all = sources.data ?? [];
  const visible = all.filter((source) => suppliesAny(source, kinds));
  const labels = distinctLabels(all);
  const act = (
    source: RegistrySource,
    action: 'enable' | 'disable' | 'refresh' | 'remove',
  ) => {
    setNotice(null);
    mutation.mutate(
      { id: source.id, action },
      {
        onSuccess: () => {
          if (action === 'remove' && selected === source.id) onSelect('all');
          setNotice(
            action === 'remove'
              ? 'Source removed. Installed content is preserved in your Library.'
              : action === 'refresh'
                ? 'Source read again.'
                : 'Source updated.',
          );
        },
      },
    );
  };
  return (
    <section className="marketplaces__manager" aria-label="Connected sources">
      <Wrapper
        presentation={presentation}
        summary={`Manage sources (${visible.length})`}
      >
        <p className="marketplaces__note">
          A source makes its catalog available; it installs nothing. Each item
          still needs its own installation and approval. Publisher metadata does
          not establish Station endorsement.
        </p>
        {sources.isLoading && (
          <SkeletonList count={3} label="Loading sources" />
        )}
        <div className="marketplaces__grid">
          {visible.map((source) => {
            const tier = trustTier(source);
            const label = labels.get(source.id) ?? source.displayName;
            const unread =
              source.detection?.state === 'refused' ||
              source.detection?.state === 'unavailable';
            const overlaps = overlappingSources(source, all);
            return (
              <article key={source.id} className="marketplaces__source">
                <header className="marketplaces__source-head">
                  <strong className="marketplaces__source-name">{label}</strong>
                  <span title={tier.detail}>
                    <Badge value={tier.label} tone={tier.tone} />
                  </span>
                  {source.status !== 'unknown' && (
                    <Badge
                      value={source.status}
                      tone={statusTone(source.status)}
                    />
                  )}
                </header>
                <p className="marketplaces__meta">{tier.detail}</p>
                {source.location && (
                  <code className="marketplaces__location">
                    {source.location}
                    {source.ref ? ` @ ${source.ref}` : ''}
                  </code>
                )}
                <DetectedKinds source={source} />
                <Freshness source={source} />
                {overlaps.length > 0 && (
                  <p className="marketplaces__note">
                    Overlaps{' '}
                    {overlaps
                      .map((other) => labels.get(other.id) ?? other.displayName)
                      .join(', ')}
                    : the same items can appear from each, as separate choices.
                  </p>
                )}
                {unread && source.detection?.reason ? (
                  <p role="status" className="marketplaces__problem">
                    {source.detection.reason}
                  </p>
                ) : (
                  source.error && (
                    <p role="status" className="marketplaces__problem">
                      {source.error}
                    </p>
                  )
                )}
                {source.managedDenial && (
                  <p role="status" className="marketplaces__problem">
                    {source.managedDenial}
                  </p>
                )}
                <ActionRow
                  className="marketplaces__actions"
                  overflowLabel={`More actions for ${label}`}
                  primary={
                    <Button
                      variant="secondary"
                      disabled={mutation.isPending || !source.enabled}
                      onClick={() => act(source, 'refresh')}
                    >
                      Refresh
                    </Button>
                  }
                  secondary={
                    source.origin !== 'plugin' ? (
                      <Button
                        variant="secondary"
                        // #4521: a source the managed policy refuses stays off.
                        disabled={
                          mutation.isPending ||
                          source.managedDenial !== undefined
                        }
                        onClick={() =>
                          act(source, source.enabled ? 'disable' : 'enable')
                        }
                      >
                        {source.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    ) : undefined
                  }
                  overflow={
                    source.origin === 'user'
                      ? [
                          {
                            key: 'remove',
                            label: 'Remove source',
                            tone: 'danger',
                            disabled: mutation.isPending,
                            onSelect: () => act(source, 'remove'),
                          },
                        ]
                      : []
                  }
                />
                {source.origin === 'plugin' && (
                  <p className="marketplaces__note">
                    Enable, disable, or revoke this source through its owning
                    plugin.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </Wrapper>
      {notice && <p role="status">{notice}</p>}
      {mutation.error && (
        <p role="alert">{describeStationFailure(mutation.error).body}</p>
      )}
    </section>
  );
}

function Wrapper({
  presentation,
  summary,
  children,
}: {
  presentation: 'details' | 'list';
  summary: string;
  children: ReactNode;
}) {
  if (presentation === 'list') return <>{children}</>;
  return (
    <details className="marketplaces__manage">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
