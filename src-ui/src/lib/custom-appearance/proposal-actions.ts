import type { CustomAppearanceDocument } from '@kontourai/station-contracts/custom-appearance';
import { customAppearanceKey } from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  dismissCustomAppearanceProposal,
  getCustomAppearance,
  keepCustomAppearanceProposal,
  reportCustomAppearanceRender,
} from '@kontourai/station-sdk/client';
import type { QueryClient } from '@tanstack/react-query';
import {
  getCustomAppearanceSnapshot,
  setActiveCustomAppearance,
} from './controller';
import {
  cancelCustomAppearancePreview,
  previewCustomAppearance,
} from './preview';

export interface AppearanceProposalTarget {
  scope: ApiRequestScope & { isCurrent(): boolean };
  client: QueryClient;
  proposalId: string;
  sourceSessionId?: string;
  /** Includes the shell painter's host lease, not just the conversation's lease. */
  isCurrent(): boolean;
  onError(error: unknown): void;
  onSettled?(status: 'Kept' | 'Dismissed'): void;
}

function assertCurrent(target: AppearanceProposalTarget) {
  if (!target.scope.isCurrent() || !target.isCurrent())
    throw new Error('Reconnect to this Station to preview this appearance.');
}

async function readCurrent(target: AppearanceProposalTarget) {
  assertCurrent(target);
  const document = await getCustomAppearance(target.scope.apiBase, {
    requestScope: target.scope,
  });
  assertCurrent(target);
  target.client.setQueryData(customAppearanceKey(target.scope), document);
  return document;
}

async function readProposal(target: AppearanceProposalTarget) {
  const document = await readCurrent(target);
  if (
    document.proposal?.id !== target.proposalId ||
    (target.sourceSessionId !== undefined &&
      document.proposal.sourceSessionId !== target.sourceSessionId)
  )
    throw new Error('This proposal has already been settled or replaced.');
  return document;
}

async function recover(
  target: AppearanceProposalTarget,
  fallback: CustomAppearanceDocument['active'],
) {
  try {
    const document = await readCurrent(target);
    setActiveCustomAppearance(document.active);
  } catch {
    if (target.scope.isCurrent() && target.isCurrent())
      setActiveCustomAppearance(fallback);
  }
}

export async function dismissAppearanceProposal(
  target: AppearanceProposalTarget,
): Promise<void> {
  const document = await readProposal(target);
  const next = await dismissCustomAppearanceProposal(
    target.scope.apiBase,
    document.revision,
    { requestScope: target.scope },
  );
  assertCurrent(target);
  target.client.setQueryData(customAppearanceKey(target.scope), next);
  target.onSettled?.('Dismissed');
}

/** Uses the protected countdown/Keep bar shared with the Appearance page. */
export async function previewAppearanceProposal(
  target: AppearanceProposalTarget,
): Promise<void> {
  const document = await readProposal(target);
  const proposal = document.proposal!;
  const snapshot = getCustomAppearanceSnapshot();
  if (snapshot.safe || snapshot.previewing)
    throw new Error('Finish the current preview before starting another.');
  const monitor = setInterval(() => {
    if (getCustomAppearanceSnapshot().previewing !== proposal.appearance) {
      clearInterval(monitor);
    } else if (!target.scope.isCurrent() || !target.isCurrent()) {
      clearInterval(monitor);
      cancelCustomAppearancePreview();
    }
  }, 250);
  const finish = () => clearInterval(monitor);
  previewCustomAppearance(proposal.appearance, {
    fromAgent: true,
    proposalId: proposal.id,
    onKeep: () => {
      finish();
      const before = getCustomAppearanceSnapshot().active;
      void (async () => {
        const current = await readProposal(target);
        assertCurrent(target);
        setActiveCustomAppearance(current.proposal!.appearance);
        try {
          const next = await keepCustomAppearanceProposal(
            target.scope.apiBase,
            { revision: current.revision, proposalId: target.proposalId },
            { requestScope: target.scope },
          );
          assertCurrent(target);
          target.client.setQueryData(customAppearanceKey(target.scope), next);
          setActiveCustomAppearance(next.active);
          target.onSettled?.('Kept');
        } catch (error) {
          await recover(target, before);
          throw error;
        }
      })().catch(target.onError);
    },
    onDiscard: () => {
      finish();
      void dismissAppearanceProposal(target).catch(target.onError);
    },
    onRevert: finish,
    onReport: (report) => {
      if (!target.scope.isCurrent() || !target.isCurrent()) return;
      void reportCustomAppearanceRender(target.scope.apiBase, report, {
        requestScope: target.scope,
      }).then(
        (next) => {
          if (target.scope.isCurrent() && target.isCurrent())
            target.client.setQueryData<CustomAppearanceDocument>(
              customAppearanceKey(target.scope),
              (current) =>
                current?.revision === next.revision &&
                current.proposal?.id === target.proposalId
                  ? next
                  : current,
            );
        },
        () => undefined,
      );
    },
  });
}
