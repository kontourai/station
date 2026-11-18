import type {
  PullRequestFeedbackOwner,
  PullRequestFeedbackView,
} from '@kontourai/station-contracts/pull-request-feedback';
import { StatusBadge } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { DisclosureToggle } from '../DisclosureToggle';
import { Toggle } from '../Toggle';
import {
  historyRowParts,
  pullRequestFeedbackBadge,
  pullRequestFeedbackLine,
} from './pull-request-feedback-presentation';
import { RelativeTime } from './RelativeTime';
import type { PullRequestFeedbackSwitches } from './usePullRequestFeedback';
import './PullRequestFeedbackDialog.css';

const SWITCHES: Array<{
  key: 'fixFailingChecks' | 'addressReviewComments' | 'reviewEachHead';
  label: string;
  description: (chat: string | undefined) => string;
}> = [
  {
    key: 'fixFailingChecks',
    label: 'Fix failing checks automatically',
    description: (chat) =>
      `Sends failing checks and merge conflicts to ${chat ? `the agent in “${chat}”` : "this chat's agent"}.`,
  },
  {
    key: 'addressReviewComments',
    label: 'Address review comments automatically',
    description: () => 'Sends unresolved review threads and change requests.',
  },
  {
    key: 'reviewEachHead',
    label: 'Review each new head',
    description: () =>
      "Station's Codex reviewers read each push; you choose what reaches the agent.",
  },
];

/**
 * A pull request's agent feedback switches and what Station sent. Each
 * switch applies at once; there is nothing to save.
 */
export function PullRequestFeedbackDialog({
  reference,
  view,
  pending,
  error,
  conflict,
  onWrite,
  onSendAgain,
  onClose,
  chatTitle,
  headReview = false,
}: {
  /** Offer "Review each new head" (its preview is on). */
  headReview?: boolean;
  /**
   * The chat these switches belong to, when it is not the one open (the
   * pull request panel's gear for another chat's feedback).
   */
  chatTitle?: string;
  reference: string;
  view: PullRequestFeedbackView | undefined;
  pending: boolean;
  error?: string;
  conflict?: PullRequestFeedbackOwner;
  onWrite: (settings: PullRequestFeedbackSwitches, move?: boolean) => void;
  onSendAgain: () => void;
  onClose: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = useId();
  const now = Date.now();
  const settings: PullRequestFeedbackSwitches = {
    fixFailingChecks: view?.ownedHere ? view.settings.fixFailingChecks : false,
    addressReviewComments: view?.ownedHere
      ? view.settings.addressReviewComments
      : false,
    // Left out while not offered: the server keeps what the chat stored.
    ...(headReview
      ? {
          reviewEachHead: view?.ownedHere
            ? view.settings.reviewEachHead
            : false,
        }
      : {}),
  };
  const switches = SWITCHES.filter(
    (entry) => headReview || entry.key !== 'reviewEachHead',
  );
  const owner = conflict ?? (view && !view.ownedHere ? view.owner : null);
  const badge = view ? pullRequestFeedbackBadge(view) : undefined;
  const line = pullRequestFeedbackLine(view);
  const paused = view?.ownedHere && view.status.state === 'paused';
  const history = view?.ownedHere ? view.history : [];

  return (
    <Dialog
      open
      title="Agent feedback"
      subtitle={reference}
      closeLabel="Close agent feedback"
      onClose={onClose}
      size="sm"
      panelClassName="pr-feedback-dialog"
      footer={
        paused ? (
          <Button variant="primary" pending={pending} onClick={onSendAgain}>
            Send again
          </Button>
        ) : undefined
      }
    >
      <div className="pr-feedback-dialog__body">
        {(badge || (line && !owner)) && (
          <div className="pr-feedback-dialog__status">
            {badge && <StatusBadge status={badge.label} tone={badge.tone} />}
            {line && !owner && (
              <span className="pr-feedback-dialog__line">
                {line.text}
                {line.at && (
                  <>
                    {' · '}
                    <RelativeTime iso={line.at} now={now} />
                  </>
                )}
              </span>
            )}
          </div>
        )}
        {owner && (
          <div className="pr-feedback-dialog__owner">
            <p>
              {owner.title
                ? `Feedback goes to “${owner.title}”.`
                : 'Feedback goes to another chat.'}
            </p>
            <Button
              size="sm"
              pending={pending}
              onClick={() => {
                // The owner's switches when this reader may see them; when the
                // owner is hidden the read reports them off, so moving would
                // switch feedback off. Move with both on instead.
                const known =
                  !!view && !view.ownedHere && !!owner.conversationId;
                onWrite(
                  {
                    fixFailingChecks: known
                      ? view.settings.fixFailingChecks
                      : true,
                    addressReviewComments: known
                      ? view.settings.addressReviewComments
                      : true,
                    ...(headReview && known
                      ? { reviewEachHead: view.settings.reviewEachHead }
                      : {}),
                  },
                  true,
                );
              }}
            >
              Move here
            </Button>
          </div>
        )}
        <ul className="pr-feedback-dialog__switches">
          {switches.map((entry) => {
            const descriptionId = `${historyId}-${entry.key}`;
            return (
              <li key={entry.key} className="pr-feedback-dialog__switch">
                <div>
                  <span className="pr-feedback-dialog__label">
                    {entry.label}
                  </span>
                  <span
                    id={descriptionId}
                    className="pr-feedback-dialog__description"
                  >
                    {entry.description(chatTitle)}
                  </span>
                </div>
                <Toggle
                  checked={settings[entry.key] ?? false}
                  label={entry.label}
                  describedBy={descriptionId}
                  disabled={pending || !!owner}
                  onChange={(checked) =>
                    onWrite({ ...settings, [entry.key]: checked })
                  }
                />
              </li>
            );
          })}
        </ul>
        {error && (
          <p className="pr-feedback-dialog__error" role="status">
            {error}
          </p>
        )}
        {history.length > 0 && (
          <div className="pr-feedback-dialog__history">
            <DisclosureToggle
              expanded={historyOpen}
              onToggle={() => setHistoryOpen((open) => !open)}
              controls={historyId}
            >
              History ({history.length})
            </DisclosureToggle>
            {historyOpen && (
              <ol id={historyId} className="pr-feedback-dialog__rows">
                {history.map((row) => {
                  const parts = historyRowParts(row);
                  return (
                    <li key={row.id}>
                      <RelativeTime iso={row.at} now={now} />
                      <span>{parts.what}</span>
                      <code>{parts.head}</code>
                      <span
                        className="pr-feedback-dialog__state"
                        data-state={row.state}
                        title={row.reason}
                      >
                        {parts.state}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
        <p className="pr-feedback-dialog__fine">
          Reads GitHub with this Station's sign-in. The agent is asked to push
          fixes, not to merge or approve.
        </p>
      </div>
    </Dialog>
  );
}
