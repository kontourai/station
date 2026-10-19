export type AcceptedReleaseMark =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'recorded'; version: string };

export type AcceptedReleaseRelation = 'older' | 'not-older' | 'incomparable';

export type AcceptedReleaseDecision = {
  action: 'ok' | 'note' | 'warn' | 'refuse';
  message: string;
};

export type AcceptedReleaseRules = {
  FILENAME: string;
  isRingVersion(ring: string, version: unknown): version is string;
  compareVersions(left: string, right: string): -1 | 0 | 1 | null;
  markPath(installRoot: string): string;
  read(path: string, ring: string): AcceptedReleaseMark;
  relation(
    ring: string,
    version: string,
    accepted: string,
  ): AcceptedReleaseRelation;
  decide(
    path: string,
    ring: string,
    version: string,
    explicit: boolean,
  ): AcceptedReleaseDecision;
  record(
    path: string,
    ring: string,
    version: string,
    onlyIfAbsent?: boolean,
  ): void;
  cli(argv: string[]): never;
};

export function acceptedReleaseRules(
  rings: Readonly<Record<string, { prerelease: boolean }>>,
  fs: Pick<
    typeof import('node:fs'),
    | 'closeSync'
    | 'lstatSync'
    | 'openSync'
    | 'readFileSync'
    | 'rmSync'
    | 'writeFileSync'
  >,
  rename: (source: string, destination: string) => void,
  randomBytes: (size: number) => { toString(encoding: 'hex'): string },
): AcceptedReleaseRules;
