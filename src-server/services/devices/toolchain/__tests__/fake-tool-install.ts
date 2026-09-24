/**
 * A synthetic device-tool pin and the tree a successful `npm ci` of it
 * leaves behind, including the tool's tarball in the install's private npm
 * cache, so the verifier's content checks run against real bytes. No
 * network, no npm.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { DeviceToolId } from '@kontourai/station-contracts/device-toolchain';
import type { DeviceToolPin } from '../device-tool-pins.js';

/** A minimal ustar archive of regular files. */
export function makeTarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

const DEP_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

export interface SyntheticTool {
  pin: DeviceToolPin;
  tarball: Buffer;
  files: Record<string, string>;
}

/** A pin for `tool` whose own tarball is real and whose lock has one dep. */
export function syntheticTool(
  tool: DeviceToolId,
  version = '9.9.9',
): SyntheticTool {
  const entry = tool === 'expo-device-hub' ? ['cli.mjs'] : ['bin.mjs'];
  const files = {
    'package/package.json': JSON.stringify({ name: tool, version }),
    [`package/${entry.join('/')}`]: `// ${tool} ${version}\n`,
  };
  const tarball = makeTarball(files);
  const integrity = integrityOf(tarball);
  return {
    tarball,
    files,
    pin: {
      tool,
      version,
      requiredIntegrity: integrity,
      entry,
      lock: {
        name: 'station-device-tool',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'station-device-tool',
            dependencies: { [tool]: version },
          },
          [`node_modules/${tool}`]: {
            version,
            resolved: `https://registry.npmjs.org/${tool}/-/${tool}-${version}.tgz`,
            integrity,
          },
          'node_modules/dep': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz',
            integrity: DEP_INTEGRITY,
          },
        },
      },
    },
  };
}

export function syntheticPins(): Record<DeviceToolId, DeviceToolPin> {
  return {
    'expo-device-hub': syntheticTool('expo-device-hub').pin,
    'agent-device': syntheticTool('agent-device').pin,
  };
}

export interface InstallTamper {
  /** Rewrite npm's recorded tree before it is written. */
  record?: (
    packages: Record<string, { version?: string; integrity?: string }>,
  ) => void;
  /** Change the extracted tool files (relative path to content). */
  toolFiles?: (files: Record<string, string>) => void;
  /** Leave the tarball out of the private cache. */
  noCache?: boolean;
  /** Put these bytes in the cache at the pinned tarball's address instead. */
  cacheBytes?: Buffer;
  /** Extra package directories to create (lockfile-style paths). */
  extraPackages?: string[];
  /** Loose files or bare directories to create (relative to the install). */
  extraEntries?: Array<{ path: string; kind: 'file' | 'dir' }>;
}

/** Write what `npm ci` of `synthetic.pin` would leave in `dir`. */
export function writeFakeInstall(
  dir: string,
  synthetic: SyntheticTool,
  tamper: InstallTamper = {},
): void {
  const { pin } = synthetic;
  const packages: Record<string, { version?: string; integrity?: string }> = {};
  for (const [path, entry] of Object.entries(pin.lock.packages)) {
    if (path === '') continue;
    packages[path] = { version: entry.version, integrity: entry.integrity };
    if (path === `node_modules/${pin.tool}`) continue;
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(
      join(dir, path, 'package.json'),
      JSON.stringify({ version: entry.version }),
    );
  }
  tamper.record?.(packages);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '.package-lock.json'),
    JSON.stringify({ packages }),
  );
  const toolFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(synthetic.files))
    toolFiles[path.replace(/^package\//, '')] = content;
  tamper.toolFiles?.(toolFiles);
  for (const [rel, content] of Object.entries(toolFiles)) {
    const target = join(dir, 'node_modules', pin.tool, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  for (const extra of tamper.extraPackages ?? []) {
    mkdirSync(join(dir, extra), { recursive: true });
    writeFileSync(join(dir, extra, 'package.json'), '{"version":"0.0.1"}');
  }
  for (const extra of tamper.extraEntries ?? []) {
    const target = join(dir, extra.path);
    if (extra.kind === 'dir') mkdirSync(target, { recursive: true });
    else {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'module.exports = "shadow";\n');
    }
  }
  if (!tamper.noCache) {
    const hex = Buffer.from(
      pin.requiredIntegrity.replace(/^sha512-/, ''),
      'base64',
    ).toString('hex');
    const cached = join(
      dir,
      '.npm-cache',
      '_cacache',
      'content-v2',
      'sha512',
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    mkdirSync(join(cached, '..'), { recursive: true });
    writeFileSync(cached, tamper.cacheBytes ?? synthetic.tarball);
  }
}
