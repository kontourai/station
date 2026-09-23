import { getJson } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { LazyBoundary } from '../../components/LazyBoundary';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { pluginScaffoldEligibilityKey } from './pluginScaffoldEligibilityKey';

/**
 * The only part of "Start a plugin in this folder" that loads with the
 * Project page: one read-only eligibility query. The callout, its dialog and
 * the scaffold flow load only when the server says this folder could take a
 * scaffold, so a Project page that never offers it never pays for it.
 */

type PluginScaffoldEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * `GET /api/projects/:slug/plugin-scaffold`: whether a plugin could be
 * scaffolded into this Project's folder now. Read-only.
 */
async function fetchPluginScaffoldEligibility(
  apiBase: string,
  projectSlug: string,
): Promise<PluginScaffoldEligibility> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/plugin-scaffold`,
  );
  const envelope = (await response.json()) as {
    success?: boolean;
    error?: string;
    data?: PluginScaffoldEligibility;
  };
  if (!response.ok || !envelope.success || !envelope.data) {
    throw new Error(
      envelope.error ||
        `Station could not check this folder (${response.status})`,
    );
  }
  return envelope.data;
}

const loadProjectPluginStartCallout = () =>
  import('./ProjectPluginStartCallout').then((module) => ({
    default: module.ProjectPluginStartCallout,
  }));

/** Renders the offer only when the server says this folder is eligible. */
export function ProjectPluginStartGate({
  project,
}: {
  project: { slug: string; name: string };
}) {
  const { apiBase } = useApiBase();
  const eligibility = useQuery({
    queryKey: pluginScaffoldEligibilityKey(apiBase, project.slug),
    queryFn: () => fetchPluginScaffoldEligibility(apiBase, project.slug),
    // An offer, not a status: a failed check simply offers nothing.
    retry: false,
  });
  if (!eligibility.data?.eligible) return null;
  return (
    <LazyBoundary
      load={loadProjectPluginStartCallout}
      componentProps={{ project }}
      pending={null}
    />
  );
}
