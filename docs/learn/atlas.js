const article = document.getElementById('article');
const tree = document.getElementById('tree');
const results = document.getElementById('results');
const outline = document.getElementById('outline');
const breadcrumbs = document.getElementById('breadcrumbs');
const readingStatus = document.getElementById('reading-status');
const search = document.getElementById('search');
let atlas;
const readingCache = new Map();
let searchIndex;
let renderRevision = 0;

async function loadReading(node) {
  if (node.html) return node;
  if (!readingCache.has(node.contentUrl)) {
    readingCache.set(
      node.contentUrl,
      fetch(node.contentUrl).then(async (response) => {
        if (!response.ok)
          throw new Error(`Document returned HTTP ${response.status}`);
        const content = await response.json();
        if (
          content.digest !== node.digest ||
          !node.snapshotDigest ||
          content.snapshotDigest !== node.snapshotDigest ||
          (node.path ? content.path !== node.path : content.id !== node.id)
        )
          throw new Error(
            'This document was rebuilt. Reload to open the current snapshot.',
          );
        return content;
      }),
    );
  }
  return readingCache.get(node.contentUrl);
}

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
  setOutline(
    headings
      .filter((heading) => heading.level <= 3)
      .map(
        (heading) =>
          `<a href="${prefix}&section=${encodeURIComponent(heading.id)}">${escapeText(heading.title)}</a>`,
      )
      .join(''),
  );
}

function setOutline(html) {
  outline.innerHTML = html;
  document.querySelector('.outline-panel').hidden = !html;
  const compact = document.getElementById('compact-outline');
  compact.hidden = !html;
  compact.querySelector('nav').innerHTML = html;
  document
    .querySelector('.workspace')
    .classList.toggle('has-outline', Boolean(html));
}

function overview() {
  breadcrumbs.innerHTML = 'Station / Explore';
  readingStatus.innerHTML = '';
  setOutline('');
  article.className = 'view-overview';
  article.innerHTML = `<section class="hero">
      <div class="hero-copy"><p class="eyebrow">THE STATION FIELD GUIDE</p><h1>How Station <em>fits together.</em></h1>
      <p class="hero-description">Understand the big picture. Follow the work into its interfaces, decisions, and code. Find the places worth improving.</p>
      <a class="primary-link" href="${documentHref('docs/architecture.md')}">Start with the overview <span aria-hidden="true">↗</span></a>
      <p class="hero-caption">Built from the same documentation your agents read.</p></div>
      <div class="learning-map"><div class="map-caption"><span>A FEW WAYS IN</span><span>Choose a branch ↗</span></div>
        <div class="map-grid"><svg class="map-lines" viewBox="0 0 400 270" preserveAspectRatio="none" aria-hidden="true"><path d="M100 45V135H300V225M300 45V135H100V225" /></svg>
          <a class="map-node" href="#branch=work"><span class="node-symbol" aria-hidden="true">▤</span><span>Projects & Tasks</span></a>
          <a class="map-node" href="#branch=execution"><span class="node-symbol" aria-hidden="true">↗</span><span>Sessions & engines</span></a>
          <div class="map-root"><span class="root-symbol" aria-hidden="true">S</span><div>Station<small>The agent workspace</small></div></div>
          <a class="map-node" href="#branch=surfaces"><span class="node-symbol" aria-hidden="true">▦</span><span>Work surfaces</span></a>
          <a class="map-node" href="#branch=evidence"><span class="node-symbol" aria-hidden="true">✓</span><span>Trust & evidence</span></a>
        </div><p class="map-footer">A learning map, from concepts to implementation.</p>
      </div>
    </section>
    <section class="reading-routes" aria-label="Suggested reading paths">
      <a href="${documentHref('docs/user/concepts.md')}"><span class="route-number">01</span><div><strong>Get the big picture</strong><span>The concepts behind the workspace</span></div><span aria-hidden="true">↗</span></a>
      <a href="${documentHref('docs/architecture.md#data-flow-chat-request')}"><span class="route-number">02</span><div><strong>Follow a real request</strong><span>From a message to an execution</span></div><span aria-hidden="true">↗</span></a>
      <a href="${documentHref('docs/architecture/abstraction-review.md')}"><span class="route-number">03</span><div><strong>Question the design</strong><span>Boundaries, tradeoffs, and open questions</span></div><span aria-hidden="true">↗</span></a>
    </section>
    <section class="explore-section"><div class="section-heading"><div><p class="eyebrow">EXPLORE THE ARCHITECTURE</p><h2>Pick a part. Go deeper.</h2></div><span class="section-count">${atlas.groups.length} branches · ${atlas.modules.length} interfaces & notes</span></div>
    <div class="branches">${atlas.groups.map((group, index) => `<a class="branch-card" href="${groupHref(group.id)}" aria-labelledby="branch-${group.id}-title"><div class="branch-top"><span class="branch-number">${String(index + 1).padStart(2, '0')}</span><span class="branch-arrow" aria-hidden="true">↗</span></div><h3 id="branch-${group.id}-title">${escapeText(group.title)}</h3><p>${escapeText(group.summary)}</p><div class="branch-meta">${group.modules.length} interfaces & notes <span>·</span> ${group.docs.length} reading routes</div></a>`).join('')}</div></section>
    <details class="audit-note"><summary>About this preview and its review status</summary><p>The library contains ${atlas.documents.length} Markdown files. Inclusion is an inventory, not a completed semantic audit. Historical records and proposals retain their own status.</p><a href="${documentHref('docs/plans/documentation-code-audit.md')}">Read the audit ledger and remaining work ↗</a></details>`;
}

function showGroup(group) {
  breadcrumbs.innerHTML = `<a href="#">Station</a> / ${escapeText(group.title)}`;
  readingStatus.innerHTML = '';
  setOutline('');
  article.className = 'view-branch';
  article.innerHTML = `<p class="eyebrow">EXPLORE A RESPONSIBILITY</p><h1>${escapeText(group.title)}</h1><p class="lead">${escapeText(group.summary)}</p>
    <div class="question-panel"><p class="eyebrow">QUESTIONS TO FOLLOW</p><ul>${group.questions.map((question) => `<li>${escapeText(question)}</li>`).join('')}</ul></div>
    <h2>Start reading</h2><ul class="reading-list">${group.docs.map((doc) => `<li>${documentLink(doc)}</li>`).join('')}</ul>
    <h2>Inside this part of the system</h2><p class="section-intro">Open an interface to explore its purpose, boundaries, implementation, and evidence.</p>
    <ul class="module-list">${group.modules
      .map((title) => {
        const module = atlas.modules.find((entry) => entry.title === title);
        return `<li><a href="${moduleHref(module.id)}"><span>${escapeText(title)}</span><span aria-hidden="true">↗</span></a></li>`;
      })
      .join('')}</ul>
    <div class="improvement-note"><h2>What could be better?</h2><p>Follow a real caller and its failure path. Look for responsibilities that leak across a boundary, unclear ownership, and evidence that leaves a gap.</p>
    <a href="${documentHref('docs/architecture/abstraction-review.md')}">Open the abstraction review ↗</a></div>`;
}

function showDocument(doc, section, module) {
  const group =
    module &&
    atlas.groups.find((entry) => entry.modules.includes(module.title));
  breadcrumbs.innerHTML = `<a href="#">Station</a> / ${group ? `<a href="${groupHref(group.id)}">${escapeText(group.title)}</a> / ` : ''}${escapeText(module?.title ?? doc.title)}`;
  const review = doc.reviewRecord;
  const kindLabels = {
    current: 'Current guide',
    historical: 'Historical record',
    design: 'Design decision',
    policy: 'Policy',
    'release-note': 'Release note',
    generated: 'Generated reference',
    fixture: 'Test fixture',
  };
  const stateLabels = {
    classified: 'Purpose checked',
    partial: 'Partially reviewed',
    'source-reviewed': 'Reviewed against code',
    'needs-review': 'Review out of date',
    'generated-validated': 'Generated output checked',
    'absent-historical': 'Historical file absent',
  };
  const reviewTitle = review
    ? `${kindLabels[review.kind]} · ${stateLabels[review.state]}`
    : 'Full review pending';
  const stateDescriptions = {
    classified: 'Purpose classification does not verify current behavior.',
    partial:
      'Only selected claims have been checked; the full page is not verified.',
    'source-reviewed':
      'Checked within the recorded scope; live outcomes need their own evidence.',
    'needs-review':
      'The document or its supporting code changed after this review.',
    'generated-validated':
      'Current data and rendering match the reviewed generator contract. New release claims have not been independently reverified.',
    'absent-historical':
      'This classified release note is no longer present. Its absence does not establish publication.',
  };
  const reviewText = review
    ? stateDescriptions[review.state]
    : 'This page has not been verified in full against the code.';
  const generatedCheck =
    review?.state === 'generated-validated' && review.validation
      ? `<p><strong>Current generated check.</strong> ${escapeText(review.validation.summary)} ${escapeText(review.validation.entryCount)} release records checked.</p>`
      : '';
  const evidence = review
    ? `<p><strong>Review scope.</strong> ${escapeText(review.summary)}</p><p><strong>Limits.</strong> ${escapeText(review.limits)}</p>${generatedCheck}${review.historyUnavailable ? `<p>${escapeText(review.historyUnavailable)}</p>` : review.reviewBaseline ? `<p>Review history since <code>${escapeText(review.reviewBaseline)}</code>; covering notes are listed below.</p>` : `<p>Legacy document review at <code>${escapeText(review.documentRevision)}</code>.</p>`}${review.sources.length ? `<ul>${review.sources.map((source) => `<li><a href="${atlas.sourceSnapshots[source.path.replace(/(\.json)#\/.*$/, '$1')]}">${escapeText(source.path)}</a>${source.revision ? ` reviewed at <code>${escapeText(source.revision)}</code>` : ''}</li>`).join('')}</ul>` : ''}${review.checks.length ? `<p>Recorded checks:</p><ul>${review.checks.map((check) => `<li>${escapeText(check)}</li>`).join('')}</ul>` : ''}`
    : '';
  readingStatus.innerHTML = `<p class="review-status"><strong>${escapeText(reviewTitle)}.</strong> ${escapeText(reviewText)} <a href="${documentHref('docs/plans/documentation-code-audit.md#initial-findings')}">See reviewed claims and corrections</a>.</p><details class="source-details"><summary>Sources & review</summary><div class="doc-actions"><a href="${doc.sourceUrl}">Markdown source</a><a href="${documentHref('docs/plans/documentation-code-audit.md')}">Audit status</a></div>
    <p class="provenance">${escapeText(doc.path)}${atlas.dirty ? ' · Working-tree changes included.' : ''} This panel links to the captured source files.</p>${evidence}</details>`;
  article.className = 'view-document';
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

async function render(event) {
  const revision = ++renderRevision;
  const requestedHash = location.hash;
  const params = new URLSearchParams(
    location.hash === '#content' ? '' : location.hash.slice(1),
  );
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
  } else if (doc) {
    article.innerHTML =
      '<p class="loading-message">Opening this part of the guide…</p>';
    try {
      const content = await loadReading(module ?? doc);
      if (revision !== renderRevision || location.hash !== requestedHash)
        return;
      showDocument(
        module ? doc : { ...doc, ...content },
        params.get('section'),
        module ? { ...module, ...content } : undefined,
      );
    } catch (error) {
      if (revision !== renderRevision || location.hash !== requestedHash)
        return;
      readingStatus.innerHTML = '';
      setOutline('');
      article.innerHTML = `<h1>This page could not open</h1><p role="alert">${escapeText(error.message)}</p><p>Reload the page to refresh the documentation snapshot.</p>`;
      return;
    }
  } else if (params.size) showMissing();
  else overview();
  const renderedHash = location.hash;
  const diagrams = article.querySelector('code.language-mermaid')
    ? import('./diagrams.js').then(({ renderDiagrams }) =>
        revision === renderRevision && location.hash === renderedHash
          ? renderDiagrams(article)
          : undefined,
      )
    : Promise.resolve();
  void diagrams
    .then(() => {
      if (
        revision !== renderRevision ||
        location.hash !== renderedHash ||
        !params.get('section')
      )
        return;
      const target = [...article.querySelectorAll('[id]')].find(
        (element) => element.id === params.get('section'),
      );
      target?.scrollIntoView({ block: 'start' });
    })
    .catch((error) => {
      if (revision !== renderRevision || location.hash !== renderedHash) return;
      const notice = document.createElement('p');
      notice.className = 'notice';
      notice.setAttribute('role', 'alert');
      notice.textContent = `The diagram renderer could not load. Diagram source remains available. ${error.message}`;
      readingStatus.append(notice);
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
  setOutline('');
  article.className = 'view-document';
  readingStatus.innerHTML = '';
  article.innerHTML =
    '<h1>That reading route is unavailable</h1><p>The document or concept may have moved since this link was created. Search the library or return to the overview.</p><a href="#">Explore Station</a>';
}

async function searchLibrary() {
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
  status.textContent = 'Searching the guide…';
  try {
    searchIndex ??= fetch('search-index.json').then((response) => {
      if (!response.ok)
        throw new Error(`Search returned HTTP ${response.status}`);
      return response.json();
    });
    const index = await searchIndex;
    if (search.value.trim().toLowerCase() !== query) return;
    const matches = new Set(
      index
        .filter((doc) =>
          `${doc.path.toLowerCase()} ${doc.search}`.includes(query),
        )
        .map((doc) => doc.path),
    );
    const docs = atlas.documents.filter((doc) => matches.has(doc.path));
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
  } catch (error) {
    if (search.value.trim().toLowerCase() !== query) return;
    searchIndex = undefined;
    status.textContent = `Search is unavailable: ${error.message}`;
  }
}

async function start() {
  try {
    const sidebar = document.getElementById('sidebar');
    const dialog = document.getElementById('navigation-dialog');
    const mobile = window.matchMedia('(max-width: 900px)');
    const placeNavigation = () => {
      if (dialog.open) dialog.close();
      if (mobile.matches) dialog.append(sidebar);
      else document.querySelector('.workspace').prepend(sidebar);
    };
    placeNavigation();
    mobile.addEventListener('change', placeNavigation);
    document
      .getElementById('open-navigation')
      .addEventListener('click', () => dialog.showModal());
    document
      .getElementById('close-navigation')
      .addEventListener('click', () => dialog.close());
    sidebar.addEventListener('click', (event) => {
      if (event.target.closest('a') && dialog.open) dialog.close();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
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
    document.querySelector('.skip').addEventListener('click', (event) => {
      event.preventDefault();
      const content = document.getElementById('content');
      content.focus();
      content.scrollIntoView({ block: 'start' });
    });
    window.addEventListener('hashchange', render);
    render();
  } catch (error) {
    article.innerHTML = `<h1>The atlas could not load</h1><p role="alert">${escapeText(error.message)}</p><p>Run npm run docs:learn:build, then serve .kontourai/docs-learning over local HTTP as described in docs/learn/README.md.</p>`;
  }
}

start();
