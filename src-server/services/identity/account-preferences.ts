import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  AccountPreferencesPatch,
  AccountPreferencesView,
} from '@kontourai/station-contracts/account-preferences';
import { COLOR_THEME_ID_PATTERN } from '@kontourai/station-contracts/device-settings';
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
  diffStyle: z.enum(['unified', 'split']),
  diffWrap: z.boolean(),
  chatShowReasoning: z.boolean(),
  chatShowToolDetails: z.boolean(),
  chatFontSize: z.number().int().min(10).max(24).nullable(),
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
 * The color-theme ids live in a sibling file a server from before them never
 * opens: that server parses its document strictly, so one unknown key there
 * would fail every account preference after a downgrade or with a shared
 * home (docs/guides/release-rings.md, release-channel-ports.md).
 */
const APPEARANCE_KEYS = [
  'colorTheme',
  'colorThemeFlavor',
  'colorThemeAccent',
] as const;
type AppearanceKey = (typeof APPEARANCE_KEYS)[number];
const isAppearanceKey = (key: string): key is AppearanceKey =>
  (APPEARANCE_KEYS as readonly string[]).includes(key);
const { colorTheme, colorThemeFlavor, colorThemeAccent, ...mainFields } =
  fields;
const appearanceFields = { colorTheme, colorThemeFlavor, colorThemeAccent };
/**
 * Known keys are validated; unknown ones (written by a newer server) pass
 * through so a write here keeps them, and `read` leaves them out of the view.
 * The patch schema stays strict: a key this server cannot validate is
 * refused, not silently dropped.
 */
const storedDocument = (shape: z.ZodRawShape) =>
  z
    .object({
      schemaVersion: z.literal(1),
      values: z.object(shape).partial().passthrough(),
    })
    .strict();
const mainDocument = storedDocument(mainFields);
const appearanceDocument = storedDocument(appearanceFields);
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
    diffStyle: fields.diffStyle.nullable().optional(),
    diffWrap: fields.diffWrap.nullable().optional(),
    chatShowReasoning: fields.chatShowReasoning.nullable().optional(),
    chatShowToolDetails: fields.chatShowToolDetails.nullable().optional(),
    chatFontSize: fields.chatFontSize.nullable().optional(),
    chatDockAutoHide: fields.chatDockAutoHide.nullable().optional(),
    confirmConversationDelete: fields.confirmConversationDelete
      .nullable()
      .optional(),
    developerToolsEnabled: fields.developerToolsEnabled.nullable().optional(),
    modelPickerPreferences: fields.modelPickerPreferences.nullable().optional(),
    smoothReveal: fields.smoothReveal.nullable().optional(),
    bufferedDelivery: fields.bufferedDelivery.nullable().optional(),
    interactiveApprovalModes: z
      .object({
        codex: mode.nullable().optional(),
        claude: mode.nullable().optional(),
        muse: mode.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const limits = { maxBytes: 128 * 1024, label: 'account preferences' };
export class InvalidAccountPreferencesError extends Error {}
export class AccountPreferencesConflictError extends Error {}
function withRevision(
  document: AccountPreferencesView,
): AccountPreferencesView {
  return {
    ...document,
    revision: createHash('sha256')
      .update(JSON.stringify(document.values.modelPickerPreferences ?? null))
      .digest('hex'),
  };
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
      for (const engine of ['codex', 'claude', 'muse'] as const) {
        const pick = (value as Record<string, unknown>)[engine];
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

  private view(main: StoredValues, appearance: StoredValues) {
    return withRevision({
      schemaVersion: 1,
      values: {
        ...known(main, MAIN_KEYS),
        ...known(appearance, APPEARANCE_KEYS),
      } as AccountPreferencesView['values'],
    });
  }

  read(owner: Owner): AccountPreferencesView {
    const main = mainDocument.parse(
      readJsonFile(this.path(owner), EMPTY, limits),
    );
    const appearance = appearanceDocument.parse(
      readJsonFile(this.appearancePath(owner), EMPTY, limits),
    );
    return this.view(main.values, appearance.values);
  }

  async patch(
    owner: Owner,
    input: unknown,
    onlyMissing = false,
    expectedRevision?: string,
  ): Promise<AccountPreferencesView> {
    const parsed = patchSchema.safeParse(input);
    if (!parsed.success) throw new InvalidAccountPreferencesError();
    const patch: AccountPreferencesPatch = parsed.data;
    const mainPatch: Record<string, unknown> = {};
    const appearancePatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch))
      (isAppearanceKey(key) ? appearancePatch : mainPatch)[key] = value;
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
                expectedRevision !== this.view(current.values, {}).revision
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
    return this.view(main.values, appearance.values);
  }
}
