// The public /public/ page: Kontour's noisy weekly aggregates as a few
// headline charts. It reads only GET /v1/public/aggregates (every page) and
// changes nothing about what is published.
//
// Every cell is a separately noised count clipped at zero, so the page never
// adds cells together: clipping turns zero-mean noise into a positive bias
// (about +140 per empty cell at the published noise scale), and a sum of six
// channels would report hundreds of network-days that never happened. It
// also names a "top" value only when that value clears the noise bound and
// its runner-up by the same margin. Both are post-processing of the
// published output, so the privacy guarantee is unchanged.
import { DASHBOARD_KIT_JS, DASHBOARD_STYLE } from './dashboard-kit.js';

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Station usage</title><style>${DASHBOARD_STYLE}</style>
<script src="/public/dashboard.js" defer></script></head><body><main>
<header class="top"><div><h1>Station usage</h1>
<p class="sub">Weekly estimates from Station's anonymous daily count · last four closed weeks (UTC)</p></div>
<a href="/v1/public/aggregates">Aggregate JSON</a></header>
<p class="muted" id="status" role="status">Loading…</p>
<div id="tiles" class="tiles"></div>
<div id="charts" class="grid"></div>
<p class="muted">Estimates with privacy noise added, not counts of people. Small values are unreliable.</p>
</main></body></html>`;

const PAGE_JS = `
(function () {
  var C = window.StationCharts;
  var status = document.getElementById('status'), tiles = document.getElementById('tiles'), charts = document.getElementById('charts');
  var LABELS = { engines_used_today: 'Harnesses used', platform: 'Platform', arch: 'Architecture', surfaces_today: 'Surfaces used', version: 'Versions', channel: 'Release channel', distribution: 'Distribution', public_plugins_enabled: 'Public plugins' };
  function load() {
    var cells = [], epsilon = 0;
    function page(cursor) {
      return fetch('/v1/public/aggregates' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('unavailable'); return r.json(); })
        .then(function (data) {
          cells.push.apply(cells, data.cells);
          epsilon = data.epsilonPerCount;
          return data.nextCursor ? page(data.nextCursor) : { cells: cells, epsilon: epsilon };
        });
    }
    return page(null);
  }
  function render(data) {
    var cells = data.cells;
    // 95% of the two-sided geometric noise at this epsilon lies within this
    // many network-days (about 839 at epsilon 1/280).
    var bound = data.epsilon > 0 ? Math.log(20) / data.epsilon : Infinity;
    tiles.replaceChildren(); charts.replaceChildren();
    var weeks = Array.from(new Set(cells.map(function (c) { return c.week; }))).sort();
    if (!weeks.length) { status.textContent = 'No week has been published yet.'; return; }
    status.textContent = '';
    var latest = weeks[weeks.length - 1];
    function values(week, dimension) {
      return cells.filter(function (c) { return c.week === week && c.dimension === dimension; });
    }
    function cell(week, dimension, value) {
      var found = values(week, dimension).filter(function (c) { return c.value === value; })[0];
      return found ? found.estimate : 0;
    }
    function shown(estimate) { return estimate > bound ? '≈ ' + C.compact(estimate) : 'Too few to show'; }
    // One cell, never a sum: networks whose ping that day was their first of the ISO week.
    var active = weeks.map(function (w) { return cell(w, 'first_active_this_week', 'true'); });
    var current = active[active.length - 1], prior = active.length > 1 ? active[active.length - 2] : null;
    C.stat(tiles, 'Weekly active networks, week of ' + C.shortDay(latest), shown(current),
      prior !== null && prior > bound ? 'Previous week ≈ ' + C.compact(prior) : '', true);
    function leader(label, dimension) {
      var ranked = values(latest, dimension).filter(function (c) { return c.value !== 'none'; })
        .sort(function (a, b) { return b.estimate - a.estimate; });
      var top = ranked[0], next = ranked[1] ? ranked[1].estimate : 0;
      if (top && top.estimate > bound && top.estimate - next > bound)
        C.stat(tiles, label, top.value, '≈ ' + C.compact(top.estimate) + ' network-days');
    }
    leader('Most used harness', 'engines_used_today');
    leader('Top platform', 'platform');

    var trend = C.card(charts, 'Weekly active networks', 'Network-days that were a first activity of the ISO week · one noisy estimate per closed week', 'wide');
    C.columnChart(trend.body, { labels: weeks, values: active, labelCount: 4, titleFormat: function (w) { return 'Week of ' + C.shortDay(w); }, unit: 'network-days', ariaLabel: 'Weekly active networks' });
    C.table(trend.body, ['Week of', 'Estimate'], weeks.map(function (w, i) { return [w, C.full(active[i])]; }));

    ['engines_used_today', 'platform', 'surfaces_today', 'version', 'arch', 'channel'].forEach(function (dimension) {
      // A dimension with no published cells (an empty version catalog) gets no card.
      if (!values(latest, dimension).length) return;
      var rows = values(latest, dimension).filter(function (c) { return c.value !== 'none' && c.estimate > 0; })
        .sort(function (a, b) { return b.estimate - a.estimate || (a.value < b.value ? -1 : 1); })
        .slice(0, 8).map(function (c) { return { label: c.value, value: c.estimate }; });
      var card = C.card(charts, LABELS[dimension], 'Week of ' + C.shortDay(latest) + ' · each bar is its own estimate', 'third');
      C.barList(card.body, rows, { unit: 'network-days' });
      C.table(card.body, ['Value', 'Estimate'], rows.map(function (r) { return [r.label, C.full(r.value)]; }));
    });
  }
  load().then(function (data) { render(data); C.onResize(function () { render(data); }); })
    .catch(function () { status.textContent = 'Weekly estimates are unavailable. Try again later.'; });
})();
`;

export const DASHBOARD_JS = DASHBOARD_KIT_JS + PAGE_JS;
