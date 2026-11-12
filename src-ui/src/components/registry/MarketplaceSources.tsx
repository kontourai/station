import type {
  RegistrySource,
  RegistrySourceDetectedKind,
} from '@kontourai/station-contracts/catalog';
import {
  useRegistrySourceActionMutation,
  useRegistrySourcesQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { describeStationFailure } from '../../utils/stationFailure';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SkeletonList } from '../state';

type CatalogKind = RegistrySource['kind'];

/**
 * Whether a source supplies a catalog of one of `kinds`: its primary kind, or
 * an installable kind its content was detected to provide.
 */
function supplies(source: RegistrySource, kinds?: readonly CatalogKind[]) {
  if (!kinds) return true;
  return (
    kinds.includes(source.kind) ||
    (source.detection?.kinds ?? []).some(
      (detected) =>
        detected.installable &&
        detected.kind !== 'integrations' &&
        kinds.includes(detected.kind),
    )
  );
}

const KIND_NAMES: Record<RegistrySourceDetectedKind['kind'], [string, string]> =
  {
    skills: ['skill', 'skills'],
    plugins: ['plugin', 'plugins'],
    agents: ['agent', 'agents'],
    integrations: ['tool server', 'tool servers'],
  };

function kindLabel(kind: RegistrySourceDetectedKind) {
  const [one, many] = KIND_NAMES[kind.kind];
  return `${kind.count} ${kind.count === 1 ? one : many}`;
}

/**
 * Who stands behind a source. Only Station's own collection and an operator's
 * configuration are vouched for by this Station; a source a person added, and
 * its publisher metadata, are not verified.
 */
function trust(source: RegistrySource): { label: string; detail: string } {
  switch (source.origin) {
    case 'station':
      return { label: 'Station', detail: 'Ships with Station' };
    case 'configured':
      return {
        label: 'Operator',
        detail: 'Configured for this Station by its operator',
      };
    case 'plugin':
      return {
        label: 'Plugin',
        detail: `Provided by plugin ${source.owner ?? ''}`,
      };
    default:
      return {
        label: 'Unverified',
        detail: 'Added on this Station. Its publisher is not verified.',
      };
  }
}

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
  if (!detection) return null;
  if (detection.state === 'nothing-recognized')
    return <p className="marketplaces__note">{NOTHING_RECOGNIZED}</p>;
  if (detection.kinds.length === 0) return null;
  return (
    <ul className="marketplaces__kinds" aria-label="What this source provides">
      {detection.kinds.map((kind) => {
        const blocked = kind.managedDenial !== undefined;
        const muted = blocked || !kind.installable;
        return (
          <li
            key={kind.kind}
            className={`marketplaces__kind${muted ? ' marketplaces__kind--muted' : ''}`}
            title={kind.managedDenial ?? kind.note}
          >
            <strong>{kindLabel(kind)}</strong>
            {blocked ? (
              <span> · blocked by policy</span>
            ) : !kind.installable ? (
              <span> · recognized, not installable</span>
            ) : null}
          </li>
        );
      })}
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

export function MarketplaceSources({
  selected,
  onSelect,
  kinds,
}: {
  selected: string;
  onSelect: (id: string, kind?: RegistrySource['kind']) => void;
  kinds?: readonly RegistrySource['kind'][];
}) {
  const sources = useRegistrySourcesQuery();
  const mutation = useRegistrySourceActionMutation();
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState('');
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [added, setAdded] = useState<RegistrySource | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const visible = (sources.data ?? []).filter((source) =>
    supplies(source, kinds),
  );
  const closeDialog = () => {
    setOpen(false);
    setAdded(null);
    setLocation('');
    setRef('');
    setName('');
  };
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
    <section className="marketplaces" aria-label="Connected sources">
      <div className="marketplaces__toolbar">
        <label>
          Browse marketplace
          <select
            className="choice-trigger"
            value={selected}
            onChange={(event) =>
              onSelect(
                event.target.value,
                sources.data?.find((source) => source.id === event.target.value)
                  ?.kind,
              )
            }
          >
            <option value="all">All sources</option>
            {visible.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
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
      <details className="marketplaces__manage">
        <summary>Manage sources ({visible.length})</summary>
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
            const tier = trust(source);
            const unread =
              source.detection?.state === 'refused' ||
              source.detection?.state === 'unavailable';
            return (
              <article key={source.id} className="marketplaces__source">
                <header className="marketplaces__source-head">
                  <strong className="marketplaces__source-name">
                    {source.displayName}
                  </strong>
                  <span
                    className={`marketplaces__trust marketplaces__trust--${source.origin}`}
                    title={tier.detail}
                  >
                    {tier.label}
                  </span>
                  <span className="page__meta-pill">{source.status}</span>
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
                  overflowLabel={`More actions for ${source.displayName}`}
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
      </details>
      {notice && <p role="status">{notice}</p>}
      {mutation.error && !open && (
        <p role="alert">{describeStationFailure(mutation.error).body}</p>
      )}
      {open && (
        <Dialog
          title={added ? `Added ${added.displayName}` : 'Add source'}
          closeLabel="Close add source"
          onClose={closeDialog}
          footer={
            added ? (
              <Button
                variant="primary"
                onClick={() => {
                  onSelect(added.id, added.kind);
                  closeDialog();
                }}
              >
                Browse this source
              </Button>
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
            <div className="marketplaces__form">
              <p>
                {added.detection?.state === 'detected'
                  ? 'Station read this source and found:'
                  : added.detection?.state === 'nothing-recognized'
                    ? NOTHING_RECOGNIZED
                    : (added.detection?.reason ??
                      'Station could not read this source yet. Refresh it once it is available.')}
              </p>
              <DetectedKinds source={added} />
              <p className="marketplaces__note">
                Nothing is installed yet. Choose items from the catalog and
                approve each one when you install it.
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
