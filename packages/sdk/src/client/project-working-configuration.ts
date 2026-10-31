import {
  PROJECT_WORKING_CONFIGURATION_VERSION,
  type ProjectWorkingConfiguration,
  type ProjectWorkingConfigurationApply,
  type ProjectWorkingConfigurationView,
} from '@kontourai/station-contracts/project-working-configuration';
import { z } from 'zod';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

type Options = ClientRequestOptions & { requestScope: ApiRequestScope };
const draft = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        sourcePath: z.string().max(512),
        text: z.string().max(6000),
      }),
    )
    .max(24),
  validationCommands: z
    .array(
      z.strictObject({
        sourcePath: z.string().max(512),
        command: z.string().max(512),
      }),
    )
    .max(24),
  completionCriteria: z.string().max(2000),
  checkpoints: z.array(z.string().max(300)).max(12),
  evidencePointers: z.array(z.string().max(512)).max(16),
});
const configuration = z.strictObject({
  version: z.literal(PROJECT_WORKING_CONFIGURATION_VERSION),
  projectId: z.string(),
  revision: z.number().int().positive(),
  sourceDigest: z.string(),
  rootIdentity: z.string(),
  draft,
  reviewedBy: z.string(),
  operationId: z.string(),
  applyDigest: z.string(),
});
const view = z.strictObject({
  projectId: z.string(),
  sourceDigest: z.string(),
  rootIdentity: z.string(),
  sources: z
    .array(
      z.strictObject({
        path: z.string().max(512),
        kind: z.enum(['instructions', 'package', 'ci', 'guidance']),
        scope: z.string(),
        sha256: z.string(),
        text: z.string().max(6000),
        shortened: z.boolean(),
      }),
    )
    .max(32),
  omissions: z.array(z.string()),
  suggested: draft,
  current: configuration.nullable(),
  stale: z.boolean(),
});
async function unwrap<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await readJsonBody(response);
  if (response.status === 404 || response.status === 501)
    throw envelopeError(
      response,
      body,
      'Project working configuration is unavailable. Enable its Feature Preview or update this Station.',
      {
        message:
          'Project working configuration is unavailable. Enable its Feature Preview or update this Station.',
      },
    );
  if (!response.ok)
    throw envelopeError(
      response,
      body,
      'Project working configuration unavailable',
    );
  return z.object({ success: z.literal(true), data: schema }).parse(body).data;
}
const path = (apiBase: string, slug: string) =>
  `${apiBase}/api/projects/${encodeURIComponent(slug)}/working-configuration`;
const bounded = (options: Options): Options => ({
  ...options,
  maxResponseBytes: Math.min(
    options.maxResponseBytes ?? 512 * 1024,
    512 * 1024,
  ),
});
export function fetchProjectWorkingConfiguration(
  apiBase: string,
  slug: string,
  options: Options,
): Promise<ProjectWorkingConfigurationView> {
  return getJson(path(apiBase, slug), bounded(options)).then((response) =>
    unwrap(response, view),
  );
}
export function applyProjectWorkingConfiguration(
  apiBase: string,
  slug: string,
  input: ProjectWorkingConfigurationApply,
  options: Options,
): Promise<ProjectWorkingConfiguration> {
  return mutateJson(path(apiBase, slug), 'PUT', bounded(options), input).then(
    (response) => unwrap(response, configuration),
  );
}
