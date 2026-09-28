const moduleMap = 'docs/architecture/module-map.md';

export function headingId(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function extractModules(source) {
  return documentSections(source).flatMap(({ title, text }) => {
    if (title === 'Shared language' || title === 'Index') return [];
    return [
      {
        title,
        id: headingId(title),
        document: `${moduleMap}#${headingId(title)}`,
        text,
      },
    ];
  });
}

export function documentSections(source) {
  const headings = [];
  let offset = 0;
  let fence = null;
  for (const line of source.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
    } else if (!fence) {
      const heading = /^## (.+)$/.exec(line);
      if (heading)
        headings.push({
          title: heading[1].trim(),
          start: offset,
          bodyStart: offset + line.length,
        });
    }
    offset += line.length + 1;
  }
  return headings.map((heading, index) => ({
    title: heading.title,
    text: source.slice(
      heading.start,
      headings[index + 1]?.start ?? source.length,
    ),
    body: source
      .slice(heading.bodyStart, headings[index + 1]?.start ?? source.length)
      .trim(),
  }));
}

export function validateCatalog(catalog, modules, files) {
  if (
    catalog?.version !== 1 ||
    !Array.isArray(catalog.groups) ||
    !catalog.groups.length
  )
    throw new Error('Learning catalog requires version 1 and nonempty groups.');
  const ids = new Set();
  const assigned = new Set();
  const known = new Set(modules.map((module) => module.title));
  if (
    known.size !== modules.length ||
    new Set(modules.map((module) => headingId(module.title))).size !==
      modules.length
  )
    throw new Error('Duplicate module title or navigation id.');
  for (const group of catalog.groups) {
    if (
      typeof group.id !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(group.id) ||
      ids.has(group.id)
    )
      throw new Error(`Invalid or duplicate learning group: ${group.id}`);
    ids.add(group.id);
    for (const key of ['title', 'summary'])
      if (typeof group[key] !== 'string' || !group[key].trim())
        throw new Error(`Missing ${key} for ${group.id}`);
    for (const key of ['docs', 'modules', 'questions'])
      if (
        !Array.isArray(group[key]) ||
        !group[key].length ||
        group[key].some((value) => typeof value !== 'string' || !value.trim())
      )
        throw new Error(`Invalid ${key} for ${group.id}`);
    for (const doc of group.docs)
      if (!files.has(doc.split('#')[0]))
        throw new Error(`Untracked learning document: ${doc}`);
    for (const name of group.modules) {
      if (!known.has(name)) throw new Error(`Unknown module: ${name}`);
      if (assigned.has(name))
        throw new Error(`Multiply assigned module: ${name}`);
      assigned.add(name);
    }
  }
  const missing = [...known].filter((name) => !assigned.has(name));
  if (missing.length)
    throw new Error(
      `Modules missing from learning tree: ${missing.join(', ')}`,
    );
}
