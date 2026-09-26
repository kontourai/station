import { renderDiagrams } from './diagrams.js';

const article = document.getElementById('article');
const tree = document.getElementById('tree');
const results = document.getElementById('results');
const outline = document.getElementById('outline');
const breadcrumbs = document.getElementById('breadcrumbs');
const readingStatus = document.getElementById('reading-status');
const search = document.getElementById('search');
let atlas;

function escapeText(value) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}

function documentHref(reference) {
  const [file, section] = reference.split('#');
  return `#doc=${encodeURIComponent(file)}${section ? `&section=${encodeURIComponent(section)}` : ''}`;
}

function documentLink(reference) {
  const file = reference.split('#')[0];
  const doc = atlas.documents.find((entry) => entry.path === file);
  return `<a href="${documentHref(reference)}">${escapeText(doc?.title ?? file)}<small>${escapeText(reference)}</small></a>`;
}

function groupHref(id) {
  return `#branch=${encodeURIComponent(id)}`;
}
function moduleHref(id) {
  return `#module=${encodeURIComponent(id)}`;
}

function showOutline(headings, prefix) {
  outline.innerHTML = headings
    .filter((heading) => heading.level <= 3)
    .map(
      (heading) =>
        `<a href="${prefix}&section=${encodeURIComponent(heading.id)}">${escapeText(heading.title)}</a>`,
    )
    .join('');
}

function overview() {
  breadcrumbs.innerHTML = 'Station / Explore';
  readingStatus.innerHTML = '';
  outline.innerHTML = '';
  article.innerHTML = `<h1>How Station fits together</h1>
    <p>Start with a responsibility, then open an interface beneath it. Follow the implementation and evidence links to understand what happens—and what remains uncertain.</p>
    <div class="doc-actions"><a href="${documentHref('docs/architecture.md')}">System overview</a><a href="${documentHref('docs/user/concepts.md')}">Product vocabulary</a><a href="${documentHref('docs/architecture/abstraction-review.md')}">Abstraction review</a></div>
    <div class="notice"><p>This is a reading map of the current checkout. Its ${atlas.documents.length} documents and ${atlas.modules.length} module sections are an inventory, not an audit-completion score. Designs, historical records, and implementation evidence retain their own status.</p><a href="${documentHref('docs/plans/documentation-code-audit.md')}">Read the audit scope and remaining work</a></div>
    <div class="branches">${atlas.groups.map((group) => `<section class="branch"><h2><a href="${groupHref(group.id)}">${escapeText(group.title)}</a></h2><p>${escapeText(group.summary)}</p></section>`).join('')}</div>`;
}

function showGroup(group) {
  breadcrumbs.innerHTML = `<a href="#">Station</a> / ${escapeText(group.title)}`;
  readingStatus.innerHTML = '';
  outline.innerHTML = '';
  article.innerHTML = `<h1>${escapeText(group.title)}</h1><p>${escapeText(group.summary)}</p>
    <h2>Questions to understand this boundary</h2><ul>${group.questions.map((question) => `<li>${escapeText(question)}</li>`).join('')}</ul>
    <h2>Read the explanation</h2><ul>${group.docs.map((doc) => `<li>${documentLink(doc)}</li>`).join('')}</ul>
    <h2>Open an interface</h2><p>These sections come directly from the canonical module map. They describe the interface, invariants, composition, and evidence; their presence does not certify that every claim has been re-audited.</p>
    <ul>${group.modules
      .map((title) => {
        const module = atlas.modules.find((entry) => entry.title === title);
        return `<li><a href="${moduleHref(module.id)}">${escapeText(title)}</a></li>`;
      })
      .join('')}</ul>
    <h2>Look for improvements</h2><p>Follow a real caller and its failure path. Identify what the caller must coordinate, where state lives, and whether the tests reach the same boundary. Separate a missing explanation from a missing abstraction.</p>
    <a href="${documentHref('docs/architecture/abstraction-review.md')}">Open the abstraction review</a>`;
}

function showDocument(doc, section, module) {
  const group =
    module &&
    atlas.groups.find((entry) => entry.modules.includes(module.title));
  breadcrumbs.innerHTML = `<a href="#">Station</a> / ${group ? `<a href="${groupHref(group.id)}">${escapeText(group.title)}</a> / ` : ''}${escapeText(module?.title ?? doc.title)}`;
  const sourcePath = doc.path.split('/').map(encodeURIComponent).join('/');
  readingStatus.innerHTML = `<div class="doc-actions"><a href="https://github.com/kontourai/station/blob/${atlas.revision}/${sourcePath}${module ? `#${module.id}` : ''}">Source on GitHub</a><a href="${documentHref('docs/plans/documentation-code-audit.md')}">Audit status</a></div>
    <p class="provenance">${escapeText(doc.path)} · ${escapeText(doc.review)}${atlas.dirty ? ' · Working-tree changes included; unpublished changes may not exist at the GitHub revision.' : ''}</p>`;
  article.innerHTML = module?.html ?? doc.html;
  const prefix = module ? moduleHref(module.id) : documentHref(doc.path);
  showOutline(module?.headings ?? doc.headings, prefix);
  if (section) {
    const target = [...article.querySelectorAll('[id]')].find(
      (element) => element.id === section,
    );
    if (target) target.scrollIntoView({ block: 'start' });
    else
      readingStatus.insertAdjacentHTML(
        'beforeend',
        '<p class="notice">That section is not present in this checkout. Use the page outline to find its current location.</p>',
      );
  }
}

function render(event) {
  if (location.hash === '#content') {
    document.getElementById('content').focus();
    return;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  const branch = params.get('branch');
  const module = atlas.modules.find(
    (entry) => entry.id === params.get('module'),
  );
  const docPath = module?.document.split('#')[0] ?? params.get('doc');
  const doc = atlas.documents.find((entry) => entry.path === docPath);
  if (branch) {
    const group = atlas.groups.find((entry) => entry.id === branch);
    if (group) showGroup(group);
    else showMissing();
  } else if (doc) showDocument(doc, params.get('section'), module);
  else if (params.size) showMissing();
  else overview();
  const renderedHash = location.hash;
  void renderDiagrams(article).then(() => {
    if (location.hash !== renderedHash || !params.get('section')) return;
    const target = [...article.querySelectorAll('[id]')].find(
      (element) => element.id === params.get('section'),
    );
    target?.scrollIntoView({ block: 'start' });
  });
  for (const link of tree.querySelectorAll('a')) {
    const active =
      link.getAttribute('href') ===
      (module ? moduleHref(module.id) : groupHref(branch));
    if (active) {
      link.setAttribute('aria-current', 'page');
      const parent = link.closest('details');
      if (parent) parent.open = true;
    } else link.removeAttribute('aria-current');
  }
  if (event && !params.get('section'))
    document.getElementById('content').scrollIntoView({ block: 'start' });
  document.title = `${article.querySelector('h1,h2')?.textContent ?? 'Explore'} · Learn Station`;
}

function showMissing() {
  breadcrumbs.innerHTML = '<a href="#">Station</a>';
  outline.innerHTML = '';
  readingStatus.innerHTML = '';
  article.innerHTML =
    '<h1>That reading route is unavailable</h1><p>The document or concept may have moved since this link was created. Search the library or return to the overview.</p><a href="#">Explore Station</a>';
}

function searchLibrary() {
  const query = search.value.trim().toLowerCase();
  tree.hidden = Boolean(query);
  results.hidden = !query;
  const status = document.getElementById('search-status');
  if (!query) {
    results.innerHTML = '';
    status.textContent = '';
    return;
  }
  const groups = atlas.groups.filter((group) =>
    `${group.title} ${group.summary}`.toLowerCase().includes(query),
  );
  const docs = atlas.documents.filter((doc) =>
    `${doc.path.toLowerCase()} ${doc.search}`.includes(query),
  );
  status.textContent = `${groups.length} concepts and ${docs.length} documents match. ${docs.length > 60 ? 'Showing the first 60 documents; narrow your search for more.' : ''}`;
  results.innerHTML =
    groups
      .map(
        (group) =>
          `<a href="${groupHref(group.id)}">${escapeText(group.title)}<small>Concept branch</small></a>`,
      )
      .join('') +
    docs
      .slice(0, 60)
      .map((doc) => documentLink(doc.path))
      .join('');
}

async function start() {
  try {
    const response = await fetch('atlas-data.json');
    if (!response.ok)
      throw new Error(`Atlas data returned HTTP ${response.status}`);
    atlas = await response.json();
    tree.innerHTML = atlas.groups
      .map(
        (group) =>
          `<details><summary>${escapeText(group.title)}</summary><a href="${groupHref(group.id)}">Overview and reading path</a><ul>${group.modules
            .map((title) => {
              const module = atlas.modules.find(
                (entry) => entry.title === title,
              );
              return `<li><a href="${moduleHref(module.id)}">${escapeText(title)}</a></li>`;
            })
            .join('')}</ul></details>`,
      )
      .join('');
    document.getElementById('library').innerHTML =
      `<ul>${atlas.documents.map((doc) => `<li>${documentLink(doc.path)}</li>`).join('')}</ul>`;
    document.getElementById('provenance').textContent =
      `${atlas.documents.length} Markdown files · ${atlas.revision.slice(0, 12)}${atlas.dirty ? ' + local changes' : ''} · built ${atlas.builtAt}`;
    search.addEventListener('input', searchLibrary);
    window.addEventListener('hashchange', render);
    render();
  } catch (error) {
    article.innerHTML = `<h1>The atlas could not load</h1><p role="alert">${escapeText(error.message)}</p><p>Run npm run docs:learn:build, then serve .kontourai/docs-learning over local HTTP as described in docs/learn/README.md.</p>`;
  }
}

start();
