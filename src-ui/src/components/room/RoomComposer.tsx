import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { useChatPaneFileDrop } from '../../hooks/useChatPaneFileDrop';
import { useClipboardImagePaste } from '../../hooks/useClipboardImagePaste';
import { useFileAttachment } from '../../hooks/useFileAttachment';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { useRoomAttachments } from '../../hooks/useRoomAttachments';
import { filesFromDataTransfer } from '../../utils/attachment-file-transfer';
import { Button } from '../Button';
import { ComposerAttachmentStrip } from '../chat/ComposerAttachmentStrip';
import { IconButton } from '../IconButton';
import { AttachmentGlyph, PasteGlyph } from '../icons/Glyph';
import { composerEnterAction, useTouchKeyboard } from './composerKeys';
import './RoomComposer.css';
import { useKeepAboveKeyboard } from './useKeepAboveKeyboard';

/** The attachment port a room offers when its messages can carry files. */
export type RoomComposerAttachments = Pick<
  ReturnType<typeof useRoomAttachments>,
  'files' | 'error' | 'setError' | 'selectFiles' | 'remove' | 'busy'
>;

type InputProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'placeholder' | 'id'
>;

/**
 * The one room composer (#4793): an auto-growing field, a round send button,
 * and slots for the room's own tools. Enter sends on a hardware keyboard;
 * Return adds a line on a touch keyboard; composition never sends. On a phone
 * it rides above the on-screen keyboard.
 */
export function RoomComposer({
  id,
  label,
  placeholder,
  value,
  onValueChange,
  onSend,
  canSend,
  pending = false,
  sendLabel,
  readOnly = false,
  disabled = false,
  textareaRef,
  inputProps,
  above,
  tools,
  below,
  sendGlyph,
  attachments,
  className,
}: {
  id: string;
  /** Accessible name of the message field. */
  label: string;
  placeholder: string;
  value: string;
  onValueChange(value: string, caret: number | null): void;
  onSend(): void;
  canSend: boolean;
  pending?: boolean;
  /** Accessible name of the send button, such as "Send to task room". */
  sendLabel: string;
  readOnly?: boolean;
  /** Locks the field (an unconfirmed send is held); sending follows `canSend`. */
  disabled?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Picker wiring and composition handlers. Its onKeyDown runs first. */
  inputProps?: InputProps;
  /** Chips inside the frame, above the field (reply target, recipient). */
  above?: ReactNode;
  /** Controls beside the send button. */
  tools?: ReactNode;
  /** Below the frame: a picker, notices. */
  below?: ReactNode;
  /** Replaces the send arrow, such as a check for saving an edit. */
  sendGlyph?: ReactNode;
  attachments?: {
    port: RoomComposerAttachments;
    locked: boolean;
    /** Resets a drag in progress when the room changes. */
    owner: string;
  };
  className?: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  // The field always renders, so the handle is set whenever a caller reads it.
  useImperativeHandle(
    textareaRef,
    () => field.current as HTMLTextAreaElement,
    [],
  );
  const root = useRef<HTMLDivElement>(null);
  const touchKeyboard = useTouchKeyboard();
  const mobile = useIsMobile();
  const viewport = useMobileVisualViewport();

  useKeepAboveKeyboard(root, mobile, viewport);

  // Grow with the text up to the CSS cap, then scroll inside the field.
  useLayoutEffect(() => {
    void value;
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  const port = attachments?.port;
  const attachLocked = !port || !!attachments?.locked || disabled;
  const drop = useChatPaneFileDrop({
    rootRef: root,
    resetKey: attachments?.owner ?? id,
    enabled: !attachLocked,
    selectFiles: async (files) => port?.selectFiles(files),
    reportError: (error) => port?.setError(error),
  });
  const picker = useFileAttachment({
    onFilesSelected: (files) => port?.selectFiles(files),
  });
  // Paste image: mobile WebViews offer no Paste for an image-only clipboard,
  // so the clipboard's images enter through the same port as Attach.
  const clipboard = useClipboardImagePaste({
    onFiles: async (files) => port?.selectFiles(files),
    onMessage: (message) => port?.setError(message),
  });

  const send = () => {
    if (canSend && !pending) onSend();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // A key that belongs to an IME composition is the IME's: neither the @
    // list nor sending may act on it (#4810 review 4).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    inputProps?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const action = composerEnterAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
      },
      touchKeyboard,
    );
    if (action !== 'send') return;
    event.preventDefault();
    send();
  };

  return (
    <div
      ref={root}
      className={[
        'room-composer',
        mobile && 'room-composer--compact',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        mobile && viewport.bottomInset > 0
          ? { marginBottom: viewport.bottomInset }
          : undefined
      }
      {...(port
        ? {
            onDragEnter: drop.onDragEnter,
            onDragOver: drop.onDragOver,
            onDragLeave: drop.onDragLeave,
            onDragEnd: drop.onDragEnd,
            onDrop: (event: React.DragEvent<HTMLDivElement>) => {
              drop.onDrop(event);
              if (event.defaultPrevented) event.stopPropagation();
            },
          }
        : {})}
    >
      <div
        className={`room-composer__frame${drop.isDraggingFiles ? ' room-composer__frame--drop' : ''}`}
      >
        {above && <div className="room-composer__above">{above}</div>}
        {drop.isDraggingFiles && (
          <p className="room-composer__drop" role="status">
            Drop images or files to attach
          </p>
        )}
        {port && port.files.length > 0 && (
          <fieldset
            disabled={attachLocked}
            className="room-composer__attachments"
          >
            <ComposerAttachmentStrip
              attachments={port.files}
              onRemove={port.remove}
            />
          </fieldset>
        )}
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <textarea
          {...inputProps}
          ref={field}
          id={id}
          className="room-composer__field"
          rows={1}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          disabled={disabled}
          enterKeyHint={touchKeyboard ? 'enter' : 'send'}
          onChange={(event) =>
            onValueChange(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            )
          }
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            inputProps?.onPaste?.(event);
            if (attachLocked || event.defaultPrevented) return;
            const files = filesFromDataTransfer(event.clipboardData);
            if (!files.length) return;
            event.preventDefault();
            void port?.selectFiles(files);
          }}
        />
        <div className="room-composer__bar">
          {port && (
            <>
              <input
                type="file"
                ref={picker.fileInputRef}
                className="attachment-input"
                multiple
                accept="image/*,.heic,.heif,.pdf,.txt,.csv,.md,.json"
                onChange={picker.handleFileSelect}
                disabled={attachLocked || port.busy}
                hidden
              />
              <IconButton
                ref={picker.attachButtonRef}
                aria-label="Attach files"
                title="Attach files"
                className="room-composer__tool"
                disabled={attachLocked || port.busy}
                onClick={picker.openFilePicker}
              >
                <AttachmentGlyph />
              </IconButton>
              {clipboard.available && (
                <IconButton
                  aria-label="Paste image"
                  title="Paste image"
                  className="room-composer__tool"
                  disabled={attachLocked || port.busy || clipboard.pending}
                  onClick={() => void clipboard.paste()}
                >
                  <PasteGlyph />
                </IconButton>
              )}
            </>
          )}
          {tools}
          <Button
            type="button"
            variant="primary"
            className="room-composer__send"
            aria-label={pending ? 'Sending…' : sendLabel}
            title={sendLabel}
            pending={pending}
            pendingLabel="Sending…"
            disabled={!canSend}
            onClick={send}
          >
            {sendGlyph ?? (
              <svg
                aria-hidden="true"
                focusable="false"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" />
              </svg>
            )}
          </Button>
        </div>
      </div>
      {port?.error && (
        <p className="room-composer__status" role="alert">
          {port.error}
        </p>
      )}
      {below}
    </div>
  );
}
