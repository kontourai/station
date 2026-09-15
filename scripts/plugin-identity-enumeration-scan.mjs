#!/usr/bin/env node
/**
 * Finds HTTP handlers that return PLUGIN IDENTITY and fails when one is not
 * recorded in the inventory (#2067).
 *
 * ## Why this exists
 *
 * `GET /api/plugins` was projected first. A review then found four more
 * enumerators on the same read tier; those were closed, the inventory was
 * written down — and a second review found five more plus the event stream,
 * because the inventory's own test claimed "a new enumerating route added
 * with no inventory row fails the scan" and NO SCAN EXISTED. A promise that
 * nothing computes is the exact defect the inventory was built to prevent,
 * and it is why the family was incomplete twice. This is the thing that
 * computes it.
 *
 * ## What it checks
 *
 * For every route registration it can resolve to a mounted path, it reads the
 * handler body and looks for the shapes plugin identity actually travels in:
 *
 *   - an identifier or property named `plugin`, `pluginName`, `pluginId`,
 *     `installedPluginName`, or `pluginsDir`;
 *   - a string literal containing `plugins/` (the on-disk install path);
 *   - a call to one of the known enumerating readers (`listLayouts`,
 *     `listInstalled`, `readRegistryPluginAvailability`, …);
 *   - `installed` appearing beside a name-bearing projection.
 *
 * Every flagged route must appear in `PLUGIN_IDENTITY_ROUTES` (with a
 * disposition) or in `SCAN_EXCLUSIONS` below (with a written reason).
 *
 * It also checks the SSE relay: every `plugins:*` server event must carry a
 * recorded broadcast disposition, because a stream that relays plugin
 * lifecycle events by name to every listener enumerates the inventory just as
 * surely as a list route does.
 *
 * ## What it deliberately CANNOT do
 *
 * It is a source scan, not a type-aware analysis. This list is exhaustive as
 * far as is known, because a limitation list that omits its own gaps is the
 * same defect as an inventory nothing scans:
 *
 *   - MOUNTING. It resolves prefixes from `runtime-routes.ts`'s own
 *     `app.route(prefix, factory(...))` calls and from `register*Routes(app)`
 *     helpers. A route mounted by any other mechanism is reported as
 *     `(unmounted)` and FAILS the gate rather than being skipped — but a file
 *     the scan never walks is invisible, and it walks `src-server/routes` and
 *     `src-server/runtime/routes` only.
 *   - INDIRECTION. It reads handler SOURCE TEXT, so a handler that returns
 *     plugin identity through a helper whose name matches none of the
 *     signals is missed; new enumerating readers must be added to
 *     `ENUMERATING_READERS` by hand. It cannot follow a handler defined
 *     elsewhere and merely referenced at the mount.
 *   - EXCLUSIONS ARE KEYED BY ROUTE, NOT BY SIGNAL SET. An excluded route is
 *     a permanent pass: adding an enumerating call to an already-excluded
 *     handler is never re-examined. Mitigated only by each exclusion
 *     carrying a reason specific enough to re-check by hand, and by stale
 *     exclusions (routes no longer flagged) being reported.
 *   - DISPOSITION IS NOT BEHAVIOUR, for ROUTES. It asserts a route was
 *     CONSIDERED, never that its disposition is honoured; that is what
 *     `plugin-identity-enumeration.test.ts` drives through the real
 *     handlers. For EVENTS it does check the decision is honoured — that
 *     hole existed, was found by injection, and is closed.
 *   - `:slug` ROWS skip the recorded-but-not-flagged reconciliation, because
 *     the path this scan reconstructs does not always match a parameterised
 *     mount prefix.
 *   - REGISTRATION SHAPE. It matches a literal `app.` receiver and a path as
 *     the FIRST argument, so `router.get(...)`, a destructured `get(...)`, or
 *     `app.on(method, path, ...)` (where the path is the second argument) are
 *     invisible. All three are latent today — nothing in the scanned tree
 *     uses them — and all three are exactly the kind of thing that stops
 *     being latent without anyone noticing, which is why they are written
 *     here rather than left to be rediscovered.
 *
 * It errs toward flagging on purpose. A false positive costs one exclusion
 * line with a reason; a false negative is the defect this file exists for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_ROUTES = 'src-server/runtime/routes/runtime-routes.ts';
const INVENTORY = 'src-server/routes/plugins/plugin-identity-enumeration.ts';
const EVENT_SAFETY = 'packages/contracts/src/runtime-events.ts';

/** Property/identifier names that carry a plugin's identity. */
const IDENTITY_TOKENS = [
  'installedPluginName',
  'pluginName',
  'pluginId',
  'pluginsDir',
];

/** Readers whose return value enumerates installed plugins. */
const ENUMERATING_READERS = [
  'listLayouts',
  'listInstalledLayouts',
  'listInstalled',
  'listPluginWorkspacePaneContributions',
  'scanInstalledPluginInventory',
  'readRegistryPluginAvailability',
  'readCurrentWorkspacePaneCatalog',
  'deriveWorkspaceHomeRoleStatus',
  'listPluginCatalogIdentities',
];

/**
 * Routes the scan flags that are NOT plugin-identity enumerators, each with
 * the reason it is not one. An exclusion is a claim; keep it specific enough
 * that the next reader can check it.
 */
const SCAN_EXCLUSIONS = {
  'POST /api/plugins/preview':
    'Describes a candidate the CALLER named (a git URL or path). It reports nothing about what is already installed, so it enumerates nothing.',
  'POST /api/plugins/install':
    'A mutation naming its own target. It reveals no plugin the caller did not already name.',
  'POST /api/registry/plugins/install':
    'Same: a mutation naming its own target. The `plugins/` signal is the install destination, not a listing.',
  'DELETE /api/registry/plugins/:id':
    'A mutation addressed by id. The `plugins/` signal is the removal path.',
  'POST /api/plugins/home-role/requests':
    'A mutation: it creates a grant request for a pane the caller named, and returns the transaction, not a catalog. The candidate LIST it is paired with is the enumerator, and that one is projected.',
  'POST /api/plugins/host-approvals':
    'A mutation naming its own target; it returns the approval transaction. The `installed+name` signal is the approval record it writes, not a listing of other plugins.',
  'POST /api/projects/:slug/layouts/from-plugin':
    'A mutation applying a plugin layout the caller named to a project. Its lookup is now projected through `projectLayoutCatalogItems` (#2103) — it used to search `listLayouts()` unprojected and answer 404-by-name, which is an existence oracle for a caller guessing names; a hidden plugin and an uninstalled one now get the identical 404. Kept here rather than in the inventory because it is a POST whose 404-vs-201 the inventory test (which drives a bare GET and asserts 200) cannot express.',
  'PUT /api/projects/:slug/layouts/:layoutSlug':
    'A mutation addressed by slug. Its `plugin` signal is the STORED binding, read for two reasons that both withhold rather than disclose: to restore a binding the GET withheld from this caller (so their read-modify-write cannot destroy it), and to project its own response exactly as the GET is projected. The inventory cannot hold it — `PluginIdentityRoute.method` is GET|POST — and its read half is the recorded `GET` row beside it.',
  'GET /api/plugins/:name/bundle.js':
    'Addressed by name: serving it reveals no OTHER plugin. DISCLOSED RESIDUAL — a 200 against a 404 is a weak existence oracle for a caller who can already guess an exact plugin name. Closing that means gating asset delivery on the projection, which is a separate change with its own UI path to prove; it is not an enumeration of the inventory.',
  'GET /api/plugins/:name/bundle.css': 'Same as bundle.js, same residual.',
  'GET /api/plugins/:name/permissions':
    "Addressed by name; reports that plugin's declared and granted permissions. Same existence-oracle residual as the bundle routes. Per-plugin authority is the permission grant state, which this projection deliberately is not.",
  'PUT /api/plugins/:name/settings': 'Addressed by name, and a mutation.',
  'ALL /api/plugins/:name/*':
    "The plugin's own public server mount: it forwards the request into the named plugin's server module. Addressed by name, reveals no OTHER plugin, and carries the same 200-vs-404 existence-oracle residual as the bundle routes. Found only when this scan was widened past four verbs — it had been outside the promise entirely.",
  'POST /api/plugins/:name/update':
    'A mutation updating the plugin the caller named. Its signals are the update transaction it writes about that one plugin.',
  'DELETE /api/plugins/:name':
    'A mutation removing the plugin the caller named.',
  'POST /api/plugins/:name/grant':
    'A mutation granting permissions to the plugin the caller named. Permission grants are execution authority, a separate axis this projection deliberately is not.',
  'DELETE /api/plugins/:name/grant':
    'A mutation revoking permissions from the plugin the caller named.',
};

/** Read every `.ts` under a directory, skipping tests and fixtures. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(path, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** factory name -> mounted prefix, from the runtime's own composition. */
function mountPrefixes() {
  const source = readFileSync(join(ROOT, RUNTIME_ROUTES), 'utf8');
  const prefixes = new Map();
  for (const match of source.matchAll(
    /app\.route\(\s*\n?\s*'([^']+)',\s*\n?\s*(\w+)\(/g,
  )) {
    if (!prefixes.has(match[2])) prefixes.set(match[2], match[1]);
  }
  return prefixes;
}

/**
 * file -> mounted prefix. A file earns one by exporting a mounted factory, or
 * by exporting a `register*Routes(app, …)` helper that a mounted factory
 * calls with its own app (the plugin route family is built this way).
 */
function filePrefixes(files, prefixes) {
  const byFile = new Map();
  const exportsIn = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const names = [...source.matchAll(/export function (\w+)\s*\(/g)].map(
      (m) => m[1],
    );
    exportsIn.set(file, names);
    for (const name of names) {
      if (prefixes.has(name) && !byFile.has(file)) {
        byFile.set(file, prefixes.get(name));
      }
    }
  }
  // Propagate: a mounted file that calls register*Routes(app, …) lends its
  // prefix to the file exporting that helper. Two passes is enough for the
  // one level of nesting this codebase uses.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [file, prefix] of [...byFile]) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /\b(register\w*Routes)\s*\(\s*app/g,
      )) {
        for (const [other, names] of exportsIn) {
          if (names.includes(match[1]) && !byFile.has(other)) {
            byFile.set(other, prefix);
          }
        }
      }
    }
  }
  return byFile;
}

/**
 * The handler text for one registration.
 *
 * Paren matching, but string- and comment-aware: the naive version counted a
 * `)` inside a string literal or a comment and truncated the body before its
 * identity tokens, which under-reports silently. On a malformed file it errs
 * LONG (a fixed window) because over-reading costs a false positive and a
 * written exclusion, while under-reading costs a miss.
 */
function handlerBody(source, start) {
  let depth = 0;
  let quote = null;
  let comment = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (comment === 'line') {
      if (ch === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') {
        comment = null;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      comment = 'line';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      comment = 'block';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start, start + 8000);
}

function identitySignals(body) {
  const hits = [];
  for (const token of IDENTITY_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(body)) hits.push(token);
  }
  for (const reader of ENUMERATING_READERS) {
    if (new RegExp(`\\b${reader}\\s*\\(`).test(body)) hits.push(`${reader}()`);
  }
  if (/['"`][^'"`]*plugins\/[^'"`]*['"`]/.test(body))
    hits.push('plugins/ path');
  // A bare `plugin:` property or `plugin` field on a returned object.
  if (/\bplugin\s*:/.test(body)) hits.push('plugin field');
  if (/\binstalled\b/.test(body) && /\bname\b/.test(body)) {
    hits.push('installed+name');
  }
  return hits;
}

function scanRoutes() {
  const prefixes = mountPrefixes();
  const roots = ['src-server/routes', 'src-server/runtime/routes'].map((d) =>
    join(ROOT, d),
  );
  const files = roots.flatMap((d) =>
    statSync(d).isDirectory() ? sourceFiles(d) : [],
  );
  const byFile = filePrefixes(files, prefixes);
  const flagged = [];
  const unresolved = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const prefix = byFile.get(file);
    for (const match of source.matchAll(
      // Every verb this codebase mounts with, including `patch`, `all` and
      // `on` — an earlier version scanned four verbs while
      // `plugin-public-routes.ts` already used `app.all` and three other
      // files used `app.patch`, so a whole verb class sat outside the
      // promise. All three quote styles, for the same reason.
      /\bapp\.(get|post|put|patch|delete|all|on)\(\s*\n?\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g,
    )) {
      const routePath = match[2] ?? match[3] ?? match[4] ?? '';
      const body = handlerBody(source, match.index);
      const hits = identitySignals(body);
      if (hits.length === 0) continue;
      const rel = relative(ROOT, file);
      if (prefix === undefined) {
        unresolved.push({ file: rel, path: routePath, hits });
        continue;
      }
      const full = `${prefix}${routePath === '/' ? '' : routePath}` || '/';
      flagged.push({
        key: `${match[1].toUpperCase()} ${full}`,
        file: rel,
        hits,
      });
    }
  }
  return { flagged, unresolved };
}

function inventoryKeys() {
  const source = readFileSync(join(ROOT, INVENTORY), 'utf8');
  const keys = new Map();
  for (const match of source.matchAll(
    /method: '(\w+)',\s*\n\s*path: '([^']+)',\s*\n\s*disposition: '([^']+)'/g,
  )) {
    keys.set(`${match[1]} ${match[2]}`, match[3]);
  }
  return keys;
}

/**
 * The plugin lifecycle channels, derived from the broadcast-safety map itself
 * rather than from a list kept beside it — a second list is a second thing to
 * drift, and this check exists because the first version of it asserted a
 * recorded decision without asserting the decision was honoured.
 *
 * Why these six matter: `GET /events` relays every 'broadcast' channel to
 * every listener unconditionally. While they were 'broadcast', a collaborator
 * who merely held the stream open watched the instance's plugin inventory
 * change by name — install, remove, update, settings, grants,
 * updates-available — which enumerates exactly what `GET /api/plugins` is
 * projected to withhold, spread over time instead of in one response. They
 * are 'scoped' now, which in that relay means denied unless a named gate
 * recognizes the channel, and the gate is the same projection.
 */
function pluginEventDispositions() {
  const source = readFileSync(join(ROOT, EVENT_SAFETY), 'utf8');
  const events = [];
  for (const match of source.matchAll(
    /\[SERVER_EVENTS\.(PLUGINS_\w+)\]:\s*'(\w+)'/g,
  )) {
    events.push({ event: match[1], safety: match[2] });
  }
  return events;
}

function main() {
  const { flagged, unresolved } = scanRoutes();
  const inventory = inventoryKeys();
  const failures = [];

  const seen = new Set();
  for (const route of flagged) {
    if (seen.has(route.key)) continue;
    seen.add(route.key);
    if (inventory.has(route.key)) continue;
    if (SCAN_EXCLUSIONS[route.key]) continue;
    failures.push(
      `  ${route.key}\n      ${route.file}\n      signals: ${route.hits.join(', ')}`,
    );
  }

  for (const route of unresolved) {
    failures.push(
      `  (unmounted) ${route.path}\n      ${route.file}\n      signals: ${route.hits.join(', ')}\n      This file's mount prefix could not be resolved, so the scan cannot name the route. Mount it through runtime-routes.ts or record it by hand.`,
    );
  }

  // The event relay. A plugin lifecycle event broadcast by name to every
  // listener enumerates the inventory over time.
  const events = pluginEventDispositions();
  const inventoryText = readFileSync(join(ROOT, INVENTORY), 'utf8');
  for (const { event, safety } of events) {
    // Two different failures, and the first one is the one that matters.
    //
    // Recording a decision is not honouring it: an earlier version of this
    // scan only asked whether the channel was NAMED in the inventory, so
    // flipping all six back to 'broadcast' passed — the exact regression the
    // check exists to stop, waved through by the check itself. A channel the
    // inventory claims is scoped must BE scoped.
    if (inventoryText.includes(event)) {
      if (safety !== 'scoped') {
        failures.push(
          `  SERVER_EVENTS.${event} is recorded in the inventory as a scoped plugin channel but is '${safety}'.\n      'broadcast' relays it to EVERY listener on GET /events unconditionally, which enumerates plugin identity over time.`,
        );
      }
      continue;
    }
    if (safety !== 'broadcast') continue;
    failures.push(
      `  SERVER_EVENTS.${event} is 'broadcast' and has no disposition recorded in the inventory.\n      Every listener on GET /events receives it, so it enumerates plugin identity over time.`,
    );
  }

  // The exclusions are claims; an exclusion for a route the scan no longer
  // flags is a stale claim, and stale claims are how an inventory rots.
  for (const key of Object.keys(SCAN_EXCLUSIONS)) {
    if (!seen.has(key)) {
      failures.push(
        `  stale exclusion: ${key} is excluded but the scan no longer flags it. Remove the exclusion.`,
      );
    }
  }
  for (const [key] of inventory) {
    // `:slug`-mounted rows are exempt from the recorded-but-not-flagged
    // check because their mount prefix is itself parameterised
    // (`/api/projects/:slug/...`), so the key this scan reconstructs from
    // `app.route` + `app.get` does not always match the inventory's written
    // path. The exemption is about the scan's own path arithmetic, not about
    // those routes being less important — each is driven through its real
    // handler in `plugin-identity-enumeration.test.ts`'s ELSEWHERE map.
    if (!seen.has(key) && !key.includes(':slug')) {
      failures.push(
        `  inventory row ${key} is recorded but the scan does not flag it. Either the route moved or the row is stale.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      'FAIL: plugin-identity enumeration scan\n\n' +
        'These handlers return plugin identity and are not recorded in\n' +
        `${INVENTORY}:\n\n${failures.join('\n\n')}\n\n` +
        'Give each one a disposition (projected | operator-only) with a\n' +
        'rationale, or add a SCAN_EXCLUSIONS entry saying why it does not\n' +
        'enumerate. #2067: the acceptance criterion is that a collaborator\n' +
        "cannot learn this instance's plugin inventory.",
    );
    process.exit(1);
  }
  console.log(
    `OK: plugin-identity enumeration scan — ${seen.size} handler(s) carry plugin-identity signals; ` +
      `${inventory.size} recorded with a disposition, ${Object.keys(SCAN_EXCLUSIONS).length} excluded with a reason, ` +
      `${events.length} plugin event(s) checked.`,
  );
}

main();
