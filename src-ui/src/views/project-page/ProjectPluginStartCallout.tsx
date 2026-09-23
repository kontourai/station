import { useState } from 'react';
import { Button } from '../../components/Button';
import { LazyBoundary } from '../../components/LazyBoundary';
import { PageCallout, PageCalloutStack } from '../../components/PageCallout';

const loadStartPluginModal = () =>
  import('../plugin-management/StartPluginModal').then((module) => ({
    default: module.StartPluginModal,
  }));

/**
 * The "Start a plugin in this folder" offer. `ProjectPluginStartGate` mounts
 * it only when the server says this Project's folder could take a scaffold
 * (it exists, is empty, and chats run in it directly); any Project member
 * may see it. A successful Start re-reads eligibility, and the gate then
 * unmounts this offer.
 */
export function ProjectPluginStartCallout({
  project,
}: {
  project: { slug: string; name: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
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
          This Project's folder is empty. Station can put a starter plugin in it
          and open a chat to build it with an Agent.
        </PageCallout>
      </PageCalloutStack>
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
