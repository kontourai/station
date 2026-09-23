import type { BrowserLocalTargetSuggestionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

const WARNING_TEXT: Record<string, string> = {
  'station-process':
    'This looks like a Station process. Sharing it can expose Station itself.',
  'may-proxy':
    'This server may proxy other addresses, so admins could reach whatever it reaches.',
};

/**
 * Operator-only (D7): the local servers this Project's admins' browsers may
 * reach. Suggestions are offers, never pre-selected: each one is shared only
 * by its own explicit button, and says what it would share.
 */
export function BrowserLocalTargetsPanel({
  apiBase,
  api,
  projectSlug,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
}) {
  const queryClient = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const targetsKey = browserPaneKeys.localTargets(apiBase, projectSlug);
  const suggestionsKey = browserPaneKeys.suggestions(apiBase, projectSlug);
  const targets = useQuery({
    queryKey: targetsKey,
    queryFn: ({ signal }) => api.localTargets(projectSlug, signal),
  });
  const suggestions = useQuery({
    queryKey: suggestionsKey,
    queryFn: ({ signal }) => api.suggestions(projectSlug, signal),
    enabled: scanning,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: targetsKey }),
      queryClient.invalidateQueries({ queryKey: suggestionsKey }),
    ]);
  const share = useMutation({
    mutationFn: (suggestion: BrowserLocalTargetSuggestionView) =>
      api.addTarget(projectSlug, {
        host: suggestion.host,
        port: suggestion.port,
        label: suggestion.label,
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (targetId: string) => api.removeTarget(projectSlug, targetId),
    onSuccess: refresh,
  });

  return (
    <section
      className="browser-pane__panel"
      aria-labelledby="browser-local-targets-heading"
    >
      <h3 id="browser-local-targets-heading">Shared local servers</h3>
      <p className="browser-pane__hint">
        Project admins' browsers reach the public internet plus only the local
        servers shared here.
      </p>
      {targets.isPending ? (
        <SkeletonList count={2} label="Loading shared local servers" />
      ) : targets.isError ? (
        <ErrorState
          title="Shared local servers could not be read"
          description={describeBrowserFailure(targets.error)}
        />
      ) : targets.data.length === 0 ? (
        <Empty variant="compact" label="Nothing shared yet" />
      ) : (
        <ul className="browser-pane__list">
          {targets.data.map((target) => (
            <li key={target.id} className="browser-pane__list-item">
              <span>
                {target.label} — {target.host}:{target.port}
              </span>
              <Button
                size="sm"
                variant="danger-outline"
                className="browser-pane__control"
                pending={remove.isPending && remove.variables === target.id}
                onClick={() => remove.mutate(target.id)}
              >
                {`Stop sharing ${target.label}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {remove.isError ? (
        <p role="alert">{describeBrowserFailure(remove.error)}</p>
      ) : null}

      <h4>Local servers on this computer</h4>
      {!scanning ? (
        <Button
          className="browser-pane__control"
          onClick={() => setScanning(true)}
        >
          Find local servers
        </Button>
      ) : suggestions.isPending ? (
        <SkeletonList count={2} label="Looking for local servers" />
      ) : suggestions.isError ? (
        <ErrorState
          title="Local servers could not be listed"
          description={describeBrowserFailure(suggestions.error)}
        />
      ) : suggestions.data.state === 'unavailable' ? (
        <Empty
          variant="compact"
          label="Local servers can't be listed here"
          description={suggestions.data.reason}
        />
      ) : suggestions.data.suggestions.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing new to share"
          description="Only servers running inside this Project's workspace are offered."
        />
      ) : (
        <ul className="browser-pane__list">
          {suggestions.data.suggestions.map((suggestion) => (
            <li
              key={`${suggestion.host}:${suggestion.port}`}
              className="browser-pane__suggestion"
            >
              <p>
                <strong>{suggestion.label}</strong> :{suggestion.port}
                {suggestion.processName ? ` — ${suggestion.processName}` : ''}
                {suggestion.pid !== null ? ` (pid ${suggestion.pid})` : ''}
              </p>
              <p className="browser-pane__hint">Folder: {suggestion.cwd}</p>
              {suggestion.commandLine ? (
                <p className="browser-pane__hint">
                  Command: <code>{suggestion.commandLine}</code>
                </p>
              ) : null}
              {suggestion.warnings.map((warning) => (
                <p key={warning} className="browser-pane__warning">
                  {WARNING_TEXT[warning] ?? warning}
                </p>
              ))}
              <Button
                size="sm"
                className="browser-pane__control"
                pending={
                  share.isPending &&
                  share.variables?.port === suggestion.port &&
                  share.variables?.host === suggestion.host
                }
                onClick={() => share.mutate(suggestion)}
              >
                {`Share ${suggestion.label} :${suggestion.port} with this Project's admins`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {share.isError ? (
        <p role="alert">{describeBrowserFailure(share.error)}</p>
      ) : null}
    </section>
  );
}
