import { mutateJson } from '@kontourai/station-sdk';

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
}

interface ScaffoldEnvelope {
  success?: boolean;
  error?: string;
  entries?: string[];
  entryCount?: number;
  data?: PluginScaffoldResult;
}

/**
 * The server's refusal, worded for the person. A non-empty folder names what
 * is in it, because "not empty" alone sends them hunting for hidden files.
 */
function refusalMessage(envelope: ScaffoldEnvelope, status: number): string {
  const base =
    envelope.error || `Station could not scaffold the plugin (${status})`;
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
