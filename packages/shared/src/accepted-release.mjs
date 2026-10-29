/**
 * The accepted-release record of an install root (#187): the newest release
 * it accepted from a verified public manifest, kept in
 * `.station-release-accepted.json` and only ever raised. The installers
 * refuse a manifest older than it, so a rollback (by the service launcher
 * after a failed trial, or a deliberate one) does not reopen a replay of an
 * older signed manifest; the server release check does not offer one.
 *
 * One implementation: the Windows installer core and the server use it
 * through prebuilt-archive.ts, and install.sh (which must stay one
 * standalone file) carries this exact function, generated into it by
 * scripts/install-script-generated.mjs. So it depends on nothing but its
 * arguments (Node.js built-ins are passed in).
 *
 * The record lives in the install root, not the Station home: a launcher
 * rollback restores the home from its backup, which would lower a record
 * kept there. Like `current`, it is writable by the installing user; it
 * defends against a hostile manifest host, not a local actor running as that
 * user.
 */
export function acceptedReleaseRules(rings, fs, rename, randomBytes) {
  const RELEASE = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
  const ANY_VERSION = new RegExp(`^${RELEASE}(?:-([a-z]+)\\.([1-9][0-9]*))?$`);
  const FILENAME = '.station-release-accepted.json';
  const ROLLBACK = 'STATION_INSTALL_ALLOW_ROLLBACK=1';

  /** Whether `version` has the ring shape: X.Y.Z, or X.Y.Z-<ring>.N. */
  function isRingVersion(ring, version) {
    if (typeof version !== 'string' || !Object.hasOwn(rings, ring))
      return false;
    const label = rings[ring].prerelease ? `-${ring}\\.[1-9][0-9]*` : '';
    return new RegExp(`^${RELEASE}${label}$`).test(version);
  }

  /**
   * Station release order: X.Y.Z, then a release outranks every prerelease
   * of its X.Y.Z, and two prereleases of one ring order by N. Null when the
   * two cannot be ordered (prereleases of two rings, or not a version).
   */
  function compareVersions(left, right) {
    const read = (version) => {
      const match =
        typeof version === 'string' ? ANY_VERSION.exec(version) : null;
      if (!match) return null;
      return {
        release: match.slice(1, 4).map(BigInt),
        ring: match[4] ?? null,
        build: match[5] === undefined ? null : BigInt(match[5]),
      };
    };
    const a = read(left);
    const b = read(right);
    if (!a || !b) return null;
    const order = (x, y) => (x === y ? 0 : (x ?? 0n) < (y ?? 0n) ? -1 : 1);
    for (let part = 0; part < 3; part += 1) {
      const result = order(a.release[part], b.release[part]);
      if (result !== 0) return result;
    }
    if (a.ring === b.ring) return a.ring === null ? 0 : order(a.build, b.build);
    if (a.ring === null) return 1;
    if (b.ring === null) return -1;
    return null;
  }

  function markPath(installRoot) {
    return `${installRoot}/${FILENAME}`;
  }

  /**
   * absent, invalid (not a regular file this user owns and only it can
   * read, malformed, another ring, or a version not of the ring shape), or
   * recorded. The owner and mode checks are those of the install state
   * beside it, and do not apply where the platform has no user ids.
   */
  function read(path, ring) {
    let info;
    try {
      info = fs.lstatSync(path);
    } catch (error) {
      return error && error.code === 'ENOENT'
        ? { state: 'absent' }
        : { state: 'invalid' };
    }
    const owner =
      typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (owner !== null && (info.uid !== owner || (info.mode & 0o077) !== 0))
    )
      return { state: 'invalid' };
    let value;
    try {
      value = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
      return { state: 'invalid' };
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(['releaseChannel', 'schemaVersion', 'version']) ||
      value.schemaVersion !== 1 ||
      value.releaseChannel !== ring ||
      !isRingVersion(ring, value.version)
    )
      return { state: 'invalid' };
    return { state: 'recorded', version: value.version };
  }

  /** older and incomparable are refused; not-older passes. */
  function relation(ring, version, accepted) {
    if (!isRingVersion(ring, version)) return 'incomparable';
    const order = compareVersions(version, accepted);
    if (order === null) return 'incomparable';
    return order < 0 ? 'older' : 'not-older';
  }

  /**
   * What an installer does with `version` (tag `v<version>`): ok, note (go
   * on, printing the message), warn (go on, printing it as a warning), or
   * refuse. `explicit` is STATION_VERSION naming this exact tag beside the
   * rollback flag.
   */
  function decide(path, ring, version, explicit) {
    const tag = `v${version}`;
    const mark = read(path, ring);
    if (mark.state === 'absent') return { action: 'ok', message: '' };
    if (mark.state === 'invalid')
      return explicit
        ? {
            action: 'warn',
            message: `Warning: cannot read the newest release this install accepted; installing ${tag} as explicitly requested (${ROLLBACK}).`,
          }
        : {
            action: 'refuse',
            message: `cannot read the newest release this install accepted (${path}: not a private file of this user with the expected content); fix its owner and permissions or remove it, or set STATION_VERSION=${tag} and ${ROLLBACK} to install ${tag} explicitly`,
          };
    const found = relation(ring, version, mark.version);
    if (found === 'not-older') return { action: 'ok', message: '' };
    if (explicit)
      return {
        action: 'note',
        message: `Installing Station ${tag}, not newer than v${mark.version} which this install already accepted (${ROLLBACK}).`,
      };
    return {
      action: 'refuse',
      message:
        found === 'older'
          ? `refusing Station ${tag}: this install already accepted the newer signed release v${mark.version}, so this manifest is stale or replayed; to install ${tag} deliberately, set STATION_VERSION=${tag} and ${ROLLBACK}`
          : `cannot compare Station ${tag} with v${mark.version}, the newest release this install accepted; set STATION_VERSION=${tag} and ${ROLLBACK} to install ${tag} explicitly`,
    };
  }

  /**
   * Raises the record to `version`, atomically, and never lowers it: a
   * valid record is kept unless `version` is newer; a missing or invalid one
   * is replaced (the caller checked it first, or was explicitly told to go
   * on). Throws for a version not of the ring shape. The staging file has
   * a random name, so a file a killed run left behind never blocks a later
   * one (process ids repeat, in containers especially), and is created
   * exclusively, so a link planted at its name is never followed.
   * With `onlyIfAbsent`, writes only when there is no record at all.
   */
  function record(path, ring, version, onlyIfAbsent) {
    if (!isRingVersion(ring, version))
      throw new Error(
        `${version} is not a ${ring} release version; the accepted release was not recorded`,
      );
    const existing = read(path, ring);
    if (onlyIfAbsent && existing.state !== 'absent') return;
    if (
      existing.state === 'recorded' &&
      compareVersions(version, existing.version) !== 1
    )
      return;
    const stage = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    let created = false;
    try {
      const fd = fs.openSync(stage, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(
          fd,
          `${JSON.stringify({ schemaVersion: 1, releaseChannel: ring, version })}\n`,
        );
      } finally {
        fs.closeSync(fd);
      }
      rename(stage, path);
    } catch (error) {
      if (created) fs.rmSync(stage, { force: true });
      throw error;
    }
  }

  /**
   * install.sh entry: `check <installRoot> <ring> <version> <explicit 0|1>`
   * prints the message and exits 0 ok, 10 note, 11 warn, 12 refuse;
   * `record` and `seed` (only when absent) exit 0, or 1 with the reason.
   */
  function cli(argv) {
    const [mode, installRoot, ring, version, explicit] = argv;
    const path = markPath(installRoot);
    if (mode === 'check') {
      const { action, message } = decide(path, ring, version, explicit === '1');
      if (message) process.stdout.write(`${message}\n`);
      process.exit({ ok: 0, note: 10, warn: 11, refuse: 12 }[action]);
    }
    try {
      record(path, ring, version, mode === 'seed');
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  return {
    FILENAME,
    isRingVersion,
    compareVersions,
    markPath,
    read,
    relation,
    decide,
    record,
    cli,
  };
}
