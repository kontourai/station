export function downloadDiagnosticsBundle(
  blob: Blob,
  now: Date = new Date(),
): void {
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = `station-diagnostics-${now.toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
