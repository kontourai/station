import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * station#3392. A control filled with the accent and painted with a foreground
 * that is not derived FROM that accent is a colour pair nothing computes: the
 * accent moves per theme and per custom accent, and a literal — or a token
 * derived from something else, like the page background — cannot follow it.
 * Measured on the shipped dark brand (#5ce0c6), white reads 1.62:1.
 *
 * Modelled on `focus-visible-ratchet.mjs`: a checked-in inventory of NAMED
 * offenders, not a count. A count-ratchet reds on whoever gates next rather
 * than on the author, and the cheapest way out of it is to raise the number;
 * an occurrence list names the exact rule that regressed, in the diff that
 * introduced it.
 *
 * Deliberately NOT a shared `.accent-fill` utility class (station#3377): a
 * shared colour rule at utility specificity was silently inert at four of six
 * adopters, because later same-specificity component rules and lazily injected
 * chunk stylesheets win. Each component consumes the tokens in its own rule;
 * this gate is what keeps that honest.
 *
 * WHAT THIS GATE CANNOT SEE, so the next author does not read a green run as
 * more than it is (station#3392 review):
 *
 * 1. An accent-filled rule that declares NO `color` at all, and a DESCENDANT
 *    of one. Both render a foreground this never inspects — it is inherited
 *    from an ancestor, not declared here. `.auto-select-modal__item--selected
 *    .auto-select-modal__active-indicator` was exactly that, white on the
 *    accent, and had to be found by reading the file rather than by this gate.
 * 2. Inline styles in `.tsx`. This reads stylesheets only; a `style={{
 *    background: 'var(--accent-primary)', color: '#fff' }}` is invisible to it.
 *
 * Both are real instances of the same defect. Closing them means parsing
 * inheritance and JSX respectively, which is a different tool; until then this
 * gate covers declared CSS pairs and says so.
 */
const ROOT = process.cwd();
const INVENTORY = join(ROOT, 'docs/ui/accent-foreground-exceptions.json');
/**
 * Everything whose CSS the APP ships. `packages/sdk/src` is here because the
 * app imports its components — `AutoSelectModal` is re-exported by src-ui and
 * `FullScreenLoader` is rendered by `PlatformProfileContext` — so its rules
 * land in the same built stylesheets as src-ui's; four white-on-accent rules
 * were live in the entry stylesheet while this gate reported the class clean.
 * Most of `examples/` is deliberately absent: those are standalone demo apps,
 * not surfaces this product renders. The three STARTER plugins are the
 * exception — `examples/registry/manifest.json` publishes them, Station
 * installs them, and their layouts render inside the shell, so their CTA is a
 * surface this product paints. All three shipped `color: var(--accent-contrast,
 * #fff)` on an `--accent-primary` fill; `--accent-contrast` is defined nowhere
 * in this repo, so the fallback won and the label rendered white at 1.62:1 —
 * the exact pair measured in this file's opening paragraph, in the one part of
 * `examples/` the gate could not see (#1582 G9).
 *
 * The scope split also decides the FALLBACK. A starter renders only inside the
 * shell, so it consumes `--text-on-accent` bare, which is what this gate
 * requires — a fallback on this pair is the same defect wherever the token is
 * absent. The demo apps outside this scope keep `var(--text-on-accent, #fff)`:
 * they may render with no Station token layer at all, where their own literal
 * fill is one white text belongs on. `ConnectionManagerDiscoverPanel` keeps
 * `var(--text-on-accent, white)` for the same reason — and note that it is an
 * INLINE JSX style, so this gate never reads that declaration either way
 * (limitation 2 above): its root is in scope, the rule is not (review L3).
 */
const SOURCE_ROOTS = [
  'src-ui/src',
  'packages/connect/src/react',
  'packages/sdk/src',
  'examples/getting-started-starter/src',
  'examples/coding-starter/src',
  'examples/knowledge-docs-starter/src',
];

/** Fill tokens whose contrast partner is derived at runtime. */
const ACCENT_FILL_TOKENS = new Set([
  '--accent-primary',
  '--accent-hover-fill',
  '--accent-darker',
]);
/** Fill tokens that resolve to the yellow accent. */
const YELLOW_FILL_TOKENS = new Set(['--accent-yellow', '--color-accent']);

/** The foreground each fill family must consume. */
const PARTNER = {
  accent: ['--text-on-accent'],
  yellow: ['--text-on-accent-yellow'],
};

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function normalizeSelector(selector) {
  return selector.replace(/\s+/g, ' ').trim();
}

/**
 * `var(--a, var(--b))` nests, so a `[^)]*` fallback pattern stops at the inner
 * paren and misses the declaration entirely — which is exactly how the two
 * first-run controls this issue names escaped an earlier scan. Read the value
 * by matching parens instead.
 */
function readValue(declarations, property) {
  const pattern = new RegExp(`(?<![-\\w])${property}\\s*:`, 'g');
  for (const match of declarations.matchAll(pattern)) {
    let index = match.index + match[0].length;
    let depth = 0;
    let value = '';
    while (index < declarations.length) {
      const character = declarations[index];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (character === ';' && depth === 0) break;
      value += character;
      index += 1;
    }
    return value.trim();
  }
  return null;
}

/** The token a value is exactly, ignoring any literal fallback. */
function rootToken(value) {
  const match = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(value ?? '');
  return match ? { token: match[1], fallback: (match[2] ?? '').trim() } : null;
}

/**
 * The token of a value that BEGINS with `var(...)`, ignoring whatever
 * shorthand follows it (`background: var(--accent-primary) no-repeat`).
 *
 * Deliberately anchored at the start rather than "the first var() anywhere":
 * `color-mix(in srgb, var(--accent-primary) 8%, …)` and gradients also lead
 * with a function that mentions the token, and those are TINTS whose correct
 * foreground is often the accent itself. Matching them would make this gate
 * fire on rules that are already right, which is how a gate gets ignored.
 */
function leadingVarToken(value) {
  const text = (value ?? '').trim();
  if (!text.startsWith('var(')) return null;
  let depth = 0;
  for (let index = 3; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return rootToken(text.slice(0, index + 1));
    }
  }
  return null;
}

/**
 * A SOLID fill, not a tint. `color-mix(in srgb, var(--accent-primary) 8%, …)`
 * and gradients also mention the token, and a foreground of the accent itself
 * is correct on those — flagging them would train authors to ignore this gate.
 */
function solidFillToken(declarations) {
  for (const property of ['background', 'background-color']) {
    const value = readValue(declarations, property);
    if (!value) continue;
    const cleaned = value.replace(/\s*!important$/, '').trim();
    // `background` is a shorthand, so a token may be followed by legitimate
    // extras. `background-color` takes exactly one colour, so anything after
    // the token makes the declaration INVALID and the browser drops it whole —
    // reading such a rule as an accent fill would report a fill that never
    // paints (`background-color: var(--accent-primary) 20` is a real example
    // in this tree).
    const root =
      property === 'background' ? leadingVarToken(cleaned) : rootToken(cleaned);
    if (!root) continue;
    if (ACCENT_FILL_TOKENS.has(root.token))
      return { family: 'accent', token: root.token };
    if (YELLOW_FILL_TOKENS.has(root.token))
      return { family: 'yellow', token: root.token };
    // A fallback CHAIN still resolves to a fill token when the outer name is
    // undefined, e.g. `var(--color-accent, var(--color-primary))`.
    const inner = rootToken(root.fallback);
    if (inner && YELLOW_FILL_TOKENS.has(inner.token))
      return { family: 'yellow', token: inner.token };
  }
  return null;
}

/**
 * Every solid accent fill that declares a foreground, with whether that
 * foreground is the fill's derived partner. One reading serves both consumers:
 * this gate filters it to `derived: false`, and
 * `src-ui/src/__tests__/accent-fill-foreground.test.ts` takes the `true` half
 * and measures each one. A second detector beside this one would eventually
 * disagree with it about what an accent fill is.
 */
export function findAccentFilledRules(css, path) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = normalizeSelector(match[1]);
    if (selector.startsWith('@')) continue;
    const declarations = match[2];
    const fill = solidFillToken(declarations);
    if (!fill) continue;
    const foreground = readValue(declarations, 'color');
    if (foreground === null) continue;
    const root = rootToken(foreground);
    const derived = Boolean(
      root &&
        PARTNER[fill.family].includes(root.token) &&
        // A literal fallback on a derived token is the same defect wearing the
        // right name: it is what actually paints wherever the token is unset.
        root.fallback === '',
    );
    rules.push({
      path,
      selector,
      fill: fill.family,
      fillToken: fill.token,
      foreground,
      derived,
    });
  }
  return rules;
}

export function discoverAccentFilledRules(root = ROOT) {
  return SOURCE_ROOTS.flatMap((sourceRoot) =>
    walk(join(root, sourceRoot))
      .filter((path) => path.endsWith('.css'))
      .flatMap((path) =>
        findAccentFilledRules(
          readFileSync(path, 'utf8'),
          relative(root, path).replaceAll('\\', '/'),
        ),
      ),
  ).sort((a, b) =>
    `${a.path}|${a.selector}`.localeCompare(`${b.path}|${b.selector}`),
  );
}

export function discoverAccentForegroundOffenders(root = ROOT) {
  return discoverAccentFilledRules(root)
    .filter((rule) => !rule.derived)
    .map(({ path, selector, fill, foreground }) => ({
      path,
      selector,
      fill,
      foreground,
    }));
}

function key(entry) {
  return `${entry.path}|${entry.selector}`;
}

export function validateAccentForegroundInventory(
  root = ROOT,
  inventoryPath = INVENTORY,
) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const entries = inventory.exceptions ?? [];
  const discovered = discoverAccentForegroundOffenders(root);
  const discoveredKeys = discovered.map(key);
  const inventoryKeys = entries.map(key);
  const missing = discovered.filter(
    (entry) => !inventoryKeys.includes(key(entry)),
  );
  const stale = entries.filter((entry) => !discoveredKeys.includes(key(entry)));
  const invalid = entries.filter(
    (entry) =>
      typeof entry.path !== 'string' ||
      typeof entry.selector !== 'string' ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length < 8,
  );
  const duplicates = inventoryKeys.filter(
    (entryKey, index) => inventoryKeys.indexOf(entryKey) !== index,
  );

  if (missing.length || stale.length || invalid.length || duplicates.length) {
    const lines = [];
    for (const entry of missing) {
      lines.push(
        `NEW accent-filled control with an underived foreground: ${entry.path} — ${entry.selector} paints "${entry.foreground}" on a ${entry.fill} fill. Consume var(${PARTNER[entry.fill][0]}) (and var(--accent-hover-fill) if this control changes fill on hover), or add a reviewed entry to docs/ui/accent-foreground-exceptions.json.`,
      );
    }
    for (const entry of stale) {
      lines.push(
        `STALE inventory entry: ${entry.path} — ${entry.selector} no longer pairs an accent fill with an underived foreground. Remove it; the list must shrink as controls migrate.`,
      );
    }
    for (const entry of invalid) {
      lines.push(
        `INVALID inventory entry (needs path, selector and a reason of at least 8 characters): ${entry.path} — ${entry.selector}`,
      );
    }
    for (const entryKey of duplicates) {
      lines.push(`DUPLICATE inventory entry: ${entryKey}`);
    }
    throw new Error(lines.join('\n'));
  }

  return { total: discovered.length };
}

if (process.argv[1]?.endsWith('accent-foreground-ratchet.mjs')) {
  const result = validateAccentForegroundInventory();
  console.log(
    `Accent-foreground ratchet: ${result.total} reviewed accent fills with an underived foreground; new ones are blocked.`,
  );
}
