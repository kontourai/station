import { useCallback, useRef } from 'react';

interface UseFileAttachmentOptions {
  onFilesSelected: (files: File[]) => void | Promise<void>;
}

/** A hidden file input and the button that opens it. */
export function useFileAttachment({
  onFilesSelected,
}: UseFileAttachmentOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      await onFilesSelected(files);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      setTimeout(() => attachButtonRef.current?.focus(), 0);
    },
    [onFilesSelected],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return {
    fileInputRef,
    attachButtonRef,
    handleFileSelect,
    openFilePicker,
  };
}
