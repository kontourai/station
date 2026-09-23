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
  entryCount?: number;
  presentCount?: number;
  missingCount?: number;
  data?: PluginScaffoldResult;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The server's refusal, worded for the person. The server reports what is in
 * the folder only as counts (a member may call it, and the folder is not
 * theirs to list), so this says how much is there, not what.
 */
function refusalMessage(envelope: ScaffoldEnvelope, status: number): string {
  const base =
    envelope.error || `Station could not scaffold the plugin (${status})`;
  if (envelope.presentCount !== undefined) {
    return `${base}. ${plural(envelope.presentCount, 'file')} of this plugin ${envelope.presentCount === 1 ? 'is' : 'are'} already there.`;
  }
  if (envelope.entryCount) {
    return `${base}. It holds ${plural(envelope.entryCount, 'item')}.`;
  }
  return base;
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
