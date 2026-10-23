import { useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SearchGlyph } from '../../components/icons/Glyph';
import { LazyBoundary } from '../../components/LazyBoundary';
import { ErrorState, SkeletonBlock } from '../../components/state';

const loadSearch = () =>
  import('../../components/search/WorkspaceSearchPalette');

export function ProjectSearch({ projectId }: { projectId: string }) {
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
            projectId,
            query,
            onQueryChange: setQuery,
            onClose: () => setOpen(false),
            onCommands: () => {
              setOpen(false);
              window.dispatchEvent(new Event('open-command-palette'));
            },
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
