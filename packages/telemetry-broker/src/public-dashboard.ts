export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Station public telemetry</title><style>
body{font:16px system-ui,sans-serif;line-height:1.6;max-width:64rem;margin:3rem auto;padding:0 1rem;color:#172630;background:#f5f7f8}
table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #d8e1e7}
section{margin:2rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1,h2{line-height:1.2}
</style><script src="/public/dashboard.js" defer></script></head><body>
<h1>Station public telemetry</h1><p>Kontour publisher · last 30 closed UTC receipt days.</p>
<p>Counts describe received pings, not people. Only groups of at least ten identical daily observations contribute.
Sparse groups are omitted from every total and distribution. Missing days mean no publishable data, not zero use.</p>
<p id="status" role="status">Loading aggregates…</p><main id="results"></main>
<p><a href="/v1/public/aggregates">Read the aggregate JSON</a></p></body></html>`;

export const DASHBOARD_JS = `async function load(){
 const status=document.getElementById('status'),root=document.getElementById('results');
 try{
  const response=await fetch('/v1/public/aggregates',{credentials:'omit'});
  if(!response.ok)throw new Error('unavailable');
  const data=await response.json();
  status.textContent=data.days.length?'Published groups only; first-active counts are lower-bound installation estimates.':'No publishable groups yet.';
  for(const day of data.days){
   const section=document.createElement('section'),title=document.createElement('h2');title.textContent=day.day;section.append(title);
   const text=document.createElement('p');text.textContent=day.representedPings+' represented pings · '+day.firstActiveThisWeek+' first-active week flags · '+day.firstActiveThisMonth+' first-active month flags';section.append(text);
   const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Usage and friction distributions';details.append(summary);
   const table=document.createElement('table'),head=document.createElement('tr');for(const label of ['Dimension','Bucket','Pings']){const th=document.createElement('th');th.textContent=label;th.scope='col';head.append(th)}table.append(head);
   for(const [dimension,buckets] of Object.entries(day.distributions))for(const [bucket,count] of Object.entries(buckets)){
    const row=document.createElement('tr');for(const value of [dimension,bucket,count]){const td=document.createElement('td');td.textContent=String(value);row.append(td)}table.append(row);
   }details.append(table);section.append(details);root.append(section);
  }
 }catch{status.textContent='Aggregates are unavailable. Try again later.'}
}load();`;
