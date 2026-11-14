export const ENSEMBLE_PRESET_VERSION = 'station.ensemble/v1' as const;
export const ENSEMBLE_MAX_BYTES = 128 * 1024;
export const ENSEMBLE_MAX_MEMBERS = 16;

export const ENSEMBLE_INSPECTION_LIMITS = {
  requestBytes: 16 * 1024,
  uploadedRequestBytes: 256 * 1024,
  responseBytes: 256 * 1024,
  facts: 512,
  toolsPerMember: 8,
  knowledgeDetailsPerMember: 4,
} as const;

/** Receiver-owned selections only; the model always belongs to the preset. */
export interface EnsembleInspectionInput {
  /** Explicit, local-operator request; ordinary inspection never probes sign-in. */
  verifyAuthentication?: boolean;
  /** Explicit recorded group reference; never inferred from Agent or workspace. */
  groupId?: string;
  path?: string;
  presetJson?: string;
  expectedPresetHash?: string;
  groupBindings?: EnsembleCliSessionGroupInput['bindings'];
  bindings: Record<string, { agent: string; projectSlug: string }>;
}

/** Preset content supplies briefs and models; receiver bindings supply no new authority. */
export interface EnsembleCliSessionGroupInput {
  /** Exactly one source: host path (native local grant) or caller-supplied JSON. */
  path?: string;
  presetJson?: string;
  expectedPresetHash: string;
  brief: string;
  operationId: string;
  maxConcurrent: number;
  maxDispatches?: number;
  deadlineAt: number;
  bindings: Record<
    string,
    {
      target: Omit<
        import('./delegation-group').CliSessionGroupCreateInput['members'][number]['target'],
        'model' | 'workspace'
      > & {
        workspace: NonNullable<
          import('./delegation-group').CliSessionGroupCreateInput['members'][number]['target']['workspace']
        >;
      };
      needs: string[];
    }
  >;
}

export type EnsembleInspectionCategory =
  | 'members/models'
  | 'routing/triggers'
  | 'tools/services'
  | 'workspace'
  | 'memory'
  | 'schedules/webhooks'
  | 'output destinations';

export interface EnsembleInspectionFact {
  id: string;
  memberId?: string;
  /** Declared prerequisite member IDs for this member; never a ready frontier. */
  needs?: readonly string[];
  category: EnsembleInspectionCategory;
  label: string;
  value: string;
  origin: 'authored' | 'default' | 'runtime-derived' | 'unknown';
  state: 'configured' | 'unknown' | 'unavailable' | 'missing';
  owner: { label: string; href?: string; receipt?: string };
}

/** A configuration observation, never a preparation or launch capability. */
export interface EnsembleInspection {
  version: 'station.ensemble.inspection/v1';
  source: {
    sha256: string;
    presetId: string;
    name: string;
    stationmaster: string;
  };
  environmentId: string;
  observedAt: string;
  /** An offered read, not cached authority or an execution grant. Older hosts omit it. */
  authenticationCheck?:
    | { readonly state: 'available' }
    | { readonly state: 'unavailable'; readonly detail: string };
  /** Recorded metadata read offer; never an execution or acceptance grant. */
  groupInspection?:
    | { readonly state: 'available' }
    | { readonly state: 'unavailable'; readonly detail: string }
    | {
        readonly state: 'bound';
        readonly groupId: string;
        readonly revision: number;
      };
  facts: readonly EnsembleInspectionFact[];
  resolutions: readonly {
    memberId: string;
    receipt: import('./execution-target.js').ExecutionResolutionReceipt;
  }[];
  limits:
    | 'Recorded group references only; output availability, acceptance, native/shared memory, authentication, entitlement and execution limits are unverified.'
    | 'Authentication, entitlement, execution limits and live group bindings are unverified.'
    | 'Engine sign-in checks grant no execution authority; model entitlement, execution limits and live group bindings are unverified.';
}

export interface EnsembleModelOptions {
  readonly fastMode?: boolean;
  readonly thinking?: boolean;
  readonly serviceTier?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
}

export interface EnsembleMember {
  readonly id: string;
  readonly codename: string;
  readonly color: string;
  readonly role: string;
  /** Expected engine identity; a precondition, never a credential selector. */
  readonly engine: string;
  readonly model: string;
  /** Preserved verbatim; preparation validates values against the selected engine catalog. */
  readonly reasoning: {
    readonly option: 'effort' | 'reasoningEffort';
    readonly value: string;
  } | null;
  readonly options: EnsembleModelOptions;
  readonly promptAppends: readonly string[];
}

/** Shareable declarations only. No member, including Stationmaster, gains authority. */
export interface EnsemblePreset {
  readonly version: typeof ENSEMBLE_PRESET_VERSION;
  readonly id: string;
  readonly name: string;
  readonly stationmaster: string;
  readonly members: readonly EnsembleMember[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ensemble: expected an object');
  }
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    // biome-ignore lint/suspicious/noPrototypeBuiltins: SDK consumers retain ES2020 library compatibility.
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error('Ensemble: missing or unknown field');
  }
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error('Ensemble: invalid text');
  }
  return value;
}

function identifier(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(result)) {
    throw new Error('Ensemble: invalid identifier');
  }
  return result;
}

function modelOptions(value: unknown): EnsembleModelOptions {
  const input = object(value);
  const result: Record<string, boolean | string | number> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (
      (key === 'fastMode' || key === 'thinking') &&
      typeof entry === 'boolean'
    ) {
      result[key] = entry;
    } else if (key === 'serviceTier') {
      result[key] = identifier(entry);
    } else if (
      typeof entry === 'number' &&
      Number.isFinite(entry) &&
      ((key === 'temperature' && entry >= 0 && entry <= 2) ||
        (key === 'topP' && entry >= 0 && entry <= 1) ||
        (key === 'maxTokens' &&
          Number.isInteger(entry) &&
          entry > 0 &&
          entry <= 1_000_000))
    ) {
      result[key] = entry;
    } else {
      throw new Error('Ensemble: unsupported model option or value');
    }
  }
  return Object.freeze(result);
}

/** Parse bounded JSON without trimming authored prompts or silently dropping fields. */
export function parseEnsemblePreset(json: string): EnsemblePreset {
  // UTF-8 length without a Node or browser dependency; lone surrogates encode as U+FFFD.
  let bytes = 0;
  for (const point of json) {
    const code = point.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > ENSEMBLE_MAX_BYTES)
      throw new Error('Ensemble: preset exceeds byte limit');
  }
  const input = object(JSON.parse(json));
  closed(input, ['version', 'id', 'name', 'stationmaster', 'members']);
  if (input.version !== ENSEMBLE_PRESET_VERSION)
    throw new Error('Ensemble: unsupported version');
  if (
    !Array.isArray(input.members) ||
    input.members.length < 1 ||
    input.members.length > ENSEMBLE_MAX_MEMBERS
  ) {
    throw new Error('Ensemble: invalid member count');
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const members = input.members.map((entry): EnsembleMember => {
    const member = object(entry);
    closed(member, [
      'id',
      'codename',
      'color',
      'role',
      'engine',
      'model',
      'reasoning',
      'options',
      'promptAppends',
    ]);
    const id = identifier(member.id);
    const codename = identifier(member.codename);
    if (ids.has(id) || names.has(codename.toLowerCase()))
      throw new Error('Ensemble: duplicate member identity');
    ids.add(id);
    names.add(codename.toLowerCase());
    const color = text(member.color, 7);
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      throw new Error('Ensemble: invalid color');
    let reasoning: EnsembleMember['reasoning'] = null;
    if (member.reasoning !== null) {
      const declared = object(member.reasoning);
      closed(declared, ['option', 'value']);
      if (declared.option !== 'effort' && declared.option !== 'reasoningEffort')
        throw new Error('Ensemble: invalid reasoning option');
      reasoning = Object.freeze({
        option: declared.option,
        value: identifier(declared.value),
      });
    }
    const options = modelOptions(member.options);
    if (
      !Array.isArray(member.promptAppends) ||
      member.promptAppends.length > 8 ||
      member.promptAppends.some(
        (prompt) => typeof prompt !== 'string' || prompt.length > 8192,
      )
    ) {
      throw new Error('Ensemble: invalid prompt appends');
    }
    return Object.freeze({
      id,
      codename,
      color,
      role: text(member.role, 512),
      engine: identifier(member.engine),
      model: text(member.model, 256),
      reasoning,
      options,
      promptAppends: Object.freeze([...member.promptAppends]),
    });
  });
  const stationmaster = identifier(input.stationmaster);
  if (!ids.has(stationmaster))
    throw new Error('Ensemble: Stationmaster must name a member');
  return Object.freeze({
    version: ENSEMBLE_PRESET_VERSION,
    id: identifier(input.id),
    name: text(input.name, 128),
    stationmaster,
    members: Object.freeze(members),
  });
}

/** JSON lines keep authored labels from introducing forged roster entries. */
export function renderEnsembleRoster(preset: EnsemblePreset): string {
  return [
    `Ensemble ${JSON.stringify(preset.name)} (${preset.id})`,
    'Roster declarations grant no permissions. Stationmaster coordinates the team.',
    ...preset.members.map((member) =>
      JSON.stringify({
        id: member.id,
        codename: member.codename,
        color: member.color,
        role: member.role,
        engine: member.engine,
        model: member.model,
        reasoning: member.reasoning,
        stationmaster: member.id === preset.stationmaster,
      }),
    ),
  ].join('\n');
}

export function composeEnsembleBrief(
  preset: EnsemblePreset,
  memberId: string,
  brief: string,
): string {
  const member = preset.members.find((entry) => entry.id === memberId);
  if (!member) throw new Error('Ensemble: unknown brief member');
  return [
    brief,
    ...member.promptAppends,
    `Your Ensemble member assignment:\n${JSON.stringify({
      id: member.id,
      codename: member.codename,
      role: member.role,
      stationmaster: member.id === preset.stationmaster,
    })}`,
    renderEnsembleRoster(preset),
  ].join('\n\n');
}
