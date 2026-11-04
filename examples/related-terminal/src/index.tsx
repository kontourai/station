import { type RelatedPanes, useRelatedPanes } from '@kontourai/station-sdk';
import { useRef, useState } from 'react';

type RelatedHost = Pick<RelatedPanes, 'open' | 'reveal' | 'close'>;

/**
 * Opens a shell for this Project with the Tools. The plugin names only the
 * closed terminal target: the binding and that it wants a new shell. Station
 * decides the program and the working directory, and opens it only when the
 * person viewing holds `terminal:operate`. Every outcome is a value.
 */
function terminalActions(
  host: RelatedHost,
  report: (status: string, handle: string | null) => void,
) {
  let handle: string | null = null;
  return {
    async open() {
      const outcome = await host.open({
        kind: 'terminal',
        binding: 'project',
        new: {},
      });
      if (outcome.status === 'unavailable') {
        report(`No terminal opened (${outcome.reason}).`, handle);
        return;
      }
      handle = outcome.handle;
      report(`Terminal ${outcome.status}, ${outcome.presentation}.`, handle);
    },
    async reveal() {
      if (!handle) return;
      const outcome = await host.reveal(handle);
      report(
        outcome.status === 'unavailable'
          ? `Not revealed (${outcome.reason}).`
          : 'Terminal revealed.',
        handle,
      );
    },
    async close() {
      if (!handle) return;
      const outcome = await host.close(handle);
      if (outcome.status === 'closed') handle = null;
      report(
        outcome.status === 'unavailable'
          ? `Not closed (${outcome.reason}).`
          : 'Terminal pane closed; the shell keeps running.',
        handle,
      );
    },
  };
}

function Launcher() {
  const related = useRelatedPanes();
  const current = useRef(related);
  current.current = related;
  const [status, setStatus] = useState('');
  const [handle, setHandle] = useState<string | null>(null);
  const [actions] = useState(() =>
    terminalActions(
      {
        open: (request) => current.current.open(request),
        reveal: (target) => current.current.reveal(target),
        close: (target) => current.current.close(target),
      },
      (next, opened) => {
        setStatus(next);
        setHandle(opened);
      },
    ),
  );
  return (
    <section aria-label="Terminal launcher">
      <h2>Terminal</h2>
      {!related.supported && <p>This Station opens no related panes.</p>}
      <button type="button" onClick={() => void actions.open()}>
        Open a terminal
      </button>
      <button
        type="button"
        disabled={!handle}
        onClick={() => void actions.reveal()}
      >
        Show terminal
      </button>
      <button
        type="button"
        disabled={!handle}
        onClick={() => void actions.close()}
      >
        Close terminal pane
      </button>
      <p role="status">{status}</p>
    </section>
  );
}

export const components = { launcher: Launcher };

export default Launcher;
