import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { inspectDeviceArchive } from './device-artifact-archive.mjs';
import { runBoundedToolCapture } from './device-host-tools.js';

const WORKSPACE_SNAPSHOT = String.raw`import base64, json, os, re, stat, sys, unicodedata

MAX_BYTES = 128 * 1024 * 1024
MAX_FILES = 10000
MAX_DEPTH = 32
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

class Refused(Exception):
    pass

def valid_component(name):
    if not name or name in ('.', '..') or name.lower() == '.git' or len(name) > 255 or ':' in name or '\\' in name or name.endswith(('.', ' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)', name, re.I):
        return False
    return not any(ord(c) < 32 or ord(c) == 127 or ord(c) == 0xfffd for c in name)

def same(a, b):
    return a.st_dev == b.st_dev and a.st_ino == b.st_ino and a.st_mode == b.st_mode and a.st_size == b.st_size and a.st_mtime_ns == b.st_mtime_ns and a.st_ctime_ns == b.st_ctime_ns

def same_directory(a, b):
    return a.st_dev == b.st_dev and a.st_ino == b.st_ino and a.st_mode == b.st_mode

def read_snapshot(spec):
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY') or os.open not in os.supports_dir_fd or os.scandir not in os.supports_fd:
        raise Refused()
    root = spec.get('root')
    relative = spec.get('relativePath')
    platform = spec.get('platform')
    if not isinstance(root, str) or not root.startswith('/') or root == '/' or len(root) > 4096 or not isinstance(relative, str) or not relative or len(relative) > 512 or platform not in ('ios', 'android'):
        raise Refused()
    root_parts = root.split('/')[1:]
    parts = relative.split('/')
    if len(parts) > MAX_DEPTH or len(root_parts) > 128 or not all(valid_component(p) for p in root_parts + parts):
        raise Refused()
    opened = []
    chain = []
    fd = os.open('/', FLAGS)
    opened.append(fd)
    try:
        for component in root_parts:
            before = os.stat(component, dir_fd=fd, follow_symlinks=False)
            child = os.open(component, FLAGS, dir_fd=fd)
            opened.append(child)
            if not stat.S_ISDIR(before.st_mode) or not same_directory(before, os.fstat(child)):
                raise Refused()
            chain.append((fd, component, child, before))
            fd = child
        root_device = os.fstat(fd).st_dev
        for component in parts[:-1]:
            before = os.stat(component, dir_fd=fd, follow_symlinks=False)
            child = os.open(component, FLAGS, dir_fd=fd)
            opened.append(child)
            if not stat.S_ISDIR(before.st_mode) or before.st_dev != root_device or not same_directory(before, os.fstat(child)):
                raise Refused()
            chain.append((fd, component, child, before))
            fd = child
        files = []
        names = set()
        total = 0
        entries = 0
        def read_file(parent, name, path, before):
            nonlocal total
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_dev != root_device or before.st_size > MAX_BYTES - total:
                raise Refused()
            child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_NONBLOCK', 0), dir_fd=parent)
            try:
                actual = os.fstat(child)
                if not same(before, actual): raise Refused()
                chunks = []
                left = before.st_size
                while left:
                    data = os.read(child, min(left, 1024 * 1024))
                    if not data: raise Refused()
                    chunks.append(data)
                    left -= len(data)
                if os.read(child, 1) or not same(before, os.fstat(child)) or not same(before, os.stat(name, dir_fd=parent, follow_symlinks=False)):
                    raise Refused()
                total += before.st_size
                files.append({'path': path, 'executable': bool(before.st_mode & 0o111), 'data': base64.b64encode(b''.join(chunks)).decode('ascii')})
            finally:
                os.close(child)
        def walk(directory, prefix, depth):
            nonlocal entries
            if depth > MAX_DEPTH: raise Refused()
            listing = []
            with os.scandir(directory) as iterator:
                for child in iterator:
                    entries += 1
                    if entries > MAX_FILES: raise Refused()
                    listing.append(child.name)
            for name in sorted(listing):
                if not valid_component(name): raise Refused()
                path = prefix + '/' + name if prefix else name
                key = unicodedata.normalize('NFD', path).casefold()
                if len(path) > 512 or key in names: raise Refused()
                names.add(key)
                before = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if before.st_dev != root_device: raise Refused()
                if stat.S_ISDIR(before.st_mode):
                    child = os.open(name, FLAGS, dir_fd=directory)
                    try:
                        if not same(before, os.fstat(child)): raise Refused()
                        walk(child, path, depth + 1)
                        if not same(before, os.fstat(child)) or not same(before, os.stat(name, dir_fd=directory, follow_symlinks=False)): raise Refused()
                    finally: os.close(child)
                else:
                    if len(files) >= MAX_FILES: raise Refused()
                    read_file(directory, name, path, before)
        final = parts[-1]
        before = os.stat(final, dir_fd=fd, follow_symlinks=False)
        if platform == 'ios':
            if not final.lower().endswith('.app') or not stat.S_ISDIR(before.st_mode) or before.st_dev != root_device: raise Refused()
            child = os.open(final, FLAGS, dir_fd=fd)
            try:
                if not same(before, os.fstat(child)): raise Refused()
                walk(child, '', 1)
                if not same(before, os.fstat(child)) or not same(before, os.stat(final, dir_fd=fd, follow_symlinks=False)): raise Refused()
            finally: os.close(child)
            if not any(file['path'] == 'Info.plist' for file in files): raise Refused()
        else:
            if not final.lower().endswith('.apk'): raise Refused()
            read_file(fd, final, final, before)
        for parent, component, child, expected in reversed(chain):
            if not same_directory(expected, os.fstat(child)) or not same_directory(expected, os.stat(component, dir_fd=parent, follow_symlinks=False)): raise Refused()
        return {'ok': True, 'files': files}
    finally:
        for handle in reversed(opened): os.close(handle)

try:
    request = json.loads(sys.stdin.buffer.read(8193))
    result = read_snapshot(request)
    sys.stdout.write(json.dumps(result, separators=(',', ':')))
except Exception:
    sys.stdout.write('{"ok":false}')
`;

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_STORED_BYTES = 256 * 1024 * 1024;
const RETENTION_MS = 10 * 60_000;
const MAX_ARTIFACTS = 10;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type AppFile = { path: string; executable: boolean; bytes: Buffer };
type Payload =
  | { platform: 'ios'; files: AppFile[] }
  | { platform: 'android'; apk: Buffer };
export type StagedDeviceArtifact = {
  handle: string;
  platform: 'ios' | 'android';
  digest: `sha256:${string}`;
  source: 'workspace' | 'upload';
  revision: null;
  state: 'staged';
};
type Entry = {
  projectId: string;
  receipt: StagedDeviceArtifact;
  payload: Payload;
  bytes: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export class DeviceArtifactError extends Error {
  constructor(
    readonly code:
      | 'invalid-source'
      | 'invalid-artifact'
      | 'artifact-unavailable'
      | 'artifact-capacity'
      | 'workspace-snapshot-unavailable'
      | 'not-authorized'
      | 'cancelled',
  ) {
    super(`Device artifact refused: ${code}`);
    this.name = 'DeviceArtifactError';
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validRelative(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('\\') &&
    value
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !part.includes(':') &&
          ![...part].some(
            (c) => (c.codePointAt(0) ?? 0) < 32 || c.codePointAt(0) === 127,
          ),
      )
  );
}
async function digest(
  payload: Payload,
  signal: AbortSignal,
): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  const update = async (bytes: Buffer) => {
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      if (signal.aborted) throw new DeviceArtifactError('cancelled');
      hash.update(bytes.subarray(offset, offset + 1024 * 1024));
      await yieldTurn();
    }
  };
  if (payload.platform === 'android') await update(payload.apk);
  else {
    hash.update('station-device-app-tree/v1\0');
    for (const file of [...payload.files].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    )) {
      const path = Buffer.from(file.path, 'utf8');
      const header = Buffer.alloc(13);
      header.writeUInt32BE(path.length, 0);
      header.writeUInt8(file.executable ? 1 : 0, 4);
      header.writeBigUInt64BE(BigInt(file.bytes.length), 5);
      hash.update(header).update(path);
      await update(file.bytes);
    }
  }
  return `sha256:${hash.digest('hex')}`;
}
function sizeOf(payload: Payload): number {
  return payload.platform === 'android'
    ? payload.apk.length
    : payload.files.reduce((sum, file) => sum + file.bytes.length, 0);
}
function copy(payload: Payload): Payload {
  return payload.platform === 'android'
    ? { platform: 'android', apk: Buffer.from(payload.apk) }
    : {
        platform: 'ios',
        files: payload.files.map((file) => ({
          ...file,
          bytes: Buffer.from(file.bytes),
        })),
      };
}
function wipe(payload: Payload): void {
  if (payload.platform === 'android') payload.apk.fill(0);
  else for (const file of payload.files) file.bytes.fill(0);
}

/** UNWIRED(#1970): bounded staging awaiting the authorized install route and host protocol. */
export class DeviceArtifactStaging {
  private readonly entries = new Map<string, Entry>();
  private readonly shutdown = new AbortController();
  private active = 0;
  private activeDone: Promise<void> | undefined;
  private disposed = false;
  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.entries)
      if (entry.expiresAt <= now) {
        clearTimeout(entry.timer);
        wipe(entry.payload);
        this.entries.delete(id);
      }
  }
  private async reserve<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed || this.active >= 1)
      throw new DeviceArtifactError('artifact-capacity');
    const combined = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    if (combined.aborted) throw new DeviceArtifactError('cancelled');
    this.active += 1;
    let finish!: () => void;
    this.activeDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      return await run(combined);
    } finally {
      this.active -= 1;
      finish();
      this.activeDone = undefined;
    }
  }
  private async publish(
    projectId: string,
    payload: Payload,
    source: StagedDeviceArtifact['source'],
    authorize: () => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<StagedDeviceArtifact> {
    if (!projectId || projectId.length > 256 || !(await authorize()))
      throw new DeviceArtifactError('not-authorized');
    const bytes = sizeOf(payload);
    if (bytes < 1 || bytes > MAX_BYTES)
      throw new DeviceArtifactError('invalid-artifact');
    const hash = await digest(payload, signal);
    if (signal.aborted) throw new DeviceArtifactError('cancelled');
    if (!(await authorize()) || this.disposed || signal.aborted)
      throw new DeviceArtifactError('not-authorized');
    this.prune();
    if (
      this.entries.size >= MAX_ARTIFACTS ||
      [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) +
        bytes >
        MAX_STORED_BYTES
    )
      throw new DeviceArtifactError('artifact-capacity');
    const handle = randomUUID();
    const receipt: StagedDeviceArtifact = {
      handle,
      platform: payload.platform,
      digest: hash,
      source,
      revision: null,
      state: 'staged',
    };
    const stored = copy(payload);
    const timer = setTimeout(() => {
      const entry = this.entries.get(handle);
      if (entry) {
        wipe(entry.payload);
        this.entries.delete(handle);
      }
    }, RETENTION_MS);
    timer.unref?.();
    this.entries.set(handle, {
      projectId,
      receipt,
      payload: stored,
      bytes,
      expiresAt: Date.now() + RETENTION_MS,
      timer,
    });
    return { ...receipt };
  }
  async stageUpload(
    projectId: string,
    bytes: Buffer,
    platform: 'ios' | 'android',
    authorize: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<StagedDeviceArtifact> {
    return this.reserve(async (activeSignal) => {
      if (!(await authorize())) throw new DeviceArtifactError('not-authorized');
      let archive: Awaited<ReturnType<typeof inspectDeviceArchive>>;
      try {
        archive = await inspectDeviceArchive(bytes, platform, activeSignal);
      } catch {
        if (activeSignal.aborted) throw new DeviceArtifactError('cancelled');
        throw new DeviceArtifactError('invalid-artifact');
      }
      const payload: Payload =
        platform === 'android'
          ? { platform, apk: Buffer.from(bytes) }
          : {
              platform,
              files: archive.map((entry) => {
                if (!entry.bytes)
                  throw new DeviceArtifactError('invalid-artifact');
                return {
                  path: entry.path,
                  executable: entry.executable,
                  bytes: entry.bytes,
                };
              }),
            };
      try {
        return await this.publish(
          projectId,
          payload,
          'upload',
          authorize,
          activeSignal,
        );
      } finally {
        wipe(payload);
      }
    }, signal);
  }
  async stageWorkspace(
    projectId: string,
    root: string,
    relativePath: string,
    platform: 'ios' | 'android',
    authorize: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<StagedDeviceArtifact> {
    return this.reserve(async (activeSignal) => {
      if (!(await authorize())) throw new DeviceArtifactError('not-authorized');
      if (
        !validRelative(relativePath) ||
        !root ||
        (platform !== 'ios' && platform !== 'android')
      )
        throw new DeviceArtifactError('invalid-source');
      if (process.platform === 'win32')
        throw new DeviceArtifactError('workspace-snapshot-unavailable');
      let output: string;
      try {
        output = await runBoundedToolCapture(
          '/usr/bin/python3',
          ['-I', '-c', WORKSPACE_SNAPSHOT],
          {
            stdin: JSON.stringify({ root, relativePath, platform }),
            timeoutMs: 120_000,
            maxBuffer: Math.ceil(MAX_BYTES / 3) * 4 + 16 * 1024 * 1024,
            signal: activeSignal,
          },
        );
      } catch {
        if (activeSignal.aborted) throw new DeviceArtifactError('cancelled');
        throw new DeviceArtifactError('workspace-snapshot-unavailable');
      }
      let value: unknown;
      try {
        value = JSON.parse(output);
      } catch {
        throw new DeviceArtifactError('invalid-source');
      }
      if (
        !plainRecord(value) ||
        value.ok !== true ||
        !Array.isArray(value.files) ||
        value.files.length === 0 ||
        value.files.length > 10000
      )
        throw new DeviceArtifactError('invalid-source');
      let total = 0;
      const files: AppFile[] = value.files.map((item: unknown) => {
        if (
          !plainRecord(item) ||
          typeof item.path !== 'string' ||
          !validRelative(item.path) ||
          typeof item.executable !== 'boolean' ||
          typeof item.data !== 'string' ||
          !BASE64.test(item.data)
        )
          throw new DeviceArtifactError('invalid-source');
        const bytes = Buffer.from(item.data, 'base64');
        if (bytes.toString('base64') !== item.data)
          throw new DeviceArtifactError('invalid-source');
        total += bytes.length;
        if (total > MAX_BYTES)
          throw new DeviceArtifactError('invalid-artifact');
        return { path: item.path, executable: item.executable, bytes };
      });
      let payload: Payload;
      if (platform === 'ios') {
        if (!files.some((file) => file.path === 'Info.plist'))
          throw new DeviceArtifactError('invalid-artifact');
        payload = { platform, files };
      } else {
        if (files.length !== 1)
          throw new DeviceArtifactError('invalid-artifact');
        try {
          await inspectDeviceArchive(files[0]!.bytes, 'android', activeSignal);
        } catch {
          if (activeSignal.aborted) throw new DeviceArtifactError('cancelled');
          throw new DeviceArtifactError('invalid-artifact');
        }
        payload = { platform, apk: files[0]!.bytes };
      }
      try {
        return await this.publish(
          projectId,
          payload,
          'workspace',
          authorize,
          activeSignal,
        );
      } finally {
        wipe(payload);
      }
    }, signal);
  }
  async withArtifact<T>(
    projectId: string,
    handle: string,
    authorize: () => Promise<boolean>,
    run: (
      receipt: StagedDeviceArtifact,
      payload: Payload,
      current: () => Promise<boolean>,
      signal: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.reserve(async (activeSignal) => {
      if (!(await authorize())) throw new DeviceArtifactError('not-authorized');
      this.prune();
      const entry = this.entries.get(handle);
      if (!entry || entry.projectId !== projectId)
        throw new DeviceArtifactError('artifact-unavailable');
      const payload = copy(entry.payload);
      const current = async () =>
        !activeSignal.aborted &&
        !this.disposed &&
        this.entries.get(handle) === entry &&
        (await authorize()) &&
        !this.disposed &&
        !activeSignal.aborted &&
        this.entries.get(handle) === entry;
      try {
        if (
          (await digest(payload, activeSignal)) !== entry.receipt.digest ||
          !(await current())
        )
          throw new DeviceArtifactError('artifact-unavailable');
        const result = await run(
          { ...entry.receipt },
          payload,
          current,
          activeSignal,
        );
        if (!(await current())) throw new DeviceArtifactError('not-authorized');
        return result;
      } finally {
        wipe(payload);
      }
    }, signal);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.shutdown.abort();
    const active = this.activeDone;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (active)
        await Promise.race([
          active,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Device artifact cleanup timed out.')),
              10_000,
            );
          }),
        ]);
    } finally {
      clearTimeout(timer);
      for (const entry of this.entries.values()) {
        clearTimeout(entry.timer);
        wipe(entry.payload);
      }
      this.entries.clear();
    }
  }
}
