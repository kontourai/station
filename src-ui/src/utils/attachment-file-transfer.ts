/** Extract File entries from paste and drag DataTransfers without reading them. */
export function filesFromDataTransfer(source: DataTransfer): File[] {
  const files: File[] = [];
  const items = source.items;
  if (items && items.length > 0) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0 && source.files && source.files.length > 0) {
    files.push(...Array.from(source.files));
  }
  return files;
}
