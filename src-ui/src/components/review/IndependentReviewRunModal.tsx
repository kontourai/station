import type { IndependentReviewRequest } from '@kontourai/station-contracts/review-evidence';
import {
  useAgentsQuery,
  useProjectsQuery,
  useRunIndependentReviewMutation,
} from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../Button';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import '../../views/ReviewQueueView.css';

/**
 * #2064 (D4): the "Run independent review" form, extracted from
 * `ReviewQueueView` so the project's Coding layout runs a review through the
 * SAME `POST /api/projects/:slug/reviews` request builder and the same
 * validation rules — distinct reviewer Agents, delta reviews requiring a
 * prior receipt — rather than a second form that agrees today.
 *
 * The "input only" sentence travels with the form deliberately: a receipt is
 * evidence for verification and does not approve, reject, or satisfy a gate,
 * and that has to be true of every surface that can produce one.
 */
export function IndependentReviewRunModal({
  isOpen,
  onClose,
  onCompleted,
  lockedProjectSlug,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCompleted: (receiptId: string, projectSlug: string) => void;
  /**
   * #2064 (D4): the Coding layout runs a review for the project it is already
   * showing, so the project picker would be a second, contradictable answer to
   * a question the host has already answered. When set, the form shows the
   * project as fixed text and submits exactly it. The global Review page
   * leaves it unset and keeps the picker.
   */
  lockedProjectSlug?: string;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { data: projectData = [] } = useProjectsQuery();
  const { data: agentData = [] } = useAgentsQuery();
  const projects = projectData as Array<{ slug: string; name?: string }>;
  const agents = agentData as Array<{ slug: string }>;
  const mutation = useRunIndependentReviewMutation();
  const [mode, setMode] = useState<'initial' | 'delta'>('initial');
  const [projectSlug, setProjectSlug] = useState(lockedProjectSlug ?? '');
  const [baseRevision, setBaseRevision] = useState('origin/main');
  const [headRevision, setHeadRevision] = useState('HEAD');
  const [implementerAgentSlug, setImplementerAgentSlug] = useState('station');
  const [executorAgentSlugs, setExecutorAgentSlugs] = useState('');
  const [lensId, setLensId] = useState('architecture');
  const [lensInstructions, setLensInstructions] = useState(
    'Review placement, reachability, failure totality, and compatibility.',
  );
  const [priorReceiptId, setPriorReceiptId] = useState('');
  const [claimedFindingIds, setClaimedFindingIds] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (lockedProjectSlug) {
      setProjectSlug(lockedProjectSlug);
      return;
    }
    if (!projectSlug && projects[0]?.slug) setProjectSlug(projects[0].slug);
  }, [lockedProjectSlug, projectSlug, projects]);

  if (!isOpen) return null;

  function submit() {
    const agentSlugs = commaList(executorAgentSlugs);
    if (
      !projectSlug ||
      !implementerAgentSlug.trim() ||
      agentSlugs.length === 0
    ) {
      setValidationError(
        'Project, implementing Agent, and reviewer Agents are required.',
      );
      return;
    }
    if (new Set(agentSlugs).size !== agentSlugs.length) {
      setValidationError(
        'Every independent reviewer must use a distinct Agent.',
      );
      return;
    }
    const deltaFindingIds = commaList(claimedFindingIds);
    if (
      mode === 'delta' &&
      (!priorReceiptId.trim() || deltaFindingIds.length === 0)
    ) {
      setValidationError(
        'Delta reviews require a prior receipt and finding IDs.',
      );
      return;
    }
    setValidationError(null);
    const request: IndependentReviewRequest = {
      requestId: randomCorrelationId(),
      mode,
      target: {
        kind: 'git-range',
        projectSlug,
        baseRevision: baseRevision.trim(),
        headRevision: headRevision.trim(),
      },
      implementerAgentSlug: implementerAgentSlug.trim(),
      reviewers: agentSlugs.map((agentSlug, index) => ({
        reviewerId: `reviewer-${index + 1}`,
        executorAgentSlug: agentSlug,
        lens: { id: lensId.trim(), instructions: lensInstructions.trim() },
      })),
      ...(mode === 'delta'
        ? {
            delta: {
              priorReceiptId: priorReceiptId.trim(),
              claimedFindingIds: deltaFindingIds,
            },
          }
        : {}),
    };
    mutation.mutate(request, {
      onSuccess: (result) =>
        onCompleted(
          result.receipt.receiptId,
          result.receipt.target.projectSlug,
        ),
    });
  }

  return createPortal(
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onClose}
      ariaLabelledBy={titleId}
      overlayClassName="modal-overlay"
      panelClassName="modal-dialog review-run-modal"
      initialFocusRef={cancelRef}
      initialFocusPolicy="always"
      historyMode="none"
    >
      <div className="modal-header">
        <h3 id={titleId}>Run independent review</h3>
      </div>
      <div className="modal-body review-run-modal__fields">
        {lockedProjectSlug ? (
          <p>Project {lockedProjectSlug}</p>
        ) : (
          <label>
            Project
            <select
              value={projectSlug}
              onChange={(event) => setProjectSlug(event.target.value)}
            >
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name ?? project.slug}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Mode
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as 'initial' | 'delta')
            }
          >
            <option value="initial">Initial review</option>
            <option value="delta">Delta review</option>
          </select>
        </label>
        <label>
          Base revision
          <input
            value={baseRevision}
            onChange={(event) => setBaseRevision(event.target.value)}
          />
        </label>
        <label>
          Head revision
          <input
            value={headRevision}
            onChange={(event) => setHeadRevision(event.target.value)}
          />
        </label>
        <label>
          Implementing Agent
          <select
            value={implementerAgentSlug}
            onChange={(event) => setImplementerAgentSlug(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.slug} value={agent.slug}>
                {agent.slug}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reviewer Agent slugs
          <input
            list="review-run-agent-slugs"
            value={executorAgentSlugs}
            onChange={(event) => setExecutorAgentSlugs(event.target.value)}
            placeholder="reviewer-one, reviewer-two"
          />
          <datalist id="review-run-agent-slugs">
            {agents.map((agent) => (
              <option key={agent.slug} value={agent.slug} />
            ))}
          </datalist>
        </label>
        <label>
          Lens ID
          <input
            value={lensId}
            onChange={(event) => setLensId(event.target.value)}
          />
        </label>
        <label>
          Lens instructions
          <textarea
            value={lensInstructions}
            onChange={(event) => setLensInstructions(event.target.value)}
          />
        </label>
        {mode === 'delta' ? (
          <>
            <label>
              Prior receipt ID
              <input
                value={priorReceiptId}
                onChange={(event) => setPriorReceiptId(event.target.value)}
              />
            </label>
            <label>
              Claimed finding IDs
              <textarea
                value={claimedFindingIds}
                onChange={(event) => setClaimedFindingIds(event.target.value)}
                placeholder="finding ID, finding ID"
              />
            </label>
          </>
        ) : null}
        <p className="review-run-modal__truth">
          Findings are recorded as evidence input. They do not approve, reject,
          or satisfy a gate.
        </p>
        {validationError ? <p role="alert">{validationError}</p> : null}
        {mutation.isError ? (
          <p role="alert">The independent review could not be completed.</p>
        ) : null}
      </div>
      <ResponsiveSurfaceActions className="modal-footer">
        <Button ref={cancelRef} variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={mutation.isPending} onClick={submit}>
          {mutation.isPending ? 'Reviewing…' : 'Run review'}
        </Button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>,
    document.body,
  );
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
