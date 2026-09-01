import { createHash } from 'node:crypto';
import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH } from '@kontourai/station-contracts/environment-security';

/**
 * Where the launcher sends the browser once a session cookie exists. Fixed at
 * build time and never read from the request: a destination taken from a query
 * parameter or fragment would turn this page into an open redirect that a
 * hostile link could point anywhere, using Station's own origin for cover.
 */
const API_DOCS_PATH = '/ui';

/**
 * The fragment key `station start` and the desktop launcher already use for
 * the SPA. Reused verbatim so there is one launcher capability format rather
 * than a second one that drifts.
 */
const FRAGMENT_KEY = 'station-ui-bootstrap';

/**
 * Runs in the browser with no bundler and no network fetch of its own beyond
 * the same-origin redemption POST.
 *
 * The fragment is cleared from the address bar BEFORE the exchange, so the
 * capability does not sit in browser history or get carried into a copied URL
 * even if the exchange then fails. A fragment never reaches the server, which
 * is why the capability travels there rather than in a query string — Station
 * refuses query-parameter credentials outright.
 */
const LAUNCH_SCRIPT = `(function(){
var status=document.getElementById('status');
function fail(message){status.textContent=message;}
var hash=String(window.location.hash||'').replace(/^#/,'');
var token=null;
hash.split('&').forEach(function(part){
var eq=part.indexOf('=');
if(eq>0&&decodeURIComponent(part.slice(0,eq))===${JSON.stringify(FRAGMENT_KEY)}){
token=decodeURIComponent(part.slice(eq+1));
}
});
try{window.history.replaceState(null,'',window.location.pathname);}catch(e){}
if(!token){fail('This link carried no launch capability. Open the API docs from the Station tray again.');return;}
fetch(${JSON.stringify(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH)},{
method:'POST',
credentials:'same-origin',
headers:{'content-type':'application/json'},
body:JSON.stringify({token:token})
}).then(function(response){
if(!response.ok){fail('Station refused this launch capability. It may have already been used, or a newer one replaced it. Open the API docs from the tray again.');return;}
window.location.replace(${JSON.stringify(API_DOCS_PATH)});
}).catch(function(){fail('Could not reach Station to complete the launch.');});
})();`;

const LAUNCH_SCRIPT_HASH = `sha256-${createHash('sha256')
  .update(LAUNCH_SCRIPT, 'utf8')
  .digest('base64')}`;

/**
 * Hash-pinned rather than `'unsafe-inline'`: the page's only script is the one
 * above, so the browser can be told exactly which bytes are allowed to run.
 * `connect-src 'self'` admits the redemption POST and nothing else.
 */
export const API_DOCS_LAUNCH_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': [
    "default-src 'none'",
    `script-src '${LAUNCH_SCRIPT_HASH}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  // The capability lives in the fragment, which browsers never send as a
  // Referer, but the destination is same-origin anyway and the redemption POST
  // needs a real Origin (see the consent listener's note on the same choice).
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/**
 * The launcher page. It contains no credential: the capability arrives in the
 * fragment of the URL the tray opened, which is why this HTML is safe to serve
 * to an unauthenticated caller.
 */
export function renderApiDocsLaunchPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Opening Station API docs</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
background:Canvas;color:CanvasText}
main{max-width:34rem;padding:2rem;text-align:center}
h1{font-size:1rem;font-weight:600;margin:0 0 .5rem}
p{margin:0;opacity:.8}
</style>
</head>
<body>
<main>
<h1>Opening the Station API docs</h1>
<p id="status">Completing sign-in&hellip;</p>
</main>
<script>${LAUNCH_SCRIPT}</script>
</body>
</html>
`;
}
