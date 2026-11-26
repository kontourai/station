import type { ConversationPullRequestLinkObservation } from '@kontourai/station-contracts/conversation-pull-request-links';
import { useEffect, useState } from 'react';
import { useProjects } from '../../contexts/ProjectsContext';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { toastStore } from '../../contexts/ToastContext';
import { useOpenPullRequestInRegion } from '../../contexts/useOpenInRegion';
import { RowMenu } from '../notifications/RowMenu';

const checks = {
  passing: 'Passing',
  failing: 'Failing',
  pending: 'Pending',
  'awaiting-approval': 'Checks need approval',
};

export function InboxLinkedPullRequest({
  links,
  projectSlug,
}: {
  links: ConversationPullRequestLinkObservation[];
  projectSlug?: string;
}) {
  const { projects } = useProjects();
  const projectId = projects.find(
    (project) => project.slug === projectSlug,
  )?.id;
  const openPullRequest = useOpenPullRequestInRegion();
  const model = useRegionModelOptional();
  const [opened, setOpened] = useState<{
    surfaceId: string;
    returnFocus: HTMLButtonElement;
  }>();

  useEffect(() => {
    if (!opened || !model) return;
    const visible = Object.values(model.regions).some(
      (region) => region.visible && region.panes.includes(opened.surfaceId),
    );
    if (!visible) {
      opened.returnFocus.focus({ preventScroll: true });
      setOpened(undefined);
    }
  }, [model, opened]);

  function open(
    link: ConversationPullRequestLinkObservation,
    button: HTMLButtonElement,
  ) {
    const result = openPullRequest?.(
      {
        host: link.host,
        owner: link.repository.owner,
        repository: link.repository.name,
        ref: link.ref,
      },
      projectId ?? null,
    );
    if (!result?.ok) {
      toastStore.show('This pull request can’t be opened here.');
      return;
    }
    setOpened({
      surfaceId: result.surfaceId,
      returnFocus:
        button
          .closest('.inbox-row')
          ?.querySelector<HTMLButtonElement>('.inbox-row__open') ?? button,
    });
  }

  const primary = links[0];
  if (!primary) return null;
  const status =
    primary.status.state === 'current' ? primary.status : undefined;
  const state = status?.checks
    ? checks[status.checks]
    : status?.pullRequestState === 'MERGED'
      ? 'Merged'
      : status?.pullRequestState === 'CLOSED'
        ? 'Closed'
        : status?.isDraft
          ? 'Draft'
          : undefined;
  const content =
    links.length > 1
      ? `${links.length} PRs`
      : [`#${primary.ref}`, state].filter(Boolean).join(' · ');
  return (
    <span className="inbox-row__pull-request" data-checks={status?.checks}>
      {links.length === 1 ? (
        <button
          className="inbox-row__chip"
          type="button"
          aria-label={`Open pull request ${content}`}
          onClick={(event) => open(primary, event.currentTarget)}
        >
          {content}
        </button>
      ) : (
        <RowMenu
          label={`Open one of ${links.length} linked pull requests`}
          triggerClassName="inbox-row__chip"
          triggerContent={content}
          items={links.map((link) => ({
            id: `${link.provider}:${link.host}/${link.repository.owner}/${link.repository.name}#${link.ref}`,
            label:
              link.status.state === 'current'
                ? `#${link.ref} ${link.status.title}`
                : `${link.repository.name} #${link.ref}`,
            onSelect: (button) => open(link, button),
          }))}
        />
      )}
    </span>
  );
}
