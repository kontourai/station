import { isReleaseTag } from './release-tag.mjs';

const API = 'https://api.github.com';

function identity(plan) {
  const version = plan?.versionIdentities?.desktop?.version;
  if (
    !/^\d+\.\d+\.\d+-nightly\.\d+(?:\.\d+)?$/.test(version ?? '') ||
    !/^[a-f0-9]{40}$/.test(plan?.sourceSha ?? '')
  )
    throw new Error('Expected an exact-source Nightly desktop plan');
  return { version, source: plan.sourceSha, tag: `desktop-v${version}` };
}

function github(repository, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
    throw new Error('GitHub repository and token are required');
  return async (path, body) => {
    const method = body ? 'POST' : 'GET';
    // Retry reads and note generation only: release creation may have succeeded
    // before a response was lost and must not be blindly repeated.
    const retrySafe = !body || path === '/releases/generate-notes';
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(`${API}/repos/${repository}${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (!['TimeoutError', 'TypeError', 'AbortError'].includes(error?.name))
          throw error;
        if (!retrySafe || attempt)
          throw Object.assign(error, {
            releaseNotesUnavailable: true,
            releaseNotesCode: 'network',
          });
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const transient =
        response.status >= 500 ||
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')));
      if (!retrySafe || attempt || !transient) break;
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      // GitHub sends x-ratelimit-reset on nearly every response; it only says
      // when to retry once the quota is actually exhausted.
      const reset =
        response.headers.get('x-ratelimit-remaining') === '0'
          ? response.headers.get('x-ratelimit-reset')
          : null;
      const requested =
        retryAfter === null && reset !== null
          ? Number(reset) * 1000 - Date.now()
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter ?? '') - Date.now();
      const delay = Number.isFinite(requested)
        ? Math.min(30_000, Math.max(0, requested))
        : 250;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (response.status === 404 && !body) return null;
    if (!response.ok) {
      const unavailable =
        response.status >= 500 ||
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')));
      if (unavailable) {
        await response.body?.cancel();
        throw Object.assign(
          new Error(
            `GitHub release notes: HTTP ${response.status} ${method} ${path}`,
          ),
          {
            // The nightly fallback logs a fixed message for this code only.
            releaseNotesCode: 'github-unavailable',
            releaseNotesUnavailable: true,
          },
        );
      }
      const safe = (value) =>
        typeof value === 'string'
          ? value
              .replaceAll(token, '[redacted]')
              .replaceAll(body?.body || token, '[redacted]')
              .slice(0, 160)
          : undefined;
      const detail = await response.json().catch(() => null);
      const diagnostic = {
        message: safe(detail?.message),
        errors: Array.isArray(detail?.errors)
          ? detail.errors.slice(0, 3).map((error) => ({
              resource: safe(error?.resource),
              field: safe(error?.field),
              code: safe(error?.code),
              message: safe(error?.message),
            }))
          : undefined,
        requestId: safe(response.headers.get('x-github-request-id')),
        acceptedPermissions: safe(
          response.headers.get('x-accepted-github-permissions'),
        ),
        oauthScopes: safe(response.headers.get('x-oauth-scopes')),
      };
      // Fail-closed configuration errors keep the full diagnostic.
      throw new Error(
        `GitHub release notes: HTTP ${response.status} ${method} ${path} ${JSON.stringify(diagnostic)}`,
      );
    }
    return response.json();
  };
}

// Leave room for the CLI's installation section beneath GitHub's 125k limit.
function boundedNotes(body, compareUrl) {
  const entries = [...body.matchAll(/^(?:[-*+] |\d+\. )/gm)];
  if (body.length <= 50_000 && entries.length <= 100) return body;
  const cutoff = Math.min(49_000, entries[100]?.index ?? body.length);
  const prefix = body.slice(0, cutoff);
  const kept = prefix.slice(0, prefix.lastIndexOf('\n')).trim();
  const shown = [...kept.matchAll(/^(?:[-*+] |\d+\. )/gm)].length;
  return `${kept || '## What Changed'}\n\n${entries.length - shown} changes omitted.\n\n**Full changelog**: ${compareUrl}`;
}

function unavailable(message, code) {
  return Object.assign(new Error(message), {
    releaseNotesUnavailable: true,
    releaseNotesCode: code,
  });
}

export async function generateDesktopReleaseNotes({ plan, repository, token }) {
  const { tag, source } = identity(plan);
  const api = github(repository, token);
  const previous = await api('/commits/nightly-desktop');
  if (!/^[a-f0-9]{40}$/.test(previous?.sha ?? ''))
    throw new Error('Previous desktop source is unavailable');
  const generated = await api('/releases/generate-notes', {
    tag_name: tag,
    target_commitish: source,
    previous_tag_name: 'nightly-desktop',
  });
  const after = await api('/commits/nightly-desktop');
  if (after?.sha !== previous.sha)
    throw new Error('Desktop release moved while generating notes');
  if (typeof generated?.body !== 'string' || !generated.body.trim())
    throw new Error('GitHub generated no release notes');
  // The rolling marker moves on publication; retain a usable historical range.
  return boundedNotes(
    generated.body.replaceAll(
      `/compare/nightly-desktop...${tag}`,
      `/compare/${previous.sha}...${source}`,
    ),
    `https://github.com/${repository}/compare/${previous.sha}...${source}`,
  );
}

export async function publishDesktopReleaseNotes({
  plan,
  manifest,
  repository,
  token,
}) {
  const { tag, source, version } = identity(plan);
  if (
    manifest?.version !== version ||
    typeof manifest.notes !== 'string' ||
    !manifest.notes.trim()
  )
    throw new Error('Desktop changelog differs from the published update');
  const api = github(repository, token);
  const existing = await api(`/releases/tags/${tag}`);
  // Resolving a missing tag through /commits returns 422, not 404.
  const tagRef = await api(`/git/ref/tags/${tag}`);
  if (existing && !tagRef)
    throw new Error('Archived desktop changelog tag is unavailable');
  if (tagRef) {
    const tagSource = await api(`/commits/${tag}`);
    if (tagSource?.sha !== source)
      throw new Error('Desktop changelog tag names a different source');
  }
  const expected = {
    tag_name: tag,
    target_commitish: source,
    name: `Station desktop ${version}`,
    body: manifest.notes,
    draft: false,
    prerelease: true,
    make_latest: 'false',
  };
  if (existing) {
    for (const key of [
      'tag_name',
      'target_commitish',
      'body',
      'draft',
      'prerelease',
    ]) {
      if (existing[key] !== expected[key])
        throw new Error('An archived desktop changelog already differs');
    }
    return;
  }
  const created = await api('/releases', expected);
  if (
    created?.tag_name !== tag ||
    created?.body !== manifest.notes ||
    created?.draft !== false
  )
    throw new Error('GitHub did not confirm the archived changelog');
}

function isServerReleaseTag(tag) {
  return (
    isReleaseTag(tag) ||
    /^v\d+\.\d+\.\d+-(?:nightly|preview)\.\d+(?:\.\d+)?$/.test(tag ?? '')
  );
}

export async function generateServerReleaseNotes({
  tag,
  source,
  repository,
  token,
}) {
  if (!isServerReleaseTag(tag) || !/^[a-f0-9]{40}$/.test(source ?? ''))
    throw new Error('Expected an exact-source server release');
  const api = github(repository, token);
  const ring = tag.includes('-nightly.')
    ? 'nightly'
    : tag.includes('-rc.')
      ? 'rc'
      : tag.includes('-preview.')
        ? 'preview'
        : 'stable';
  const order = (value) =>
    value
      .slice(1)
      .split(/[.-]/)
      .filter((part) => /^\d+$/.test(part))
      .map(Number);
  const older = (candidate) => {
    const a = order(candidate),
      b = order(tag);
    const sameBase = a.slice(0, 3).every((part, i) => part === b[i]);
    if (sameBase && !tag.includes('-')) return candidate.includes('-');
    if (sameBase && !candidate.includes('-')) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
    }
    return false;
  };
  const releaseRing = (value) =>
    value.includes('-nightly.')
      ? 'nightly'
      : value.includes('-rc.')
        ? 'rc'
        : value.includes('-preview.')
          ? 'preview'
          : 'stable';
  // API order is publication order, not version order. Promotion must span
  // the preceding base version, rather than compare against its own prerelease.
  const compare = (a, b) => {
    const x = order(a),
      y = order(b);
    for (let i = 0; i < 3; i++) {
      if (x[i] !== y[i]) return x[i] - y[i];
    }
    const rank = (value) =>
      value.includes('-nightly.') ? 0 : value.includes('-') ? 1 : 2;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    for (let i = 3; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return a.localeCompare(b);
  };
  let previous;
  let fallback;
  for (let page = 1; ; page++) {
    const releases = await api(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Invalid release history');
    for (const release of releases) {
      const candidate = release.tag_name;
      if (release.draft || !isServerReleaseTag(candidate) || !older(candidate))
        continue;
      const lowerBase = order(candidate)
        .slice(0, 3)
        .some((part, i) => part !== order(tag)[i]);
      if (lowerBase && (!fallback || compare(candidate, fallback.tag_name) > 0))
        fallback = release;
      if (
        releaseRing(candidate) === ring &&
        (!previous || compare(candidate, previous.tag_name) > 0)
      )
        previous = release;
    }
    if (releases.length < 100) break;
  }
  // Combine Release-derived fallback and plain stable tags before choosing.
  if (!previous) {
    previous = fallback;
    for (let page = 1; ; page++) {
      const tags = await api(`/tags?per_page=100&page=${page}`);
      if (!Array.isArray(tags)) throw new Error('Invalid tag history');
      for (const entry of tags) {
        const candidate = entry.name;
        if (
          /^v\d+\.\d+\.\d+$/.test(candidate ?? '') &&
          older(candidate) &&
          (!previous || compare(candidate, previous.tag_name) > 0)
        )
          previous = { tag_name: candidate };
      }
      if (tags.length < 100) break;
    }
  }
  if (!previous)
    throw unavailable(
      'Previous server release is unavailable',
      'no-previous-release',
    );
  const priorTag = previous.tag_name;
  const before = await api(`/commits/${priorTag}`);
  if (!/^[a-f0-9]{40}$/.test(before?.sha ?? ''))
    throw unavailable(
      'Previous server source is unavailable',
      'no-previous-source',
    );
  const noChanges = () => {
    const message = `No changes since ${priorTag}.`;
    if (ring === 'nightly') throw unavailable(message, 'no-changes');
    return message;
  };
  if (before.sha === source) return noChanges();
  const generated = await api('/releases/generate-notes', {
    tag_name: tag,
    target_commitish: source,
    previous_tag_name: priorTag,
  });
  const after = await api(`/commits/${priorTag}`);
  if (after?.sha !== before.sha)
    throw new Error('Server release moved while generating notes');
  if (typeof generated?.body !== 'string' || !generated.body.trim())
    return noChanges();
  const changes = generated.body
    .replace(/^.*(?:Full Changelog|\/compare\/).*$/gm, '')
    .replace(/^#+.*$/gm, '')
    .trim();
  if (!changes) return noChanges();
  return boundedNotes(
    generated.body.replaceAll(
      `/compare/${priorTag}...${tag}`,
      `/compare/${before.sha}...${source}`,
    ),
    `https://github.com/${repository}/compare/${before.sha}...${source}`,
  );
}
