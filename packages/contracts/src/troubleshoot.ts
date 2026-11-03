/**
 * In-app troubleshooting: the prepare route's request and response, and the
 * `troubleshoot-report.yml` issue form's prefilled-URL builder.
 *
 * The URL builder never truncates. A field that does not fit within
 * {@link MAX_TROUBLESHOOT_ISSUE_URL_LENGTH} is returned whole in `overflow`
 * so the person can paste it into the form by hand.
 */

export const TROUBLESHOOT_PREPARE_PATH =
  '/api/diagnostics/troubleshoot/prepare';

/** The CLI fallback when the app itself is not usable. */
export const TROUBLESHOOT_CLI_COMMAND = 'station triage';

export const TROUBLESHOOT_SURFACES = [
  'desktop',
  'web',
  'mobile',
  'unknown',
] as const;
export type TroubleshootSurface = (typeof TROUBLESHOOT_SURFACES)[number];

export interface TroubleshootPrepareRequest {
  /** Where the person is looking at Station from. Display-only. */
  readonly surface?: TroubleshootSurface;
  /** Optional error context, for entry points that start from an error. */
  readonly seed?: {
    readonly route?: string;
    readonly errorSummary?: string;
  };
}

export interface TroubleshootPrepareResponse {
  readonly runId: string;
  /** The reserved Station Assistant id the conversation must run on. */
  readonly agentId: 'station';
  /** Model-facing seed sent out of band with the first message. */
  readonly ambientContext: string;
  /** Visible first message when the person leaves the description empty. */
  readonly openingMessage: string;
  readonly display: {
    readonly stationName: string;
    readonly version: string;
    readonly channel: string;
    readonly sourceRevision: string | null;
    readonly platform: string;
    readonly surface: TroubleshootSurface;
    readonly role: 'owner' | 'member';
    readonly serverLogs: 'available' | 'unavailable';
  };
  readonly cliCommand: typeof TROUBLESHOOT_CLI_COMMAND;
}

// ── issue form ─────────────────────────────────────────────────────────────

export const TROUBLESHOOT_REPORT_REPOSITORY = 'kontourai/station';
export const TROUBLESHOOT_REPORT_TEMPLATE = 'troubleshoot-report.yml';
export const TROUBLESHOOT_REPORT_LABEL = 'reported:troubleshoot';
/** Matches the browser-safe ceiling Report a problem uses for GitHub links. */
export const MAX_TROUBLESHOOT_ISSUE_URL_LENGTH = 7_900;
export const MAX_TROUBLESHOOT_REPORT_TITLE_LENGTH = 200;
export const MAX_TROUBLESHOOT_REPORT_FIELD_LENGTH = 20_000;

/**
 * The form's field ids, in the order they are added to the link. The large,
 * least essential diagnostic text goes last so it is the first to overflow.
 */
export const TROUBLESHOOT_REPORT_FIELD_IDS = [
  'user-impact',
  'observed-behavior',
  'diagnosis',
  'build-identity',
  'environment-details',
  'prior-issue',
  'remedy-applied',
  'diagnosed-by',
  'redacted-diagnostic',
] as const;
export type TroubleshootReportFieldId =
  (typeof TROUBLESHOOT_REPORT_FIELD_IDS)[number];

export type TroubleshootReportFields = Partial<
  Record<TroubleshootReportFieldId, string>
>;

export interface TroubleshootIssueFormLink {
  readonly url: string;
  readonly included: readonly TroubleshootReportFieldId[];
  /** Fields left out of the link, whole, for the person to paste. */
  readonly overflow: ReadonlyArray<{
    readonly id: TroubleshootReportFieldId;
    readonly value: string;
  }>;
}

export class TroubleshootReportBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TroubleshootReportBoundsError';
  }
}

/**
 * Builds the prefilled `troubleshoot-report.yml` link. The caller redacts the
 * values first. A title or field over its limit is refused, not shortened.
 */
export function buildTroubleshootIssueFormUrl(input: {
  readonly title: string;
  readonly fields: TroubleshootReportFields;
}): TroubleshootIssueFormLink {
  const title = input.title.trim();
  if (!title || title.length > MAX_TROUBLESHOOT_REPORT_TITLE_LENGTH)
    throw new TroubleshootReportBoundsError(
      `Report title must be 1 to ${MAX_TROUBLESHOOT_REPORT_TITLE_LENGTH} characters.`,
    );
  for (const id of Object.keys(input.fields)) {
    if (!(TROUBLESHOOT_REPORT_FIELD_IDS as readonly string[]).includes(id))
      throw new TroubleshootReportBoundsError(`Unknown report field: ${id}.`);
  }
  const url = new URL(
    `https://github.com/${TROUBLESHOOT_REPORT_REPOSITORY}/issues/new`,
  );
  url.searchParams.set('template', TROUBLESHOOT_REPORT_TEMPLATE);
  url.searchParams.set('title', title);
  if (url.toString().length > MAX_TROUBLESHOOT_ISSUE_URL_LENGTH)
    throw new TroubleshootReportBoundsError(
      'Report title does not fit in an issue link.',
    );
  const included: TroubleshootReportFieldId[] = [];
  const overflow: Array<{ id: TroubleshootReportFieldId; value: string }> = [];
  for (const id of TROUBLESHOOT_REPORT_FIELD_IDS) {
    const value = input.fields[id];
    if (value === undefined || !value.trim()) continue;
    if (value.length > MAX_TROUBLESHOOT_REPORT_FIELD_LENGTH)
      throw new TroubleshootReportBoundsError(
        `Report field ${id} exceeds ${MAX_TROUBLESHOOT_REPORT_FIELD_LENGTH} characters.`,
      );
    url.searchParams.set(id, value);
    if (url.toString().length > MAX_TROUBLESHOOT_ISSUE_URL_LENGTH) {
      url.searchParams.delete(id);
      overflow.push({ id, value });
    } else {
      included.push(id);
    }
  }
  return { url: url.toString(), included, overflow };
}
