// The public /public/ page: Kontour's noisy weekly aggregates as a few
// headline charts. It reads only GET /v1/public/aggregates (every page) and
// changes nothing about what is published.
//
// Every cell is a separately noised count clipped at zero, so the page never
// adds cells together: clipping turns zero-mean noise into a positive bias
// (about +140 per empty cell at the published noise scale), and a sum of six
// channels would report hundreds of network-days that never happened.
//
// One rule decides every number the page shows: a card (the weekly chart,
// or one dimension's bars) shows a cell only above that card's threshold;
// anything else reads "within noise". Naming a leader compares two noisy
// cells, so it uses a bound for their difference. All of this is
// post-processing of the published output, so the privacy guarantee is
// unchanged.
//
// The thresholds. Each cell carries two-sided geometric noise X with
// alpha = exp(-epsilon): P(X >= k) = alpha^k / (1 + alpha) for k >= 1.
// - A card with m candidate cells (weeks for the chart, a dimension's
//   values otherwise) shows a false bar for a true zero only if some cell's
//   noise exceeds the threshold t. By the union (Bonferroni) bound that
//   chance is at most m alpha^t / (1 + alpha); setting it to 5% gives
//   t = ln(m / (0.05 (1 + alpha))) / epsilon. At epsilon = 1/280 that is
//   about 645 for one cell, 1,033 for four and 1,692 for 42.
// - At epsilon = 1/280 the noise is closely approximated by a Laplace
//   distribution with scale b = 1/epsilon = 280. The difference of two
//   independent Laplace(b) variables, whose tail is
//   P(|X - Y| > t) = (1 + t/(2b)) exp(-t/b). Solving for 5% gives
//   t = u b with (1 + u/2) exp(-u) = 0.05, so u is about 4.11 and t is about
//   1,151 network-days. The page solves for u numerically.
import { DASHBOARD_KIT_JS, DASHBOARD_STYLE } from './dashboard-kit.js';

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Station usage</title><style>${DASHBOARD_STYLE}</style>
<script src="/public/dashboard.js" defer></script></head><body><main>
<header class="top"><div><h1>Station usage</h1>
<p class="sub">Weekly estimates from Station's anonymous daily count · last four closed weeks (UTC)</p></div>
<div><a href="/insights">Private insights</a> · <a href="/v1/public/aggregates">Aggregate JSON</a></div></header>
<p class="muted" id="publication"></p>
<p class="muted" id="status" role="status">Loading…</p>
<div id="tiles" class="tiles"></div>
<div id="charts" class="grid"></div>
<p class="muted">Estimates with privacy noise added, not counts of people. Small estimates cannot be reliably separated from the added noise.</p>
</main></body></html>`;

const PAGE_JS = `
(function () {
  var C = window.StationCharts;
  var status = document.getElementById('status'), tiles = document.getElementById('tiles'), charts = document.getElementById('charts');
  var LABELS = { engines_used_today: 'Harnesses used', platform: 'Platform', arch: 'Architecture', surfaces_today: 'Surfaces used', version: 'Versions', channel: 'Release channel', distribution: 'Distribution', public_plugins_enabled: 'Public plugins' };
  function load() {
    var cells = [], epsilon = 0, databaseDay, deliveryCoverage;
    function page(cursor) {
      return fetch('/v1/public/aggregates' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('unavailable'); return r.json(); })
        .then(function (data) {
          cells.push.apply(cells, data.cells);
          epsilon = data.epsilonPerCount;
          databaseDay = data.databaseDay; deliveryCoverage = data.deliveryCoverage;
          return data.nextCursor ? page(data.nextCursor) : { cells: cells, epsilon: epsilon, databaseDay: databaseDay, deliveryCoverage: deliveryCoverage };
        });
    }
    return page(null);
  }
  function render(data) {
    var cells = data.cells;
    var alpha = Math.exp(-data.epsilon);
    // The card threshold for m candidate cells (see the module comment).
    function threshold(m) {
      return data.epsilon > 0 && m > 0 ? Math.log(m / (0.05 * (1 + alpha))) / data.epsilon : Infinity;
    }
    var leadBound = data.epsilon > 0 ? differenceTail95() / data.epsilon : Infinity;
    tiles.replaceChildren(); charts.replaceChildren();
    var weeks = Array.from(new Set(cells.map(function (c) { return c.week; }))).sort();
    if (!weeks.length) { status.textContent = 'No week has been published yet.'; return; }
    status.textContent = '';
    var latest = weeks[weeks.length - 1];
    var through = new Date(Date.parse(latest + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
    document.getElementById('publication').textContent = 'Published weeks through ' + through + ' (UTC). The current week is published after it closes on Monday.' + (data.deliveryCoverage === 'unknown' ? ' Collection coverage has not been verified.' : '');
    function values(week, dimension) {
      return cells.filter(function (c) { return c.week === week && c.dimension === dimension; });
    }
    function cell(week, dimension, value) {
      var found = values(week, dimension).filter(function (c) { return c.value === value; })[0];
      return found ? found.estimate : 0;
    }
    // One cell per week, never a sum: networks whose ping that day was their
    // first of the ISO week. The headline is the chart's latest week, so it
    // uses the chart's threshold.
    var active = weeks.map(function (w) { return cell(w, 'first_active_this_week', 'true'); });
    var weekBound = threshold(weeks.length);
    function aboveNoise(estimate) { return estimate > weekBound; }
    function shown(estimate) { return aboveNoise(estimate) ? '≈ ' + C.compact(estimate) : 'Too few to show'; }
    var current = active[active.length - 1], prior = active.length > 1 ? active[active.length - 2] : null;
    var dimensions = ['engines_used_today', 'platform', 'surfaces_today', 'version', 'arch', 'channel'];
    var hasSignal = active.some(aboveNoise) || dimensions.some(function (dimension) {
      var rows = values(latest, dimension).filter(function (c) { return c.value !== 'none'; });
      return rows.some(function (c) { return c.estimate > threshold(rows.length); });
    });
    if (!hasSignal) {
      var empty = C.card(charts, 'No reliable public estimates yet', 'The published estimates are too uncertain to interpret.', 'wide');
      C.h('p', '', 'This does not mean there was no activity. Privacy noise can overwhelm small counts, and the current week is not included yet.', empty.body);
      C.h('a', '', 'View exact recent activity in private insights', empty.body).href = '/insights';
      status.textContent = 'Showing the available weekly publication.';
      return;
    }
    var hero = C.stat(tiles, 'Weekly active networks, week of ' + C.shortDay(latest), shown(current),
      prior !== null && aboveNoise(prior) ? 'Previous week ≈ ' + C.compact(prior) : '', true);
    if (!aboveNoise(current)) hero.querySelector('.value').classList.add('quiet');
    function leader(label, dimension) {
      var ranked = values(latest, dimension).filter(function (c) { return c.value !== 'none'; })
        .sort(function (a, b) { return b.estimate - a.estimate; });
      var top = ranked[0], next = ranked[1] ? ranked[1].estimate : 0;
      if (top && top.estimate > threshold(ranked.length) && top.estimate - next > leadBound)
        C.stat(tiles, label, top.value, '≈ ' + C.compact(top.estimate) + ' network-days');
    }
    leader('Most used harness', 'engines_used_today');
    leader('Top platform', 'platform');

    var trend = C.card(charts, 'Weekly active networks', 'Network-days that were a first activity of the ISO week · one noisy estimate per closed week', 'wide');
    var masked = active.map(function (v, i) { return aboveNoise(v) ? -1 : i; }).filter(function (i) { return i >= 0; });
    C.columnChart(trend.body, { labels: weeks, values: active, masked: masked, labelCount: 4, titleFormat: function (w) { return 'Week of ' + C.shortDay(w); }, unit: 'network-days', ariaLabel: 'Weekly active networks' });
    C.table(trend.body, ['Week of', 'Estimate'], weeks.map(function (w, i) { return [w, aboveNoise(active[i]) ? C.full(active[i]) : 'within noise']; }));

    ['engines_used_today', 'platform', 'surfaces_today', 'version', 'arch', 'channel'].forEach(function (dimension) {
      // A dimension with no published cells (an empty version catalog) gets no card.
      if (!values(latest, dimension).length) return;
      var listed = values(latest, dimension).filter(function (c) { return c.value !== 'none'; })
        .sort(function (a, b) { return b.estimate - a.estimate || (a.value < b.value ? -1 : 1); });
      var cardBound = threshold(listed.length);
      var rows = listed.filter(function (c) { return c.estimate > cardBound; })
        .map(function (c) { return { label: c.value, value: c.estimate }; });
      var quiet = listed.filter(function (c) { return !(c.estimate > cardBound); });
      var card = C.card(charts, LABELS[dimension], 'Week of ' + C.shortDay(latest) + ' · each bar is its own estimate', 'third');
      C.barList(card.body, rows, { unit: 'network-days', folded: quiet.length });
      C.table(card.body, ['Value', 'Estimate'], rows.map(function (r) { return [r.label, C.full(r.value)]; })
        .concat(quiet.map(function (c) { return [c.value, 'within noise']; })));
    });
  }
  // u with (1 + u/2) exp(-u) = 0.05: the 95% tail of the difference of two
  // independent Laplace variables, in units of their scale (see the module comment).
  function differenceTail95() {
    var lo = 0, hi = 20;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if ((1 + mid / 2) * Math.exp(-mid) > 0.05) lo = mid; else hi = mid;
    }
    return hi;
  }
  load().then(function (data) { render(data); C.onResize(function () { render(data); }); })
    .catch(function () { status.textContent = 'Weekly estimates are unavailable. Try again later.'; });
})();
`;

export const DASHBOARD_JS = DASHBOARD_KIT_JS + PAGE_JS;
