/**
 * The Workspace Pane that opens MeetingTranscriptionModal.
 *
 * Station has no plugin toolbar actions, so the modal needs a surface a
 * person can reach: this Pane, which the manifest declares under
 * `workspacePanes` and the bundle exports under `components` (#2401).
 */
import {
  agentId,
  STATION_AGENT_ID,
} from '@kontourai/station-contracts/agent-identity';
import { useSendToChat } from '@kontourai/station-sdk';
import { useState } from 'react';
import { MeetingTranscriptionModal } from './MeetingTranscriptionModal';

const STATION_AGENT = agentId(STATION_AGENT_ID);

export function MeetingTranscriptionPane() {
  const [isOpen, setIsOpen] = useState(false);
  // The transcript goes to Station's own Agent: this plugin contributes none.
  const sendToChat = useSendToChat(STATION_AGENT);

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Meeting transcription</h1>
      <p>
        Capture a meeting through a registered speech-to-text provider, then
        send the transcript to chat.
      </p>
      <button type="button" onClick={() => setIsOpen(true)}>
        Start meeting
      </button>
      <MeetingTranscriptionModal
        isOpen={isOpen}
        onSend={sendToChat}
        onClose={() => setIsOpen(false)}
      />
    </main>
  );
}
