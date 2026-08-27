export async function rebuildOrClearRuntimeProjections(
  rebuild: () => Promise<void>,
  clear: () => void,
): Promise<void> {
  try {
    await rebuild();
  } catch (error) {
    clear();
    throw error;
  }
}
