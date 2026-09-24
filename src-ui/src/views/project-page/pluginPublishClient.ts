import { getJson, mutateJson } from '@kontourai/station-sdk';

/** The shapes `/api/projects/:slug/plugin-publish` answers with (#2374,
 * epic #2323 S6). */

export interface PluginPublishSecret {
  path: string;
  reason: string;
}

export interface PluginPublishSkip {
  path: string;
  reason: 'symbolic-link' | 'special-file' | 'git-metadata';
}

export interface PluginPublishRefusal {
  code: string;
  message?: string;
  paths?: string[];
  secrets?: PluginPublishSecret[];
}

export type PluginPublishInspection =
  | { plugin: null; reason: string }
  | {
      plugin: { name: string; version: string };
      files: Array<{ path: string; size: number }>;
      skipped: PluginPublishSkip[];
      secrets: PluginPublishSecret[];
      refusal: PluginPublishRefusal | null;
    };

export type PluginPublishSummary =
  | { plugin: null; reason: string }
  | { plugin: { name: string; version: string } };

export interface PluginPublishRequest {
  remoteUrl: string;
  branch: string;
  message: string;
}

export interface PluginPublishResult {
  plugin: { name: string; version: string };
  commit: string | null;
  parent: string | null;
  branch: string;
  remoteUrl: string;
  committer: { name: string; email: string };
  files: number;
  skipped: PluginPublishSkip[];
  installSource: string;
  installSourceDerived: boolean;
  installCommand: string;
}

/** A refusal the server explained, with the files it named when that was
 * the reason. */
export class PluginPublishError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly secrets: PluginPublishSecret[] = [],
    readonly paths: string[] = [],
  ) {
    super(message);
    this.name = 'PluginPublishError';
  }
}

interface Envelope<T> {
  success?: boolean;
  error?: string;
  code?: string;
  secrets?: PluginPublishSecret[];
  paths?: string[];
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

/** `GET`: what publishing this Project's folder would send (files, what is
 * skipped, secrets). Asked only once the person opens the dialog. */
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

/** `POST`: export and push. Throws with the server's reason. */
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
      envelope.paths,
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
