/**
 * The Workspace Pane that opens MeetingTranscriptionModal.
 *
 * Station has no plugin toolbar actions, so the modal needs a surface a
 * person can reach: this Pane, which the manifest declares under
 * `workspacePanes` and the bundle exports under `components` (#2401).
 */

import { useSendToChat } from '@kontourai/station-sdk';
import {
  type AgentId,
  agentId,
  STATION_AGENT_ID,
} from '@kontourai/station-sdk/agent';
import { useState } from 'react';
import { MeetingTranscriptionModal } from './MeetingTranscriptionModal';

export function MeetingTranscriptionPane() {
  // Installed bundles use the host's SDK, which may predate this export.
  if (typeof STATION_AGENT_ID !== 'string') {
    return <p role="status">Update Station to use Meeting Transcription.</p>;
  }
  return <MeetingCapture agent={agentId(STATION_AGENT_ID)} />;
}

function MeetingCapture({ agent }: { agent: AgentId }) {
  const [isOpen, setIsOpen] = useState(false);
  const sendToChat = useSendToChat(agent);

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
