import type { UIBlock } from '@kontourai/station-contracts/ui-block';

interface BlockPart {
  type: string;
  sourceEventId?: string;
  toolCallId?: string;
  uiBlock?: UIBlock;
}

function sourceKey(part: BlockPart, messageKey: string): string {
  if (part.sourceEventId) return JSON.stringify(['result', part.sourceEventId]);
  if (part.toolCallId) return JSON.stringify(['tool', part.toolCallId]);
  return JSON.stringify(['message', messageKey]);
}

/** Event identity and result-local ordinal survive streaming settlement and part insertion. */
export function uiBlockIdentity(
  parts: readonly BlockPart[],
  index: number,
  messageKey: string,
): string {
  const source = sourceKey(parts[index], messageKey);
  let ordinal = 0;
  for (let i = 0; i < index; i++) {
    if (
      parts[i].type === 'ui-block' &&
      sourceKey(parts[i], messageKey) === source
    )
      ordinal++;
  }
  return JSON.stringify([source, ordinal]);
}
