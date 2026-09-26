export type PortableServerOs = 'darwin' | 'linux' | 'win32';
export type PortableServerArch = 'arm64' | 'x64';
export type PortableServerFormat = 'tar.gz' | 'zip';
export type PortableServerTarget = Readonly<{
  os: PortableServerOs;
  arch: PortableServerArch;
  format: PortableServerFormat;
}>;
export const PORTABLE_SERVER_TARGETS: readonly PortableServerTarget[];
export function findPortableServerTarget(
  os: unknown,
  arch: unknown,
): PortableServerTarget | undefined;
export function portableServerArchiveName(target: {
  os: string;
  arch: string;
  format: string;
}): string;
