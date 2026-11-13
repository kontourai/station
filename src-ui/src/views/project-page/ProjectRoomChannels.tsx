import {
  PROJECT_ROOM_DEFAULT_CHANNEL_NAME,
  PROJECT_ROOM_LIMITS,
  type ProjectRoomChannel,
  projectRoomChannelNameProblem,
  projectRoomChannelTopicProblem,
} from '@kontourai/station-contracts/project-room';
import { StationHttpError } from '@kontourai/station-sdk/client';
import type {
  ProjectRoomChannelGuards,
  useProjectRoomChannels,
} from '@kontourai/station-sdk/project-rooms';
import { Badge, Field } from '@kontourai/ui/react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import {
  ActionOverflowMenu,
  type OverflowAction,
} from '../../components/ActionOverflowMenu';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import {
  ArrowDownGlyph,
  ArrowLeftGlyph,
  MoreGlyph,
} from '../../components/icons/Glyph';
import { useNewChannelRequest } from '../../components/project-conversations/new-channel-request';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../../components/ResponsiveDialogSurface';
import { ErrorState, SkeletonBlock } from '../../components/state';
import './ProjectRoomChannels.css';

export type ProjectRoomChannels = ReturnType<typeof useProjectRoomChannels>;
type Panel =
  | { kind: 'switch' }
  | { kind: 'actions' }
  | { kind: 'create' }
  | { kind: 'rename' | 'topic' | 'archive'; channel: ProjectRoomChannel };

/** The channel a room shows: `channelId`, or the default when absent. */
export function currentProjectRoomChannel(
  channels: readonly ProjectRoomChannel[] | undefined,
  channelId: string | undefined,
) {
  return channels?.find((channel) =>
    channelId === undefined
      ? channel.isDefault
      : channel.channelId === channelId,
  );
}
/**
 * What typing produces in the name field: lowercase, with spaces as hyphens.
 * The person sees the result; the server still parses the exact name.
 */
export function channelNameDraft(raw: string) {
  return raw.toLowerCase().replace(/\s/g, '-');
}
function nameError(value: string) {
  switch (projectRoomChannelNameProblem(value)) {
    case 'empty':
      return 'Enter a name.';
    case 'too_long':
      return `Use ${PROJECT_ROOM_LIMITS.channelNameLength} characters or fewer.`;
    case 'format':
      return 'Use lowercase letters, numbers and single hyphens.';
    default:
      return undefined;
  }
}
function topicError(value: string) {
  if (!value.trim()) return undefined;
  switch (projectRoomChannelTopicProblem(value)) {
    case 'too_long':
      return 'This topic is too long.';
    case 'format':
      return 'Keep the topic to one line.';
    default:
      return undefined;
  }
}
function refusal(error: unknown) {
  return error instanceof StationHttpError ? error.code : undefined;
}

export interface ChannelScreen {
  backLabel: string;
  onBack(): void;
  trailing?: ReactNode;
  /** Replaces the channel's name and topic (a thread: "Thread", `#name`). */
  heading?: { title: string; subtitle?: string };
  /** Room commands beside the channel's own settings (Notes). */
  actions: readonly { key: string; label: string; onSelect(): void }[];
}

export function ProjectRoomChannelHeader({
  channels,
  current,
  canEdit,
  guards,
  onSelect,
  projectSlug,
  screen,
}: {
  channels: ProjectRoomChannels;
  current: ProjectRoomChannel | undefined;
  canEdit: boolean;
  /** Absent until the room's person and Project are known. */
  guards: ProjectRoomChannelGuards | undefined;
  onSelect(channelId: string | undefined): void;
  /** Takes "New channel" requests from the sidebar and channel list (#4794). */
  projectSlug?: string;
  /**
   * A phone's full-screen conversation (#4795): a back button, the channel's
   * name and topic, `trailing` (who is here) and a ⋯ sheet holding the
   * channel's settings and `actions`.
   */
  screen?: ChannelScreen;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<Panel>();
  const close = () => setPanel(undefined);
  const list = channels.list.data;
  const switchable = !!list && !!current;
  const manageable = switchable && canEdit && !!guards;
  // Someone who cannot create channels gets the list, where they can still
  // pick one, rather than a form the server would refuse.
  useNewChannelRequest(projectSlug, switchable, () =>
    setPanel(manageable ? { kind: 'create' } : { kind: 'switch' }),
  );
  const unarchive = (channel: ProjectRoomChannel) => {
    if (!guards) return;
    channels.update.mutate({
      ...guards,
      channelId: channel.channelId,
      archived: false,
    });
  };
  const settings: OverflowAction[] =
    manageable && current
      ? [
          {
            key: 'rename',
            label: 'Rename channel',
            haspopup: 'dialog',
            onSelect: () => setPanel({ kind: 'rename', channel: current }),
          },
          {
            key: 'topic',
            label: current.topic ? 'Edit topic' : 'Add topic',
            haspopup: 'dialog',
            onSelect: () => setPanel({ kind: 'topic', channel: current }),
          },
          ...(current.isDefault
            ? []
            : current.archivedAt
              ? [
                  {
                    key: 'unarchive',
                    label: 'Unarchive channel',
                    separatorBefore: true,
                    onSelect: () => unarchive(current),
                  },
                ]
              : [
                  {
                    key: 'archive',
                    label: 'Archive channel',
                    haspopup: 'dialog' as const,
                    separatorBefore: true,
                    tone: 'danger' as const,
                    onSelect: () =>
                      setPanel({ kind: 'archive', channel: current }),
                  },
                ]),
        ]
      : [];
  // A host without channels has only its default room, which it cannot
  // rename; before the room opens, opening it creates that channel.
  const name =
    current?.name ??
    (channels.unsupported || list?.length === 0
      ? PROJECT_ROOM_DEFAULT_CHANNEL_NAME
      : undefined);
  // The phone's ⋯ sheet: switching, then the channel's own settings, then
  // the room's commands. Each row hands over to the panel it opens.
  const sheetRows = screen
    ? [
        ...(switchable
          ? [
              {
                key: 'switch',
                label: 'Switch channel',
                onSelect: () => setPanel({ kind: 'switch' }),
              },
            ]
          : []),
        ...settings.map((action) => ({
          key: action.key,
          label: action.label,
          tone: action.tone,
          onSelect: () => {
            close();
            // The settings open their own panels; none reads the trigger.
            if (triggerRef.current) action.onSelect(triggerRef.current);
          },
        })),
        ...screen.actions.map((action) => ({
          ...action,
          onSelect: () => {
            close();
            action.onSelect();
          },
        })),
      ]
    : [];
  return (
    <div className={`room-channel${screen ? ' room-channel--screen' : ''}`}>
      {screen ? (
        <div className="room-channel__bar">
          <button
            type="button"
            className="room-channel__bar-button"
            aria-label={screen.backLabel}
            onClick={screen.onBack}
          >
            <ArrowLeftGlyph />
          </button>
          {screen.heading ? (
            <div className="room-channel__bar-title">
              <h2 className="room-channel__name">
                <span className="room-channel__label">
                  {screen.heading.title}
                </span>
              </h2>
              {screen.heading.subtitle && (
                <p className="room-channel__topic">{screen.heading.subtitle}</p>
              )}
            </div>
          ) : (
            <div className="room-channel__bar-title">
              <h2 className="room-channel__name">
                <span className="room-channel__label" title={name}>
                  <span className="room-channel__hash" aria-hidden="true">
                    #
                  </span>
                  {name ?? 'Room'}
                </span>
              </h2>
              {current?.topic ? (
                <p className="room-channel__topic" title={current.topic}>
                  {current.topic}
                </p>
              ) : current?.archivedAt ? (
                <p className="room-channel__topic">Archived</p>
              ) : null}
            </div>
          )}
          {screen.trailing}
          {sheetRows.length > 0 && (
            <button
              ref={triggerRef}
              type="button"
              className="room-channel__bar-button"
              aria-label="Channel options"
              aria-haspopup="dialog"
              aria-expanded={panel?.kind === 'actions'}
              onClick={() => setPanel({ kind: 'actions' })}
            >
              <MoreGlyph />
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="room-channel__line">
            <h3 className="room-channel__name">
              {switchable ? (
                <button
                  ref={triggerRef}
                  type="button"
                  className="room-channel__trigger"
                  aria-haspopup="dialog"
                  aria-expanded={panel?.kind === 'switch'}
                  onClick={() => setPanel({ kind: 'switch' })}
                >
                  <span className="room-channel__label" title={name}>
                    <span className="room-channel__hash" aria-hidden="true">
                      #
                    </span>
                    {name}
                  </span>
                  <span className="sr-only">, switch channel</span>
                  <ArrowDownGlyph className="room-channel__caret" />
                </button>
              ) : name ? (
                <span className="room-channel__static">
                  <span className="room-channel__label" title={name}>
                    <span className="room-channel__hash" aria-hidden="true">
                      #
                    </span>
                    {name}
                  </span>
                </span>
              ) : channels.list.isError ? (
                <span className="room-channel__static">Room</span>
              ) : (
                <SkeletonBlock label="Loading channel" />
              )}
            </h3>
            {current?.archivedAt && <Badge value="Archived" tone="neutral" />}
            {settings.length > 0 && (
              <ActionOverflowMenu
                label="Channel settings"
                actions={settings}
                triggerClassName="action-overflow__trigger room-channel__settings"
              />
            )}
          </div>
          {current?.topic && (
            <p className="room-channel__topic" title={current.topic}>
              {current.topic}
            </p>
          )}
        </>
      )}
      {panel?.kind === 'actions' && (
        <ChannelActions
          title={name ? `#${name}` : 'Channel'}
          rows={sheetRows}
          anchorRef={triggerRef}
          onClose={close}
        />
      )}
      {channels.update.isError && !panel && (
        <p className="room-channel__notice" role="status">
          The channel was not updated. Try again.
        </p>
      )}
      {channels.list.isError && !channels.unsupported && (
        <ErrorState
          variant="compact"
          title="Channels unavailable"
          action={
            <Button size="sm" onClick={() => void channels.list.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      {panel?.kind === 'switch' && list && (
        <ChannelSwitcher
          channels={list}
          current={current}
          canCreate={manageable}
          anchorRef={triggerRef}
          onClose={close}
          onCreate={() => setPanel({ kind: 'create' })}
          onSelect={(channel) => {
            close();
            onSelect(channel.isDefault ? undefined : channel.channelId);
          }}
        />
      )}
      {panel &&
        panel.kind !== 'switch' &&
        panel.kind !== 'actions' &&
        guards && (
          <ChannelForm
            key={panel.kind}
            panel={panel}
            channels={channels}
            guards={guards}
            anchorRef={triggerRef}
            atLimit={
              (list?.length ?? 0) >= PROJECT_ROOM_LIMITS.channelsPerProject
            }
            onClose={close}
            onCreated={(channel) => {
              close();
              onSelect(channel.channelId);
            }}
          />
        )}
    </div>
  );
}

/** The phone's ⋯ for a channel: one sheet of commands (#4795). */
function ChannelActions({
  title,
  rows,
  anchorRef,
  onClose,
}: {
  title: string;
  rows: readonly {
    key: string;
    label: string;
    tone?: 'danger';
    onSelect(): void;
  }[];
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const titleId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabelledBy={titleId}
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchorRef.current}
      initialFocusRef={firstRef}
      initialFocusPolicy="always"
      overlayClassName="room-channel-overlay"
      panelClassName="room-channel-panel"
    >
      <ResponsiveDialogHeader
        title={title}
        titleId={titleId}
        closeLabel="Close channel options"
        onClose={onClose}
      />
      <ul className="room-channel-list" aria-label="Channel options">
        {rows.map((row, index) => (
          <li key={row.key}>
            <button
              ref={index === 0 ? firstRef : undefined}
              type="button"
              className="room-channel-list__item"
              data-tone={row.tone}
              onClick={row.onSelect}
            >
              <span className="room-channel-list__name">{row.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </ResponsiveDialogSurface>
  );
}

function ChannelSwitcher({
  channels,
  current,
  canCreate,
  anchorRef,
  onClose,
  onCreate,
  onSelect,
}: {
  channels: readonly ProjectRoomChannel[];
  current: ProjectRoomChannel | undefined;
  canCreate: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onCreate(): void;
  onSelect(channel: ProjectRoomChannel): void;
}) {
  const titleId = useId();
  const archivedId = useId();
  const currentRef = useRef<HTMLButtonElement>(null);
  const active = channels.filter((channel) => !channel.archivedAt);
  const archived = channels.filter((channel) => channel.archivedAt);
  const [showArchived, setShowArchived] = useState(!!current?.archivedAt);
  const item = (channel: ProjectRoomChannel) => {
    const selected = channel.channelId === current?.channelId;
    return (
      <li key={channel.channelId}>
        <button
          ref={selected ? currentRef : undefined}
          type="button"
          className="room-channel-list__item"
          aria-current={selected ? 'true' : undefined}
          onClick={() => onSelect(channel)}
        >
          <span className="room-channel__hash" aria-hidden="true">
            #
          </span>
          <span className="room-channel-list__name">{channel.name}</span>
        </button>
      </li>
    );
  };
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabelledBy={titleId}
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchorRef.current}
      initialFocusRef={currentRef}
      // Start on the current channel, on phones too: a list button raises no keyboard.
      initialFocusPolicy="always"
      overlayClassName="room-channel-overlay"
      panelClassName="room-channel-panel"
    >
      <ResponsiveDialogHeader
        title="Channels"
        titleId={titleId}
        closeLabel="Close channels"
        onClose={onClose}
      />
      <ul className="room-channel-list" aria-label="Channels">
        {active.map(item)}
      </ul>
      {archived.length > 0 && (
        <div className="room-channel-list__archived">
          <DisclosureToggle
            expanded={showArchived}
            onToggle={() => setShowArchived((open) => !open)}
            controls={archivedId}
          >
            Archived ({archived.length})
          </DisclosureToggle>
          {showArchived && (
            <ul
              id={archivedId}
              className="room-channel-list room-channel-list--archived"
              aria-label="Archived channels"
            >
              {archived.map(item)}
            </ul>
          )}
        </div>
      )}
      {canCreate && (
        <div className="room-channel-list__footer">
          <button
            type="button"
            className="room-channel-list__new"
            aria-haspopup="dialog"
            onClick={onCreate}
          >
            <span className="room-channel-list__plus" aria-hidden="true">
              +
            </span>
            New channel
          </button>
        </div>
      )}
    </ResponsiveDialogSurface>
  );
}

const FORM_TITLES = {
  create: 'New channel',
  rename: 'Rename channel',
  topic: 'Channel topic',
  archive: 'Archive channel',
} as const;

function ChannelForm({
  panel,
  channels,
  guards,
  anchorRef,
  atLimit,
  onClose,
  onCreated,
}: {
  panel: Exclude<Panel, { kind: 'switch' | 'actions' }>;
  channels: ProjectRoomChannels;
  guards: ProjectRoomChannelGuards;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  atLimit: boolean;
  onClose(): void;
  onCreated(channel: ProjectRoomChannel): void;
}) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const existing = 'channel' in panel ? panel.channel : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [topic, setTopic] = useState(existing?.topic ?? '');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [taken, setTaken] = useState<string>();
  const pending = channels.create.isPending || channels.update.isPending;
  const withName = panel.kind === 'create' || panel.kind === 'rename';
  const withTopic = panel.kind === 'create' || panel.kind === 'topic';
  const nameProblem = withName ? nameError(name) : undefined;
  // Too long is worth saying while typing; format problems wait for a pause.
  const shownNameError =
    taken === name
      ? `#${name} already exists.`
      : nameProblem &&
          (touched || name.length > PROJECT_ROOM_LIMITS.channelNameLength)
        ? nameProblem
        : undefined;
  const topicProblem = withTopic ? topicError(topic) : undefined;
  const unchanged =
    (panel.kind === 'rename' && name === existing?.name) ||
    (panel.kind === 'topic' && topic.trim() === (existing?.topic ?? ''));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    setFailure(undefined);
    if (pending || nameProblem || topicProblem) return;
    if (unchanged) return onClose();
    try {
      if (panel.kind === 'create') {
        const created = await channels.create.mutateAsync({
          ...guards,
          name,
          ...(topic.trim() ? { topic: topic.trim() } : {}),
        });
        onCreated(created);
        return;
      }
      await channels.update.mutateAsync({
        ...guards,
        channelId: panel.channel.channelId,
        ...(panel.kind === 'rename'
          ? { name }
          : panel.kind === 'topic'
            ? { topic: topic.trim() ? topic.trim() : null }
            : { archived: true }),
      });
      onClose();
    } catch (error) {
      const code = refusal(error);
      if (code === 'project_room_duplicate') {
        setTaken(name);
        nameRef.current?.focus();
      } else if (code === 'project_room_capacity')
        setFailure(
          `This Project has ${PROJECT_ROOM_LIMITS.channelsPerProject} channels, the most it can hold.`,
        );
      else setFailure('Not saved. Check your connection and try again.');
    }
  }
  const nameId = `${id}-name`;
  const topicId = `${id}-topic`;
  const submitLabel = {
    create: 'Create channel',
    rename: 'Rename',
    topic: 'Save topic',
    archive: 'Archive channel',
  }[panel.kind];
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabelledBy={`${id}-title`}
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchorRef.current}
      initialFocusRef={
        withName ? nameRef : panel.kind === 'topic' ? topicRef : confirmRef
      }
      initialFocusPolicy="always"
      overlayClassName="room-channel-overlay"
      panelClassName="room-channel-panel room-channel-panel--form"
    >
      <ResponsiveDialogHeader
        title={FORM_TITLES[panel.kind]}
        titleId={`${id}-title`}
        closeLabel={`Close ${FORM_TITLES[panel.kind].toLowerCase()}`}
        onClose={onClose}
      />
      <form className="room-channel-form" onSubmit={submit} noValidate>
        {panel.kind === 'create' && atLimit && (
          <p className="room-channel-form__note">
            This Project has {PROJECT_ROOM_LIMITS.channelsPerProject} channels,
            the most it can hold.
          </p>
        )}
        {withName && (
          <Field
            label="Name"
            htmlFor={nameId}
            hint={
              panel.kind === 'create' ? 'Lowercase, with hyphens.' : undefined
            }
            error={
              shownNameError && (
                <span id={`${nameId}-error`}>{shownNameError}</span>
              )
            }
          >
            <div className="room-channel-form__name">
              <span className="room-channel__hash" aria-hidden="true">
                #
              </span>
              <input
                ref={nameRef}
                id={nameId}
                value={name}
                className={`control control--input${shownNameError ? ' control--invalid' : ''}`}
                aria-invalid={!!shownNameError || undefined}
                aria-describedby={
                  shownNameError ? `${nameId}-error` : undefined
                }
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint={
                  panel.kind === 'create' && !withTopic ? 'done' : 'go'
                }
                placeholder="design-review"
                onFocus={(event) => {
                  if (panel.kind === 'rename') event.currentTarget.select();
                }}
                onBlur={() => {
                  if (name) setTouched(true);
                }}
                onChange={(event) => {
                  setName(channelNameDraft(event.target.value));
                  setFailure(undefined);
                }}
              />
            </div>
          </Field>
        )}
        {withTopic && (
          <Field
            label={panel.kind === 'create' ? 'Topic (optional)' : 'Topic'}
            htmlFor={topicId}
            hint={
              panel.kind === 'topic' && existing?.topic
                ? 'Clear it to remove the topic.'
                : undefined
            }
            error={
              topicProblem && (
                <span id={`${topicId}-error`}>{topicProblem}</span>
              )
            }
          >
            <input
              ref={topicRef}
              id={topicId}
              value={topic}
              className={`control control--input${topicProblem ? ' control--invalid' : ''}`}
              aria-invalid={!!topicProblem || undefined}
              aria-describedby={topicProblem ? `${topicId}-error` : undefined}
              autoComplete="off"
              enterKeyHint="done"
              placeholder="What this channel is for"
              onChange={(event) => {
                setTopic(event.target.value);
                setFailure(undefined);
              }}
            />
          </Field>
        )}
        {panel.kind === 'archive' && (
          <p className="room-channel-form__note">
            #{panel.channel.name} becomes read-only. Its history stays.
          </p>
        )}
        {failure && (
          <p className="room-channel-form__error" role="alert">
            {failure}
          </p>
        )}
        <div className="room-channel-form__actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            type="submit"
            variant={panel.kind === 'archive' ? 'danger' : 'primary'}
            pending={pending}
            disabled={
              (panel.kind === 'create' && atLimit) ||
              (withName && !name) ||
              !!(touched && nameProblem) ||
              !!topicProblem
            }
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </ResponsiveDialogSurface>
  );
}
