import type { TurnProvenanceContextInjection } from '@kontourai/station-contracts/turn-provenance-context';
import { useId, useState } from 'react';
import './ContextInjectionDisclosure.css';

interface ContextBlock {
  kind: string;
  detail?: string;
  approxTokens?: number;
}

export interface ContextInjectionDisclosureProps {
  contextInjection: TurnProvenanceContextInjection;
}

/**
 * Derive the visible rows from the dispatch-time receipt. A present contract
 * block produces exactly one row; absent blocks produce nothing (#236 item 2).
 */
function contextBlocks(record: TurnProvenanceContextInjection): ContextBlock[] {
  const blocks: ContextBlock[] = [];
  if (record.knowledge) {
    const { chunkCount, sources, omittedSources, approxTokens } =
      record.knowledge;
    const sourceNames = sources.join(', ');
    const sourceDetail =
      omittedSources > 0
        ? `${sourceNames}${sourceNames ? ' — ' : ''}and ${omittedSources} more`
        : sourceNames;
    blocks.push({
      kind: 'Project knowledge',
      detail: `${chunkCount} chunk${chunkCount === 1 ? '' : 's'}${sourceDetail ? ` from ${sourceDetail}` : ''}`,
      approxTokens,
    });
  }
  if (record.projectRules) {
    blocks.push({
      kind: 'Project rules',
      approxTokens: record.projectRules.approxTokens,
    });
  }
  if (record.guidelines) {
    const { reinforce, avoid, approxTokens } = record.guidelines;
    blocks.push({
      kind: 'Behavior guidelines',
      detail: `${reinforce} reinforce / ${avoid} avoid`,
      approxTokens,
    });
  }
  if (record.workflowSteering) {
    blocks.push({
      kind: 'Workflow steering',
      approxTokens: record.workflowSteering.approxTokens,
    });
  }
  if (record.conversationFeedback) {
    const { flaggedMessages, approxTokens } = record.conversationFeedback;
    blocks.push({
      kind: 'Conversation feedback',
      detail: `${flaggedMessages} flagged message${flaggedMessages === 1 ? '' : 's'}`,
      approxTokens,
    });
  }
  if (record.ambient) {
    blocks.push({
      kind: 'Ambient context',
      approxTokens: record.ambient.approxTokens,
    });
  }
  return blocks;
}

/**
 * Per-turn disclosure of Station-composed context. Token figures come from
 * the server's byte-derived estimate and therefore always carry `~`; this UI
 * never upgrades them into tokenizer measurements or a model-window claim.
 */
export function ContextInjectionDisclosure({
  contextInjection,
}: ContextInjectionDisclosureProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const blocks = contextBlocks(contextInjection);

  // An OBSERVED record with no blocks is a fact the pipeline earned — Station
  // composed nothing for this turn — and it is not the same as the host's
  // `unavailable` slot, which means nothing was recorded either way. The host
  // only renders this component for `observed`, so reaching here with zero
  // blocks states the fact rather than discarding it.
  if (blocks.length === 0) {
    return (
      <section
        className="context-injection context-injection--empty"
        aria-label="Injected context for this turn"
      >
        <p className="context-injection__qualification">
          Station composed no additional context for this turn.
        </p>
      </section>
    );
  }

  return (
    <section
      className="context-injection"
      aria-label="Injected context for this turn"
    >
      <button
        type="button"
        className="context-injection__summary"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span>
          Injected context · {blocks.length}{' '}
          {blocks.length === 1 ? 'block' : 'blocks'}
        </span>
        <span aria-hidden="true" className="context-injection__chevron">
          {open ? '⌄' : '›'}
        </span>
      </button>

      {open && (
        <div id={detailsId} className="context-injection__detail">
          <dl className="context-injection__blocks">
            {blocks.map((block) => (
              <div className="context-injection__block" key={block.kind}>
                <dt className="context-injection__kind">{block.kind}</dt>
                <dd className="context-injection__value">
                  {block.detail && <span>{block.detail}</span>}
                  {block.approxTokens !== undefined && (
                    <span className="context-injection__size">
                      ~{block.approxTokens} tokens
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {/* Two caveats, and the second matters more: without it a reader
              takes "N blocks" for everything Station sent the model. The
              record covers only what Station composed for this turn — the
              agent's own system prompt, its tool schemas and the prior
              conversation are assembled elsewhere and are not counted here. */}
          <p className="context-injection__qualification">
            Token figures are approximate, derived from the injected text size.
            This covers the context Station composed for this turn — not the
            agent's system prompt, its tools, or the conversation history.
          </p>
        </div>
      )}
    </section>
  );
}

export default ContextInjectionDisclosure;
