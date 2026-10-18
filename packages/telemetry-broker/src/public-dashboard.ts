export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Station public telemetry</title><style>
*{box-sizing:border-box}body{font:16px system-ui,sans-serif;line-height:1.6;max-width:64rem;margin:3rem auto;padding:0 1.2rem;color:#172630;background:#f5f7f8}
h1{font-size:2.5rem;line-height:1.15;margin:.4rem 0}h2{font-size:1.2rem}.eyebrow{color:#326358;text-transform:uppercase;letter-spacing:.1em;font-size:.8rem;font-weight:700}
.note{background:#e7f0ed;border-left:4px solid #326358;padding:1rem 1.2rem;border-radius:4px}label{display:flex;flex:1;flex-direction:column;font-weight:600;gap:.3rem}select{font:inherit;max-width:100%;padding:.6rem;background:white;border:1px solid #a8bcb6;border-radius:6px}.controls{display:flex;gap:1rem;margin:1.5rem 0;flex-wrap:wrap}
table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;padding:.7rem;border-bottom:1px solid #d8e1e7}td:last-child,th:last-child{text-align:right}td{overflow-wrap:anywhere}section{margin:2rem 0}.muted{color:#52656f}a{color:#245b50}
@media(max-width:480px){body{margin:1.5rem auto}h1{font-size:2rem}.controls{display:block}label{margin-bottom:1rem}}
</style><script src="/public/dashboard.js" defer></script></head><body>
<div class="eyebrow">Station · Kontour publisher</div><h1>Weekly network-day estimates</h1>
<p class="muted">Last four closed ISO weeks · Monday–Sunday · UTC receiver arrival</p>
<div class="note"><strong>Noisy estimates, not people.</strong> Every value in the fixed public domain is released, including values with no contributors. Zero estimates do not imply zero activity. Counts use one frozen release per publisher and week.</div>
<p>Profile and adoption fields only. Counters and friction stay in the private operator view. Set values overlap; do not sum them or join dimensions. A network contributes once per value per UTC day. Installs sharing a network count together (NAT undercount). Calendar activity flags count network-days carrying that flag.</p>
<p class="muted">Geometric mechanism: per-count ε=1/280; adding one ping costs ε≤1/7. With ≤40 coordinates per network/day, weekly L1 sensitivity is 7×40=280 and ε≤1. Arbitrary traffic can exceed 40 coordinates; the API reports its domain-based network-week bound. Typical absolute noise: about 280 network-days; 95% within 839 network-days. The implementation uses persistent-key HMAC and finite-precision sampling.</p>
<p id="status" role="status">Loading weekly estimates…</p>
<main><div class="controls"><label>Week beginning (UTC)<select id="week" disabled></select></label><label>Dimension<select id="dimension" disabled></select></label></div><section id="results"></section></main>
<p><a href="/v1/public/aggregates">Read the paginated aggregate JSON</a></p></body></html>`;

export const DASHBOARD_JS = `async function load(){
 const status=document.getElementById('status'),root=document.getElementById('results'),week=document.getElementById('week'),dimension=document.getElementById('dimension');
 try{
  const cells=[];let cursor=null;
  do{
   const response=await fetch('/v1/public/aggregates'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{credentials:'omit'});
   if(!response.ok)throw new Error('unavailable');
   const data=await response.json();cells.push(...data.cells);cursor=data.nextCursor;
  }while(cursor);
  status.textContent=cells.length?'Fixed public domain · all values included · estimates are frozen for each week.':'No configured public domain is available yet.';
  for(const [select,values] of [[week,[...new Set(cells.map(c=>c.week))].sort().reverse()],[dimension,[...new Set(cells.map(c=>c.dimension))].sort()]]){
   for(const value of values){const option=document.createElement('option');option.value=value;option.textContent=value;select.append(option)}select.disabled=!values.length;
  }
  function render(){
   root.replaceChildren();const title=document.createElement('h2');title.textContent=dimension.value+' · week of '+week.value;root.append(title);
   const table=document.createElement('table'),head=document.createElement('tr');for(const label of ['Public value','Estimated network-days']){const th=document.createElement('th');th.textContent=label;th.scope='col';head.append(th)}table.append(head);
   for(const cell of cells.filter(c=>c.week===week.value&&c.dimension===dimension.value)){
    const row=document.createElement('tr');for(const value of [cell.value,cell.estimate.toLocaleString()]){const td=document.createElement('td');td.textContent=String(value);row.append(td)}table.append(row);
   }root.append(table);
  }
  week.addEventListener('change',render);dimension.addEventListener('change',render);if(cells.length)render();
 }catch{status.textContent='Weekly estimates are unavailable. Try again later.'}
}load();`;
