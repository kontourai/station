import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse, resolve } from 'node:path';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import {
  assertWindowsPathsTrusted,
  runWindowsTrustCommand,
} from './windows-path-trust.js';

type Koffi = typeof import('koffi');
type NativeFunction = ReturnType<ReturnType<Koffi['load']>['func']>;
type FileOperation = 'read' | 'append' | 'create';

let native:
  | { koffi: Koffi; functions: Record<string, NativeFunction>; sid: Buffer }
  | undefined;

function api() {
  if (native) return native;
  if (
    process.platform !== 'win32' ||
    (process.arch !== 'x64' && process.arch !== 'arm64')
  ) {
    throw new Error('Windows private files require 64-bit Windows');
  }
  const koffi = createRequire(import.meta.url)('koffi') as Koffi;
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  const functions: Record<string, NativeFunction> = {
    CreateFileW: kernel.func(
      'intptr_t __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, const void *security, uint32_t disposition, uint32_t flags, intptr_t templateFile)',
    ),
    CloseHandle: kernel.func('int __stdcall CloseHandle(intptr_t handle)'),
    GetCurrentProcess: kernel.func('intptr_t __stdcall GetCurrentProcess()'),
    GetLastError: kernel.func('uint32_t __stdcall GetLastError()'),
    LocalFree: kernel.func('intptr_t __stdcall LocalFree(void *memory)'),
    GetFileAttributesW: kernel.func(
      'uint32_t __stdcall GetFileAttributesW(const char16_t *path)',
    ),
    GetFileInformationByHandle: kernel.func(
      'int __stdcall GetFileInformationByHandle(intptr_t handle, _Out_ uint8_t *information)',
    ),
    SetFileInformationByHandle: kernel.func(
      'int __stdcall SetFileInformationByHandle(intptr_t handle, uint32_t kind, const void *information, uint32_t size)',
    ),
    OpenProcessToken: security.func(
      'int __stdcall OpenProcessToken(intptr_t process, uint32_t access, _Out_ intptr_t *token)',
    ),
    GetTokenInformation: security.func(
      'int __stdcall GetTokenInformation(intptr_t token, uint32_t kind, _Out_ uint8_t *information, uint32_t size, _Out_ uint32_t *needed)',
    ),
    GetLengthSid: security.func(
      'uint32_t __stdcall GetLengthSid(const void *sid)',
    ),
    EqualSid: security.func(
      'int __stdcall EqualSid(const void *first, const void *second)',
    ),
    GetSecurityInfo: security.func(
      'uint32_t __stdcall GetSecurityInfo(intptr_t handle, uint32_t kind, uint32_t requested, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)',
    ),
    GetSecurityDescriptorControl: security.func(
      'int __stdcall GetSecurityDescriptorControl(const void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)',
    ),
    GetAclInformation: security.func(
      'int __stdcall GetAclInformation(const void *acl, _Out_ uint8_t *information, uint32_t size, uint32_t kind)',
    ),
    GetAce: security.func(
      'int __stdcall GetAce(const void *acl, uint32_t index, _Out_ void **ace)',
    ),
    InitializeSecurityDescriptor: security.func(
      'int __stdcall InitializeSecurityDescriptor(_Out_ uint8_t *descriptor, uint32_t revision)',
    ),
    SetSecurityDescriptorOwner: security.func(
      'int __stdcall SetSecurityDescriptorOwner(uint8_t *descriptor, const void *owner, int defaulted)',
    ),
    SetSecurityDescriptorDacl: security.func(
      'int __stdcall SetSecurityDescriptorDacl(uint8_t *descriptor, int present, const void *acl, int defaulted)',
    ),
    SetSecurityDescriptorControl: security.func(
      'int __stdcall SetSecurityDescriptorControl(uint8_t *descriptor, uint16_t interest, uint16_t control)',
    ),
    InitializeAcl: security.func(
      'int __stdcall InitializeAcl(_Out_ uint8_t *acl, uint32_t size, uint32_t revision)',
    ),
    AddAccessAllowedAce: security.func(
      'int __stdcall AddAccessAllowedAce(uint8_t *acl, uint32_t revision, uint32_t mask, const void *sid)',
    ),
    ReadFile: kernel.func(
      'int __stdcall ReadFile(intptr_t handle, _Out_ uint8_t *buffer, uint32_t size, _Out_ uint32_t *read, void *overlapped)',
    ),
    WriteFile: kernel.func(
      'int __stdcall WriteFile(intptr_t handle, const uint8_t *buffer, uint32_t size, _Out_ uint32_t *written, void *overlapped)',
    ),
    SetFilePointerEx: kernel.func(
      'int __stdcall SetFilePointerEx(intptr_t handle, int64_t distance, void *position, uint32_t method)',
    ),
    SetEndOfFile: kernel.func('int __stdcall SetEndOfFile(intptr_t handle)'),
    FlushFileBuffers: kernel.func(
      'int __stdcall FlushFileBuffers(intptr_t handle)',
    ),
  };
  const token = [0];
  if (!functions.OpenProcessToken(functions.GetCurrentProcess(), 8, token))
    throw new Error(`Windows token open failed: ${functions.GetLastError()}`);
  let sid: Buffer;
  try {
    const needed = [0];
    functions.GetTokenInformation(token[0], 1, null, 0, needed);
    const user = Buffer.alloc(needed[0]);
    if (!functions.GetTokenInformation(token[0], 1, user, user.length, needed))
      throw new Error(`Windows token read failed: ${functions.GetLastError()}`);
    const pointer = koffi.decode(user, 'void *');
    sid = Buffer.from(
      koffi.decode(
        pointer,
        'uint8_t',
        functions.GetLengthSid(pointer) as number,
      ),
    );
  } finally {
    functions.CloseHandle(token[0]);
  }
  native = { koffi, functions, sid };
  return native;
}

function assertNoReparse(file: string): void {
  const { functions } = api();
  const full = resolve(file);
  const root = parse(full).root;
  const paths: string[] = [];
  for (let current = full; current !== root; current = dirname(current)) {
    paths.push(current);
  }
  for (const current of paths.reverse()) {
    const attributes = (functions.GetFileAttributesW(current) as number) >>> 0;
    if (attributes === 0xffffffff) {
      const error = functions.GetLastError() as number;
      if (current === full && error === 2) continue;
      throw new Error(`Windows private file attributes failed: ${error}`);
    }
    if ((attributes & 0x400) !== 0)
      throw new Error('Windows private file path contains a reparse point');
  }
}

function assertPrivateHandle(handle: number): void {
  const { koffi, functions, sid } = api();
  const owner = [null];
  const dacl = [null];
  const security = [null];
  const status = functions.GetSecurityInfo(
    handle,
    1,
    5,
    owner,
    null,
    dacl,
    null,
    security,
  );
  if (status !== 0)
    throw new Error(`Windows private file security read failed: ${status}`);
  try {
    const control = [0];
    const revision = [0];
    const information = Buffer.alloc(12);
    const ace = [null];
    if (
      !functions.EqualSid(owner[0], sid) ||
      !functions.GetSecurityDescriptorControl(security[0], control, revision) ||
      (control[0] & 0x1000) === 0 ||
      !dacl[0] ||
      !functions.GetAclInformation(
        dacl[0],
        information,
        information.length,
        2,
      ) ||
      information.readUInt32LE(0) !== 1 ||
      !functions.GetAce(dacl[0], 0, ace)
    ) {
      throw new Error('Windows private file is not current-user protected');
    }
    const header = Buffer.from(koffi.decode(ace[0], 'uint8_t', 8));
    const bytes = Buffer.from(
      koffi.decode(ace[0], 'uint8_t', header.readUInt16LE(2)),
    );
    if (
      header[0] !== 0 ||
      (header.readUInt32LE(4) & 0x1f01ff) !== 0x1f01ff ||
      !functions.EqualSid(bytes.subarray(8), sid)
    ) {
      throw new Error('Windows private file permits unrelated access');
    }
  } finally {
    functions.LocalFree(security[0]);
  }
}

export function openWindowsPrivateFile(
  file: string,
  operation: FileOperation,
): WindowsPrivateFile {
  const ancestors = retainAncestors(file);
  try {
    return openPrivateFile(file, operation, ancestors);
  } catch (error) {
    try {
      releaseAncestors(ancestors);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Windows private file open and cleanup failed',
      );
    }
    throw error;
  }
}

function releaseAncestors(ancestors: number[]): void {
  const { functions } = api();
  const failures: Error[] = [];
  for (let index = ancestors.length - 1; index >= 0; index--) {
    if (functions.CloseHandle(ancestors[index])) ancestors.splice(index, 1);
    else
      failures.push(
        new Error(
          `Windows private file ancestor close failed: ${functions.GetLastError()}`,
        ),
      );
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Windows private file ancestor cleanup failed',
    );
}

function retainAncestors(file: string): number[] {
  const { functions } = api();
  const paths: string[] = [];
  let current = dirname(resolve(file));
  while (true) {
    paths.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const ancestors: number[] = [];
  try {
    for (const path of paths) {
      const handle = functions.CreateFileW(
        path,
        0x80,
        1,
        null,
        3,
        0x02200000,
        0,
      ) as number;
      if (handle === -1)
        throw new Error(
          `Windows private file ancestor open failed: ${functions.GetLastError()}`,
        );
      ancestors.push(handle);
      const information = Buffer.alloc(52);
      if (
        !functions.GetFileInformationByHandle(handle, information) ||
        (information.readUInt32LE(0) & 0x410) !== 0x10
      )
        throw new Error(
          'Windows private file ancestor is not a non-reparse directory',
        );
    }
    return ancestors;
  } catch (error) {
    try {
      releaseAncestors(ancestors);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Windows private file ancestor open and cleanup failed',
      );
    }
    throw error;
  }
}

function openPrivateFile(
  file: string,
  operation: FileOperation,
  ancestors: number[],
): WindowsPrivateFile {
  const { koffi, functions, sid } = api();
  assertNoReparse(file);
  const acl = Buffer.alloc(8 + 8 + sid.length);
  const security = Buffer.alloc(40);
  if (
    !functions.InitializeAcl(acl, acl.length, 2) ||
    !functions.AddAccessAllowedAce(acl, 2, 0x1f01ff, sid) ||
    !functions.InitializeSecurityDescriptor(security, 1) ||
    !functions.SetSecurityDescriptorOwner(security, sid, 0) ||
    !functions.SetSecurityDescriptorDacl(security, 1, acl, 0) ||
    !functions.SetSecurityDescriptorControl(security, 0x1000, 0x1000)
  ) {
    throw new Error(
      `Windows private file ACL setup failed: ${functions.GetLastError()}`,
    );
  }
  const attributes = Buffer.alloc(24);
  attributes.writeUInt32LE(attributes.length, 0);
  attributes.writeBigUInt64LE(koffi.address(security), 8);
  const handle = functions.CreateFileW(
    file,
    operation === 'read'
      ? 0x80020000
      : operation === 'create'
        ? 0xc0030000
        : 0xc0020000,
    1,
    attributes,
    operation === 'read' ? 3 : operation === 'create' ? 1 : 4,
    0x00200000,
    0,
  ) as number;
  if (handle === -1)
    throw new Error(
      `Windows private file open failed: ${functions.GetLastError()}`,
    );
  try {
    assertNoReparse(file);
    assertPrivateHandle(handle);
    assertPrivateFileBinding(handle, file);
    return new WindowsPrivateFile(handle, file, ancestors);
  } catch (error) {
    functions.CloseHandle(handle);
    throw error;
  }
}

function fileInformation(handle: number): Buffer {
  const { functions } = api();
  const information = Buffer.alloc(52);
  if (!functions.GetFileInformationByHandle(handle, information))
    throw new Error(
      `Windows private file identity failed: ${functions.GetLastError()}`,
    );
  if ((information.readUInt32LE(0) & 0x410) !== 0)
    throw new Error('Windows private file is not a regular non-reparse file');
  return information;
}

function fileIdentity(handle: number): Buffer {
  const information = fileInformation(handle);
  return Buffer.concat([
    information.subarray(28, 32),
    information.subarray(44, 52),
  ]);
}

function assertPrivateFileBinding(handle: number, file: string): void {
  const { functions } = api();
  assertNoReparse(file);
  const current = functions.CreateFileW(
    file,
    0x80020000,
    7,
    null,
    3,
    0x00200000,
    0,
  ) as number;
  if (current === -1)
    throw new Error(
      `Windows private file binding open failed: ${functions.GetLastError()}`,
    );
  try {
    if (!fileIdentity(handle).equals(fileIdentity(current)))
      throw new Error('Windows private file generation changed');
    assertPrivateHandle(handle);
    assertNoReparse(file);
  } finally {
    functions.CloseHandle(current);
  }
}

function renamePrivateFile(
  handle: number,
  target: string,
  replace: boolean,
): void {
  const { functions } = api();
  assertNoReparse(target);
  assertPrivateHandle(handle);
  const name = Buffer.from(resolve(target), 'utf16le');
  const information = Buffer.alloc(20 + name.length + 2);
  information[0] = replace ? 1 : 0;
  information.writeUInt32LE(name.length, 16);
  name.copy(information, 20);
  if (
    !functions.SetFileInformationByHandle(
      handle,
      3,
      information,
      information.length,
    )
  ) {
    throw new Error(
      `Windows private file rename failed: ${functions.GetLastError()}`,
    );
  }
}

class WindowsPrivateFile {
  private closed = false;

  constructor(
    private readonly handle: number,
    private file: string,
    private readonly ancestors: number[],
  ) {}

  private verify(): void {
    if (this.closed) throw new Error('Windows private file handle is closed');
    assertPrivateFileBinding(this.handle, this.file);
  }

  private flush(): void {
    const { functions } = api();
    if (!functions.FlushFileBuffers(this.handle))
      throw new Error(
        `Windows private file flush failed: ${functions.GetLastError()}`,
      );
  }

  size(): number {
    this.verify();
    const information = fileInformation(this.handle);
    const size =
      information.readUInt32LE(32) * 0x100000000 + information.readUInt32LE(36);
    if (!Number.isSafeInteger(size))
      throw new Error('Windows private file is too large');
    return size;
  }

  read(maxBytes: number): Buffer {
    this.verify();
    const size = this.size();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || size > maxBytes)
      throw new Error('Windows private file exceeds its read bound');
    const { functions } = api();
    if (!functions.SetFilePointerEx(this.handle, 0, null, 0))
      throw new Error(
        `Windows private file seek failed: ${functions.GetLastError()}`,
      );
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let remaining = size;
    while (remaining > 0) {
      const count = [0];
      if (
        !functions.ReadFile(
          this.handle,
          buffer,
          Math.min(buffer.length, remaining),
          count,
          null,
        )
      )
        throw new Error(
          `Windows private file read failed: ${functions.GetLastError()}`,
        );
      if (count[0] === 0)
        throw new Error('Windows private file changed while reading');
      chunks.push(Buffer.from(buffer.subarray(0, count[0])));
      remaining -= count[0];
    }
    this.verify();
    if (this.size() !== size)
      throw new Error('Windows private file changed while reading');
    return Buffer.concat(chunks);
  }

  write(content: Buffer): void {
    this.verify();
    const { functions } = api();
    if (!functions.SetFilePointerEx(this.handle, 0, null, 2))
      throw new Error(
        `Windows private file seek failed: ${functions.GetLastError()}`,
      );
    let position = 0;
    while (position < content.length) {
      const count = [0];
      const remaining = content.subarray(position, position + 64 * 1024);
      if (
        !functions.WriteFile(
          this.handle,
          remaining,
          remaining.length,
          count,
          null,
        ) ||
        count[0] === 0
      )
        throw new Error(
          `Windows private file write failed: ${functions.GetLastError()}`,
        );
      position += count[0];
    }
    this.flush();
    this.verify();
  }

  truncate(): void {
    this.verify();
    const { functions } = api();
    if (
      !functions.SetFilePointerEx(this.handle, 0, null, 0) ||
      !functions.SetEndOfFile(this.handle)
    )
      throw new Error(
        `Windows private file truncate failed: ${functions.GetLastError()}`,
      );
    this.flush();
    this.verify();
  }

  rename(target: string): void {
    if (
      dirname(resolve(target)).toLowerCase() !==
      dirname(resolve(this.file)).toLowerCase()
    )
      throw new Error('Windows private file rename must retain its directory');
    this.verify();
    assertWindowsPathsTrusted(runWindowsTrustCommand, [
      {
        path: dirname(resolve(target)),
        kind: 'directory',
        policy: 'execution-safe',
      },
    ]);
    const replace = existsSync(target);
    if (replace) withPrivateFile(target, 'read', () => undefined);
    renamePrivateFile(this.handle, target, replace);
    this.file = target;
    this.verify();
  }

  discard(unpublishedPath: string): void {
    if (resolve(this.file) !== resolve(unpublishedPath)) return;
    this.verify();
    const { functions } = api();
    if (
      !functions.SetFileInformationByHandle(this.handle, 4, Buffer.from([1]), 1)
    )
      throw new Error(
        `Windows private file cleanup failed: ${functions.GetLastError()}`,
      );
  }

  close(): void {
    const { functions } = api();
    if (!this.closed) {
      if (!functions.CloseHandle(this.handle))
        throw new Error(
          `Windows private file close failed: ${functions.GetLastError()}`,
        );
      this.closed = true;
    }
    releaseAncestors(this.ancestors);
  }
}

export function appendWindowsPrivateJournal(
  file: string,
  line: string,
  maxBytes: number,
): void {
  const temporary = join(
    dirname(file),
    `.lifecycle-journal-${randomUUID()}.tmp`,
  );
  withPrivateFile(file, 'append', (journal) => {
    const content = Buffer.from(line);
    if (journal.size() + content.length > maxBytes) {
      withPrivateFile(temporary, 'create', (retained) => {
        try {
          retained.write(journal.read(2 ** 31 - 1));
          retained.rename(`${file}.previous`);
          fsyncDirectorySync(dirname(file));
        } catch (error) {
          try {
            retained.discard(temporary);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Windows journal rotation and cleanup failed',
            );
          }
          throw error;
        }
      });
      journal.truncate();
    }
    journal.write(content);
  });
}

function withPrivateFile<Result>(
  file: string,
  operation: FileOperation,
  action: (descriptor: WindowsPrivateFile) => Result,
): Result {
  const descriptor = openWindowsPrivateFile(file, operation);
  let failure: unknown;
  let failed = false;
  try {
    return action(descriptor);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      descriptor.close();
    } catch (error) {
      if (failed)
        throw new AggregateError(
          [failure, error],
          'Windows private file operation and close failed',
        );
      throw error;
    }
  }
}

export function readWindowsPrivateFile(file: string, maxBytes: number): Buffer {
  return withPrivateFile(file, 'read', (descriptor) =>
    descriptor.read(maxBytes),
  );
}
