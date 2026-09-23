import { getJson, mutateJson } from '@kontourai/station-sdk';

export type PluginScaffoldTemplateChoice = 'pane' | 'full' | 'provider';

export interface PluginScaffoldRequest {
  name: string;
  template: PluginScaffoldTemplateChoice;
  displayName?: string;
}

export interface PluginScaffoldResult {
  name: string;
  template: PluginScaffoldTemplateChoice;
  displayName: string;
  /** Paths relative to the Project folder. */
  files: string[];
  /** The folder already held exactly this scaffold; nothing was written. */
  alreadyPresent?: boolean;
}

interface ScaffoldEnvelope {
  success?: boolean;
  error?: string;
  code?: string;
  entries?: string[];
  entryCount?: number;
  present?: string[];
  data?: PluginScaffoldResult;
}

/**
 * The server's refusal, worded for the person. A non-empty folder names what
 * is in it, because "not empty" alone sends them hunting for hidden files.
 */
function refusalMessage(envelope: ScaffoldEnvelope, status: number): string {
  const base =
    envelope.error || `Station could not scaffold the plugin (${status})`;
  if (envelope.present?.length) {
    return `${base}. Already there: ${envelope.present.join(', ')}.`;
  }
  if (!envelope.entries?.length) return base;
  const more =
    (envelope.entryCount ?? envelope.entries.length) - envelope.entries.length;
  return `${base}. It contains: ${envelope.entries.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

/** `POST /api/projects/:slug/plugin-scaffold`. Throws with the server's reason. */
export async function scaffoldProjectPlugin(
  apiBase: string,
  projectSlug: string,
  request: PluginScaffoldRequest,
): Promise<PluginScaffoldResult> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/plugin-scaffold`,
    'POST',
    undefined,
    request,
  );
  let envelope: ScaffoldEnvelope = {};
  try {
    envelope = (await response.json()) as ScaffoldEnvelope;
  } catch {
    // An unreadable body still has a status to report below.
  }
  if (!response.ok || !envelope.success || !envelope.data) {
    throw new Error(refusalMessage(envelope, response.status));
  }
  return envelope.data;
}

export type PluginScaffoldEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * `GET /api/projects/:slug/plugin-scaffold`: whether a plugin could be
 * scaffolded into this Project's folder now. Read-only.
 */
export async function fetchPluginScaffoldEligibility(
  apiBase: string,
  projectSlug: string,
): Promise<PluginScaffoldEligibility> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/plugin-scaffold`,
  );
  const envelope = (await response.json()) as {
    success?: boolean;
    error?: string;
    data?: PluginScaffoldEligibility;
  };
  if (!response.ok || !envelope.success || !envelope.data) {
    throw new Error(
      envelope.error ||
        `Station could not check this folder (${response.status})`,
    );
  }
  return envelope.data;
}
