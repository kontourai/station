import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  type AccountPreferencesPatch,
  type AccountPreferencesView,
  ADDITIONAL_INTERACTIVE_APPROVAL_ENGINES,
  LEGACY_INTERACTIVE_APPROVAL_ENGINES,
} from '@kontourai/station-contracts/account-preferences';
import {
  COLOR_THEME_ID_PATTERN,
  DENSITY_PREFERENCES,
  MOTION_PREFERENCES,
} from '@kontourai/station-contracts/device-settings';
import {
  mutateJsonFile,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { z } from 'zod/v3';

const list = z.array(z.string().min(1).max(1024)).max(512);
const mode = z.enum(['ask', 'auto', 'never']);
/**
 * Color-theme family, flavor and accent ids are parsed as ids, not checked
 * against today's catalog: the catalog lives in the UI, and a client newer
 * than this server may name a family this server has never heard of. The UI
 * resolves an unknown id to its default (`resolveColorThemeSelection`), so
 * storing it is harmless, and refusing it would fail the whole patch.
 */
const colorThemeId = z.string().regex(new RegExp(COLOR_THEME_ID_PATTERN));
const fields = {
  theme: z.enum(['light', 'dark']),
  accentColor: z.string().max(128).nullable(),
  colorTheme: colorThemeId,
  colorThemeFlavor: colorThemeId.nullable(),
  colorThemeAccent: colorThemeId.nullable(),
  density: z.enum(DENSITY_PREFERENCES),
  motion: z.enum(MOTION_PREFERENCES),
  diffStyle: z.enum(['unified', 'split']),
  diffWrap: z.boolean(),
  chatShowReasoning: z.boolean(),
  chatShowToolDetails: z.boolean(),
  chatFontSize: z.number().int().min(10).max(24).nullable(),
  chatAnswerWidth: z.enum(['comfortable', 'wide', 'full']),
  chatDockAutoHide: z.boolean(),
  confirmConversationDelete: z.boolean(),
  developerToolsEnabled: z.boolean(),
  modelPickerPreferences: z
    .object({
      favorites: list,
      recents: list,
      hidden: list,
      order: list,
    })
    .strict(),
  smoothReveal: z.boolean(),
  bufferedDelivery: z.boolean(),
  interactiveApprovalModes: z
    .object({
      codex: mode.optional(),
      claude: mode.optional(),
      muse: mode.optional(),
    })
    .strict(),
};
/**
 * The color-theme ids, density and motion live in a sibling file a server from
 * before color themes never opens: that server parses its document strictly,
 * so one unknown key there would fail every account preference after a
 * downgrade or with a shared home (docs/guides/release-rings.md,
 * release-channel-ports.md). A server that knows the sibling but not density
 * or motion keeps them (its values pass through) and leaves them out of its
 * view.
 */
const APPEARANCE_KEYS = [
  'colorTheme',
  'colorThemeFlavor',
  'colorThemeAccent',
  'density',
  'motion',
] as const;
type AppearanceKey = (typeof APPEARANCE_KEYS)[number];
const isAppearanceKey = (key: string): key is AppearanceKey =>
  (APPEARANCE_KEYS as readonly string[]).includes(key);
const {
  colorTheme,
  colorThemeFlavor,
  colorThemeAccent,
  density,
  motion,
  ...mainFields
} = fields;
const appearanceFields = {
  colorTheme,
  colorThemeFlavor,
  colorThemeAccent,
  density,
  motion,
};
/**
 * Known keys are validated; unknown ones (written by a newer server) pass
 * through so a write here keeps them, and `read` leaves them out of the view.
 * The patch schema stays strict: a key this server cannot validate is
 * refused, not silently dropped.
 */
const storedDocument = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z
    .object({
      schemaVersion: z.literal(1),
      values: z.object(shape).partial().passthrough(),
    })
    .strict();
const mainDocument = storedDocument(mainFields);
const appearanceDocument = storedDocument(appearanceFields);
// Older servers validate the engine keys in the main file strictly.
const approvalDocument = storedDocument({
  interactiveApprovalDefault: mode,
  interactiveApprovalModes: z
    .object({
      opencode: mode.optional(),
      acp: mode.optional(),
      antigravity: mode.optional(),
    })
    .passthrough(),
});
// Pre-color-theme servers parse the main file strictly. Keep send mode in a
// sibling they never open. Queue is represented by the absence of Steer.
const chatDocument = storedDocument({
  chatDefaultSendMode: z.literal('steer'),
});
type StoredValues = Record<string, unknown>;
function known(
  values: StoredValues,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => keys.includes(key)),
  );
}
const MAIN_KEYS = Object.keys(mainFields);
const patchSchema = z
  .object({
    theme: fields.theme.nullable().optional(),
    accentColor: fields.accentColor.nullable().optional(),
    colorTheme: fields.colorTheme.nullable().optional(),
    colorThemeFlavor: fields.colorThemeFlavor.nullable().optional(),
    colorThemeAccent: fields.colorThemeAccent.nullable().optional(),
    density: fields.density.nullable().optional(),
    motion: fields.motion.nullable().optional(),
    diffStyle: fields.diffStyle.nullable().optional(),
    diffWrap: fields.diffWrap.nullable().optional(),
    chatShowReasoning: fields.chatShowReasoning.nullable().optional(),
    chatShowToolDetails: fields.chatShowToolDetails.nullable().optional(),
    chatFontSize: fields.chatFontSize.nullable().optional(),
    chatAnswerWidth: fields.chatAnswerWidth.nullable().optional(),
    chatDockAutoHide: fields.chatDockAutoHide.nullable().optional(),
    chatDefaultSendMode: z.enum(['queue', 'steer']).nullable().optional(),
    confirmConversationDelete: fields.confirmConversationDelete
      .nullable()
      .optional(),
    developerToolsEnabled: fields.developerToolsEnabled.nullable().optional(),
    modelPickerPreferences: fields.modelPickerPreferences.nullable().optional(),
    smoothReveal: fields.smoothReveal.nullable().optional(),
    bufferedDelivery: fields.bufferedDelivery.nullable().optional(),
    interactiveApprovalDefault: mode.nullable().optional(),
    interactiveApprovalModes: z
      .object({
        codex: mode.nullable().optional(),
        claude: mode.nullable().optional(),
        muse: mode.nullable().optional(),
        opencode: mode.nullable().optional(),
        acp: mode.nullable().optional(),
        antigravity: mode.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const limits = { maxBytes: 128 * 1024, label: 'account preferences' };
export class InvalidAccountPreferencesError extends Error {}
export class AccountPreferencesConflictError extends Error {}
function preferenceRevision(modelPickerPreferences: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(modelPickerPreferences ?? null))
    .digest('hex');
}

function applyPatch(
  current: StoredValues,
  patch: Record<string, unknown>,
  onlyMissing: boolean,
): StoredValues {
  const values: StoredValues = { ...current };
  for (const key of Object.keys(patch)) {
    if (onlyMissing && Object.hasOwn(current, key)) continue;
    const value = patch[key];
    if (value === null) delete values[key];
    else if (key === 'interactiveApprovalModes' && value) {
      const modes = {
        ...(values.interactiveApprovalModes as Record<string, unknown>),
      };
      for (const [engine, pick] of Object.entries(value)) {
        if (pick === null) delete modes[engine];
        else if (pick !== undefined) modes[engine] = pick;
      }
      values.interactiveApprovalModes = modes;
    } else values[key] = value;
  }
  return values;
}

type Owner = { principalId: string; tenantId?: string };
const EMPTY = { schemaVersion: 1 as const, values: {} };

export class AccountPreferencesStore {
  constructor(private readonly home: string) {}

  private path(owner: Owner, suffix = ''): string {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          'account-preferences-v1',
          owner.tenantId ?? null,
          owner.principalId,
        ]),
      )
      .digest('hex');
    return join(
      this.home,
      'config',
      'account-preferences',
      `${key}${suffix}.json`,
    );
  }

  private appearancePath(owner: Owner): string {
    return this.path(owner, '.appearance');
  }

  private view(
    main: z.infer<typeof mainDocument>['values'],
    appearance: StoredValues,
    approval: z.infer<typeof approvalDocument>['values'],
    chat: StoredValues,
  ) {
    const modes = approval.interactiveApprovalModes;
    const additionalModes = modes
      ? known(modes, ADDITIONAL_INTERACTIVE_APPROVAL_ENGINES)
      : undefined;
    return {
      schemaVersion: 1,
      revision: preferenceRevision(main.modelPickerPreferences),
      values: {
        ...known(main, MAIN_KEYS),
        ...known(appearance, APPEARANCE_KEYS),
        ...known(approval, ['interactiveApprovalDefault']),
        ...(additionalModes && Object.keys(additionalModes).length > 0
          ? {
              interactiveApprovalModes: {
                ...main.interactiveApprovalModes,
                ...additionalModes,
              },
            }
          : {}),
        ...known(chat, ['chatDefaultSendMode']),
      } as AccountPreferencesView['values'],
    } satisfies AccountPreferencesView;
  }

  read(owner: Owner): AccountPreferencesView {
    const main = mainDocument.parse(
      readJsonFile(this.path(owner), EMPTY, limits),
    );
    const appearance = appearanceDocument.parse(
      readJsonFile(this.appearancePath(owner), EMPTY, limits),
    );
    const approval = approvalDocument.parse(
      readJsonFile(this.path(owner, '.approval'), EMPTY, limits),
    );
    const chat = this.readChat(owner);
    return this.view(
      main.values,
      appearance.values,
      approval.values,
      chat.values,
    );
  }

  private readChat(owner: Owner) {
    return chatDocument.parse(
      readJsonFile(this.path(owner, '.chat'), EMPTY, limits),
    );
  }

  async patch(
    owner: Owner,
    input: unknown,
    onlyMissing = false,
    expectedRevision?: string,
  ): Promise<AccountPreferencesView> {
    const parsed = patchSchema.safeParse(input);
    if (!parsed.success) throw new InvalidAccountPreferencesError();
    const { chatDefaultSendMode, ...patch }: AccountPreferencesPatch =
      parsed.data;
    const mainPatch: Record<string, unknown> = {};
    const appearancePatch: Record<string, unknown> = {};
    const approvalPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'interactiveApprovalDefault') approvalPatch[key] = value;
      else if (key !== 'interactiveApprovalModes')
        (isAppearanceKey(key) ? appearancePatch : mainPatch)[key] = value;
    }
    const modes = patch.interactiveApprovalModes;
    if (modes === null) {
      mainPatch.interactiveApprovalModes = null;
      approvalPatch.interactiveApprovalModes = Object.fromEntries(
        ADDITIONAL_INTERACTIVE_APPROVAL_ENGINES.map((engine) => [engine, null]),
      );
    } else if (modes) {
      const legacy = known(modes, LEGACY_INTERACTIVE_APPROVAL_ENGINES);
      const additional = known(modes, ADDITIONAL_INTERACTIVE_APPROVAL_ENGINES);
      if (Object.keys(legacy).length > 0 || Object.keys(modes).length === 0)
        mainPatch.interactiveApprovalModes = legacy;
      if (Object.keys(additional).length > 0)
        approvalPatch.interactiveApprovalModes = additional;
    }
    // Each document is mutated under its own lock, and only when the patch
    // names one of its keys; a read-only side is read, never rewritten.
    const main =
      Object.keys(mainPatch).length === 0
        ? mainDocument.parse(readJsonFile(this.path(owner), EMPTY, limits))
        : await mutateJsonFile(
            this.path(owner),
            EMPTY as { schemaVersion: 1; values: StoredValues },
            (raw) => {
              const current = mainDocument.parse(raw);
              if (
                !onlyMissing &&
                Object.hasOwn(mainPatch, 'modelPickerPreferences') &&
                expectedRevision !==
                  preferenceRevision(current.values.modelPickerPreferences)
              )
                throw new AccountPreferencesConflictError();
              return mainDocument.parse({
                schemaVersion: 1,
                values: applyPatch(current.values, mainPatch, onlyMissing),
              });
            },
            limits,
          );
    const appearance =
      Object.keys(appearancePatch).length === 0
        ? appearanceDocument.parse(
            readJsonFile(this.appearancePath(owner), EMPTY, limits),
          )
        : await mutateJsonFile(
            this.appearancePath(owner),
            EMPTY as { schemaVersion: 1; values: StoredValues },
            (raw) => {
              const current = appearanceDocument.parse(raw);
              return appearanceDocument.parse({
                schemaVersion: 1,
                values: applyPatch(
                  current.values,
                  appearancePatch,
                  onlyMissing,
                ),
              });
            },
            limits,
          );
    const approvalPath = this.path(owner, '.approval');
    const approval =
      Object.keys(approvalPatch).length === 0
        ? approvalDocument.parse(readJsonFile(approvalPath, EMPTY, limits))
        : await mutateJsonFile(
            approvalPath,
            EMPTY as { schemaVersion: 1; values: StoredValues },
            (raw) =>
              approvalDocument.parse({
                schemaVersion: 1,
                values: applyPatch(
                  approvalDocument.parse(raw).values,
                  approvalPatch,
                  onlyMissing,
                ),
              }),
            limits,
          );
    const chat =
      chatDefaultSendMode === undefined
        ? this.readChat(owner)
        : await mutateJsonFile(
            this.path(owner, '.chat'),
            EMPTY as { schemaVersion: 1; values: StoredValues },
            (raw) =>
              chatDocument.parse({
                schemaVersion: 1,
                values: applyPatch(
                  chatDocument.parse(raw).values,
                  {
                    chatDefaultSendMode:
                      chatDefaultSendMode === 'steer' ? 'steer' : null,
                  },
                  onlyMissing,
                ),
              }),
            limits,
          );
    return this.view(
      main.values,
      appearance.values,
      approval.values,
      chat.values,
    );
  }
}
