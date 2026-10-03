import type { RegistrySource } from '@kontourai/station-contracts/catalog';
import {
  useRegistrySourceActionMutation,
  useRegistrySourcesQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SkeletonList } from '../state';

export function MarketplaceSources({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string, kind?: RegistrySource['kind']) => void;
}) {
  const sources = useRegistrySourcesQuery();
  const mutation = useRegistrySourceActionMutation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [adapter, setAdapter] = useState<'manifest' | 'github' | 'directory'>(
    'github',
  );
  const [notice, setNotice] = useState<string | null>(null);
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
              ? 'Marketplace removed. Installed content is preserved in your Library.'
              : 'Marketplace updated.',
          );
        },
      },
    );
  };
  return (
    <section className="marketplaces" aria-label="Connected marketplaces">
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
            <option value="all">All marketplaces</option>
            {(sources.data ?? []).map((source) => (
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
            setOpen(true);
          }}
        >
          Add marketplace
        </Button>
      </div>
      {sources.error && (
        <p role="alert">
          Connected marketplaces could not be loaded. Check your connection and
          operator access.
          <Button variant="secondary" onClick={() => void sources.refetch()}>
            Retry
          </Button>
        </p>
      )}
      <details>
        <summary>Manage connected marketplaces</summary>
        <p>
          Adding a marketplace makes its catalog available. Each item still
          requires its own installation and approval. Publisher metadata does
          not establish Station endorsement.
        </p>
        {sources.isLoading && (
          <SkeletonList count={3} label="Loading marketplaces" />
        )}
        {(sources.data ?? []).map((source) => (
          <article key={source.id} className="marketplaces__source">
            <div>
              <strong>{source.displayName}</strong>
              <span className="page__meta-pill">{source.status}</span>
              <p>
                {source.origin === 'plugin'
                  ? `Provided by plugin ${source.owner ?? ''}`
                  : source.origin === 'station'
                    ? 'Station collection'
                    : 'Connected by this Station'}
              </p>
              {source.location && <code>{source.location}</code>}
              {source.lastSuccessfulAt && (
                <p>
                  Last successful catalog:{' '}
                  {new Date(source.lastSuccessfulAt).toLocaleString()}
                </p>
              )}
              {source.error && <p role="status">{source.error}</p>}
            </div>
            <div>
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
                      disabled={mutation.isPending}
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
                <p>
                  Enable, disable, or revoke this source through its owning
                  plugin.
                </p>
              )}
            </div>
          </article>
        ))}
      </details>
      {notice && <p role="status">{notice}</p>}
      {mutation.error && <p role="alert">{mutation.error.message}</p>}
      {open && (
        <Dialog
          title="Add marketplace"
          closeLabel="Close add marketplace"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={
                  mutation.isPending || !name.trim() || !location.trim()
                }
                onClick={() =>
                  mutation.mutate(
                    {
                      action: 'add',
                      source: { displayName: name, location, adapter },
                    },
                    {
                      onSuccess: (source) => {
                        setOpen(false);
                        setName('');
                        setLocation('');
                        if (source) onSelect(source.id, source.kind);
                      },
                    },
                  )
                }
              >
                {mutation.isPending ? 'Connecting…' : 'Connect marketplace'}
              </Button>
            </>
          }
        >
          <div className="marketplaces__form">
            <label>
              Marketplace name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
              />
            </label>
            <label>
              Catalog type
              <select
                className="choice-trigger"
                value={adapter}
                onChange={(event) =>
                  setAdapter(event.target.value as typeof adapter)
                }
              >
                <option value="github">Public GitHub skill library</option>
                <option value="manifest">Station JSON manifest</option>
                <option value="directory">Local skill directory</option>
              </select>
            </label>
            <label>
              {adapter === 'directory'
                ? 'Absolute directory path on this Station'
                : adapter === 'github'
                  ? 'Repository URL'
                  : 'HTTPS manifest URL or absolute local file path'}
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder={
                  adapter === 'github'
                    ? 'https://github.com/mattpocock/skills'
                    : adapter === 'directory'
                      ? '/path/to/skills'
                      : 'https://example.com/catalog.json'
                }
              />
            </label>
            <p>
              Public GitHub libraries and Station JSON manifests are supported.
              Other marketplace indexes require an adapter. Private
              credential-bearing URLs are not supported.
            </p>
            {mutation.error && <p role="alert">{mutation.error.message}</p>}
          </div>
        </Dialog>
      )}
    </section>
  );
}
