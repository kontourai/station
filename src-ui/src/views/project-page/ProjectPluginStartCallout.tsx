import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { LazyBoundary } from '../../components/LazyBoundary';
import { PageCallout, PageCalloutStack } from '../../components/PageCallout';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { fetchPluginScaffoldEligibility } from '../plugin-management/plugin-scaffold-client';
import { pluginScaffoldEligibilityKey } from '../plugin-management/useStartPluginFlow';

const loadStartPluginModal = () =>
  import('../plugin-management/StartPluginModal').then((module) => ({
    default: module.StartPluginModal,
  }));

/**
 * Offers "Start a plugin in this folder" when, and only when, the server
 * says this Project's folder could take a scaffold right now (it exists, is
 * empty, and chats run in it directly). Any Project member sees it.
 */
export function ProjectPluginStartCallout({
  project,
}: {
  project: { slug: string; name: string };
}) {
  const { apiBase } = useApiBase();
  const [open, setOpen] = useState(false);
  const eligibility = useQuery({
    queryKey: pluginScaffoldEligibilityKey(apiBase, project.slug),
    queryFn: () => fetchPluginScaffoldEligibility(apiBase, project.slug),
    // An offer, not a status: a failed check simply offers nothing.
    retry: false,
  });

  if (!eligibility.data?.eligible && !open) return null;
  return (
    <>
      {eligibility.data?.eligible && (
        <PageCalloutStack>
          <PageCallout
            calloutId="project-plugin-start"
            ariaLabel="Start a plugin in this folder"
            title="Start a plugin in this folder"
            action={
              <Button variant="secondary" onClick={() => setOpen(true)}>
                Start a plugin
              </Button>
            }
          >
            This Project's folder is empty. Station can put a starter plugin in
            it and open a chat to build it with an Agent.
          </PageCallout>
        </PageCalloutStack>
      )}
      {open && (
        <LazyBoundary
          load={loadStartPluginModal}
          componentProps={{ project, onClose: () => setOpen(false) }}
          pending={null}
        />
      )}
    </>
  );
}
