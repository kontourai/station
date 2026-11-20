/**
 * The per-person custom appearance document (docs/decisions/custom-appearance.md).
 *
 * One file per owner under `config/custom-appearance/`, keyed like account
 * preferences (a digest of tenant and principal) and written under the same
 * per-file mutation lock and atomic publish. It is its own document, not an
 * account-preferences key: that document carries old-server compatibility
 * rules this one does not need, and its patch path has no compare-and-set.
 *
 * `revision` covers `active` and `proposal` only. A render report is the
 * person's browser describing a proposal, so posting one must not invalidate
 * the revision that same browser is about to Keep with.
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  appearanceContrastViolations,
  CUSTOM_APPEARANCE_LIBRARY_MAX_ENTRIES,
  type CustomAppearance,
  type CustomAppearanceDocument,
  type CustomAppearanceLibraryDocument,
  type CustomAppearanceLibraryEntry,
  type CustomAppearanceLibrarySaveInput,
  type CustomAppearanceLibraryUpdateInput,
  type CustomAppearanceProposal,
  type CustomAppearanceRenderReport,
  type CustomAppearanceViolation,
  parseCustomAppearance,
} from '@kontourai/station-contracts/custom-appearance';
import {
  mutateJsonFile,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { contrastRatio } from '@kontourai/ui/contrast';

export class CustomAppearanceGrantExpiredError extends Error {
  constructor() {
    super('The delegated appearance proposal grant expired.');
  }
}

export class CustomAppearanceConflictError extends Error {
  constructor() {
    super('This appearance changed. Read it again before proposing or saving.');
  }
}
export class InvalidCustomAppearanceError extends Error {
  constructor(readonly violations: CustomAppearanceViolation[]) {
    super(violations.map((v) => v.message).join(' '));
  }
}
export class CustomAppearanceTooLargeError extends Error {
  constructor() {
    super('This appearance document is too large to store.');
  }
}
export class CustomAppearanceStudioDisabledError extends Error {
  constructor() {
    super('Enable Appearance Studio in Feature Previews to use this feature.');
  }
}
export class CustomAppearanceLibraryFullError extends Error {
  constructor() {
    super(
      `Save at most ${CUSTOM_APPEARANCE_LIBRARY_MAX_ENTRIES} themes. Remove one before saving another.`,
    );
  }
}
export class CustomAppearanceThemeNotFoundError extends Error {
  constructor() {
    super('This saved theme no longer exists.');
  }
}
export class StaleRenderReportError extends Error {
  constructor() {
    super('That proposal is no longer pending.');
  }
}

interface StoredDocument {
  schemaVersion: 1;
  themes: CustomAppearanceLibraryEntry[];
  active: CustomAppearance | null;
  proposal: CustomAppearanceProposal | null;
  renderReport: CustomAppearanceRenderReport | null;
}
const EMPTY: StoredDocument = {
  schemaVersion: 1,
  themes: [],
  active: null,
  proposal: null,
  renderReport: null,
};
/** Total bound includes the saved library and embedded raster images. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

type Owner = { principalId: string; tenantId?: string };

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Parse, then rate the proposal's own pairs: an agent hears why at once. */
function admitCustomAppearance(input: unknown): CustomAppearance {
  const parsed = parseCustomAppearance(input);
  if (!parsed.ok) throw new InvalidCustomAppearanceError(parsed.violations);
  const contrast = appearanceContrastViolations(parsed.value, contrastRatio);
  if (contrast.length > 0) throw new InvalidCustomAppearanceError(contrast);
  return parsed.value;
}

/** A stored document re-read through the same checks; anything else reads as empty. */
function storedDocument(raw: unknown): StoredDocument {
  if (typeof raw !== 'object' || raw === null) return EMPTY;
  const record = raw as Partial<StoredDocument>;
  if (record.schemaVersion !== 1) return EMPTY;
  const parse = (value: unknown): CustomAppearance | null => {
    const parsed = value ? parseCustomAppearance(value) : null;
    return parsed?.ok ? parsed.value : null;
  };
  const proposed = parse(record.proposal?.appearance);
  const themes: CustomAppearanceLibraryEntry[] = [];
  if (Array.isArray(record.themes))
    for (const entry of record.themes.slice(
      0,
      CUSTOM_APPEARANCE_LIBRARY_MAX_ENTRIES,
    )) {
      if (!entry || typeof entry !== 'object') continue;
      const appearance = parse(entry.appearance);
      if (
        !appearance ||
        entry.id !== digest(['theme', appearance]) ||
        entry.name !== appearance.name ||
        typeof entry.favorite !== 'boolean' ||
        typeof entry.createdAt !== 'string' ||
        typeof entry.updatedAt !== 'string' ||
        themes.some((theme) => theme.id === entry.id)
      )
        continue;
      themes.push({
        id: entry.id,
        name: appearance.name,
        appearance,
        favorite: entry.favorite,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
  return {
    schemaVersion: 1,
    themes,
    active: parse(record.active),
    proposal:
      record.proposal && proposed
        ? { ...record.proposal, appearance: proposed }
        : null,
    renderReport:
      record.renderReport &&
      record.proposal &&
      record.renderReport.proposalId === record.proposal.id
        ? record.renderReport
        : null,
  };
}

function view(document: StoredDocument): CustomAppearanceDocument {
  return {
    revision: digest([document.active, document.proposal]),
    active: document.active,
    proposal: document.proposal,
    renderReport: document.renderReport,
  };
}

export class CustomAppearanceStore {
  private readonly limits: { maxBytes: number; label: string };

  constructor(
    private readonly home: string,
    private readonly now: () => string = () => new Date().toISOString(),
    /** Overridable so a test can fill the document without 512 KiB of CSS. */
    maxBytes = DEFAULT_MAX_BYTES,
  ) {
    this.limits = { maxBytes, label: 'custom appearance' };
  }

  private key(owner: Owner): string {
    return digest([
      'custom-appearance-v1',
      owner.tenantId ?? null,
      owner.principalId,
    ]);
  }

  private path(owner: Owner): string {
    return join(
      this.home,
      'config',
      'custom-appearance',
      `${this.key(owner)}.json`,
    );
  }

  read(owner: Owner): CustomAppearanceDocument {
    return view(
      storedDocument(readJsonFile(this.path(owner), EMPTY, this.limits)),
    );
  }

  private async change(
    owner: Owner,
    expected: string | null,
    update: (current: StoredDocument) => StoredDocument,
    assertCurrent?: () => void,
  ): Promise<CustomAppearanceDocument> {
    const next = await mutateJsonFile<unknown>(
      this.path(owner),
      EMPTY,
      (raw) => {
        const current = storedDocument(raw);
        if (expected !== null && view(current).revision !== expected)
          throw new CustomAppearanceConflictError();
        const next = update(current);
        // The same serialization the publish uses (two-space indent, newline):
        // refuse here with a typed error rather than let the write's own limit
        // surface as an unexpected failure.
        if (
          Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) >
          this.limits.maxBytes
        )
          throw new CustomAppearanceTooLargeError();
        return next;
      },
      { ...this.limits, assertCurrent },
    );
    return view(next as StoredDocument);
  }

  /** An agent's (or anyone's) proposal. Replaces a pending one; clears its report. */
  propose(
    owner: Owner,
    revision: string,
    input: unknown,
    sourceSessionId?: string,
    studioEnabled: () => boolean = () => false,
    grantCurrent?: () => boolean,
  ): Promise<CustomAppearanceDocument> {
    const appearance = admitCustomAppearance(input);
    return this.change(
      owner,
      revision,
      (current) => {
        if (appearance.visual && !studioEnabled())
          throw new CustomAppearanceStudioDisabledError();
        return {
          ...current,
          proposal: {
            id: digest(['proposal', appearance, randomUUID()]),
            appearance,
            proposedAt: this.now(),
            ...(sourceSessionId ? { sourceSessionId } : {}),
          },
          renderReport: null,
        };
      },
      grantCurrent &&
        (() => {
          if (!grantCurrent()) throw new CustomAppearanceGrantExpiredError();
        }),
    );
  }

  /** The person's own save; `null` turns custom appearance off. */
  save(
    owner: Owner,
    revision: string,
    input: unknown,
    studioEnabled: () => boolean = () => false,
  ): Promise<CustomAppearanceDocument> {
    const appearance = input === null ? null : admitCustomAppearance(input);
    return this.change(owner, revision, (current) => {
      if (appearance?.visual && !studioEnabled())
        throw new CustomAppearanceStudioDisabledError();
      return { ...current, active: appearance };
    });
  }

  /** The person keeps the pending proposal named by `proposalId`. */
  keep(
    owner: Owner,
    revision: string,
    proposalId: string,
    studioEnabled: () => boolean = () => false,
  ): Promise<CustomAppearanceDocument> {
    return this.change(owner, revision, (current) => {
      if (!current.proposal || current.proposal.id !== proposalId)
        throw new CustomAppearanceConflictError();
      if (current.proposal.appearance.visual && !studioEnabled())
        throw new CustomAppearanceStudioDisabledError();
      return {
        ...current,
        active: current.proposal.appearance,
        proposal: null,
        renderReport: null,
      };
    });
  }

  dismiss(owner: Owner, revision: string): Promise<CustomAppearanceDocument> {
    return this.change(owner, revision, (current) => ({
      ...current,
      proposal: null,
      renderReport: null,
    }));
  }

  readLibrary(owner: Owner): CustomAppearanceLibraryDocument {
    const current = storedDocument(
      readJsonFile(this.path(owner), EMPTY, this.limits),
    );
    return { revision: digest(current.themes), themes: current.themes };
  }

  private async changeLibrary(
    owner: Owner,
    expected: string,
    enabled: () => boolean,
    update: (
      themes: CustomAppearanceLibraryEntry[],
    ) => CustomAppearanceLibraryEntry[],
  ): Promise<CustomAppearanceLibraryDocument> {
    let themes: CustomAppearanceLibraryEntry[] = [];
    await this.change(owner, null, (current) => {
      if (!enabled()) throw new CustomAppearanceStudioDisabledError();
      if (digest(current.themes) !== expected)
        throw new CustomAppearanceConflictError();
      themes = update(current.themes);
      return { ...current, themes };
    });
    return { revision: digest(themes), themes };
  }

  saveLibraryTheme(
    owner: Owner,
    input: Omit<CustomAppearanceLibrarySaveInput, 'appearance'> & {
      appearance?: unknown;
    },
    enabled: () => boolean = () => false,
  ): Promise<CustomAppearanceLibraryDocument> {
    const appearance = admitCustomAppearance({
      ...(typeof input.appearance === 'object' && input.appearance !== null
        ? input.appearance
        : {}),
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    return this.changeLibrary(owner, input.revision, enabled, (themes) => {
      const previous = input.id
        ? themes.find((theme) => theme.id === input.id)
        : undefined;
      if (input.id && !previous) throw new CustomAppearanceThemeNotFoundError();
      const id = digest(['theme', appearance]);
      const duplicate = themes.find((theme) => theme.id === id);
      const now = this.now();
      const next = themes.filter(
        (theme) => theme.id !== input.id && theme.id !== id,
      );
      if (next.length >= CUSTOM_APPEARANCE_LIBRARY_MAX_ENTRIES)
        throw new CustomAppearanceLibraryFullError();
      return [
        ...next,
        {
          id,
          name: appearance.name,
          appearance,
          favorite:
            input.favorite ??
            previous?.favorite ??
            duplicate?.favorite ??
            false,
          createdAt: previous?.createdAt ?? duplicate?.createdAt ?? now,
          updatedAt: now,
        },
      ];
    });
  }

  updateLibraryTheme(
    owner: Owner,
    input: CustomAppearanceLibraryUpdateInput,
    enabled: () => boolean = () => false,
  ): Promise<CustomAppearanceLibraryDocument> {
    return this.changeLibrary(owner, input.revision, enabled, (themes) => {
      const previous = themes.find((theme) => theme.id === input.id);
      if (!previous) throw new CustomAppearanceThemeNotFoundError();
      const appearance = admitCustomAppearance({
        ...previous.appearance,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
      const id = digest(['theme', appearance]);
      if (id !== input.id && themes.some((theme) => theme.id === id))
        throw new CustomAppearanceConflictError();
      return themes.map((theme) =>
        theme.id === input.id
          ? {
              ...theme,
              id,
              name: appearance.name,
              appearance,
              favorite: input.favorite ?? previous.favorite,
              updatedAt: this.now(),
            }
          : theme,
      );
    });
  }

  removeLibraryTheme(
    owner: Owner,
    revision: string,
    id: string,
    enabled: () => boolean = () => false,
  ): Promise<CustomAppearanceLibraryDocument> {
    return this.changeLibrary(owner, revision, enabled, (themes) => {
      if (!themes.some((theme) => theme.id === id))
        throw new CustomAppearanceThemeNotFoundError();
      return themes.filter((theme) => theme.id !== id);
    });
  }

  /** The person's browser describing a preview of the CURRENT proposal. */
  report(
    owner: Owner,
    report: CustomAppearanceRenderReport,
  ): Promise<CustomAppearanceDocument> {
    return this.change(owner, null, (current) => {
      if (!current.proposal || current.proposal.id !== report.proposalId)
        throw new StaleRenderReportError();
      return {
        ...current,
        renderReport: { ...report, reportedAt: this.now() },
      };
    });
  }
}
