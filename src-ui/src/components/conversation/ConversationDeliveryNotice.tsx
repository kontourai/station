import type { ConversationDeliveryNotice as Notice } from '../../utils/messageDeliveryState';
import './ConversationDeliveryNotice.css';

export function ConversationDeliveryNotice({ notice }: { notice: Notice }) {
  return (
    <div className="message-delivery-notice">
      <p>{notice.description}</p>
      <details>
        <summary>Details</summary>
        <pre>{notice.diagnostic}</pre>
      </details>
    </div>
  );
}
