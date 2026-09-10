import { isAbsolute } from 'node:path';

export function assertPluginNameSegment(pluginName: string): void {
  if (
    !pluginName ||
    pluginName === '.' ||
    pluginName === '..' ||
    isAbsolute(pluginName) ||
    pluginName.includes('/') ||
    pluginName.includes('\\')
  ) {
    throw new Error(`Invalid plugin name: ${pluginName || '(empty)'}`);
  }
}
