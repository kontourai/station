// The public /public/ page: Kontour's noisy weekly aggregates as a few
// headline charts. It reads only GET /v1/public/aggregates (every page) and
// changes nothing about what is published.
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
<p class="muted">Counts are network-days with privacy noise added, so small values are unreliable and multi-valued sets overlap.</p>
</main></body></html>`;

const PAGE_JS = `
(function () {
  var C = window.StationCharts;
  var status = document.getElementById('status'), tiles = document.getElementById('tiles'), charts = document.getElementById('charts');
  var LABELS = { engines_used_today: 'Harnesses used', platform: 'Platform', arch: 'Architecture', surfaces_today: 'Surfaces used', version: 'Versions', channel: 'Release channel', distribution: 'Distribution', public_plugins_enabled: 'Public plugins' };
  function load() {
    var cells = [];
    function page(cursor) {
      return fetch('/v1/public/aggregates' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('unavailable'); return r.json(); })
        .then(function (data) { cells.push.apply(cells, data.cells); return data.nextCursor ? page(data.nextCursor) : cells; });
    }
    return page(null);
  }
  function render(cells) {
    tiles.replaceChildren(); charts.replaceChildren();
    var weeks = Array.from(new Set(cells.map(function (c) { return c.week; }))).sort();
    if (!weeks.length) { status.textContent = 'No week has been published yet.'; return; }
    status.textContent = '';
    var latest = weeks[weeks.length - 1];
    function values(week, dimension) {
      return cells.filter(function (c) { return c.week === week && c.dimension === dimension; });
    }
    // Channel is single-valued, so its estimates sum to one estimate per week.
    var weekly = weeks.map(function (w) { return values(w, 'channel').reduce(function (s, c) { return s + c.estimate; }, 0); });
    var total = weekly[weekly.length - 1], prior = weekly.length > 1 ? weekly[weekly.length - 2] : null;
    C.stat(tiles, 'Network-days, week of ' + C.shortDay(latest), C.compact(total), prior === null ? '' : 'Previous week ' + C.compact(prior), true);
    var engines = values(latest, 'engines_used_today').filter(function (c) { return c.value !== 'none'; })
      .sort(function (a, b) { return b.estimate - a.estimate; });
    if (engines.length) C.stat(tiles, 'Most used harness', engines[0].value, C.compact(engines[0].estimate) + ' network-days');
    var platforms = values(latest, 'platform').sort(function (a, b) { return b.estimate - a.estimate; });
    if (platforms.length) C.stat(tiles, 'Top platform', platforms[0].value, C.compact(platforms[0].estimate) + ' network-days');

    var trend = C.card(charts, 'Weekly network-days', 'Sum of release-channel estimates per closed week', 'wide');
    C.columnChart(trend.body, { labels: weeks, values: weekly, labelCount: 4, titleFormat: function (w) { return 'Week of ' + C.shortDay(w); }, unit: 'network-days', ariaLabel: 'Weekly network-days' });
    C.table(trend.body, ['Week of', 'Network-days'], weeks.map(function (w, i) { return [w, C.full(weekly[i])]; }));

    ['engines_used_today', 'platform', 'surfaces_today', 'version', 'arch', 'channel'].forEach(function (dimension) {
      var rows = values(latest, dimension).filter(function (c) { return c.value !== 'none' && c.estimate > 0; })
        .sort(function (a, b) { return b.estimate - a.estimate || (a.value < b.value ? -1 : 1); })
        .slice(0, 8).map(function (c) { return { label: c.value, value: c.estimate }; });
      // A dimension with no published cells (an empty version catalog) gets no card.
      if (!values(latest, dimension).length) return;
      var card = C.card(charts, LABELS[dimension], 'Week of ' + C.shortDay(latest), 'third');
      C.barList(card.body, rows, { unit: 'network-days' });
      C.table(card.body, ['Value', 'Network-days'], rows.map(function (r) { return [r.label, C.full(r.value)]; }));
    });
  }
  load().then(function (cells) { render(cells); C.onResize(function () { render(cells); }); })
    .catch(function () { status.textContent = 'Weekly estimates are unavailable. Try again later.'; });
})();
`;

export const DASHBOARD_JS = DASHBOARD_KIT_JS + PAGE_JS;
