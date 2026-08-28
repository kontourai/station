import { z } from 'zod/v3';

// Notifications
export const notificationCreateSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    category: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough();

export const notificationSnoozeSchema = z.object({
  until: z.string().min(1),
});

// Config
export const appConfigUpdateSchema = z.record(z.unknown());

export const featurePreviewUpdateSchema = z.object({
  enabled: z.boolean(),
});

// SSH environments
export const sshEnvironmentCreateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  hostAlias: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/),
  remoteProjectPath: z.string().min(1).max(4096),
  remotePort: z.number().int().min(1).max(65_535).optional(),
  // archive#1133 R2: opt-in managed launch. Omitted entirely defaults to
  // 'attach' (today's behavior, byte-identical).
  launchMode: z.enum(['attach', 'managed']).optional(),
});

/**
 * "Test connection" for a prospective SSH computer (audit CI-R1/CI-R14).
 * Deliberately narrower than the create schema: a probe writes nothing, so
 * it needs only the host — everything else it reports (user, port, auth) is
 * DERIVED from the resolvable SSH config rather than supplied by the caller.
 */
export const sshEnvironmentProbeSchema = z.object({
  hostAlias: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/),
});

// Outbound peer credentials (archive#1123)
export const peerCredentialUpsertSchema = z.object({
  environmentId: z.string().min(1).max(200),
  apiBase: z.string().min(1).max(2048),
  credential: z.string().min(16).max(4096),
  scope: z.string().min(1).max(256),
  label: z.string().min(1).max(120).optional(),
});

// Answer share permalinks (archive#1423)
export const answerShareMintSchema = z.object({
  sessionId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  label: z.string().min(1).max(120).optional(),
  // Bounded here as well as clamped in the store: a caller-supplied lifetime
  // is the one field on this route that changes how long a capability lives.
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(90 * 24 * 60 * 60 * 1000)
    .optional(),
});

// Coding
export const execCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});

export const gitCheckoutSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  create: z.boolean().optional(),
});

export const gitCommitSchema = z.object({
  path: z.string().min(1),
  message: z.string().min(1),
});

export const gitPushSchema = z.object({
  path: z.string().min(1),
  remote: z.string().optional(),
  branch: z.string().optional(),
  setUpstream: z.boolean().optional(),
});

// Telemetry
export const telemetryEventsSchema = z.object({
  events: z.array(z.unknown()),
});

// Voice
export const voiceSessionCreateSchema = z.object({
  agentSlug: z.string().optional(),
});

// Registry
export const registryInstallSchema = z.object({
  id: z.string().min(1),
});

// Plugins
export const pluginPreviewSchema = z.object({
  source: z.string().min(1),
});

/**
 * `consent` is the operator's pre-install decision (archive#4288): the derived
 * permission set they were shown, the digest of the bytes they were shown, and
 * the dependency ids that decision named. It is `optional()` here only so the
 * route can answer the omission with a sentence that says what to do instead
 * of a field-shape error; the route refuses without it, and the installer
 * refuses a decision that does not match the staged source.
 */
export const pluginInstallConsentSchema = z.object({
  permissions: z.array(z.string()).max(256),
  contentDigest: z.string().min(1).max(256),
  dependencies: z.array(z.string()).max(256).optional(),
});

export const pluginInstallSchema = z.object({
  source: z.string().min(1),
  skip: z.array(z.string()).optional(),
  consent: pluginInstallConsentSchema.optional(),
});

export const pluginGrantSchema = z.object({
  permissions: z.array(z.string()),
});

/**
 * Both plugin-override write routes copy caller-supplied values VERBATIM into
 * `<home>/config/plugin-overrides.json` — `PUT /:name/settings` keeps every
 * undeclared settings key, `PUT /:name/overrides` keeps `disabled` as given —
 * and neither `z.record(z.unknown())` bounded how deeply those values nest.
 * Two consequences, both measured (archive#4307 review):
 *
 * - amplification: `JSON.stringify(…, null, 2)` indents by depth, so a 24 KB
 *   body of nested objects persisted as a 32 MB file (~1336x), re-parsed on
 *   every read of the store including at server boot;
 * - a hard ceiling nobody declared: `JSON.stringify` itself throws above
 *   ~6.2k levels, so a deeper body failed the write with a 500 rather than a
 *   refusal naming the reason.
 *
 * A settings map is a flat field-name→scalar record in the manifest contract,
 * so 32 is far above anything a real plugin writes; the point is that a store
 * refuses at its own boundary instead of persisting something a later reader
 * has to survive. The reader is bounded independently — `nullPrototypeDeep`
 * is iterative — so this cap is defence in depth, not the only guard.
 */
const MAX_PLUGIN_OVERRIDE_DEPTH = 32;

/**
 * True when `value` nests more than `limit` levels of object/array. Iterative
 * for the same reason the cap exists: a recursive depth check would itself
 * overflow on the input it is meant to refuse. Stops descending as soon as the
 * limit is passed, so an over-deep payload is refused without a full walk.
 */
function exceedsJsonDepth(value: unknown, limit: number): boolean {
  const pending: Array<[unknown, number]> = [[value, 1]];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) break;
    const [current, depth] = frame;
    if (typeof current !== 'object' || current === null) continue;
    if (depth > limit) return true;
    for (const entry of Object.values(current)) {
      pending.push([entry, depth + 1]);
    }
  }
  return false;
}

const boundedOverrideDepth = <T>(value: T): boolean =>
  !exceedsJsonDepth(value, MAX_PLUGIN_OVERRIDE_DEPTH);

const overrideDepthMessage = `Plugin override values may nest at most ${MAX_PLUGIN_OVERRIDE_DEPTH} levels`;

export const pluginSettingsSchema = z
  .record(z.unknown())
  .refine(boundedOverrideDepth, { message: overrideDepthMessage });

export const pluginOverridesSchema = z
  .record(z.unknown())
  .refine(boundedOverrideDepth, { message: overrideDepthMessage });

export const pluginFetchSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

// Feedback
export const feedbackDeleteSchema = z.object({
  conversationId: z.string().optional(),
  messageIndex: z.number().int().min(0),
});

// Conversations
export const conversationUpdateSchema = z
  .object({
    title: z.string().optional(),
  })
  .passthrough();

// Skills
/**
 * A registry id becomes a DIRECTORY NAME on both sides of the install copy, so
 * it must be a single, ordinary path segment. The leading character excludes
 * `.` and `_`, which is what keeps `..`, `.` and `__proto__` out; the service
 * asserts the same thing again at the write seam (`resolveSkillDirectory`),
 * because this schema guards one route and that seam guards every caller.
 */
const skillDirectoryName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message:
      'Skill id must be a single directory name: letters or digits first, then letters, digits, dots, dashes or underscores',
  });

export const skillInstallSchema = z.object({
  id: skillDirectoryName,
});

export const skillCreateSchema = z.object({
  name: skillDirectoryName,
  source: z.enum(['local', 'registry', 'plugin']).optional(),
  path: z.string().optional(),
});

// Coding file operations. `path` is the workspace root; `target`/`from`/`to`
// are paths relative to it. The service enforces that they resolve inside the
// root (no traversal) before touching disk.
export const fileCreateSchema = z.object({
  path: z.string().min(1),
  target: z.string().min(1),
  type: z.enum(['file', 'directory']),
});

export const fileRenameSchema = z.object({
  path: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

export const fileDeleteSchema = z.object({
  path: z.string().min(1),
  target: z.string().min(1),
});
