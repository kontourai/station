import {
  type ChildWorkItem,
  childWorkKey,
} from '@kontourai/station-contracts/child-work';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { parseEpochMs } from '../../utils/parseEpochMs';
import { Button } from '../Button';
import {
  childChatTarget,
  useChildChatNavigation,
} from '../chat-dock/ChildChatNavigationContext';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { ElapsedDuration } from '../ElapsedDuration';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowRightGlyph } from '../icons/Glyph';

function ChildMark({ item, size }: { item: ChildWorkItem; size: number }) {
  return (
    <AgentIcon
      agent={{ name: item.title || 'Subagent', id: childWorkKey(item) }}
      size={size}
    />
  );
}

export function ChatActivityMarks({
  items,
}: {
  items: readonly ChildWorkItem[];
}) {
  return (
    <span className="chat-status-pill__children" aria-hidden="true">
      {items.slice(0, 3).map((item) => (
        <ChildMark key={childWorkKey(item)} item={item} size={18} />
      ))}
      <span>{items.length}</span>
    </span>
  );
}

export function ChatActivityChildren({
  items,
  returnFocus,
}: {
  items: readonly ChildWorkItem[];
  returnFocus(): HTMLElement | undefined;
}) {
  const open = useChildChatNavigation();
  const connection = useOptionalConversationConnection();
  return (
    <ul className="chat-activity-children" aria-label="Running subagents">
      {items.map((item) => {
        const engine =
          item.transcript?.kind === 'codex-thread'
            ? 'codex'
            : item.transcript?.kind === 'claude-subagent'
              ? 'claude'
              : undefined;
        const identity = [engine && engineDisplayLabel(engine), item.model?.id]
          .filter(Boolean)
          .join(' · ');
        const since = parseEpochMs(item.startedAt);
        const canOpen =
          !!open &&
          !!connection &&
          (!!item.transcript ||
            item.producer === 'station-delegate' ||
            item.result?.handle?.kind === 'session');
        const content = (
          <>
            <ChildMark item={item} size={24} />
            <span className="chat-activity-children__identity">
              <strong>{item.title || 'Subagent'}</strong>
              {identity && <small>{identity}</small>}
            </span>
            <span className="chat-activity-children__duration">
              Working
              {since !== undefined && (
                <small>
                  <ElapsedDuration since={since} />
                </small>
              )}
            </span>
            {canOpen && <ArrowRightGlyph />}
          </>
        );
        return (
          <li key={childWorkKey(item)}>
            {canOpen ? (
              <Button
                variant="ghost"
                onClick={() => {
                  open({
                    ...childChatTarget(item, connection),
                    returnFocus: returnFocus(),
                  });
                }}
              >
                {content}
              </Button>
            ) : (
              <div>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
