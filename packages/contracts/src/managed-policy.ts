/**
 * Managed policy (#4515): the machine administrator's outer bound on what
 * Station does. An administrator installs one policy document; the server
 * loads it once at startup and refuses to start when it cannot enforce it.
 *
 * This module owns the v1 document shape, its boundary parser, the
 * value-free summary that clients see, and the fingerprint input. Reading a
 * policy from a source and hashing it belong to
 * `@kontourai/station-shared/managed-policy`, which needs Node.
 *
 * The parser accepts only what this build enforces. A key it does not know
 * may be a restriction from a newer release, and a key it knows but does not
 * yet enforce (any `settings` entry and every `limits` key, until each
 * enforcement slice lands) would make the machine look managed when it is
 * not. Both are rejected with a problem that names the key.
 */
import { boundaryText, isRecord } from './contract-validation.js';
import { canonicalizeForDigest } from './fleet-routing-receipt.js';

export const MANAGED_POLICY_SCHEMA_VERSION = 1;

/**
 * The fail-closed startup marker. The server's fatal line starts with it, the
 * desktop sidecar treats an exit carrying it as unrecoverable (no retry), and
 * the CLI surfaces the line that carries it after a failed start.
 */
export const MANAGED_POLICY_INVALID_MARKER = 'STATION_MANAGED_POLICY_INVALID';

/** A managed setting: a default (`locked: false`) or a fixed value. */
export interface ManagedPolicySettingEntry {
  value: unknown;
  locked: boolean;
}

/**
 * Limits sit outside settings. Each enforcement slice adds its key here and
 * to {@link MANAGED_POLICY_ENFORCED_LIMIT_KEYS} together.
 */
export interface ManagedPolicyLimits {
  /** #4519: the client kinds that may reach this machine's servers. */
  clients?: ManagedPolicyClientKind[];
}

export interface ManagedPolicyDocument {
  schemaVersion: typeof MANAGED_POLICY_SCHEMA_VERSION;
  /** Shown to users as "Managed by <organization>". */
  organization: string;
  /** An https page users can visit for help with a managed control. */
  supportUrl?: string;
  /** Keyed by setting path. Empty in this build: see the module comment. */
  settings?: Record<string, ManagedPolicySettingEntry>;
  limits?: ManagedPolicyLimits;
}

/** Limit keys this build enforces. */
export const MANAGED_POLICY_ENFORCED_LIMIT_KEYS: readonly string[] = [
  'clients',
];

/**
 * Limit keys the managed-policy plan reserves for later releases. A reserved
 * key gets a "not supported by this version" problem instead of "unknown",
 * so an administrator learns to upgrade rather than to fix a typo.
 */
export const MANAGED_POLICY_RESERVED_LIMIT_KEYS: readonly string[] = [
  'maxApprovalMode',
  'engines',
  'telemetry',
  'webhookAutomations',
  'registries',
  'updates',
];

const DOCUMENT_KEYS = [
  'schemaVersion',
  'organization',
  'supportUrl',
  'settings',
  'limits',
] as const;
const ORGANIZATION_MAX_CHARS = 200;
const SUPPORT_URL_MAX_CHARS = 2048;

/** One reason a document is refused; `path` is a dotted document path. */
export interface ManagedPolicyProblem {
  path: string;
  message: string;
}

export type ManagedPolicyParseResult =
  | { ok: true; document: ManagedPolicyDocument }
  | { ok: false; problems: ManagedPolicyProblem[] };

/**
 * Longest key name quoted in a problem path. Key names come from the policy
 * file, and the paths end up in the server's one-line fatal message, so an
 * enormous key must not make that line enormous.
 */
export const MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS = 64;

function describeKey(parent: string, key: string): string {
  if (key.length > MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS) {
    const shown = JSON.stringify(
      key.slice(0, MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS),
    );
    return `${parent}[${shown}… (${key.length} characters)]`;
  }
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? parent
      ? `${parent}.${key}`
      : key
    : `${parent}[${JSON.stringify(key)}]`;
}

type JsonContainerFrame =
  | { object: true; path: string; seen: Set<string> }
  | { object: false; path: string; index: number };

const JSON_LITERAL =
  /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * The path of the first member name repeated within one JSON object, or
 * null when every object's names are distinct. Names are compared after
 * unescaping, so `"limits"` and `"limits"` are the same name.
 *
 * `JSON.parse` keeps the last of two equal names, which would let a second
 * `"limits": {}` erase the first one's restrictions; a policy must say each
 * thing once. Expects text `JSON.parse` already accepted and throws a
 * `SyntaxError` on anything else. Iterative, so nesting depth is bounded
 * only by the input size.
 */
export function duplicateJsonMemberPath(text: string): string | null {
  let i = 0;
  let path = '';
  const stack: JsonContainerFrame[] = [];
  const fail = (): never => {
    throw new SyntaxError(`unexpected JSON input at offset ${i}`);
  };
  const skipSpace = () => {
    while (
      text[i] === ' ' ||
      text[i] === '\t' ||
      text[i] === '\n' ||
      text[i] === '\r'
    )
      i++;
  };
  const readString = (): string => {
    const start = i;
    let escaped = false;
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        escaped = true;
        i++;
      } else if (c === '"') {
        i++;
        return escaped
          ? (JSON.parse(text.slice(start, i)) as string)
          : text.slice(start + 1, i - 1);
      }
    }
    return fail();
  };
  /** Reads `"name":` in `frame`; returns its path if the name repeats. */
  const readMemberName = (
    frame: Extract<JsonContainerFrame, { object: true }>,
  ): string | null => {
    skipSpace();
    if (text[i] !== '"') fail();
    const name = readString();
    const memberPath = describeKey(frame.path, name);
    if (frame.seen.has(name)) return memberPath;
    frame.seen.add(name);
    skipSpace();
    if (text[i++] !== ':') fail();
    path = memberPath;
    return null;
  };

  for (;;) {
    // A value starts here, at `path`.
    skipSpace();
    const c = text[i];
    if (c === '{' || c === '[') {
      i++;
      skipSpace();
      if (text[i] === (c === '{' ? '}' : ']')) {
        i++;
      } else if (c === '{') {
        const frame = { object: true as const, path, seen: new Set<string>() };
        stack.push(frame);
        const duplicate = readMemberName(frame);
        if (duplicate !== null) return duplicate;
        continue;
      } else {
        stack.push({ object: false, path, index: 0 });
        path = `${path}[0]`;
        continue;
      }
    } else if (c === '"') {
      readString();
    } else {
      JSON_LITERAL.lastIndex = i;
      if (!JSON_LITERAL.test(text)) fail();
      i = JSON_LITERAL.lastIndex;
    }
    // A value ended: close finished containers, then move to the next entry.
    for (;;) {
      const frame = stack[stack.length - 1];
      skipSpace();
      if (!frame) {
        if (i !== text.length) fail();
        return null;
      }
      const separator = text[i++];
      if (separator === ',') {
        if (frame.object) {
          const duplicate = readMemberName(frame);
          if (duplicate !== null) return duplicate;
        } else {
          frame.index++;
          path = `${frame.path}[${frame.index}]`;
        }
        break;
      }
      if (separator !== (frame.object ? '}' : ']')) fail();
      stack.pop();
    }
  }
}

function unknownKeyProblems(
  record: Record<string, unknown>,
): ManagedPolicyProblem[] {
  return Reflect.ownKeys(record)
    .filter(
      (key) =>
        typeof key !== 'string' ||
        !(DOCUMENT_KEYS as readonly string[]).includes(key),
    )
    .map((key) => ({
      path: describeKey('', String(key)),
      message:
        'unknown key; this version of Station refuses keys it cannot enforce',
    }));
}

function schemaVersionProblem(version: unknown): string | null {
  if (version === undefined) return 'is required';
  if (version === MANAGED_POLICY_SCHEMA_VERSION) return null;
  return typeof version === 'number' &&
    Number.isInteger(version) &&
    version > MANAGED_POLICY_SCHEMA_VERSION
    ? `${version} is newer than this version of Station supports (${MANAGED_POLICY_SCHEMA_VERSION}); upgrade Station`
    : `must be ${MANAGED_POLICY_SCHEMA_VERSION}`;
}

function organizationProblem(organization: unknown): string | null {
  if (organization === undefined) return 'is required';
  return boundaryText(organization, ORGANIZATION_MAX_CHARS)
    ? null
    : `must be a non-empty single line of at most ${ORGANIZATION_MAX_CHARS} characters without leading or trailing spaces`;
}

/** Every entry of a reserved map, each with the message `entryMessage` gives. */
function reservedMapProblems(
  name: 'settings' | 'limits',
  value: unknown,
  entryMessage: (key: string) => string | null,
): ManagedPolicyProblem[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [{ path: name, message: 'must be an object' }];
  return Reflect.ownKeys(value).flatMap((key) => {
    const message = entryMessage(String(key));
    return message ? [{ path: describeKey(name, String(key)), message }] : [];
  });
}

function limitProblem(name: string): string | null {
  if (MANAGED_POLICY_ENFORCED_LIMIT_KEYS.includes(name)) return null;
  return MANAGED_POLICY_RESERVED_LIMIT_KEYS.includes(name)
    ? 'this limit is not supported by this version of Station'
    : 'unknown limit; this version of Station refuses keys it cannot enforce';
}

/**
 * Parse an already-decoded JSON value as a v1 policy document. Every problem
 * is reported, not only the first, so `station policy check` can list them.
 */
export function parseManagedPolicyDocument(
  value: unknown,
): ManagedPolicyParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      problems: [{ path: '', message: 'the policy must be a JSON object' }],
    };
  }
  const { organization, supportUrl, settings, limits } = value;
  const problems: ManagedPolicyProblem[] = unknownKeyProblems(value);
  const fieldProblems: Array<[string, string | null]> = [
    ['schemaVersion', schemaVersionProblem(value.schemaVersion)],
    ['organization', organizationProblem(organization)],
    [
      'supportUrl',
      supportUrl === undefined ? null : supportUrlProblem(supportUrl),
    ],
  ];
  for (const [path, message] of fieldProblems)
    if (message) problems.push({ path, message });
  problems.push(
    ...reservedMapProblems(
      'settings',
      settings,
      () => 'managed settings are not supported by this version of Station',
    ),
    ...reservedMapProblems('limits', limits, limitProblem),
    ...clientsLimitProblems(limits),
  );

  if (problems.length > 0) return { ok: false, problems };
  const document: ManagedPolicyDocument = {
    schemaVersion: MANAGED_POLICY_SCHEMA_VERSION,
    organization: organization as string,
  };
  if (supportUrl !== undefined) document.supportUrl = supportUrl as string;
  if (settings !== undefined) document.settings = {};
  if (limits !== undefined) document.limits = acceptedLimits(limits);
  return { ok: true, document };
}

function supportUrlProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0)
    return 'must be an https URL';
  if (value.length > SUPPORT_URL_MAX_CHARS)
    return `must be at most ${SUPPORT_URL_MAX_CHARS} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an https URL';
  }
  if (url.protocol !== 'https:') return 'must be an https URL';
  // Every user on the machine can read the policy, and clients show this
  // link; a credential in it would be disclosed to all of them.
  if (url.username || url.password)
    return 'must not contain a user name or password';
  return null;
}

/** Problems as one line each, e.g. for an error message or `policy check`. */
export function formatManagedPolicyProblems(
  problems: readonly ManagedPolicyProblem[],
): string {
  return problems
    .map((problem) =>
      problem.path ? `${problem.path}: ${problem.message}` : problem.message,
    )
    .join('; ');
}

/**
 * The bytes the fingerprint covers: the parsed document with object keys
 * sorted and no whitespace. Reformatting the file does not change it;
 * changing any value does.
 */
export function canonicalManagedPolicyJson(
  document: ManagedPolicyDocument,
): string {
  return JSON.stringify(canonicalizeForDigest(document));
}

/**
 * What clients learn about the policy: who manages the machine, where to get
 * help, which setting paths are locked, and the effective limits. It never
 * carries a setting value, because a value may be sensitive to someone, and
 * clients need only to explain why a control is locked.
 */
export interface ManagedPolicySummary {
  organization: string;
  supportUrl: string | null;
  lockedSettings: string[];
  limits: ManagedPolicyLimits;
}

export function summarizeManagedPolicy(
  document: ManagedPolicyDocument,
): ManagedPolicySummary {
  return {
    organization: document.organization,
    supportUrl: document.supportUrl ?? null,
    lockedSettings: Object.entries(document.settings ?? {})
      .filter(([, entry]) => entry.locked)
      .map(([path]) => path)
      .sort(),
    limits: acceptedLimits(document.limits),
  };
}

/** Where a loaded policy came from. More kinds arrive with later sources. */
export type ManagedPolicySourceKind = 'file' | 'test-override';

export interface ManagedPolicySourceDescriptor {
  kind: ManagedPolicySourceKind;
  /** A path, or a later source's identifier (a profile domain, a key). */
  location: string;
}

/** A `sha256:<64 hex>` fingerprint of {@link canonicalManagedPolicyJson}. */
export type ManagedPolicyDigest = `sha256:${string}`;

/**
 * `GET /api/settings/managed-policy`: what the running server loaded at
 * startup. A server never runs with a policy it could not load, so there is
 * no error state here.
 */
export type ManagedPolicyStatus =
  | { state: 'none' }
  | {
      state: 'loaded';
      source: ManagedPolicySourceDescriptor;
      digest: ManagedPolicyDigest;
      summary: ManagedPolicySummary;
    };

export function isManagedPolicyDigest(
  value: unknown,
): value is ManagedPolicyDigest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Boundary parser for a {@link ManagedPolicyStatus} read from a server. */
export function parseManagedPolicyStatus(
  value: unknown,
): ManagedPolicyStatus | null {
  if (!isRecord(value)) return null;
  if (value.state === 'none') return { state: 'none' };
  if (value.state !== 'loaded') return null;
  const { source, digest, summary } = value;
  if (
    !isRecord(source) ||
    (source.kind !== 'file' && source.kind !== 'test-override') ||
    typeof source.location !== 'string' ||
    !isManagedPolicyDigest(digest) ||
    !isRecord(summary) ||
    typeof summary.organization !== 'string' ||
    (summary.supportUrl !== null && typeof summary.supportUrl !== 'string') ||
    !Array.isArray(summary.lockedSettings) ||
    !summary.lockedSettings.every((path) => typeof path === 'string') ||
    !isRecord(summary.limits) ||
    clientsValueProblem(ownValue(summary.limits, 'clients'), false) !== null
  ) {
    return null;
  }
  return {
    state: 'loaded',
    source: { kind: source.kind, location: source.location },
    digest,
    summary: {
      organization: summary.organization,
      supportUrl: summary.supportUrl,
      lockedSettings: [...summary.lockedSettings],
      limits: acceptedLimits(summary.limits),
    },
  };
}

/** "Managed by <organization>", the label beside a managed control. */
export function managedByLabel(summary: ManagedPolicySummary): string {
  return `Managed by ${summary.organization}`;
}

/**
 * The one sentence every surface uses to refuse a change the policy forbids,
 * e.g. `managedPolicyDenial(summary, 'this setting')` gives "Acme's policy
 * manages this setting. For help, visit https://…".
 */
export function managedPolicyDenial(
  summary: ManagedPolicySummary,
  subject: string,
): string {
  const help = summary.supportUrl
    ? ` For help, visit ${summary.supportUrl}`
    : ' Contact your administrator for help.';
  return `${summary.organization}'s policy manages ${subject}.${help}`;
}

/**
 * #4519: how a client reaches the server. `desktop` is the desktop app's own
 * server, `local-browser` a browser on this machine, and `remote` anything
 * off the machine: paired phones and computers, the relay, LAN discovery and
 * Tailscale Serve.
 */
export type ManagedPolicyClientKind = 'desktop' | 'local-browser' | 'remote';

export const MANAGED_POLICY_CLIENT_KINDS: readonly ManagedPolicyClientKind[] = [
  'desktop',
  'local-browser',
  'remote',
];

/**
 * The kinds every accepted `limits.clients` must keep. This build enforces
 * only the absence of `remote`; it cannot keep the desktop app or a local
 * browser out, so a list without one of them is refused rather than accepted
 * and ignored.
 */
const REQUIRED_CLIENT_KINDS: readonly ManagedPolicyClientKind[] = [
  'desktop',
  'local-browser',
];

/**
 * `record[key]` only when it is the record's own member. Not `Object.hasOwn`:
 * the SDK, which imports this module, compiles against a library without it.
 */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

/**
 * Why `value` is not an accepted `limits.clients`, or null. A status read
 * from a server skips the required-kinds rule (`forDocument: false`): a newer
 * server may enforce lists this build refuses in a policy.
 */
function clientsValueProblem(
  value: unknown,
  forDocument = true,
): string | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    !value.every(
      (kind) =>
        typeof kind === 'string' &&
        (MANAGED_POLICY_CLIENT_KINDS as readonly string[]).includes(kind),
    )
  )
    return 'must be a list of "desktop", "local-browser" and "remote"';
  if (new Set(value).size !== value.length)
    return 'must not list a client kind twice';
  if (!forDocument) return null;
  const missing = REQUIRED_CLIENT_KINDS.filter((kind) => !value.includes(kind));
  return missing.length > 0
    ? `must include ${missing.map((kind) => `"${kind}"`).join(' and ')}; this version of Station can only leave out "remote"`
    : null;
}

/** #4519: problems with `limits.clients`, when `limits` is an object. */
function clientsLimitProblems(limits: unknown): ManagedPolicyProblem[] {
  if (!isRecord(limits)) return [];
  const message = clientsValueProblem(ownValue(limits, 'clients'));
  return message ? [{ path: 'limits.clients', message }] : [];
}

/**
 * Every enforced limit in an already-validated limits object, each as
 * parsed (a JSON copy), then each one this module normalizes. The parsed
 * document, the summary and the status decode all build `limits` here, so
 * a limit another slice adds to `MANAGED_POLICY_ENFORCED_LIMIT_KEYS` is kept
 * even where only one slice's normalization survives a merge.
 */
function acceptedLimits(limits: unknown): ManagedPolicyLimits {
  if (!isRecord(limits)) return {};
  const kept: Record<string, unknown> = {};
  for (const key of MANAGED_POLICY_ENFORCED_LIMIT_KEYS) {
    const value = ownValue(limits, key);
    if (value !== undefined) kept[key] = JSON.parse(JSON.stringify(value));
  }
  return { ...(kept as ManagedPolicyLimits), ...acceptedClientsLimit(limits) };
}

/** `{ clients }` from an already-validated limits object, else `{}`. */
function acceptedClientsLimit(limits: unknown): ManagedPolicyLimits {
  if (!isRecord(limits)) return {};
  const clients = ownValue(limits, 'clients');
  return Array.isArray(clients)
    ? {
        clients: MANAGED_POLICY_CLIENT_KINDS.filter((kind) =>
          clients.includes(kind),
        ),
      }
    : {};
}

/**
 * #4519: whether clients off this machine may reach the server. True without
 * a policy, without `limits.clients`, or when it lists `remote`.
 */
export function managedPolicyAllowsRemoteClients(
  summary: Pick<ManagedPolicySummary, 'limits'> | null | undefined,
): boolean {
  const clients = summary?.limits.clients;
  return clients === undefined || clients.includes('remote');
}

/**
 * #4519: the refusal code for remote access the managed policy forbids: a
 * pairing offer, a relay invitation, LAN discovery, or a credential of a
 * device paired before the policy. Clients key on it to show the managed
 * message instead of offering a retry.
 */
export const MANAGED_POLICY_REMOTE_CLIENTS_CODE =
  'managed-policy-remote-clients' as const;

/**
 * #4519: the refusal without its help tail, for a surface that renders the
 * policy's support link itself ("Get help").
 */
export function managedRemoteClientsStatement(
  summary: ManagedPolicySummary,
): string {
  return `${summary.organization}'s policy manages remote access: only this computer can connect to Station.`;
}

/** The sentence every surface uses to refuse remote access under the limit. */
export function managedRemoteClientsDenial(
  summary: ManagedPolicySummary,
): string {
  return managedPolicyDenial(
    summary,
    'remote access: only this computer can connect to Station',
  );
}
