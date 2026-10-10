import type {
  InputRequestOutcome,
  InputRequestRecord,
} from '@kontourai/station-contracts/input-request';
import './InputRequestCard.css';

const OUTCOME_LABEL: Record<InputRequestOutcome, string> = {
  pending: 'Waiting for you',
  accepted: 'Answered',
  declined: 'Declined',
  cancelled: 'Cancelled',
  allowed: 'Allowed',
  denied: 'Denied',
  expired: 'Expired',
};

/**
 * #3390: the transcript's record of one input request — who asked, what,
 * and what became of it. The answer itself is never shown here; a request
 * still waiting is answered on its own card.
 */
export function InputRequestRecordRow({
  record,
}: {
  record: InputRequestRecord;
}) {
  return (
    <div
      className="input-request-record"
      data-outcome={record.outcome}
      data-request-id={record.requestId}
    >
      <span className="input-request-record__asker">
        {record.kind === 'form'
          ? `${record.requester} asked`
          : `${record.requester} needed approval`}
      </span>
      {record.message && (
        <span className="input-request-record__message">{record.message}</span>
      )}
      <span className="input-request-record__outcome">
        {OUTCOME_LABEL[record.outcome]}
      </span>
    </div>
  );
}
