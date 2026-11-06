import type React from 'react';
import { Button } from '../Button';
import type { ChatInputArea } from '../chat/ChatInputArea';
import { LazyBoundary } from '../LazyBoundary';
import { ErrorState, SkeletonList } from '../state';
import { ConversationStopControl } from './ConversationStopControl';

const loadChatInputArea = () =>
  import('../chat/ChatInputArea').then((module) => ({
    default: module.ChatInputArea,
  }));

export function ConversationComposer(
  props: React.ComponentProps<typeof ChatInputArea>,
) {
  const pendingControls = (
    <div className="chat-controls-row">
      <div className="chat-input__activity" ref={props.activityRef}>
        {props.activity}
      </div>
      <span className="chat-controls-row__spacer" />
      {props.turnInFlight && (
        <ConversationStopControl
          onCancel={props.onCancel}
          stopPending={props.stopPending}
        />
      )}
    </div>
  );
  return (
    <LazyBoundary
      load={loadChatInputArea}
      componentProps={props}
      pending={
        <div className="chat-input">
          <SkeletonList count={2} label="Loading composer" />
          {pendingControls}
        </div>
      }
      unavailable={(retry) => (
        <div className="chat-input">
          <ErrorState
            title="Could not load the composer"
            description="Your draft is retained. Retry to continue writing."
            action={<Button onClick={retry}>Retry composer</Button>}
          />
          {pendingControls}
        </div>
      )}
    />
  );
}
