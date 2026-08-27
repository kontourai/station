import { useCallback, useRef, useState } from 'react';

interface UseFileAttachmentOptions {
  onFilesSelected: (files: File[]) => void | Promise<void>;
}

export function useFileAttachment({
  onFilesSelected,
}: UseFileAttachmentOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

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

  const closePreviewImage = useCallback(() => {
    setPreviewImage(null);
    attachButtonRef.current?.focus();
  }, []);

  return {
    fileInputRef,
    attachButtonRef,
    showPreview,
    setShowPreview,
    previewImage,
    setPreviewImage,
    handleFileSelect,
    openFilePicker,
    closePreviewImage,
  };
}
