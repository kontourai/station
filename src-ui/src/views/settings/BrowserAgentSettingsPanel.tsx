import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from '../../workspace-panes/browser-pane/browserPaneApi';

/**
 * Whether agents may run JavaScript in this Project's browser (#90 D4). Off
 * until the operator or a Project admin turns it on.
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
      className="browser-settings__panel"
      aria-labelledby="browser-agent-settings-heading"
    >
      <h3 id="browser-agent-settings-heading">Agent JavaScript</h3>
      {settings.isPending ? (
        <SkeletonBlock count={1} label="Loading agent JavaScript setting" />
      ) : settings.isError ? (
        <ErrorState
          title="The agent JavaScript setting could not be read"
          description={describeBrowserFailure(settings.error)}
        />
      ) : (
        <div className="browser-settings__item">
          <span>
            <strong>Let agents run JavaScript in this Project's pages</strong>
            <span id={descriptionId} className="browser-settings__hint">
              A script acts as the page: it can read its content, cookies and
              local storage, and keep running after the agent's call ends.
            </span>
            <details className="browser-settings__details">
              <summary>Details</summary>
              <p className="browser-settings__hint">
                Agents can read, click and type without this. Station checks
                that nothing covers an element before clicking it, but a page
                that moves things on a timer can still redirect a click, and a
                browser step that timed out may still finish later.
              </p>
            </details>
          </span>
          <Toggle
            checked={settings.data.browserEvaluate}
            disabled={update.isPending}
            describedBy={descriptionId}
            label="Let agents run JavaScript in this Project's pages"
            onChange={(next) => update.mutate(next)}
            showStateLabel
          />
        </div>
      )}
      {update.isError ? (
        <p role="alert">{describeBrowserFailure(update.error)}</p>
      ) : null}
    </section>
  );
}
