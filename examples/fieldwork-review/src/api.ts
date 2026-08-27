export const PLUGIN_NAME = 'fieldwork-review';

export interface RunSummary {
  id: string;
  proposalCount: number;
  createdAt: string;
  open: boolean;
}

interface ApiErrorBody {
  error?: string;
  success?: boolean;
}

export function pluginUrl(apiBase: string, projectSlug: string, suffix = '') {
  return `${apiBase}/api/plugins/${PLUGIN_NAME}/projects/${encodeURIComponent(projectSlug)}${suffix}`;
}

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok || body.success === false) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'The Fieldwork request failed.';
}
