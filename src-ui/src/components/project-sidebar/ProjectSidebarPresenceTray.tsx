import { ACTIVITY_SURFACE_ID } from '@kontourai/station-contracts/surface-deep-link';
import {
  type LiveActivityParticipant,
  useLiveActivityQuery,
} from '@kontourai/station-sdk/live-activity';
import { type KeyboardEvent, useRef, useState } from 'react';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { identiconHue } from '../../utils/identicon';
import { getInitials } from '../../utils/layout';
import { PeopleGlyph } from '../icons/Glyph';
import './ProjectSidebarPresenceTray.css';

/** Faces in the stack before the rest collapse into a "+k". */
const MAX_AVATARS = 3;

const MESSAGE_NOTE_ID = 'sidebar-presence-message-note';

/**
 * Why the message action is inert, in the user's words. `docs/design/
 * project-membership.md` is explicit that shared-resource admission is
 * incomplete: a second member cannot yet be authorized to read the owner's
 * work, let alone be addressed. #488 owns that admission. Until it lands an
 * enabled button would be a claim Station cannot honour, so the reason is on
 * screen rather than in a tooltip a keyboard user cannot reach.
 */
const MESSAGE_DISABLED_REASON =
  'Messaging opens when project membership admission ships. Station cannot address another member yet.';

interface PresenceParticipant {
  readonly key: string;
  readonly label: string;
}
interface PresenceWorker {
  readonly key: string;
  readonly label: string;
  readonly workName: string;
  readonly sessionId?: string;
}
interface PresenceRoster {
  readonly participants: readonly PresenceParticipant[];
  readonly workers: readonly PresenceWorker[];
}

/**
 * The roster is a pure read of whichever participants the live projection
 * reports on THIS poll. It reads no stored status field, because none exists.
 *
 * WHAT ACTUALLY REMOVES A PARTICIPANT, corrected after review. An earlier
 * version of this comment credited the SSE connection lease
 * (`src-server/services/ssh/client-connection-presence.ts`), which is wrong:
 * that feeds only `connectedClients`
 * (`src-server/routes/orchestration/live-activity.ts:28-34`), a field this tray
 * never reads. Participants come from each task room's live-work session, and
 * leave it two ways — an explicit `depart` command, which only a button sends
 * (`src-ui/src/workspace-panes/ProjectTaskRoomPresence.tsx`, never on tab
 * close), or TTL expiry: a participant carries an `expiresAt` renewed by its
 * heartbeat, and `#prune` drops it on the next mutation or snapshot
 * (`src-server/domain/live-work-session.ts`, `ttlMs: 30_000`).
 *
 * So presence here is HEARTBEAT-BOUNDED, not connection-bound: a closed tab
 * stays in the projection for up to the 30s TTL plus this query's 10s poll.
 * That is still a derivation of live behaviour rather than a stored flag —
 * nothing writes "online" and nothing clears it — but the copy must not
 * promise an immediacy the mechanism does not have, and this function must
 * hold no memory that would out-live even that bound.
 *
 * A HUMAN PARTICIPANT IS A PAIRED DEVICE, NOT A PERSON. The label is
 * `Participant <12 hex>` over `sha256(operatorId, deviceId)`
 * (`project-task-room-runtime.ts` `participantDisplayLabel` / `actorIdFor`,
 * whose own comment reads "a live actor is a paired-device identity"), so one
 * person on a laptop and a phone is two labels — and the runtime's own test
 * pins exactly that as two distinct actors. This tray therefore counts
 * PARTICIPANTS and says so; calling them people would be a claim nothing
 * computes. The fold on the label is a defensive one: the SAME device
 * publishing in two task rooms is two ids for one participant, because the
 * contract calls `id` an "opaque per-room actor key"
 * (`packages/contracts/src/live-activity.ts`). Workers are NOT folded — each
 * row is a separate piece of published work, which is what Follow opens.
 */
function roster(
  participants: readonly LiveActivityParticipant[] | undefined,
): PresenceRoster {
  const humans = new Map<string, PresenceParticipant>();
  const workers: PresenceWorker[] = [];
  for (const participant of participants ?? []) {
    if (participant.actor.kind === 'human') {
      if (!humans.has(participant.actor.label))
        humans.set(participant.actor.label, {
          key: participant.actor.label,
          label: participant.actor.label,
        });
      continue;
    }
    workers.push({
      key: participant.id,
      label: participant.actor.label,
      workName: participant.work.workName,
      ...(participant.work.sessionId
        ? { sessionId: participant.work.sessionId }
        : {}),
    });
  }
  return { participants: [...humans.values()], workers };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One sentence from the two counts, in the same spirit as
 * `liveCollaboratorSummary`: both branches read the same two numbers, so this
 * is a derivation and not a label. "Participant", not "person", for the reason
 * `roster` records: the unit the projection can distinguish is a paired
 * device. The empty branch is a statement about the projection, not a claim
 * that the control is broken — the control stays visible and says what it
 * read.
 */
export function presenceSummary(participants: number, workers: number): string {
  if (participants === 0 && workers === 0)
    return 'nobody is publishing live work';
  const parts = [plural(participants, 'participant', 'participants')];
  if (workers > 0) parts.push(plural(workers, 'agent worker', 'agent workers'));
  return parts.join(', ');
}

/**
 * THREE states, and only one of them is about people.
 *
 * The one this shipped without, and the reason availability is gated on
 * `isError` rather than on `data` alone: TanStack keeps the last successful
 * `data` across a FAILING refetch. `fetchLiveActivity` throws on 5xx and on a
 * network failure (`packages/sdk/src/client/live-activity.ts`), so a Station
 * that goes away leaves the last good roster in the cache — and a tray reading
 * only `data` would keep that roster on screen under copy asserting it is
 * live. That is the stalest possible claim: a list of who WAS here, labelled
 * as who IS here. `roster` holds no memory of its own, but the cache it reads
 * does, so the refusal has to be enforced — in the caller's `available`, which
 * this function is handed rather than recomputing.
 *
 * WHAT THIS DELIBERATELY NO LONGER CLAIMS. An earlier cut had a fourth state,
 * "unavailable on this Station", for `data === undefined` with no error — the
 * hosted deployment that serves no projection at all
 * (`src-server/routes/orchestration/live-activity.ts` refuses when `hosted()`
 * holds, and `fetchLiveActivity` maps its 404 to `undefined`). That branch was
 * UNREACHABLE for every input, which the review's transient-503 finding led to
 * and a probe confirmed: `useQuery` cannot carry an `undefined` value, so a
 * 404 resolves to `status: 'error'` with TanStack's own
 * `["live-activity"] data is undefined`. Success therefore always has data,
 * and a branch conditioned on its absence could only ever be decoration.
 *
 * DISCLOSED GAP, not a solved problem: because both arrive as errors, a
 * Station that is failing and a Station that does not offer presence at all
 * are currently indistinguishable here, so the copy claims neither. Telling
 * them apart needs the fetcher to return a VALUE for "this host has no
 * projection" rather than `undefined` — an SDK change with other consumers
 * (`LiveCollaboratorsSection` renders null on the same input), which is why it
 * is not made here. `ProjectSidebarPresenceTrayLiveQuery.test.tsx` pins both
 * status codes landing in this one state so the conflation stays visible.
 */
function presenceState(
  /**
   * The SAME boolean the caller gates its roster, its stack and its count on,
   * passed in rather than re-derived from `pending`/`error` here. Two
   * derivations of one decision cannot disagree today — `available` already
   * carries the error-outranks-data precedence, since an errored query's
   * `data` is the last good answer — but nothing bound them, and the state
   * this function must never reach is exactly "the copy says who is here
   * while the caller has decided it does not know".
   */
  available: boolean,
  pending: boolean,
  participants: number,
  workers: number,
): { readonly name: string; readonly reads: string } {
  if (available)
    return {
      name: presenceSummary(participants, workers),
      reads: `Publishing live work on the projects you share: ${presenceSummary(participants, workers)}. Read from each task room's live session, which a participant holds by heartbeat: one that stops is dropped when its lease expires, and this panel can take another poll to notice — up to about forty seconds, not the instant its tab closes. One participant per paired device, so one person on two devices counts twice.`,
    };
  if (pending)
    return {
      name: 'not read yet',
      reads: 'Station has not finished reading who is here.',
    };
  // Not available and not pending. The only way to get here is an error:
  // success cannot carry `undefined` data (see above), so there is no fourth
  // case hiding in this branch.
  return {
    name: 'Station is not answering',
    reads:
      'Station did not answer, so this cannot say who is here. The last answer is not repeated, because it may no longer be true. A Station that is failing and one that does not offer presence at all both arrive here.',
  };
}

/**
 * The footer presence tray (#2066, design record D5). An avatar stack and the
 * participant count, opening onto the participants and the agent workers
 * together: participants carry a message action that admission has not
 * unlocked yet, workers carry a follow that opens the same Activity surface
 * `LiveCollaboratorsSection`'s "View session" opens. The record says "people";
 * `roster` records why this says participants instead.
 *
 * It reads the one authority Activity reads — `useLiveActivityQuery`, the
 * `['live-activity']` cache entry — rather than a second copy of it. Two
 * surfaces deriving the same presence from two reads is how they start
 * disagreeing about who is here.
 */
export function ProjectSidebarPresenceTray() {
  const { data, isPending, isError } = useLiveActivityQuery();
  const showSurface = useShowSurface();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const trayRef = useMenuFocus<HTMLDivElement>(open, close);

  const { participants, workers } = roster(data?.participants);
  // An errored query's `data` is the LAST GOOD answer, not the current one.
  const available = data !== undefined && !isError;
  const { name, reads } = presenceState(
    available,
    isPending,
    participants.length,
    workers.length,
  );
  const shown = available ? participants.slice(0, MAX_AVATARS) : [];
  const overflow = available ? participants.length - shown.length : 0;

  /**
   * Escape, shared by BOTH halves of the control rather than owned by the
   * dialog alone. The trigger is a sibling of the tray, not a child, so a
   * keydown on it never reached the tray's handler.
   *
   * It lives on the two interactive elements instead of on the wrapper that
   * contains them: a keydown handler on the wrapping `<span>` is a keyboard
   * affordance on something with no role and no focus, which the a11y ratchet
   * refuses (`noStaticElementInteractions`) — and it is right to, because a
   * span cannot be focused to receive the key in the first place. The wrapper
   * would only ever see Escape by bubbling from these two.
   *
   * Honest scope for the trigger half: opening moves focus INTO the tray, so a
   * user is not normally standing on the trigger holding Escape. This is
   * defensive, not a reported dead end; what it removes is two children of one
   * control answering the same key differently for no stated reason.
   */
  const onEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <span className="sidebar__footer-presence">
      <button
        ref={triggerRef}
        type="button"
        className="sidebar__presence-trigger"
        aria-label={`Who is here: ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onKeyDown={onEscape}
        onMouseDown={(event) => {
          // A pointer press must not move focus. `useMenuFocus` dismisses the
          // tray on focusout, so the browser's focus-on-mousedown closed it
          // BEFORE this button's click ran — and the click then read `open`
          // as false and re-opened what the user meant to dismiss. The tray
          // was unclosable by mouse from its own trigger.
          event.preventDefault();
        }}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          // Focus the trigger ourselves on the way in, since the press no
          // longer does: `useMenuFocus` captures whatever holds focus at open
          // time as the thing to restore to, and for a pointer user that
          // would otherwise be `document.body`, which it refuses to focus.
          triggerRef.current?.focus();
          setOpen(true);
        }}
      >
        {/*
          UNCONDITIONAL. This used to be the else-branch of `shown.length > 0`,
          which made the collapsed rail render a BLANK trigger whenever anyone
          was present: the rail hides the stack and the count in CSS, so with a
          roster the only two children it had were both hidden and the glyph
          that was supposed to survive was never rendered to begin with. The
          glyph is the one child of this button that is always present at every
          width, which is what makes the control impossible to render empty.
        */}
        <span className="sidebar__presence-glyph" aria-hidden="true">
          <PeopleGlyph />
        </span>
        {shown.length > 0 && (
          <span className="sidebar__presence-stack" aria-hidden="true">
            {shown.map((participant) => (
              <span
                key={participant.key}
                className="sidebar__presence-avatar"
                style={{
                  backgroundColor: `hsl(${identiconHue(participant.label)} 45% 32%)`,
                }}
              >
                {getInitials(participant.label)}
              </span>
            ))}
            {overflow > 0 && (
              <span className="sidebar__presence-avatar sidebar__presence-avatar--overflow">
                {`+${overflow}`}
              </span>
            )}
          </span>
        )}
        {available && (
          <span className="sidebar__presence-count" aria-hidden="true">
            {participants.length}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={trayRef}
          className="sidebar__presence-tray"
          role="dialog"
          aria-label="Who is here"
          tabIndex={-1}
          onKeyDown={onEscape}
        >
          <p className="sidebar__presence-reads">{reads}</p>
          {/* Gated on `available`, not on length: under an error the roster in
              hand is the last good one, and listing it would restate in rows
              exactly the stale claim the summary above refuses to make. */}
          {available && participants.length > 0 && (
            <ul
              className="sidebar__presence-rows"
              aria-label="Participants here"
            >
              {participants.map((participant) => (
                <li key={participant.key} className="sidebar__presence-row">
                  <span
                    className="sidebar__presence-avatar"
                    aria-hidden="true"
                    style={{
                      backgroundColor: `hsl(${identiconHue(participant.label)} 45% 32%)`,
                    }}
                  >
                    {getInitials(participant.label)}
                  </span>
                  <span className="sidebar__presence-label">
                    {participant.label}
                  </span>
                  <button
                    type="button"
                    className="sidebar__presence-action"
                    disabled
                    aria-describedby={MESSAGE_NOTE_ID}
                  >
                    Message
                  </button>
                </li>
              ))}
            </ul>
          )}
          {available && workers.length > 0 && (
            <ul
              className="sidebar__presence-rows"
              aria-label="Agent workers here"
            >
              {workers.map((worker) => (
                <li key={worker.key} className="sidebar__presence-row">
                  <span className="sidebar__presence-label">
                    {worker.label}
                    <span className="sidebar__presence-work">
                      {worker.workName}
                    </span>
                  </span>
                  {worker.sessionId ? (
                    <button
                      type="button"
                      className="sidebar__presence-action"
                      aria-label={`Follow ${worker.label} on ${worker.workName}`}
                      onClick={() => {
                        close();
                        showSurface(ACTIVITY_SURFACE_ID, {
                          session: worker.sessionId,
                        });
                      }}
                    >
                      Follow
                    </button>
                  ) : (
                    /* The contract carries `sessionId` only for an
                       already-authorized agent-session reference
                       (`packages/contracts/src/live-activity.ts:33`). With no
                       reference there is no session to open, and a button
                       that could only fail is worse than saying so. */
                    <span className="sidebar__presence-note">
                      No session to follow
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {available && participants.length > 0 && (
            <p id={MESSAGE_NOTE_ID} className="sidebar__presence-note">
              {MESSAGE_DISABLED_REASON}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
