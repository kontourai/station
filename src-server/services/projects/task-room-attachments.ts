import { createHash, randomUUID } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type ChatAttachmentInput,
  parseChatAttachmentDataUrl,
  sniffChatImageMimeType,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import {
  isTaskRoomAttachments,
  type TaskRoomAttachment,
} from '@kontourai/station-contracts/project-task-room';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { AttachmentBlobStore } from '../orchestration/attachment-blob-store.js';

/** Files stored under one binding (a Task incarnation or a Project room). */
const FILES_PER_BINDING = 1280;

const BLOB_REF = /^sha256-[0-9a-f]{64}$/;
/**
 * The blob reference a record names, only when its identity is fully
 * determined (#4852 review): a record that parses names its `blobRef`; a
 * damaged one names a reference only if its text holds exactly one `sha256-`
 * token, and that token is a complete `"blobRef":"sha256-<64 hex>"` value.
 * Anything else (a truncated reference, a second hash, a parsed record
 * without a valid `blobRef`) is unknown, so its bytes cannot be ruled out.
 */
function recordReferences(raw: string): string[] {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    const tokens = raw.match(/sha256-/g)?.length ?? 0;
    const whole = /"blobRef":"(sha256-[0-9a-f]{64})"/.exec(raw);
    return tokens === 1 && whole ? [whole[1]!] : [];
  }
  return stored &&
    typeof stored === 'object' &&
    'blobRef' in stored &&
    typeof stored.blobRef === 'string' &&
    BLOB_REF.test(stored.blobRef)
    ? [stored.blobRef]
    : [];
}
function describeError(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * What a store directory is (#4852 review): `absent` only when the lookup
 * says ENOENT. Any other lookup error (EACCES, EIO), a link, or anything that
 * is not a directory is returned as the reason it cannot be trusted, so a
 * tree that cannot be inspected is never mistaken for an empty one.
 */
function storeDirectory(path: string): 'absent' | 'directory' | string {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return 'a link, which is not supported';
    return entry.isDirectory() ? 'directory' : 'not a directory';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : describeError(error);
  }
}

/** A repair entry's name, and the name Station renames it to on claiming. */
const REPAIR_RECORD = /^[0-9a-f-]{36}\.json$/;
const CLAIMED_REPAIR =
  /^([0-9a-f-]{36}\.json)\.claimed-(\d{15})-[0-9a-f-]{36}$/;

/**
 * Room attachment bytes. Bindings (which room may read which file) are kept
 * apart from the deduplicated byte store. A binding is an identity tuple, so
 * a recreated Task or Project never reads its predecessor's files.
 */
export class RoomAttachments {
  private readonly blobs: AttachmentBlobStore;
  constructor(
    private readonly root: string,
    /** Names the owner in the limit refusal ("This Task has…"). */
    private readonly owner: string,
    /** `retention: false` turns off the byte store's age and size eviction. */
    options: { retention?: false } = {},
  ) {
    this.blobs = new AttachmentBlobStore({
      rootDir: join(root, 'blobs'),
      ...(options.retention === false ? { retention: false } : {}),
    });
  }
  private directory(binding: readonly string[]) {
    const key = createHash('sha256')
      .update(JSON.stringify(binding))
      .digest('hex');
    return join(this.root, 'bindings', key);
  }
  store(
    binding: readonly string[],
    inputs: ChatAttachmentInput[],
  ): TaskRoomAttachment[] {
    const error = validateChatAttachments(inputs);
    if (error) throw new Error(error);
    // A declared image type is a claim the bytes must make too: bytes that
    // are not that image are never stored and served as one.
    for (const input of inputs)
      if (
        input.kind === 'image' &&
        sniffChatImageMimeType(
          Buffer.from(
            parseChatAttachmentDataUrl(input.dataUrl)!.base64.slice(0, 24),
            'base64',
          ),
        ) !== input.mimeType
      )
        throw new Error(`${input.name} is not a ${input.mimeType} image.`);
    const directory = this.directory(binding);
    mkdirSync(directory, { recursive: true });
    if (readdirSync(directory).length + inputs.length > FILES_PER_BINDING)
      throw new Error(`This ${this.owner} has reached its attachment limit.`);
    return inputs.map(({ dataUrl, ...metadata }) => {
      const blobRef = this.blobs.write(
        parseChatAttachmentDataUrl(dataUrl)!.base64,
      );
      if (!blobRef) throw new Error('Attachment bytes could not be saved.');
      const attachment = { ...metadata, id: randomUUID() };
      // Written whole, then renamed into place: a crash leaves a staging
      // file outside the bindings, never a torn record in them.
      const staging = join(this.root, 'staging');
      mkdirSync(staging, { recursive: true });
      const pending = join(staging, `${attachment.id}.json`);
      writeFileSync(pending, JSON.stringify({ attachment, blobRef }), {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(pending, join(directory, `${attachment.id}.json`));
      return attachment;
    });
  }
  read(
    binding: readonly string[],
    id: string,
  ):
    | { attachment: TaskRoomAttachment; dataUrl: string; bytes: Buffer }
    | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const path = join(this.directory(binding), `${id}.json`);
    if (!existsSync(path)) return undefined;
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !stored ||
      typeof stored !== 'object' ||
      !('attachment' in stored) ||
      !('blobRef' in stored) ||
      typeof stored.blobRef !== 'string'
    )
      return undefined;
    const attachments = [stored.attachment];
    if (!isTaskRoomAttachments(attachments)) return undefined;
    const [attachment] = attachments;
    const bytes = this.blobs.readBytes(stored.blobRef);
    if (!bytes || bytes.length !== attachment.size) return undefined;
    return {
      attachment,
      bytes,
      dataUrl: `data:${attachment.mimeType};base64,${bytes.toString('base64')}`,
    };
  }
  /**
   * Every record's blob references, read before anything changes. A record
   * that cannot be parsed still protects any `sha256-` reference recoverable
   * from its text; a record (or directory) whose references cannot be known
   * at all (unparseable with none recoverable, or unreadable: EIO, EACCES)
   * is listed in `unknown`. So is every directory level that is not a
   * plain directory or cannot be looked up (`storeDirectory`); only a tree
   * root or level that does not exist counts as empty.
   */
  scanReferences(): {
    byRecord: Map<string, string[]>;
    unknown: { path: string; reason: string }[];
  } {
    const byRecord = new Map<string, string[]>();
    const unknown: { path: string; reason: string }[] = [];
    const list = (path: string) => {
      try {
        return readdirSync(path);
      } catch (error) {
        unknown.push({ path, reason: describeError(error) });
        return [];
      }
    };
    // Records waiting in `repair/` protect their bytes too: they are about
    // to become live (`ProjectRoomAttachments`).
    const directory = (path: string) => {
      const kind = storeDirectory(path);
      if (kind === 'absent' || kind === 'directory') return kind;
      unknown.push({ path, reason: kind });
      return undefined;
    };
    for (const tree of ['bindings', 'repair']) {
      const top = join(this.root, tree);
      if (directory(top) !== 'directory') continue;
      for (const key of list(top)) {
        if (directory(join(top, key)) !== 'directory') continue;
        for (const name of list(join(top, key))) {
          const path = join(top, key, name);
          let raw: string;
          try {
            raw = readFileSync(path, 'utf8');
          } catch (error) {
            unknown.push({ path, reason: describeError(error) });
            continue;
          }
          const refs = recordReferences(raw);
          if (refs.length) byRecord.set(path, refs);
          else unknown.push({ path, reason: 'no readable blob reference' });
        }
      }
    }
    return { byRecord, unknown };
  }
  /**
   * Gives up files of this binding, then deletes each of their blobs that no
   * other record names (the byte store is deduplicated, so the same bytes may
   * back another file). Fails closed: if any record's references cannot be
   * known, nothing is removed or deleted and the unknown records are
   * returned. The caller must hold the store's cross-process lock across this
   * call and every `store` (`ProjectRoomAttachments`).
   */
  reclaim(
    binding: readonly string[],
    ids: readonly string[],
  ): {
    scanned: boolean;
    unknown: { path: string; reason: string }[];
    /** Released records kept because their bytes could not be deleted. */
    kept: number;
  } {
    // Nothing to give up: nothing to prove, and no scan (an upload's sweep
    // usually finds nothing stale).
    if (!ids.length) return { scanned: false, unknown: [], kept: 0 };
    const { byRecord, unknown } = this.scanReferences();
    if (unknown.length) return { scanned: true, unknown, kept: 0 };
    const directory = this.directory(binding);
    const released = new Set(
      ids
        .filter((id) => /^[0-9a-f-]{36}$/.test(id))
        .map((id) => join(directory, `${id}.json`)),
    );
    const candidates = new Set<string>();
    const named = new Set<string>();
    for (const [path, refs] of byRecord)
      for (const ref of refs)
        (released.has(path) ? candidates : named).add(ref);
    // Bytes go first, and a record goes only once nothing it names is still
    // owed a deletion: a failed unlink keeps the record, its quota charge and
    // its retry (a later sweep releases it again) (#4852 review).
    const stuck = new Set<string>();
    for (const ref of candidates)
      if (!named.has(ref) && !this.blobs.removeByRefConfirmed(ref))
        stuck.add(ref);
    let kept = 0;
    for (const path of released) {
      if ((byRecord.get(path) ?? []).some((ref) => stuck.has(ref))) {
        kept += 1;
        continue;
      }
      rmSync(path, { force: true });
    }
    return { scanned: true, unknown: [], kept };
  }
  /** Whether these bytes are stored, intact. */
  hasBlob(ref: string) {
    return this.blobs.readBytes(ref) !== undefined;
  }
  /**
   * This binding's files no standing message needs: any whose message was
   * deleted, and unsent uploads older than `unsentBefore` (epoch ms).
   * `standing` names, of the ids it is asked about, those linked to a message
   * that still stands; `linked`, those linked to any message.
   */
  stale(
    binding: readonly string[],
    unsentBefore: number,
    links: (ids: string[]) => { standing: Set<string>; linked: Set<string> },
  ): string[] {
    const directory = this.directory(binding);
    if (!existsSync(directory)) return [];
    const ids = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
    if (!ids.length) return [];
    const { standing, linked } = links(ids);
    return ids.filter((id) => {
      if (standing.has(id)) return false;
      if (linked.has(id)) return true;
      try {
        return statSync(join(directory, `${id}.json`)).mtimeMs < unsentBefore;
      } catch {
        return false;
      }
    });
  }
  /** Each descriptor must name a stored file of this binding, field for field. */
  resolve(
    binding: readonly string[],
    attachments: TaskRoomAttachment[],
  ): ChatAttachmentInput[] {
    if (!isTaskRoomAttachments(attachments))
      throw new Error(`Invalid ${this.owner} attachments.`);
    return attachments.map((attachment) => {
      const stored = this.read(binding, attachment.id);
      if (
        !stored ||
        ['kind', 'name', 'mimeType', 'size'].some(
          (key) =>
            Reflect.get(stored.attachment, key) !==
            Reflect.get(attachment, key),
        )
      )
        throw new Error(
          `${attachment.name} is unavailable. Choose the file again.`,
        );
      const { id: _id, ...metadata } = stored.attachment;
      return { ...metadata, dataUrl: stored.dataUrl };
    });
  }
}

type Scope = { taskId: string; taskCreatedAt: string; projectId: string };
const taskBinding = (scope: Scope) => [
  scope.projectId,
  scope.taskId,
  scope.taskCreatedAt,
];

/** Task incarnation bindings are separate from the deduplicated byte store. */
export class TaskRoomAttachments {
  private readonly files: RoomAttachments;
  constructor(root: string) {
    this.files = new RoomAttachments(root, 'Task');
  }
  store(scope: Scope, inputs: ChatAttachmentInput[]): TaskRoomAttachment[] {
    return this.files.store(taskBinding(scope), inputs);
  }
  read(scope: Scope, id: string) {
    return this.files.read(taskBinding(scope), id);
  }
  resolve(
    scope: Scope,
    attachments: TaskRoomAttachment[],
  ): ChatAttachmentInput[] {
    return this.files.resolve(taskBinding(scope), attachments);
  }
}

/**
 * Project-room files (#4812). Bytes are deleted only when no binding names
 * them, under one store-wide cross-process lock that every upload (blob and
 * binding publication), every release (binding removal, reference scan and
 * deletion) and every message that names files also holds, so no process can
 * publish or link the same bytes between the reference scan and the deletion
 * (#4852 review). The byte store's age and size eviction is off: it cannot
 * tell a live blob from a released one. Every byte on disk therefore backs a
 * live binding, and the bindings are bounded by the per-binding file limit.
 *
 * The lock is the yielding form (`acquireFileMutationLockAsync`), so waiting
 * on it never blocks the event loop. A caller runs its whole operation inside
 * `locked`, including its authority check, so a person whose access changed
 * while waiting is refused there, before anything is written. `store`,
 * `release` and `sweep` refuse to run outside `locked`.
 *
 * Fails closed: when any file record's references cannot be known (damaged
 * or unreadable), a release removes and deletes nothing. Every upload
 * re-derives the store's health under the lock, by the same scan of
 * `bindings/` and `repair/` that a release uses, and is refused with
 * `ProjectRoomFilesUnavailable` while any record is unknown or any repair is
 * incomplete. Admission depends on no cached observation and no file write,
 * so every live process refuses alike; `reclamation-blocked.json` (best
 * effort) only tells the operator which records to repair. Reading and
 * resolving existing files never consult it.
 *
 * Supported repair, under the same lock: leave a damaged record in place (it
 * keeps every release blocked) and write the corrected record to `repair/`
 * at the same relative path as under `bindings/`. Each upload and release
 * first claims each new repair entry by renaming it to a Station-owned name
 * beside it, then reads, validates and publishes only the claimed file
 * (staged, then renamed into `bindings/`), and deletes a claimed file only
 * after its bytes are published. A write that lands on the original name
 * after the claim is a new entry for the next pass; a claimed file that is
 * incomplete, or whose bytes are gone, stays a pending repair. Removing a
 * record, or fixing its permissions, may be done in place.
 * Adding or rewriting a record directly under `bindings/` while Station runs
 * is not supported: nothing could keep a release from missing it.
 */
export class ProjectRoomAttachments {
  private readonly files: RoomAttachments;
  private holding = 0;
  constructor(private readonly root: string) {
    this.files = new RoomAttachments(root, 'room', { retention: false });
  }
  /** Runs `operation` while holding the store's cross-process lock. */
  async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    mkdirSync(this.root, { recursive: true });
    const unlock = await acquireFileMutationLockAsync(
      join(this.root, 'store.lock'),
    );
    this.holding += 1;
    try {
      return await operation();
    } finally {
      this.holding -= 1;
      await unlock();
    }
  }
  store(
    binding: readonly string[],
    inputs: ChatAttachmentInput[],
  ): TaskRoomAttachment[] {
    this.held();
    // Health is derived afresh for every upload (#4852 review): the same
    // scan a release uses, plus any repair that could not be applied.
    const problems = [
      ...this.applyRepairs(),
      ...this.files.scanReferences().unknown,
    ];
    if (problems.length) {
      this.block(problems);
      throw new ProjectRoomFilesUnavailable(problems);
    }
    this.unblock();
    return this.files.store(binding, inputs);
  }
  read(binding: readonly string[], id: string) {
    return this.files.read(binding, id);
  }
  resolve(
    binding: readonly string[],
    attachments: TaskRoomAttachment[],
  ): ChatAttachmentInput[] {
    return this.files.resolve(binding, attachments);
  }
  /**
   * Gives up these files, and the bytes no other file names; `blocked` when
   * the store could not prove its references and nothing changed, `kept`
   * when some bytes could not be deleted and their records stay for a retry.
   */
  release(binding: readonly string[], ids: readonly string[]): ReclaimOutcome {
    this.held();
    const pending = this.applyRepairs();
    return this.settle(this.files.reclaim(binding, ids), pending);
  }
  /** Releases the files no standing message needs (see `RoomAttachments.stale`). */
  sweep(
    binding: readonly string[],
    unsentBefore: number,
    links: (ids: string[]) => { standing: Set<string>; linked: Set<string> },
  ): ReclaimOutcome {
    this.held();
    const pending = this.applyRepairs();
    return this.settle(
      this.files.reclaim(
        binding,
        this.files.stale(binding, unsentBefore, links),
      ),
      pending,
    );
  }
  private get marker() {
    return join(this.root, 'reclamation-blocked.json');
  }
  private settle(
    result: {
      scanned: boolean;
      unknown: { path: string; reason: string }[];
      kept: number;
    },
    pending: { path: string; reason: string }[],
  ): ReclaimOutcome {
    if (result.unknown.length) {
      this.block([...result.unknown, ...pending]);
      return 'blocked';
    }
    // A full scan that read every record clears the diagnostic, unless a
    // repair is still pending.
    if (result.scanned) {
      if (pending.length) this.block(pending);
      else this.unblock();
    }
    return result.kept ? 'kept' : 'reclaimed';
  }
  /**
   * Publishes complete repair records (under the lock, #4852 review). Each
   * new entry is first claimed by an atomic rename to
   * `<name>.claimed-<time>-<uuid>` in the same directory, so whatever an
   * operator writes to the original name afterwards is a new entry and is
   * never deleted with the claimed one. Of the claimed files of a record,
   * including any left by an earlier pass or process, the newest is
   * published: the exact bytes read and validated are staged, then renamed
   * into `bindings/`, and only after that is it deleted, with the older
   * claims it supersedes. A claimed file that is incomplete, whose bytes are
   * gone or that could not be published stays, with any it supersedes, and
   * is reported again on every pass. A failed
   * publication removes its own staging copy. Repair directories are removed
   * only when empty, never recursively. Unexpected entries and any error
   * reading the repair tree are reported as problems, never thrown.
   */
  private applyRepairs(): { path: string; reason: string }[] {
    const repair = join(this.root, 'repair');
    const kind = storeDirectory(repair);
    if (kind === 'absent') return [];
    if (kind !== 'directory') return [{ path: repair, reason: kind }];
    const problems: { path: string; reason: string }[] = [];
    let keys: Dirent[];
    try {
      keys = readdirSync(repair, { withFileTypes: true });
    } catch (error) {
      return [{ path: repair, reason: describeError(error) }];
    }
    for (const key of keys) {
      const from = join(repair, key.name);
      if (!key.isDirectory() || !/^[0-9a-f]{64}$/.test(key.name)) {
        problems.push({ path: from, reason: 'not a repair directory' });
        continue;
      }
      let names: Dirent[];
      try {
        names = readdirSync(from, { withFileTypes: true });
      } catch (error) {
        problems.push({ path: from, reason: describeError(error) });
        continue;
      }
      const claims: { path: string; target: string; order: string }[] = [];
      for (const name of names) {
        const path = join(from, name.name);
        if (!name.isFile()) {
          problems.push({ path, reason: 'not a repair record' });
          continue;
        }
        const claimed = CLAIMED_REPAIR.exec(name.name);
        if (claimed?.[1] && claimed[2]) {
          claims.push({ path, target: claimed[1], order: name.name });
          continue;
        }
        if (!REPAIR_RECORD.test(name.name)) {
          problems.push({ path, reason: 'not a repair record' });
          continue;
        }
        const order = `${name.name}.claimed-${String(Date.now()).padStart(15, '0')}-${randomUUID()}`;
        try {
          renameSync(path, join(from, order));
          claims.push({ path: join(from, order), target: name.name, order });
        } catch (error) {
          problems.push({ path, reason: describeError(error) });
        }
      }
      // The newest claim of each record is the operator's latest write, and
      // only it is published (claimed names sort by claim time). Older claims
      // of the same record are superseded, as a rewrite at the same name was
      // before claiming: they are deleted once the newest is published, and
      // until then they stay pending, so an older claim that becomes valid
      // later can never overwrite a newer repair.
      const byTarget = new Map<string, typeof claims>();
      for (const claim of claims)
        byTarget.set(claim.target, [
          ...(byTarget.get(claim.target) ?? []),
          claim,
        ]);
      for (const group of byTarget.values()) {
        group.sort((a, b) => a.order.localeCompare(b.order));
        const newest = group.pop();
        if (!newest) continue;
        const problem = this.publishRepair(key.name, newest);
        if (problem) {
          problems.push({ path: newest.path, reason: problem });
          for (const older of group)
            problems.push({
              path: older.path,
              reason: 'superseded by a later repair that is not yet applied',
            });
          continue;
        }
        for (const older of group)
          try {
            rmSync(older.path);
          } catch (error) {
            problems.push({ path: older.path, reason: describeError(error) });
          }
      }
      try {
        rmdirSync(from);
      } catch {
        // Not empty (ENOTEMPTY: a pending claim, or an entry that arrived
        // during this pass) or already gone: left for the next pass.
      }
    }
    return problems;
  }
  /** Publishes one claimed repair file; the reason it stays, if it does. */
  private publishRepair(
    key: string,
    claim: { path: string; target: string },
  ): string | undefined {
    let raw: Buffer;
    try {
      raw = readFileSync(claim.path);
    } catch (error) {
      return describeError(error);
    }
    const record = completeRecord(raw.toString('utf8'));
    if (!record) return 'not a complete file record';
    if (!this.files.hasBlob(record.blobRef))
      return 'its bytes are no longer stored';
    const staging = join(this.root, 'staging');
    const staged = join(staging, `repair.${randomUUID()}.json`);
    let created = false;
    try {
      mkdirSync(staging, { recursive: true });
      writeFileSync(staged, raw, { flag: 'wx', mode: 0o600 });
      created = true;
      const to = join(this.root, 'bindings', key);
      mkdirSync(to, { recursive: true });
      renameSync(staged, join(to, claim.target));
    } catch (error) {
      if (created)
        try {
          rmSync(staged, { force: true });
        } catch {
          // A staging copy that cannot be removed is only stray bytes.
        }
      return describeError(error);
    }
    try {
      rmSync(claim.path);
    } catch (error) {
      return describeError(error);
    }
    return undefined;
  }
  /** Tells the operator which records to repair; admission does not rely on it. */
  private block(records: { path: string; reason: string }[]) {
    try {
      const staging = join(this.root, 'staging');
      mkdirSync(staging, { recursive: true });
      const pending = join(staging, `reclamation-blocked.${randomUUID()}.json`);
      writeFileSync(
        pending,
        JSON.stringify(
          {
            since: new Date().toISOString(),
            note: 'Project room file records could not be read, so no stored bytes are deleted and new attachments are refused. Leave each damaged record in place and write its corrected record to repair/ at the same relative path, or remove it once you have decided its file is not needed, or fix its permissions; the next upload re-checks and clears this file.',
            records,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      renameSync(pending, this.marker);
    } catch {
      // Admission re-derives health on every upload, so the refusal holds
      // without this file; the service logs the block itself.
    }
  }
  private unblock() {
    try {
      rmSync(this.marker, { force: true });
    } catch {
      // A marker that cannot be removed only causes a re-check next time.
    }
  }
  private held() {
    if (!this.holding)
      throw new Error(
        'Project room files are written only under the store lock.',
      );
  }
}

/** A file record that parses whole, with its descriptor and reference. */
function completeRecord(
  raw: string,
): { attachment: TaskRoomAttachment; blobRef: string } | undefined {
  try {
    const stored: unknown = JSON.parse(raw);
    if (
      !stored ||
      typeof stored !== 'object' ||
      !('attachment' in stored) ||
      !('blobRef' in stored) ||
      typeof stored.blobRef !== 'string' ||
      !BLOB_REF.test(stored.blobRef) ||
      !isTaskRoomAttachments([stored.attachment])
    )
      return undefined;
    return {
      attachment: stored.attachment as TaskRoomAttachment,
      blobRef: stored.blobRef,
    };
  } catch {
    return undefined;
  }
}

/** What a release did: reclaimed, or stopped because the store was unsure. */
export type ReclaimOutcome = 'reclaimed' | 'blocked' | 'kept';
/**
 * A Project room's file store cannot prove which bytes are referenced, so it
 * takes no new attachments until an operator repairs it.
 */
export class ProjectRoomFilesUnavailable extends Error {
  constructor(readonly records: { path: string; reason: string }[]) {
    super(
      'Project room attachments are unavailable until the file store is repaired.',
    );
  }
}
