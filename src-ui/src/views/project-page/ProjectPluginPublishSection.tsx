import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { PluginPublishDialog } from './PluginPublishDialog';
import {
  fetchPluginPublishInspection,
  pluginPublishInspectionKey,
} from './pluginPublishClient';

/**
 * "Publish to git" for a Project whose folder is a plugin (epic #2323 S6).
 *
 * The server decides whether it appears: the inspection route is
 * operator-only and answers `plugin: null` for a folder without a plugin
 * manifest, so a collaborator, or a Project that is not a plugin, sees
 * nothing here.
 */
export function ProjectPluginPublishSection({ slug }: { slug: string }) {
  const { apiBase } = useApiBase();
  const [open, setOpen] = useState(false);
  const inspection = useQuery({
    queryKey: pluginPublishInspectionKey(apiBase, slug),
    queryFn: () => fetchPluginPublishInspection(apiBase, slug),
    // An offer, not a status: a refused or failed check offers nothing.
    retry: false,
  });
  const data = inspection.data;
  if (!data || data.plugin === null) return null;

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
          Plugin · {data.plugin.name} {data.plugin.version}
        </span>
        <div className="project-page__section-actions">
          <button
            type="button"
            className="project-page__add-btn"
            onClick={() => {
              void inspection.refetch();
              setOpen(true);
            }}
          >
            Publish to git…
          </button>
        </div>
      </div>
      <p className="project-page__section-explainer">
        Push this plugin to a git remote. Its address then installs the plugin
        on any Station.
      </p>
      {open && (
        <PluginPublishDialog
          apiBase={apiBase}
          projectSlug={slug}
          inspection={data}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}
