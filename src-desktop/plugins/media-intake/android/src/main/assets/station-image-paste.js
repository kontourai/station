// Runs in the main WebView. Capture before native I/O; never retarget a late read.
(() => {
  if (location.origin !== 'http://tauri.localhost') return;
  if (window.__stationImagePaste) return;
  const pending = new Map();
  const appOrigin = 'http://tauri.localhost';
  const eligible = () => {
    const target = document.activeElement;
    return location.origin === appOrigin && target instanceof HTMLTextAreaElement &&
      !target.disabled && !target.readOnly && target.hasAttribute('data-native-image-paste');
  };
  window.__stationImagePaste = {
    eligible,
    capture(id) {
      const target = document.activeElement;
      if (
        !eligible() ||
        target.disabled ||
        target.readOnly ||
        !target.hasAttribute('data-native-image-paste')
      )
        return false;
      if (pending.size >= 5) return 'busy';
      const scope = target.getAttribute('data-native-image-paste');
      const url = location.pathname;
      const cancel = () => {
        target.removeEventListener('blur', cancel);
        pending.delete(id);
      };
      target.addEventListener('blur', cancel, { once: true });
      pending.set(id, { target, scope, url, cancel });
      return true;
    },
    deliver(id, payload) {
      const entry = pending.get(id);
      if (!entry) return false;
      const { target, scope, url, cancel } = entry;
      cancel();
      if (
        location.origin !== appOrigin ||
        !target.isConnected ||
        document.activeElement !== target ||
        target.disabled ||
        target.readOnly ||
        location.pathname !== url ||
        target.getAttribute('data-native-image-paste') !== scope
      )
        return false;
      const data = new DataTransfer();
      for (const image of payload.files) {
        const bytes = Uint8Array.from(atob(image.dataUrl.split(',')[1]), (c) =>
          c.charCodeAt(0),
        );
        data.items.add(new File([bytes], image.name, { type: image.mimeType }));
      }
      // Both composers already route paste files through their attachment validator.
      target.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    },
    cancel(id) {
      pending.get(id)?.cancel();
    },
  };
})();
