import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, win32 } from 'node:path';

export const INTEGRATION_ICON_MAX_BYTES = 128 * 1024;

const COMMON_ICON_NAMES = [
  'icon.png',
  'icon.jpg',
  'icon.jpeg',
  'icon.webp',
  'icon.ico',
  'favicon.png',
  'favicon.ico',
  'logo.png',
  'logo.jpg',
  'logo.webp',
] as const;

export type IntegrationIconAsset = {
  body: Buffer;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon';
  etag: string;
};

type AssetResult =
  | { status: 'found'; asset: IntegrationIconAsset }
  | { status: 'missing' | 'invalid' };

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

/** Reject native and Windows absolute/cross-volume `path.relative` results. */
export function isContainedRelativePath(value: string): boolean {
  return (
    value !== '' &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !/^\.\.(?:[\\/]|$)/.test(value)
  );
}

function contentTypeFor(
  path: string,
  body: Buffer,
): IntegrationIconAsset['contentType'] | undefined {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const png =
    body.length >= 8 &&
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg =
    body.length >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff;
  const webp =
    body.length >= 12 &&
    body.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    body.subarray(8, 12).equals(Buffer.from('WEBP'));
  const ico =
    body.length >= 4 && body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
  if (ext === '.png' && png) return 'image/png';
  if ((ext === '.jpg' || ext === '.jpeg') && jpeg) return 'image/jpeg';
  if (ext === '.webp' && webp) return 'image/webp';
  if (ext === '.ico' && ico) return 'image/x-icon';
  return undefined;
}

function isSafeRelativeIconPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    /\.(png|jpe?g|webp|ico)$/i.test(value)
  );
}

/**
 * Resolves an installed integration's locally owned raster artwork. It never
 * follows an escaped realpath and validates both declared filename and bytes.
 */
export class IntegrationIconAssets {
  constructor(private readonly homeDir: string) {}

  async resolve(id: string): Promise<AssetResult> {
    if (!isSafeId(id)) return { status: 'invalid' };
    const root = join(this.homeDir, 'integrations', id);
    if (!existsSync(root)) return { status: 'missing' };

    let realRoot: string;
    try {
      realRoot = await realpath(root);
      const integrationsRoot = await realpath(
        join(this.homeDir, 'integrations'),
      );
      const rootRelative = relative(integrationsRoot, realRoot);
      if (!isContainedRelativePath(rootRelative)) {
        return { status: 'invalid' };
      }
      if (!(await stat(realRoot)).isDirectory()) return { status: 'invalid' };
    } catch {
      return { status: 'missing' };
    }

    let declared: string | undefined;
    try {
      const manifest = JSON.parse(
        await readFile(join(realRoot, 'integration.json'), 'utf8'),
      ) as { icon?: unknown };
      declared = isSafeRelativeIconPath(manifest.icon)
        ? manifest.icon
        : undefined;
    } catch {
      return { status: 'invalid' };
    }

    const candidates = declared
      ? [declared, ...COMMON_ICON_NAMES]
      : [...COMMON_ICON_NAMES];
    let sawInvalid = false;
    for (const candidate of candidates) {
      const result = await this.readContained(realRoot, candidate);
      if (result.status === 'found') return result;
      sawInvalid ||= result.status === 'invalid';
    }
    return { status: sawInvalid ? 'invalid' : 'missing' };
  }

  private async readContained(
    root: string,
    candidate: string,
  ): Promise<AssetResult> {
    if (!isSafeRelativeIconPath(candidate)) {
      return { status: 'invalid' };
    }
    const target = join(root, candidate);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const initialTarget = await realpath(target);
      if (!isContainedRelativePath(relative(root, initialTarget))) {
        return { status: 'invalid' };
      }
      if (!(await lstat(target)).isFile()) return { status: 'invalid' };

      handle = await open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const [info, currentTarget] = await Promise.all([
        handle.stat(),
        realpath(target),
      ]);
      if (!isContainedRelativePath(relative(root, currentTarget))) {
        return { status: 'invalid' };
      }
      const currentInfo = await stat(currentTarget);
      if (
        !info.isFile() ||
        info.dev !== currentInfo.dev ||
        info.ino !== currentInfo.ino ||
        info.size <= 0 ||
        info.size > INTEGRATION_ICON_MAX_BYTES
      )
        return { status: 'invalid' };

      // Read through the validated handle into a fixed-size buffer. The extra
      // byte detects growth without allocating from an attacker-controlled
      // post-stat size.
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const finalInfo = await handle.stat();
      if (
        bytesRead !== info.size ||
        finalInfo.dev !== info.dev ||
        finalInfo.ino !== info.ino ||
        finalInfo.size !== info.size
      ) {
        return { status: 'invalid' };
      }
      const body = buffer.subarray(0, bytesRead);
      const contentType = contentTypeFor(candidate, body);
      if (!contentType) return { status: 'invalid' };
      return {
        status: 'found',
        asset: {
          body,
          contentType,
          etag: `"${createHash('sha256').update(body).digest('hex')}"`,
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { status: 'missing' };
      return { status: 'invalid' };
    } finally {
      await handle?.close();
    }
  }
}
