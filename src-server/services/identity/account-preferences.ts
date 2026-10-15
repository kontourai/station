import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  AccountPreferencesPatch,
  AccountPreferencesView,
} from '@kontourai/station-contracts/account-preferences';
import {
  mutateJsonFile,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { z } from 'zod/v3';

const list = z.array(z.string().min(1).max(1024)).max(512);
const mode = z.enum(['ask', 'auto', 'never']);
const fields = {
  theme: z.enum(['light', 'dark']),
  accentColor: z.string().max(128).nullable(),
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
const valuesSchema = z.object(fields).partial().strict();
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    values: valuesSchema,
  })
  .strict();
const patchSchema = z
  .object({
    theme: fields.theme.nullable().optional(),
    accentColor: fields.accentColor.nullable().optional(),
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

export class AccountPreferencesStore {
  constructor(private readonly home: string) {}

  private path(owner: { principalId: string; tenantId?: string }): string {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          'account-preferences-v1',
          owner.tenantId ?? null,
          owner.principalId,
        ]),
      )
      .digest('hex');
    return join(this.home, 'config', 'account-preferences', `${key}.json`);
  }

  read(owner: {
    principalId: string;
    tenantId?: string;
  }): AccountPreferencesView {
    return withRevision(
      documentSchema.parse(
        readJsonFile(
          this.path(owner),
          { schemaVersion: 1, values: {} },
          limits,
        ),
      ),
    );
  }

  async patch(
    owner: { principalId: string; tenantId?: string },
    input: unknown,
    onlyMissing = false,
    expectedRevision?: string,
  ): Promise<AccountPreferencesView> {
    const parsed = patchSchema.safeParse(input);
    if (!parsed.success) throw new InvalidAccountPreferencesError();
    const patch: AccountPreferencesPatch = parsed.data;
    const saved = await mutateJsonFile(
      this.path(owner),
      { schemaVersion: 1, values: {} } as AccountPreferencesView,
      (raw) => {
        const current = documentSchema.parse(raw);
        if (
          !onlyMissing &&
          Object.hasOwn(patch, 'modelPickerPreferences') &&
          expectedRevision !== withRevision(current).revision
        )
          throw new AccountPreferencesConflictError();
        const values = { ...current.values };
        for (const key of Object.keys(
          patch,
        ) as (keyof AccountPreferencesPatch)[]) {
          if (onlyMissing && Object.hasOwn(current.values, key)) continue;
          if (patch[key] === null) delete values[key];
          else if (
            key === 'interactiveApprovalModes' &&
            patch.interactiveApprovalModes
          ) {
            const modes = { ...values.interactiveApprovalModes };
            for (const engine of ['codex', 'claude', 'muse'] as const) {
              const pick = patch.interactiveApprovalModes[engine];
              if (pick === null) delete modes[engine];
              else if (pick !== undefined) modes[engine] = pick;
            }
            values.interactiveApprovalModes = modes;
          } else Object.assign(values, { [key]: patch[key] });
        }
        return documentSchema.parse({ schemaVersion: 1, values });
      },
      limits,
    );
    return withRevision(saved);
  }
}
