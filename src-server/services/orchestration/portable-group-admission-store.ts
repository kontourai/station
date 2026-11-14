import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@kontourai/relay';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { PortableGroupPreparation } from './portable-group-preparation.js';

type Admission = ReturnType<PortableGroupPreparation['admission']>;

/** Host-private storage for signed inert admission facts. It never grants execution. */
// UNWIRED(#91): factory serving and full caller/protocol qualification remain open.
export class PortableGroupAdmissionStore {
  constructor(private readonly root: string) {
    this.#assertRoot();
  }
  #assertRoot() {
    const stat = lstatSync(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o700
    )
      throw new Error('portable_admission_root_unavailable');
  }
  #path(groupId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(groupId))
      throw new Error('portable_admission_invalid');
    return join(
      this.root,
      `${createHash('sha256').update(groupId).digest('hex')}.json`,
    );
  }
  read(groupId: string, current: () => undefined): Admission | null {
    current();
    this.#assertRoot();
    let fd: number;
    try {
      fd = openSync(
        this.#path(groupId),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > 1_048_576
      )
        throw new Error('portable_admission_unavailable');
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        !('payload' in value) ||
        !('signature' in value) ||
        typeof value.signature !== 'string'
      )
        throw new Error('portable_admission_invalid');
      current();
      return value as Admission;
    } finally {
      closeSync(fd);
    }
  }
  async retain(
    groupId: string,
    admission: Admission,
    current: () => undefined,
  ): Promise<void> {
    const path = this.#path(groupId);
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      current();
      this.#assertRoot();
      if (admission.payload.spec.groupId !== groupId)
        throw new Error('portable_admission_invalid');
      const prior = this.read(groupId, current);
      if (prior && canonicalJson(prior) !== canonicalJson(admission))
        throw new Error('portable_admission_conflict');
      if (!prior)
        await publishJsonFileWithOwnedLock(path, admission, {
          maxBytes: 1_048_576,
          finalizeCommit: current,
        });
      const retained = this.read(groupId, current);
      if (!retained || canonicalJson(retained) !== canonicalJson(admission))
        throw new Error('portable_admission_unavailable');
    } finally {
      await release();
    }
  }
}
