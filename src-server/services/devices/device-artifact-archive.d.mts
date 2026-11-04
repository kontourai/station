export interface DeviceArchiveEntry {
  path: string;
  executable: boolean;
  bytes?: Buffer;
}
export function inspectDeviceArchive(
  bytes: Buffer,
  kind: 'ios' | 'android',
  signal?: AbortSignal,
): Promise<DeviceArchiveEntry[]>;
