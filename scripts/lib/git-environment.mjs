const GIT_LOCATION_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

export function gitLocationKeys(env) {
  return Object.keys(env).filter(
    (key) =>
      GIT_LOCATION_ENV.includes(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key),
  );
}

/** Preserve global/system config while removing inherited repo-local routing. */
export function sanitizedGitEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of gitLocationKeys(clean)) delete clean[key];
  return clean;
}
