import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { PluginPublishDialog } from './PluginPublishDialog';
import {
  fetchPluginPublishInspection,
  fetchPluginPublishSummary,
  pluginPublishInspectionKey,
  pluginPublishSummaryKey,
} from './pluginPublishClient';

/**
 * "Publish to git" for a Project whose folder is a plugin (epic #2323 S6).
 *
 * On mount it asks only the summary, which reads plugin.json and runs no
 * git: viewing a Project must never run git in a folder other people can
 * write to (security review H1). The full inspection (git status, remotes,
 * secrets) runs when the operator opens the dialog. The route is
 * operator-only, so a collaborator, or a Project that is not a plugin, sees
 * nothing here.
 */
export function ProjectPluginPublishSection({ slug }: { slug: string }) {
  const { apiBase } = useApiBase();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const summary = useQuery({
    queryKey: pluginPublishSummaryKey(apiBase, slug),
    queryFn: () => fetchPluginPublishSummary(apiBase, slug),
    // An offer, not a status: a refused or failed check offers nothing.
    retry: false,
  });
  const detail = useQuery({
    queryKey: pluginPublishInspectionKey(apiBase, slug),
    queryFn: () => fetchPluginPublishInspection(apiBase, slug),
    enabled: open,
    retry: false,
  });
  const plugin = summary.data?.plugin;
  if (!plugin) return null;
  // Dropped on close, so reopening reads the folder afresh instead of
  // showing (and seeding the form from) the last answer.
  const close = () => {
    setOpen(false);
    queryClient.removeQueries({
      queryKey: pluginPublishInspectionKey(apiBase, slug),
    });
  };

  return (
    <section
      className="project-page__git-section"
      aria-labelledby="project-plugin-publish-title"
    >
      <div className="project-page__section-header">
        <span
          id="project-plugin-publish-title"
          className="project-page__section-label"
        >
          Plugin · {plugin.name} {plugin.version}
        </span>
        <div className="project-page__section-actions">
          <button
            type="button"
            className="project-page__add-btn"
            onClick={() => setOpen(true)}
          >
            Publish to git…
          </button>
        </div>
      </div>
      <p className="project-page__section-explainer">
        Push this plugin to a git remote. Its address then installs the plugin
        on any Station.
      </p>
      {open && detail.data?.plugin && (
        <PluginPublishDialog
          apiBase={apiBase}
          projectSlug={slug}
          inspection={detail.data}
          onClose={close}
        />
      )}
      {open && !detail.data?.plugin && (
        <Dialog
          eyebrow="Publish to git"
          title={`${plugin.name} ${plugin.version}`}
          closeLabel="Close publish plugin"
          onClose={close}
          footer={
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          }
        >
          <p role={detail.isError ? 'alert' : 'status'}>
            {detail.isError
              ? detail.error.message
              : detail.data
                ? 'This folder no longer holds a valid plugin.'
                : 'Checking the folder…'}
          </p>
        </Dialog>
      )}
    </section>
  );
}
