import { type ReactNode, useRef } from 'react';
import { Button } from '../components/Button';
import { ComposerAttachmentStrip } from '../components/chat/ComposerAttachmentStrip';
import { useChatPaneFileDrop } from '../hooks/useChatPaneFileDrop';
import { useFileAttachment } from '../hooks/useFileAttachment';
import type { useTaskRoomAttachments } from '../hooks/useTaskRoomAttachments';
import { filesFromDataTransfer } from '../utils/attachment-file-transfer';

export function TaskRoomAttachmentComposer({
  attachments,
  locked,
  owner,
  children,
}: {
  attachments: ReturnType<typeof useTaskRoomAttachments>;
  locked: boolean;
  owner: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const drop = useChatPaneFileDrop({
    rootRef,
    resetKey: owner,
    enabled: !locked,
    selectFiles: attachments.selectFiles,
    reportError: attachments.setError,
  });
  const { fileInputRef, attachButtonRef, handleFileSelect, openFilePicker } =
    useFileAttachment({ onFilesSelected: attachments.selectFiles });
  return (
    <section
      ref={rootRef}
      aria-label="Task message and attachments"
      className="task-room-attachment-composer"
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDragEnd={drop.onDragEnd}
      onDrop={(event) => {
        drop.onDrop(event);
        if (event.defaultPrevented) event.stopPropagation();
      }}
      onPaste={(event) => {
        if (locked) return;
        const files = filesFromDataTransfer(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        void attachments.selectFiles(files);
      }}
    >
      {drop.isDraggingFiles && (
        <p role="status">Drop images or files to attach</p>
      )}
      <fieldset disabled={locked} className="task-room-attachment-controls">
        <ComposerAttachmentStrip
          attachments={attachments.files}
          onRemove={attachments.remove}
        />
      </fieldset>
      {attachments.error && <p role="alert">{attachments.error}</p>}
      {children}
      <input
        type="file"
        ref={fileInputRef}
        className="attachment-input"
        multiple
        accept="image/*,.heic,.heif,.pdf,.txt,.csv,.md,.json"
        onChange={handleFileSelect}
        disabled={locked || attachments.busy}
      />
      <Button
        ref={attachButtonRef}
        variant="ghost"
        size="sm"
        onClick={openFilePicker}
        disabled={locked || attachments.busy}
      >
        Attach files
      </Button>
    </section>
  );
}
