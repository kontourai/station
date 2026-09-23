import { getJson, mutateJson } from '@kontourai/station-sdk';

/** The shapes `/api/projects/:slug/plugin-publish` answers with (epic #2323 S6). */

export interface PluginPublishRemote {
  name: string;
  url: string;
  usable: boolean;
  refusal?: string;
  installSource?: string;
  installSourceDerived?: boolean;
}

export type PluginPublishInspection =
  | { plugin: null; reason: string }
  | {
      plugin: { name: string; version: string };
      repository:
        | { state: 'none' }
        | { state: 'nested' }
        | { state: 'refused'; code: string; keys?: string[] }
        | {
            state: 'root';
            branch: string | null;
            hasCommits: boolean;
            remotes: PluginPublishRemote[];
          };
      changes: Array<{ path: string; status: string }>;
      secrets: Array<{ path: string; reason: string }>;
      tooManyChanges: boolean;
    };

export type PluginPublishSummary =
  | { plugin: null; reason: string }
  | { plugin: { name: string; version: string } };

export interface PluginPublishRequest {
  message: string;
  remoteName: string;
  remoteUrl?: string;
}

export interface PluginPublishResult {
  plugin: { name: string; version: string };
  commit: string | null;
  branch: string;
  remote: { name: string; url: string };
  installSource: string;
  installSourceDerived: boolean;
  installCommand: string;
}

/** A refusal the server explained, with the files it flagged when that
 * was the reason. */
export class PluginPublishError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly secrets: Array<{ path: string; reason: string }> = [],
  ) {
    super(message);
    this.name = 'PluginPublishError';
  }
}

interface Envelope<T> {
  success?: boolean;
  error?: string;
  code?: string;
  secrets?: Array<{ path: string; reason: string }>;
  data?: T;
}

function endpoint(apiBase: string, projectSlug: string): string {
  return `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/plugin-publish`;
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  try {
    return (await response.json()) as Envelope<T>;
  } catch {
    return {};
  }
}

/** `GET ?view=summary`: whether this Project's folder is a plugin. Runs no
 * git on the server. Operator-only, so anyone else gets an error and the
 * Project page offers nothing. */
export async function fetchPluginPublishSummary(
  apiBase: string,
  projectSlug: string,
): Promise<PluginPublishSummary> {
  const response = await getJson(
    `${endpoint(apiBase, projectSlug)}?view=summary`,
  );
  const envelope = await readEnvelope<PluginPublishSummary>(response);
  if (!response.ok || !envelope.success || !envelope.data) {
    throw new PluginPublishError(
      envelope.error ||
        `Station could not inspect this folder (${response.status})`,
      envelope.code,
    );
  }
  return envelope.data;
}

/** `GET`: what publishing this Project's folder would do (git status,
 * remotes, secrets). Asked only once the person opens the dialog. */
export async function fetchPluginPublishInspection(
  apiBase: string,
  projectSlug: string,
): Promise<PluginPublishInspection> {
  const response = await getJson(endpoint(apiBase, projectSlug));
  const envelope = await readEnvelope<PluginPublishInspection>(response);
  if (!response.ok || !envelope.success || !envelope.data) {
    throw new PluginPublishError(
      envelope.error ||
        `Station could not inspect this folder (${response.status})`,
      envelope.code,
    );
  }
  return envelope.data;
}

/** `POST`: commit and push. Throws with the server's reason. */
export async function publishProjectPlugin(
  apiBase: string,
  projectSlug: string,
  request: PluginPublishRequest,
): Promise<PluginPublishResult> {
  const response = await mutateJson(
    endpoint(apiBase, projectSlug),
    'POST',
    undefined,
    request,
  );
  const envelope = await readEnvelope<PluginPublishResult>(response);
  if (!response.ok || !envelope.success || !envelope.data) {
    throw new PluginPublishError(
      envelope.error ||
        `Station could not publish the plugin (${response.status})`,
      envelope.code,
      envelope.secrets,
    );
  }
  return envelope.data;
}

export function pluginPublishInspectionKey(
  apiBase: string,
  projectSlug: string,
) {
  return ['plugin-publish', apiBase, projectSlug] as const;
}

export function pluginPublishSummaryKey(apiBase: string, projectSlug: string) {
  return ['plugin-publish-summary', apiBase, projectSlug] as const;
}
