#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BUILD_WORKFLOW_PATH = '.github/workflows/build-android.yml';
const TRUSTED_BRANCH = 'main';
const TRUSTED_EVENTS = new Set(['push', 'workflow_dispatch']);
const RUN_LOOKUP_TIMEOUT_MS = 15_000;
const MAX_SUCCESS_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const MAX_RENDERED_ERROR_LENGTH = 1_024;

function replaceControlCharacters(value) {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('');
}

function normalizeRequestedRunId(runId) {
  const raw = String(runId ?? '');
  if (!/^\d+$/.test(raw))
    throw new Error('run_id must be a numeric workflow run ID');
  return BigInt(raw).toString();
}

function normalizedResponseRunId(run) {
  if (!Number.isSafeInteger(run.id) || run.id < 0)
    throw new Error(
      'selected Android build run did not resolve to a numeric ID',
    );
  return String(run.id);
}

export function sanitizeLookupDiagnostic(value, token) {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  const redacted = token ? raw.split(token).join('[REDACTED]') : raw;
  return replaceControlCharacters(redacted)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RENDERED_ERROR_LENGTH);
}

export function validateAndroidBuildRun(run, repository, requestedRunId) {
  if (!run || typeof run !== 'object')
    throw new Error('selected Android build run is not an object');
  const runId = normalizedResponseRunId(run);
  if (requestedRunId !== undefined && runId !== requestedRunId)
    throw new Error(
      `selected Android build run ID '${runId}' does not match requested run ID '${requestedRunId}'`,
    );
  if (!/^[0-9a-f]{40}$/.test(String(run.head_sha ?? '')))
    throw new Error(
      'selected Android build did not resolve to a full commit SHA',
    );
  if (run.conclusion !== 'success')
    throw new Error(
      `selected Android build conclusion is '${run.conclusion}', not success`,
    );
  if (run.path !== BUILD_WORKFLOW_PATH)
    throw new Error(
      `selected run belongs to '${run.path}', not ${BUILD_WORKFLOW_PATH}`,
    );
  if (run.head_repository?.full_name !== repository)
    throw new Error(
      `selected Android build repository is '${run.head_repository?.full_name ?? 'unknown'}', not ${repository}`,
    );
  if (!TRUSTED_EVENTS.has(run.event))
    throw new Error(
      `selected Android build event '${run.event}' is not trusted`,
    );
  if (run.head_branch !== TRUSTED_BRANCH)
    throw new Error(
      `selected Android build branch '${run.head_branch}' is not ${TRUSTED_BRANCH}`,
    );
  return { headSha: run.head_sha, runId, conclusion: run.conclusion };
}

function resolveRunLookupUrl(repository, runId, apiUrl) {
  const [owner, name, ...extra] = repository.split('/');
  if (!owner || !name || extra.length > 0)
    throw new Error('GITHUB_REPOSITORY must be an owner/repository pair');

  let baseUrl;
  try {
    baseUrl = new URL(apiUrl);
  } catch {
    throw new Error('GITHUB_API_URL must be a valid URL');
  }
  if (baseUrl.protocol !== 'https:')
    throw new Error('GITHUB_API_URL must use HTTPS');
  if (baseUrl.username || baseUrl.password)
    throw new Error('GITHUB_API_URL must not include credentials');
  if (baseUrl.search)
    throw new Error('GITHUB_API_URL must not include a query string');
  if (baseUrl.hash)
    throw new Error('GITHUB_API_URL must not include a fragment');

  const normalizedBaseUrl = new URL(
    baseUrl.pathname.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`,
  );
  return {
    origin: baseUrl.origin,
    url: new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}`,
      normalizedBaseUrl,
    ).href,
  };
}

async function cancelResponseBody(response) {
  if (response.body && typeof response.body.cancel === 'function') {
    try {
      await response.body.cancel();
    } catch {
      // Preserve the original validation failure even if transport cleanup fails.
    }
  }
}

async function rejectResponseBody(response, message) {
  await cancelResponseBody(response);
  throw new Error(message);
}

async function contentLengthWithinLimit(response, maxBytes) {
  if (!response.headers || typeof response.headers.get !== 'function')
    return rejectResponseBody(
      response,
      'GitHub run lookup returned invalid response headers',
    );
  const rawContentLength = response.headers.get('content-length');
  if (rawContentLength === null) return;
  if (!/^(0|[1-9]\d*)$/.test(rawContentLength))
    return rejectResponseBody(
      response,
      'GitHub run lookup returned an invalid Content-Length',
    );
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes)
    return rejectResponseBody(
      response,
      `GitHub run lookup response body exceeds ${maxBytes} byte limit`,
    );
}

function bodyReadFailure(error, signal, token) {
  if (signal.aborted)
    return new Error(
      `GitHub run lookup body read timed out after ${RUN_LOOKUP_TIMEOUT_MS}ms`,
    );
  if (
    error &&
    typeof error === 'object' &&
    (error.name === 'AbortError' || error.code === 'ABORT_ERR')
  )
    return new Error('GitHub run lookup body read aborted');
  return new Error(
    sanitizeLookupDiagnostic(
      `GitHub run lookup body read failed: ${sanitizeLookupDiagnostic(error, token) || 'unknown error'}`,
      token,
    ),
  );
}

async function readCappedResponseBody(response, maxBytes, signal, token) {
  await contentLengthWithinLimit(response, maxBytes);
  if (!response.body || typeof response.body.getReader !== 'function')
    throw new Error('GitHub run lookup response has no readable body');

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      let next;
      try {
        next = await reader.read();
      } catch (error) {
        throw bodyReadFailure(error, signal, token);
      }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array))
        throw new Error('GitHub run lookup response body is not bytes');
      bytesRead += next.value.byteLength;
      if (bytesRead > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the original overflow failure if cancellation fails.
        }
        throw new Error(
          `GitHub run lookup response body exceeds ${maxBytes} byte limit`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function responseMatchesRequest(response, expectedUrl, expectedOrigin) {
  if (typeof response.url !== 'string' || !response.url)
    throw new Error('GitHub run lookup returned an invalid response URL');
  let responseUrl;
  try {
    responseUrl = new URL(response.url);
  } catch {
    throw new Error('GitHub run lookup returned an invalid response URL');
  }
  if (
    response.redirected ||
    responseUrl.origin !== expectedOrigin ||
    responseUrl.href !== expectedUrl
  )
    throw new Error('GitHub run lookup response URL did not match request');
}

function responseErrorDetail(body, token) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    return sanitizeLookupDiagnostic(
      typeof parsed?.message === 'string' ? parsed.message : body,
      token,
    );
  } catch {
    return sanitizeLookupDiagnostic(body, token);
  }
}

export async function resolveAndroidBuildRun({
  runId,
  repository,
  outputPath,
  env = process.env,
  fetchImpl = fetch,
  appendFile = appendFileSync,
  createAbortSignal = () => AbortSignal.timeout(RUN_LOOKUP_TIMEOUT_MS),
}) {
  const requestedRunId = normalizeRequestedRunId(runId);
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required');
  if (typeof fetchImpl !== 'function')
    throw new Error('GitHub run lookup requires a fetch implementation');

  // This endpoint resolves one exact workflow run, so pagination is neither
  // needed nor accepted: every response must be the requested run object.
  const { url, origin } = resolveRunLookupUrl(
    repository,
    requestedRunId,
    env.GITHUB_API_URL ?? 'https://api.github.com',
  );
  const signal = createAbortSignal();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal,
    });
  } catch (error) {
    const reason = signal.aborted
      ? `timed out after ${RUN_LOOKUP_TIMEOUT_MS}ms`
      : sanitizeLookupDiagnostic(error, token) || 'unknown error';
    throw new Error(`GitHub run lookup request failed: ${reason}`);
  }
  if (
    !response ||
    typeof response.ok !== 'boolean' ||
    !Number.isInteger(response.status)
  )
    throw new Error('GitHub run lookup returned an invalid HTTP response');
  responseMatchesRequest(response, url, origin);
  if (!response.ok || response.status !== 200) {
    const body = await readCappedResponseBody(
      response,
      MAX_ERROR_BODY_BYTES,
      signal,
      token,
    );
    const detail = responseErrorDetail(body, token);
    throw new Error(
      sanitizeLookupDiagnostic(
        `GitHub run lookup failed with HTTP ${response.status}${response.statusText ? ` ${sanitizeLookupDiagnostic(response.statusText, token)}` : ''}${detail ? `: ${detail}` : ''}`,
        token,
      ),
    );
  }

  const successBody = await readCappedResponseBody(
    response,
    MAX_SUCCESS_BODY_BYTES,
    signal,
    token,
  );
  let run;
  try {
    run = JSON.parse(successBody);
  } catch {
    throw new Error('GitHub run lookup returned invalid JSON');
  }
  const validated = validateAndroidBuildRun(run, repository, requestedRunId);
  appendFile(
    outputPath,
    `head_sha=${validated.headSha}\nrun_id=${validated.runId}\nconclusion=${validated.conclusion}\n`,
  );
  return validated;
}

async function main() {
  await resolveAndroidBuildRun({
    runId:
      process.env.GITHUB_EVENT_NAME === 'workflow_run'
        ? process.env.TRIGGER_RUN_ID
        : process.env.DISPATCH_RUN_ID,
    repository: process.env.GITHUB_REPOSITORY,
    outputPath: process.env.GITHUB_OUTPUT,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    console.error(`::error::${sanitizeLookupDiagnostic(error, token)}`);
    process.exitCode = 1;
  });
}
