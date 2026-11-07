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
    const response = await fetch(`${API}/repos/${repository}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && !body) return null;
    if (!response.ok) {
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
      throw new Error(
        `GitHub release notes: HTTP ${response.status} ${method} ${path} ${JSON.stringify(diagnostic)}`,
      );
    }
    return response.json();
  };
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
  return generated.body.replaceAll(
    `/compare/nightly-desktop...${tag}`,
    `/compare/${previous.sha}...${source}`,
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
