import { useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SearchGlyph } from '../../components/icons/Glyph';
import { LazyBoundary } from '../../components/LazyBoundary';
import { ErrorState, SkeletonBlock } from '../../components/state';

const loadSearch = () =>
  import('../../components/search/WorkspaceSearchPalette');

/**
 * Search inside one Project. Unified search scopes Tasks and messages by the
 * Project slug (the key both record), so the slug is the filter, not the id.
 * It offers no way back to the command palette: that palette searches the
 * whole Station, which is not where this dialog was opened from.
 */
export function ProjectSearch({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <SearchGlyph /> Search
      </Button>
      {open && (
        <LazyBoundary
          load={loadSearch}
          componentProps={{
            projectId: slug,
            query,
            onQueryChange: setQuery,
            onClose: () => setOpen(false),
          }}
          pending={
            <Dialog
              title="Search Project"
              closeLabel="Close search"
              onClose={() => setOpen(false)}
            >
              <SkeletonBlock label="Opening search" />
            </Dialog>
          }
          unavailable={(retry) => (
            <Dialog
              title="Search Project"
              closeLabel="Close search"
              onClose={() => setOpen(false)}
            >
              <ErrorState
                title="Search unavailable"
                action={<Button onClick={retry}>Retry</Button>}
              />
            </Dialog>
          )}
        />
      )}
    </>
  );
}
