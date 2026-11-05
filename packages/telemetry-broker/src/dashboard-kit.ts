// The dependency-free chart kit shared by the public dashboard (/public/,
// served by both receivers) and the Worker's private owner dashboard
// (/insights). It is shipped as page script text: same-origin, no
// third-party code, so the pages run under `script-src 'self'`. Every label
// reaches the DOM through textContent, never markup.
//
// Colors are the reference data-visualization palette: a validated
// categorical order (slots 1-8), an ordinal blue ramp for ordered buckets,
// and separately selected dark-mode steps.

export const DASHBOARD_STYLE = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--wash:rgba(42,120,214,.10);
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;
--r1:#86b6ef;--r2:#5598e7;--r3:#2a78d6;--r4:#1c5cab;--r5:#104281}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme=light])){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--wash:rgba(57,135,229,.12);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;
--r1:#184f95;--r2:#256abf;--r3:#3987e5;--r4:#6da7ec;--r5:#9ec5f4}}
:root[data-theme=dark]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--wash:rgba(57,135,229,.12);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;
--r1:#184f95;--r2:#256abf;--r3:#3987e5;--r4:#6da7ec;--r5:#9ec5f4}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:76rem;margin:0 auto;padding:2rem 1.25rem 3rem}
header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
h1{font-size:1.6rem;line-height:1.2;margin:0;font-weight:650}
.sub{color:var(--ink2);margin:.25rem 0 0}
.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:1rem}
.card{grid-column:span 6;background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:1rem 1.1rem;min-width:0}
.card.wide{grid-column:span 12}.card.third{grid-column:span 4}
.card h2{font-size:1rem;margin:0;font-weight:600}
.card .caption{color:var(--ink2);font-size:.85rem;margin:.15rem 0 .75rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(9rem,1fr));gap:1rem;margin-bottom:1rem}.tile.hero{grid-column:span 2}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:1rem 1.1rem;min-width:0}
.tile .label{color:var(--ink2);font-size:.85rem}
.tile .value{font-size:1.9rem;font-weight:620;line-height:1.15;margin-top:.2rem}
.tile.hero .value{font-size:3.4rem}.tile .value.quiet{font-size:1.35rem;font-weight:500;color:var(--ink2);margin-top:.6rem}
.tile .note{color:var(--muted);font-size:.8rem;margin-top:.2rem}
svg.chart{display:block;width:100%;overflow:visible}
svg.chart text{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
svg.chart text.end{fill:var(--ink2);font-weight:600}
.gridline{stroke:var(--grid);stroke-width:1}.baseline{stroke:var(--axis);stroke-width:1}
.line{fill:none!important;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.line.partial{stroke-dasharray:4 4}
.area{fill:var(--wash);stroke:none}
.cross{stroke:var(--axis);stroke-width:1}
.dot{stroke:var(--surface)!important;stroke-width:2}.dot.open{fill:var(--surface)!important;stroke:currentColor!important}
.s1{fill:var(--s1);stroke:var(--s1);color:var(--s1)}.s2{fill:var(--s2);stroke:var(--s2);color:var(--s2)}.s3{fill:var(--s3);stroke:var(--s3);color:var(--s3)}.s4{fill:var(--s4);stroke:var(--s4);color:var(--s4)}
.s5{fill:var(--s5);stroke:var(--s5);color:var(--s5)}.s6{fill:var(--s6);stroke:var(--s6);color:var(--s6)}.s7{fill:var(--s7);stroke:var(--s7);color:var(--s7)}.s8{fill:var(--s8);stroke:var(--s8);color:var(--s8)}
.r1{fill:var(--r1);background:var(--r1)}.r2{fill:var(--r2);background:var(--r2)}.r3{fill:var(--r3);background:var(--r3)}.r4{fill:var(--r4);background:var(--r4)}.r5{fill:var(--r5);background:var(--r5)}
.col{stroke:none!important}.col.noise{fill:var(--grid)!important;opacity:.7}.fold{color:var(--muted);font-size:.8rem;margin-top:.6rem}.col.partial{opacity:.45}.col:hover,.col:focus{opacity:.8;outline:none}
.bars{display:grid;grid-template-columns:minmax(5rem,11rem) 1fr auto;gap:.45rem .75rem;align-items:center}
.bars .name{color:var(--ink2);font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bars .track{height:12px;position:relative}
.bars .fill{height:12px;border-radius:0 4px 4px 0;background:var(--s1);min-width:2px}
.bars .val{font-size:.85rem;font-variant-numeric:tabular-nums;color:var(--ink)}
.bars .val small{color:var(--muted);margin-left:.35rem}
.seg{display:flex;gap:2px;height:12px}
.seg span{display:block;height:12px;border-radius:2px;min-width:0}
.seg span:first-child{border-radius:4px 2px 2px 4px}.seg span:last-child{border-radius:2px 4px 4px 2px}
.legend{display:flex;flex-wrap:wrap;gap:.3rem 1rem;margin:.6rem 0 0;color:var(--ink2);font-size:.8rem}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:.35rem;vertical-align:-1px}
.legend i.key-line{height:2px;width:14px;vertical-align:3px;background:currentColor}
details.table{margin-top:.6rem;font-size:.8rem;color:var(--ink2)}
details.table summary{cursor:pointer;color:var(--muted)}
details.table table{border-collapse:collapse;margin-top:.4rem;width:100%}
details.table td,details.table th{text-align:left;padding:.2rem .4rem;border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums}
details.table td:last-child,details.table th:last-child{text-align:right}
.viz-tip{position:fixed;pointer-events:none;z-index:10;background:var(--surface);color:var(--ink);border:1px solid var(--ring);border-radius:8px;padding:.45rem .6rem;font-size:.8rem;box-shadow:0 6px 18px rgba(0,0,0,.12);display:none;max-width:16rem}
.viz-tip b{display:block;font-size:.95rem}
.viz-tip .row{display:flex;align-items:center;gap:.4rem;white-space:nowrap}
.viz-tip .row i{display:inline-block;width:12px;height:2px;background:currentColor}
.viz-tip .t{color:var(--muted)}
.empty{color:var(--muted);padding:2rem 0;text-align:center}
button,input{font:inherit}
button{background:var(--surface);color:var(--ink);border:1px solid var(--axis);border-radius:8px;padding:.45rem .9rem;cursor:pointer}
button.primary{background:var(--s1);border-color:var(--s1);color:#fff}
input{background:var(--surface);color:var(--ink);border:1px solid var(--axis);border-radius:8px;padding:.5rem .7rem;min-width:18rem}
a{color:var(--s1)}
@media (max-width:900px){.card,.card.third{grid-column:span 12}}
`;

export const DASHBOARD_KIT_JS = String.raw`
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    for (var key in attrs) node.setAttribute(key, String(attrs[key]));
    if (parent) parent.appendChild(node);
    return node;
  }
  function h(tag, cls, text, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
  }
  function full(n) { return Math.round(n).toLocaleString('en-US'); }
  function compact(n) {
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return full(n);
  }
  function pct(share) {
    if (!isFinite(share)) return '0%';
    var p = share * 100;
    return (p > 0 && p < 1 ? '<1' : p.toFixed(p < 10 ? 1 : 0).replace(/\.0$/, '')) + '%';
  }
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function shortDay(day) { return MONTHS[Number(day.slice(5, 7)) - 1] + ' ' + Number(day.slice(8, 10)); }
  function monthLabel(month) { return MONTHS[Number(month.slice(5, 7)) - 1] + ' ' + month.slice(0, 4); }
  function step(max) {
    if (max <= 0) return 1;
    var raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    var s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
    return Math.max(1, s * p);
  }
  function scaleTicks(max) {
    var s = step(max), top = Math.max(s, Math.ceil(max / s) * s), out = [];
    for (var v = 0; v <= top + 1e-9; v += s) out.push(v);
    return out;
  }

  var tip = null;
  function showTip(x, y, title, rows) {
    if (!tip) tip = h('div', 'viz-tip', null, document.body);
    tip.replaceChildren();
    rows.forEach(function (row) {
      var line = h('div', 'row', null, tip);
      if (row.cls) h('i', row.cls, null, line);
      h('b', null, row.value, line);
      if (row.name) h('span', 't', row.name, line);
    });
    h('div', 't', title, tip);
    tip.style.display = 'block';
    var w = tip.offsetWidth, hgt = tip.offsetHeight;
    var left = x + 14 + w > window.innerWidth ? x - 14 - w : x + 14;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, y - hgt - 10) + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  function card(parent, title, caption, size) {
    var node = h('section', 'card' + (size ? ' ' + size : ''), null, parent);
    h('h2', null, title, node);
    if (caption) h('p', 'caption', caption, node);
    var body = h('div', 'body', null, node);
    return { node: node, body: body };
  }
  function legend(parent, items) {
    var row = h('div', 'legend', null, parent);
    items.forEach(function (item) {
      var entry = h('span', null, null, row);
      var key = h('i', item.cls + (item.kind === 'line' ? ' key-line' : ''), null, entry);
      if (item.kind !== 'line') key.style.background = 'currentColor';
      entry.appendChild(document.createTextNode(item.name));
    });
  }
  function table(parent, headers, rows) {
    var details = h('details', 'table', null, parent);
    h('summary', null, 'Table', details);
    var t = h('table', null, null, details), head = h('tr', null, null, t);
    headers.forEach(function (name) { var th = h('th', null, name, head); th.scope = 'col'; });
    rows.forEach(function (row) {
      var tr = h('tr', null, null, t);
      row.forEach(function (cell) { h('td', null, cell, tr); });
    });
  }
  function stat(parent, label, value, note, hero) {
    var tile = h('div', 'tile' + (hero ? ' hero' : ''), null, parent);
    h('div', 'label', label, tile);
    h('div', 'value', value, tile);
    if (note) h('div', 'note', note, tile);
    return tile;
  }

  var M = { top: 12, right: 44, bottom: 26, left: 40 };
  function frame(body, height) {
    var width = Math.max(280, body.clientWidth || 600);
    var svg = svgEl('svg', { class: 'chart', viewBox: '0 0 ' + width + ' ' + height, height: height, role: 'img' }, body);
    return { svg: svg, width: width, height: height, plotW: width - M.left - M.right, plotH: height - M.top - M.bottom };
  }
  function yAxis(f, max) {
    var ticks = scaleTicks(max), top = ticks[ticks.length - 1];
    ticks.forEach(function (v) {
      var y = M.top + f.plotH - (v / top) * f.plotH;
      svgEl('line', { class: v === 0 ? 'baseline' : 'gridline', x1: M.left, x2: M.left + f.plotW, y1: y, y2: y }, f.svg);
      var label = svgEl('text', { x: M.left - 8, y: y + 4, 'text-anchor': 'end' }, f.svg);
      label.textContent = compact(v);
    });
    return top;
  }
  function xLabels(f, labels, xAt, count) {
    // Evenly spaced from the latest label back, never closer than 64px.
    var n = labels.length, every = Math.max(1, Math.ceil(n / count)), previous = Infinity;
    for (var i = n - 1; i >= 0; i -= every) {
      var x = xAt(i);
      if (previous - x < 64) continue;
      var t = svgEl('text', { x: x, y: f.height - 6, 'text-anchor': i === n - 1 ? 'end' : 'middle' }, f.svg);
      t.textContent = labels[i];
      previous = i === n - 1 ? x - 24 : x;
    }
  }

  // A line per series over one shared x. 'partialLast' draws the final
  // segment dashed with a hollow end marker: the period is still open.
  function lineChart(body, opts) {
    var f = frame(body, opts.height || 220);
    var n = opts.labels.length;
    var max = 0;
    opts.series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    var top = yAxis(f, max);
    var xAt = function (i) { return M.left + (n <= 1 ? f.plotW / 2 : (i / (n - 1)) * f.plotW); };
    var yAt = function (v) { return M.top + f.plotH - (v / top) * f.plotH; };
    xLabels(f, opts.labels.map(opts.labelFormat || shortDay), xAt, 6);
    var closed = opts.partialLast ? n - 1 : n;
    opts.series.forEach(function (s, k) {
      var pts = s.values.map(function (v, i) { return xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1); });
      if (opts.series.length === 1 && closed > 1)
        svgEl('path', { class: 'area', d: 'M' + xAt(0) + ',' + yAt(0) + 'L' + pts.slice(0, closed).join('L') + 'L' + xAt(closed - 1) + ',' + yAt(0) + 'Z' }, f.svg);
      if (closed > 1) svgEl('path', { class: 'line ' + s.cls, d: 'M' + pts.slice(0, closed).join('L') }, f.svg);
      if (opts.partialLast && n > 1) svgEl('path', { class: 'line partial ' + s.cls, d: 'M' + pts[n - 2] + 'L' + pts[n - 1] }, f.svg);
      var last = s.values[n - 1];
      svgEl('circle', { class: 'dot ' + s.cls + (opts.partialLast ? ' open' : ''), cx: xAt(n - 1), cy: yAt(last), r: 4 }, f.svg);
      if (k === 0 || opts.series.length <= 4) {
        var end = svgEl('text', { class: 'end', x: xAt(n - 1) + 8, y: yAt(last) + 4 }, f.svg);
        end.textContent = compact(last);
      }
    });
    var cross = svgEl('line', { class: 'cross', x1: 0, x2: 0, y1: M.top, y2: M.top + f.plotH, visibility: 'hidden' }, f.svg);
    var hit = svgEl('rect', { x: M.left, y: M.top, width: f.plotW, height: f.plotH, fill: 'transparent', tabindex: 0 }, f.svg);
    var active = n - 1;
    function show(i, cx, cy) {
      active = Math.max(0, Math.min(n - 1, i));
      var x = xAt(active);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      var rect = f.svg.getBoundingClientRect(), scale = rect.width / f.width;
      var title = (opts.titleFormat || shortDay)(opts.labels[active]) + (opts.partialLast && active === n - 1 ? ' (so far)' : '');
      showTip(cx !== undefined ? cx : rect.left + x * scale, cy !== undefined ? cy : rect.top + M.top * scale + 20, title,
        opts.series.map(function (s) { return { cls: s.cls, value: full(s.values[active]), name: s.name }; }));
    }
    hit.addEventListener('pointermove', function (e) {
      var rect = f.svg.getBoundingClientRect(), x = (e.clientX - rect.left) * (f.width / rect.width);
      show(Math.round(((x - M.left) / f.plotW) * (n - 1)), e.clientX, e.clientY);
    });
    hit.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') show(active - 1); else if (e.key === 'ArrowRight') show(active + 1);
    });
    hit.addEventListener('focus', function () { show(active); });
    function leave() { cross.setAttribute('visibility', 'hidden'); hideTip(); }
    hit.addEventListener('pointerleave', leave); hit.addEventListener('blur', leave);
    f.svg.setAttribute('aria-label', opts.ariaLabel || '');
    if (opts.series.length > 1) legend(body, opts.series.map(function (s) { return { name: s.name, cls: s.cls, kind: 'line' }; }));
  }

  // Columns from one baseline; partial (still open) periods are faded.
  // 'masked' indexes are values the page may not show (within noise): each
  // gets a muted full-height placeholder with no number, its tooltip says
  // 'within noise', and it does not set the scale.
  function columnChart(body, opts) {
    var f = frame(body, opts.height || 200);
    var masked = opts.masked || [];
    var isMasked = function (i) { return masked.indexOf(i) >= 0; };
    var n = opts.values.length, max = Math.max.apply(null, opts.values.filter(function (v, i) { return !isMasked(i); }).concat([0]));
    var top = yAxis(f, max), band = f.plotW / Math.max(1, n), w = Math.min(24, Math.max(2, band - 2));
    var xAt = function (i) { return M.left + band * i + band / 2; };
    var yAt = function (v) { return M.top + f.plotH - (v / top) * f.plotH; };
    xLabels(f, opts.labels.map(opts.labelFormat || shortDay), xAt, opts.labelCount || 6);
    opts.values.forEach(function (v, i) {
      if (isMasked(i)) {
        var slot = svgEl('rect', { class: 'col noise', x: xAt(i) - w / 2, y: M.top, width: w, height: f.plotH, rx: 4, tabindex: 0 }, f.svg);
        var tipNoise = function (e) {
          var rect = slot.getBoundingClientRect();
          showTip(e && e.clientX !== undefined ? e.clientX : rect.left + rect.width / 2, e && e.clientY !== undefined ? e.clientY : rect.top,
            (opts.titleFormat || shortDay)(opts.labels[i]), [{ value: 'within noise' }]);
        };
        slot.addEventListener('pointermove', tipNoise); slot.addEventListener('pointerleave', hideTip);
        slot.addEventListener('focus', function () { tipNoise(); }); slot.addEventListener('blur', hideTip);
        return;
      }
      var x = xAt(i) - w / 2, y = yAt(v), base = yAt(0), r = Math.min(4, w / 2, base - y);
      var d = v <= 0 ? 'M' + x + ',' + base + 'h' + w :
        'M' + x + ',' + base + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + base + 'Z';
      var partial = opts.partial && opts.partial.indexOf(i) >= 0;
      var col = svgEl('path', { class: 'col ' + (opts.cls || 's1') + (partial ? ' partial' : ''), d: d, tabindex: 0 }, f.svg);
      var hitBox = svgEl('rect', { x: xAt(i) - band / 2, y: M.top, width: band, height: f.plotH, fill: 'transparent' }, f.svg);
      function show(e) {
        var rect = col.getBoundingClientRect();
        showTip(e && e.clientX !== undefined ? e.clientX : rect.left + rect.width / 2, e && e.clientY !== undefined ? e.clientY : rect.top,
          (opts.titleFormat || shortDay)(opts.labels[i]) + (partial ? ' (so far)' : ''), [{ cls: opts.cls || 's1', value: full(v), name: opts.unit || '' }]);
      }
      [col, hitBox].forEach(function (node) {
        node.addEventListener('pointermove', show); node.addEventListener('pointerleave', hideTip);
      });
      col.addEventListener('focus', function () { show(); }); col.addEventListener('blur', hideTip);
    });
    // Only label the last cap where columns leave room for its text.
    if (n && band >= 18 && !isMasked(n - 1)) {
      var lastV = opts.values[n - 1], label = svgEl('text', { class: 'end', x: xAt(n - 1), y: yAt(lastV) - 6, 'text-anchor': 'middle' }, f.svg);
      label.textContent = compact(lastV);
    }
    f.svg.setAttribute('aria-label', opts.ariaLabel || '');
  }

  // Ranked horizontal bars (HTML): one series, so one color and no legend.
  // 'folded' counts values the page may not show; they become one line with
  // no numbers.
  function barList(body, rows, opts) {
    opts = opts || {};
    var list = h('div', 'bars', null, body), max = 0;
    rows.forEach(function (r) { if (r.value > max) max = r.value; });
    if (opts.folded) h('div', 'fold', opts.folded + (opts.folded === 1 ? ' other value' : ' other values') + ' within noise', body);
    if (!rows.length) { if (!opts.folded) h('div', 'empty', opts.empty || 'No data yet', body); return; }
    rows.forEach(function (r) {
      h('div', 'name', r.label, list).title = r.label;
      var track = h('div', 'track', null, list), fill = h('div', 'fill', null, track);
      fill.style.width = (max ? (r.value / max) * 100 : 0) + '%';
      var val = h('div', 'val', opts.share ? pct(r.share) : compact(r.value), list);
      if (opts.share) h('small', null, compact(r.value), val);
      track.addEventListener('pointermove', function (e) {
        showTip(e.clientX, e.clientY, r.label, [{ cls: 's1', value: full(r.value), name: opts.unit || '' }].concat(opts.share ? [{ value: pct(r.share), name: 'share' }] : []));
      });
      track.addEventListener('pointerleave', hideTip);
    });
  }

  // One thin segmented bar per row, parts in a fixed ordinal order.
  function segmentRows(body, rows, partNames, opts) {
    opts = opts || {};
    if (!rows.length) { h('div', 'empty', 'No data yet', body); return; }
    var ramp = ['r1', 'r2', 'r3', 'r4', 'r5'];
    var list = h('div', 'bars', null, body);
    rows.forEach(function (r) {
      h('div', 'name', r.label, list);
      var seg = h('div', 'seg', null, list);
      partNames.forEach(function (part, k) {
        var v = r.parts[part] || 0;
        if (!v) return;
        var span = h('span', ramp[Math.min(k, ramp.length - 1)], null, seg);
        span.style.flex = String(v);
        span.addEventListener('pointermove', function (e) {
          showTip(e.clientX, e.clientY, r.label + ' · ' + part, [{ value: pct(v / r.total), name: full(v) + ' ' + (opts.unit || '') }]);
        });
        span.addEventListener('pointerleave', hideTip);
      });
      h('div', 'val', compact(r.total), list);
    });
    var row = h('div', 'legend', null, body);
    partNames.forEach(function (part, k) {
      var entry = h('span', null, null, row);
      h('i', ramp[Math.min(k, ramp.length - 1)], null, entry);
      entry.appendChild(document.createTextNode(part));
    });
  }

  var renders = [];
  var timer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { renders.forEach(function (fn) { fn(); }); }, 150);
  });

  window.StationCharts = {
    h: h, card: card, stat: stat, legend: legend, table: table,
    lineChart: lineChart, columnChart: columnChart, barList: barList, segmentRows: segmentRows,
    full: full, compact: compact, pct: pct, shortDay: shortDay, monthLabel: monthLabel,
    onResize: function (fn) { renders.push(fn); }
  };
})();
`;
