import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import {
  useDeletePersonalLayoutMutation,
  usePersonalLayoutsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { DashboardGlyph } from '../../components/icons/Glyph';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import {
  Empty,
  ErrorState,
  FilteredEmpty,
  SkeletonBlock,
} from '../../components/state';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { AppDetailsDialog } from './AppDetailsDialog';
import './AppsLibrary.css';

/** The preview changes discovery only; layouts keep their existing owner and host. */
export function AppsLibrary(props: {
  onClose: () => void;
  onOpen: (slug: string) => void;
  onDeleted: (slug: string) => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  const enabled = useSurfaceVisibilityFlags().has('apps-library');
  return enabled ? <Library {...props} /> : null;
}

function Library({
  onClose,
  onOpen,
  onDeleted,
  returnFocusTarget,
}: {
  onClose: () => void;
  onOpen: (slug: string) => void;
  onDeleted: (slug: string) => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  const query = usePersonalLayoutsQuery();
  const remove = useDeletePersonalLayoutMutation();
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ board?: LayoutMetadata } | null>(null);
  const [deleting, setDeleting] = useState<LayoutMetadata | null>(null);
  const [launchSlug, setLaunchSlug] = useState<string | null>(null);
  // Let the details form unregister its dirty-state guard before navigation.
  useEffect(() => {
    if (launchSlug) onOpen(launchSlug);
  }, [launchSlug, onOpen]);
  const boards = query.data ?? [];
  const needle = search.trim().toLocaleLowerCase();
  const filtered = boards.filter((board) =>
    [board.name, board.description, board.plugin, board.slug].some((value) =>
      value?.toLocaleLowerCase().includes(needle),
    ),
  );
  const groups = [
    { title: 'Your Boards', items: filtered.filter((board) => !board.plugin) },
    {
      title: 'Plugin layouts',
      items: filtered.filter((board) => Boolean(board.plugin)),
    },
  ];
  const busy = editor !== null || deleting !== null;
  return (
    <>
      <Dialog
        open={!busy}
        title="Apps"
        eyebrow="YOUR WORKSPACE"
        closeLabel="Close Apps"
        subtitle="Your personal Boards and plugin layouts, ready to open."
        size="lg"
        returnFocusTarget={returnFocusTarget}
        panelClassName="apps-library"
        onClose={() => {
          if (!busy) onClose();
        }}
        dismissible={!busy}
      >
        <div className="apps-library__toolbar">
          <label className="apps-library__search">
            Search apps
            <input
              type="search"
              placeholder="Find a Board or plugin layout"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button
            variant="primary"
            disabled={query.isPending || query.isError}
            onClick={() => setEditor({})}
          >
            New Board
          </Button>
        </div>
        {query.isPending && <SkeletonBlock count={3} label="Loading apps" />}
        {query.isError && (
          <ErrorState
            title="Could not refresh your apps"
            description={
              query.data
                ? 'Showing the last loaded library.'
                : 'Your Boards could not be loaded.'
            }
            action={
              <Button onClick={() => void query.refetch()}>Retry apps</Button>
            }
          />
        )}
        {!query.isPending && !query.isError && boards.length === 0 && (
          <Empty
            label="Make room for your work"
            description="Start a Board for daily work, Project watch or review."
            icon={<DashboardGlyph />}
          />
        )}
        {boards.length > 0 && filtered.length === 0 && (
          <FilteredEmpty
            query={search}
            noun="apps"
            onClear={() => setSearch('')}
          />
        )}
        {groups.map(
          ({ title, items }) =>
            items.length > 0 && (
              <section
                className="apps-library__section"
                key={title}
                aria-label={title}
              >
                <h3>
                  {title} <span>{items.length}</span>
                </h3>
                <ul className="apps-library__grid">
                  {items.map((board) => (
                    <li key={board.slug} className="apps-library__card">
                      <button
                        type="button"
                        className="apps-library__launch"
                        onClick={() => onOpen(board.slug)}
                        aria-label={`Open ${board.name}`}
                      >
                        <span className="apps-library__icon" aria-hidden="true">
                          {board.icon || <DashboardGlyph />}
                        </span>
                        <strong>{board.name}</strong>
                        <span className="apps-library__source">
                          {board.plugin ?? 'Personal Board'}
                        </span>
                        {board.description && (
                          <span className="apps-library__description">
                            {board.description}
                          </span>
                        )}
                      </button>
                      <div className="apps-library__actions">
                        <Button
                          size="sm"
                          aria-label={`Edit ${board.name} details`}
                          onClick={() => setEditor({ board })}
                        >
                          Details
                        </Button>
                        <Button
                          size="sm"
                          aria-label={`Delete ${board.name}`}
                          onClick={() => {
                            remove.reset();
                            setDeleting(board);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ),
        )}
      </Dialog>
      {editor && (
        <AppDetailsDialog
          key={editor.board?.slug ?? 'new'}
          board={editor.board}
          takenSlugs={boards.map((board) => board.slug)}
          onClose={() => setEditor(null)}
          onSaved={(slug, created) => {
            setEditor(null);
            if (created) setLaunchSlug(slug);
          }}
        />
      )}
      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete Board?"
        message={`Delete “${deleting?.name ?? ''}” and its saved layout?`}
        confirmLabel="Delete Board"
        variant="danger"
        pending={remove.isPending}
        error={remove.error?.message}
        onCancel={() => {
          if (!remove.isPending) setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting)
            remove.mutate(deleting.slug, {
              onSuccess: () => {
                setDeleting(null);
                onDeleted(deleting.slug);
              },
            });
        }}
      />
    </>
  );
}
