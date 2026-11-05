import type { ComponentProps } from 'react';
import { ComposerStopButton } from '../chat/ComposerStopButton';

/** Turn interruption uses the controller's keyed cancel; Task stop stays confirmed. */
export function ConversationStopControl(
  props: ComponentProps<typeof ComposerStopButton>,
) {
  return <ComposerStopButton {...props} />;
}
