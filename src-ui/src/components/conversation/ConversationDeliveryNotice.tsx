import type { ConversationDeliveryNotice as Notice } from '../../utils/messageDeliveryState';
import { MessageDeliveryNote } from '../chat/message-bubble/MessageDeliveryNote';
import type { DeliveryPort } from './DeliveryPort';
import './ConversationDeliveryNotice.css';

export function ConversationDeliveryNotice({
  notice,
  port,
}: {
  notice: Notice;
  port: DeliveryPort;
}) {
  return (
    <div className="message-delivery-notice">
      <MessageDeliveryNote state={notice.state} port={port} />
      <p>{notice.description}</p>
      <details>
        <summary>Details</summary>
        <pre>{notice.diagnostic}</pre>
      </details>
    </div>
  );
}
