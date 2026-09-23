import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

/**
 * What agents may do in this Project's browser (#90 D4). The operator or a
 * Project admin decides; the permission is off until they turn it on, and
 * the description says plainly what turning it on hands over.
 */
export function BrowserAgentSettingsPanel({
  apiBase,
  api,
  projectSlug,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
}) {
  const queryClient = useQueryClient();
  const key = browserPaneKeys.settings(apiBase, projectSlug);
  const settings = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.settings(projectSlug, signal),
  });
  const update = useMutation({
    mutationFn: (browserEvaluate: boolean) =>
      api.setBrowserEvaluate(projectSlug, browserEvaluate),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });
  const descriptionId = 'browser-agent-evaluate-description';

  return (
    <section
      className="browser-pane__panel"
      aria-labelledby="browser-agent-settings-heading"
    >
      <h3 id="browser-agent-settings-heading">Agent access</h3>
      {settings.isPending ? (
        <SkeletonBlock count={1} label="Loading agent access" />
      ) : settings.isError ? (
        <ErrorState
          title="Agent access could not be read"
          description={describeBrowserFailure(settings.error)}
        />
      ) : (
        <div className="browser-pane__list-item">
          <span>
            <strong>Let agents run JavaScript in this Project's pages</strong>
            <span id={descriptionId} className="browser-pane__hint">
              A script an agent runs acts as the page itself: it can read what
              the page shows, its cookies and local storage, and anything the
              signed-in site can reach, and it can keep running in the page
              after the agent's call ends. Off by default. Agents can still
              read, click and type without it: Station checks that nothing
              covers an element before clicking it, but a page that moves things
              on a timer can still redirect a click, and a browser step that
              timed out may still finish later.
            </span>
          </span>
          {/* #2425: the state is told by more than colour — the thumb's
              side, an outlined (off) or filled (on) track, and a word. The
              switch's own aria-checked is what assistive tech reads, so the
              word is hidden from it. */}
          <span
            className="browser-pane__switch"
            data-state={settings.data.browserEvaluate ? 'on' : 'off'}
          >
            <Toggle
              checked={settings.data.browserEvaluate}
              disabled={update.isPending}
              describedBy={descriptionId}
              label="Let agents run JavaScript in this Project's pages"
              onChange={(next) => update.mutate(next)}
            />
            <span className="browser-pane__switch-state" aria-hidden="true">
              {settings.data.browserEvaluate ? 'On' : 'Off'}
            </span>
          </span>
        </div>
      )}
      {update.isError ? (
        <p role="alert">{describeBrowserFailure(update.error)}</p>
      ) : null}
    </section>
  );
}
