import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/state';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import {
  BrowserApiError,
  browserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from '../../workspace-panes/browser-pane/browserPaneApi';
import { DeviceSetupEntry } from '../../workspace-panes/device/DeviceSetupEntry';
import { BrowserAgentSettingsPanel } from './BrowserAgentSettingsPanel';
import './BrowserDevicesSection.css';
import { BrowserLocalTargetsPanel } from './BrowserLocalTargetsPanel';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

/** The Project the Browser rows open on: `?project=` (the Browser's ⋯ link), else the first. */
function initialProject(projects: readonly { slug: string }[]) {
  const requested = new URLSearchParams(window.location.search).get('project');
  return projects.some((project) => project.slug === requested)
    ? requested
    : (projects[0]?.slug ?? null);
}

/**
 * Settings › Advanced › Browser & devices: the configuration the Browser and
 * Device panes keep out of their chrome. Each panel keeps its own server
 * authority; a caller the routes refuse sees the refusal, not the control.
 */
export function BrowserDevicesSection() {
  const { apiBase } = useApiBase();
  const requestScope = useHostRequestAuthorityScope();
  const api = useMemo(
    () => browserPaneApi(apiBase, authenticatedFetch),
    [apiBase],
  );
  const { data } = useScopedProjectsQuery();
  const projects: { slug: string; name?: string }[] = Array.isArray(data)
    ? data
    : [];
  const [picked, setPicked] = useState<string | null>(null);
  const projectSlug = picked ?? initialProject(projects);
  const access = useQuery({
    queryKey: browserPaneKeys.access(apiBase, projectSlug ?? ''),
    queryFn: ({ signal }) => api.access(projectSlug ?? '', signal),
    enabled: projectSlug !== null,
    retry: false,
  });
  const projectFieldId = useId();

  return (
    <SettingsSection
      icon="◉"
      title="Browser & devices"
      id="section-browser-devices"
    >
      <div {...settingsRow('browser-project-settings')} tabIndex={-1}>
        {projectSlug === null ? (
          <p className="settings__field-hint">
            Create a Project to configure its Browser.
          </p>
        ) : (
          <>
            <label className="settings__field" htmlFor={projectFieldId}>
              <span className="settings__field-label">Project</span>
              <select
                id={projectFieldId}
                value={projectSlug}
                onChange={(event) => setPicked(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.slug} value={project.slug}>
                    {project.name ?? project.slug}
                  </option>
                ))}
              </select>
            </label>
            {access.data?.canDrive === false ||
            (access.error instanceof BrowserApiError &&
              access.error.status === 403) ? (
              <p className="settings__field-hint">
                You can't change Browser settings for this Project.
              </p>
            ) : access.isError ? (
              <ErrorState
                variant="compact"
                title="Browser access could not be read"
                description={describeBrowserFailure(access.error)}
                action={
                  <Button size="sm" onClick={() => void access.refetch()}>
                    Retry
                  </Button>
                }
              />
            ) : access.data ? (
              <BrowserAgentSettingsPanel
                key={`agent:${projectSlug}`}
                apiBase={apiBase}
                api={api}
                projectSlug={projectSlug}
              />
            ) : null}
            {access.data?.operator ? (
              <BrowserLocalTargetsPanel
                key={`targets:${projectSlug}`}
                apiBase={apiBase}
                api={api}
                projectSlug={projectSlug}
              />
            ) : null}
          </>
        )}
      </div>
      <div {...settingsRow('device-setup')} tabIndex={-1}>
        <p className="settings__field-hint">
          Device helper, sharing with Projects, and agent device access.
        </p>
        {requestScope ? (
          <DeviceSetupEntry
            requestScope={requestScope}
            label="Open device setup"
            variant="secondary"
          />
        ) : null}
      </div>
    </SettingsSection>
  );
}
