import { type KeyboardEvent, useState } from 'react';
import { Button } from '../Button';
import { Empty, FilteredEmpty, SkeletonList } from '../state';
import { RoomAvatar } from './RoomAvatar';

export interface RoomMentionCandidate {
  readonly id: string;
  readonly name: string;
  readonly agent: boolean;
  /** Shown after the name, such as an agent's handle. */
  readonly handle?: string;
  readonly description?: string;
  readonly ready: boolean;
  readonly unavailableReason?: string;
}

export interface RoomMentionQuery {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

const MAX_CANDIDATES = 8;

/** The `@query` the caret is inside, if any. */
export function findRoomMention(
  value: string,
  caret: number | null,
): RoomMentionQuery | undefined {
  if (caret === null) return undefined;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return match
    ? { start: caret - match[1].length - 1, end: caret, query: match[1] }
    : undefined;
}

/**
 * Picker state for a room composer: which `@` query is open, the filtered
 * people and agents, and the keyboard rules (arrows move, Enter or Tab picks,
 * Escape closes). The room decides what picking does.
 */
export function useRoomMention({
  candidates,
  enabled,
  onPick,
}: {
  candidates: readonly RoomMentionCandidate[];
  enabled: boolean;
  onPick(candidate: RoomMentionCandidate, mention: RoomMentionQuery): void;
}) {
  const [mention, setMention] = useState<RoomMentionQuery>();
  const [active, setActive] = useState(0);
  const query = mention?.query.toLocaleLowerCase() ?? '';
  const filtered = candidates
    .filter((candidate) =>
      `${candidate.name} ${candidate.handle ?? candidate.id} ${candidate.description ?? ''}`
        .toLocaleLowerCase()
        .includes(query),
    )
    .slice(0, MAX_CANDIDATES);
  const selected = Math.min(active, Math.max(0, filtered.length - 1));
  const open = enabled && !!mention;
  const pick = (index: number) => {
    const candidate = filtered[index];
    if (!candidate?.ready || !mention) return;
    setMention(undefined);
    onPick(candidate, mention);
  };
  return {
    mention,
    open,
    filtered,
    selected,
    pick,
    find(value: string, caret: number | null) {
      setActive(0);
      setMention(findRoomMention(value, caret));
    },
    openAt(position: number) {
      setActive(0);
      setMention({ start: position, end: position, query: '' });
    },
    close() {
      setMention(undefined);
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (!open || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(undefined);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(
          Math.max(
            0,
            Math.min(
              filtered.length - 1,
              selected + (event.key === 'ArrowDown' ? 1 : -1),
            ),
          ),
        );
      } else if (
        (event.key === 'Enter' && !event.shiftKey) ||
        event.key === 'Tab'
      ) {
        if (!filtered.length) return;
        event.preventDefault();
        pick(selected);
      }
    },
  };
}

/** The `@` list: people and agents together, agents marked. */
export function RoomMentionPicker({
  id,
  state,
  loading = false,
  failed = false,
  onClearQuery,
}: {
  id: string;
  state: ReturnType<typeof useRoomMention>;
  loading?: boolean;
  failed?: boolean;
  onClearQuery(): void;
}) {
  if (!state.open || !state.mention) return null;
  const { filtered, selected, mention } = state;
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Mention a person or agent"
      className="room-mention-picker"
    >
      {loading && <SkeletonList count={3} label="Finding people and agents" />}
      {failed && (
        <p className="room-mention-picker__note" role="alert">
          Agent choices are unavailable.
        </p>
      )}
      {!loading && !filtered.length ? (
        mention.query ? (
          <FilteredEmpty
            query={mention.query}
            noun="people or agents"
            onClear={onClearQuery}
          />
        ) : (
          <Empty variant="compact" label="Nothing available" />
        )
      ) : null}
      {filtered.map((candidate, index) => (
        <Button
          key={`${candidate.agent ? 'agent' : 'person'}:${candidate.id}`}
          id={`${id}-option-${index}`}
          role="option"
          tabIndex={-1}
          variant="ghost"
          className="room-mention-picker__option"
          aria-label={
            candidate.agent
              ? `${candidate.name} @${candidate.handle ?? candidate.id}`
              : candidate.name
          }
          aria-selected={selected === index}
          aria-disabled={!candidate.ready}
          disabled={!candidate.ready}
          // Keep focus (and the caret) in the field while picking.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => state.pick(index)}
        >
          <RoomAvatar name={candidate.name} agent={candidate.agent} />
          <span className="room-mention-picker__text">
            <span className="room-mention-picker__name">
              {candidate.name}
              {candidate.agent && (
                <span className="room-row__badge">Agent</span>
              )}
            </span>
            <span className="room-mention-picker__description">
              {[
                candidate.agent ? `@${candidate.handle ?? candidate.id}` : '',
                candidate.ready
                  ? candidate.description
                  : (candidate.unavailableReason ?? 'Unavailable'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </Button>
      ))}
    </div>
  );
}
