import type {
  ConversationPullRequestLinkObservation,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import { useState } from 'react';
import { BranchToolbar } from './BranchToolbar';
import { DiffPanel } from './DiffPanel';
import {
  CurrentBranchPullRequestLine,
  PullRequestsPanel,
} from './PullRequestsPanel';
import './CodingDiffPaneBody.css';

type DiffPaneView = 'changes' | 'pulls';

/**
 * The Diff pane's body: the git rows, then ONE view at full width — the
 * working tree's changes, or the checkout's pull requests — chosen by a
 * segmented switch on the first row. The two used to share the pane as
 * columns, and the diff (the pane's own subject) got 150–200px of it.
 *
 * A view switch rather than a second registered pane: a "Pull requests" pane
 * would be a new contract descriptor, canonical instance, persisted-stack
 * document shape and rail entry, every one of them owned elsewhere. This body
 * keeps the pull request view self-contained so lifting it into its own pane
 * later is a move, not a rewrite.
 */
export function CodingDiffPaneBody({
  projectSlug,
  workingDir,
  onOpenLinkedAsPane,
}: {
  projectSlug: string;
  workingDir: string;
  onOpenLinkedAsPane?: (
    link: ConversationPullRequestLinkObservation,
  ) => boolean;
}) {
  const [activeRepoRoot, setActiveRepoRoot] = useState<string | null>(null);
  const [view, setView] = useState<DiffPaneView>('changes');
  // The Changes view's branch line opens that pull request's review: the
  // pull requests view mounts with it selected (keyed so a later jump to a
  // different one remounts), and Back returns to the list, not to Changes.
  const [jump, setJump] = useState<PullRequestLinkIdentity | null>(null);
  const repoRoot = activeRepoRoot ?? workingDir;
  const switchView = (next: DiffPaneView) => {
    if (next === 'pulls' && view !== 'pulls') setJump(null);
    setView(next);
  };
  return (
    <div className="workspace-coding-diff-pane">
      <BranchToolbar
        projectSlug={projectSlug}
        workingDir={workingDir}
        onActiveRepoChange={setActiveRepoRoot}
        showCommit={view === 'changes'}
        leading={
          <fieldset className="coding-diff-pane__switch">
            <legend className="sr-only">Diff view</legend>
            <button
              type="button"
              className="coding-diff-pane__segment"
              aria-pressed={view === 'changes'}
              onClick={() => switchView('changes')}
            >
              Changes
            </button>
            <button
              type="button"
              className="coding-diff-pane__segment"
              aria-pressed={view === 'pulls'}
              onClick={() => switchView('pulls')}
            >
              Pull requests
            </button>
          </fieldset>
        }
      />
      {view === 'changes' ? (
        <div className="coding-diff-pane__view">
          <CurrentBranchPullRequestLine
            projectSlug={projectSlug}
            activeRepoRoot={repoRoot}
            onOpen={(pullRequest) => {
              setJump(pullRequest);
              setView('pulls');
            }}
          />
          <DiffPanel workingDir={repoRoot} projectSlug={projectSlug} />
        </div>
      ) : (
        <div className="coding-diff-pane__view">
          <PullRequestsPanel
            key={
              jump
                ? `jump:${jump.host}/${jump.repository.owner}/${jump.repository.name}#${jump.ref}`
                : 'list'
            }
            projectSlug={projectSlug}
            activeRepoRoot={repoRoot}
            onOpenLinkedAsPane={onOpenLinkedAsPane}
            initialSelected={jump}
          />
        </div>
      )}
    </div>
  );
}
