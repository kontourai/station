import type {
  TaskUserInputAttachmentProjection,
  TaskUserInputReferenceProjection,
} from '@kontourai/station-contracts/task-graph';
import { useTaskUserInputReferencesQuery } from '@kontourai/station-sdk/task-user-input-references';
import { Button } from '../../components/Button';
import { ErrorState, SkeletonList } from '../../components/state';

const PINNED_INPUT_COPY =
  'Explicitly pinned input from this Task’s work context. It was not inferred to support any answer.';
const safeWrap = { minWidth: 0, overflowWrap: 'anywhere' } as const;

function attachmentDescription(attachment: TaskUserInputAttachmentProjection) {
  const size =
    Number.isFinite(attachment.size) && attachment.size >= 0
      ? `${attachment.size.toLocaleString()} bytes`
      : 'Size unavailable';
  return `${attachment.name} · ${attachment.mediaType} · ${size}`;
}

function AvailableInput({
  input,
  index,
}: {
  input: Extract<TaskUserInputReferenceProjection, { state: 'available' }>;
  index: number;
}) {
  return (
    <article
      className="task-user-inputs__item"
      style={safeWrap}
      aria-label={`Pinned input ${index + 1}`}
    >
      <p className="task-user-inputs__copy">{PINNED_INPUT_COPY}</p>
      {input.input.prompt.length > 0 && (
        <div className="task-user-inputs__prompt">
          <span>Authored prompt</span>
          <p style={safeWrap}>{input.input.prompt}</p>
        </div>
      )}
      {input.input.attachments.length > 0 && (
        <ul
          className="task-user-inputs__attachments"
          aria-label="Attached input files"
        >
          {input.input.attachments.map((attachment, attachmentIndex) => (
            <li
              key={`${attachment.name}:${attachment.mediaType}:${attachment.size}:${attachmentIndex}`}
              style={safeWrap}
            >
              {attachmentDescription(attachment)}
            </li>
          ))}
        </ul>
      )}
      <details className="task-user-inputs__origin">
        <summary>View origin</summary>
        <dl>
          <div>
            <dt>Session</dt>
            <dd style={safeWrap}>{input.sessionId}</dd>
          </div>
          <div>
            <dt>Turn</dt>
            <dd style={safeWrap}>{input.turnId}</dd>
          </div>
          <div>
            <dt>Input event</dt>
            <dd style={safeWrap}>{input.eventId}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

function UnavailableInput() {
  return (
    <article
      className="task-user-inputs__item"
      style={safeWrap}
      aria-label="Pinned input unavailable"
    >
      <p className="task-user-inputs__copy">{PINNED_INPUT_COPY}</p>
      <p className="task-user-inputs__unavailable">
        This pinned input cannot be reopened by this Station.
      </p>
    </article>
  );
}

/** Task-owned inputs are separate context, never part of an answer card. */
export function TaskUserInputReferences({ taskId }: { taskId: string }) {
  const query = useTaskUserInputReferencesQuery(taskId);
  if (query.isLoading) {
    return (
      <section
        className="task-workspace__section task-user-inputs"
        aria-label="Pinned inputs"
      >
        <h3 className="task-workspace__section-title">Pinned inputs</h3>
        <SkeletonList count={1} label="Loading pinned inputs" />
      </section>
    );
  }
  if (query.error || !query.data) {
    return (
      <section
        className="task-workspace__section task-user-inputs"
        aria-label="Pinned inputs"
      >
        <h3 className="task-workspace__section-title">Pinned inputs</h3>
        <ErrorState
          variant="compact"
          title="Pinned inputs are unavailable"
          description="Try again to reopen pinned inputs."
          action={
            <Button size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        />
      </section>
    );
  }
  if (query.data.length === 0) return null;
  return (
    <section
      className="task-workspace__section task-user-inputs"
      aria-label="Pinned inputs"
    >
      <h3 className="task-workspace__section-title">Pinned inputs</h3>
      <div className="task-user-inputs__list">
        {query.data.map((input, index) =>
          input.state === 'available' ? (
            <AvailableInput key={input.id} input={input} index={index} />
          ) : (
            <UnavailableInput key={`unavailable-${index}`} />
          ),
        )}
      </div>
    </section>
  );
}
