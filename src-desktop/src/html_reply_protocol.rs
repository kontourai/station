/**
 * Staged visual-reply documents, served on a shell-owned scheme.
 *
 * Clients that cannot reach the loopback frame listener (the phone, or any
 * browser off the Station host) render a published page in one
 * `sandbox="allow-scripts"` frame. That frame document used to be embedded as
 * srcdoc, so it inherited the shell's own CSP — and the shell CSP refuses
 * inline scripts, which left script-driven pages blank while their static
 * markup and styles rendered (#4821 residual). A document served by this
 * scheme is a real document, not a local-scheme child: it does not inherit
 * the shell's CSP, the page's own meta policy governs it, and its inline
 * scripts run under the same opaque-origin sandbox as everywhere else.
 *
 * Bytes are staged by the shell's own webview over the command bridge. This
 * handler never proxies the network, never reads credentials, and serves only
 * what the shell explicitly staged. Admission mirrors the plugin asset
 * protocol: a per-launch HMAC capability, a fixed URL shape, shell labels
 * only, bounded staged bytes, and bounded in-flight requests.
 */
use base64::Engine;
use ring::rand::SecureRandom;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::http::{Method, Request, Response};

/// A published page expands to at most 8 MiB; the wrapper head adds little,
/// but data-URL images can sit near the cap, so keep bounded headroom.
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024 + 64 * 1024;
const STAGE_SLOTS: usize = 16;
const MAX_IN_FLIGHT: usize = 4;

const SCHEME_MESSAGE: &[u8] = b"station-html-reply-staging";

pub(super) struct StagedPage {
    handle: [u8; 32],
    document: Vec<u8>,
}

pub(super) struct RequestGate {
    capability_key: ring::hmac::Key,
    pages: Mutex<Vec<Option<StagedPage>>>,
    cursor: AtomicUsize,
    in_flight: Mutex<HashMap<String, usize>>,
}

/// The same shell labels the plugin asset protocol admits: the main window
/// and workspace-pane pop-outs, whose visual-file previews mount this viewer.
fn shell_label(label: &str) -> bool {
    label == "main"
        || label
            .strip_prefix("workspace-pane-pop-out-")
            .and_then(|suffix| {
                uuid::Uuid::parse_str(suffix).ok().filter(|id| {
                    id.get_version_num() == 4
                        && id.get_variant() == uuid::Variant::RFC4122
                        && id.to_string() == suffix
                })
            })
            .is_some()
}

fn encoded(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl RequestGate {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            capability_key: ring::hmac::Key::generate(
                ring::hmac::HMAC_SHA256,
                &ring::rand::SystemRandom::new(),
            )
            .expect("OS randomness is required for reply delivery"),
            pages: Mutex::new((0..STAGE_SLOTS).map(|_| None).collect()),
            cursor: AtomicUsize::new(0),
            in_flight: Mutex::new(HashMap::new()),
        })
    }

    fn capability(&self) -> String {
        encoded(ring::hmac::sign(&self.capability_key, SCHEME_MESSAGE).as_ref())
    }

    pub(super) fn initialization_script(&self, dev_url: Option<&url::Url>) -> String {
        let mut origins = Vec::new();
        // Wry normalizes custom schemes on Windows and Android to an
        // http(s)://<scheme>.localhost document origin.
        if cfg!(any(target_os = "windows", target_os = "android")) {
            origins.push("http://tauri.localhost".to_string());
            origins.push("https://tauri.localhost".to_string());
        } else {
            origins.push("tauri://localhost".to_string());
        }
        if cfg!(debug_assertions) {
            if let Some(url) = dev_url {
                origins.push(url.origin().ascii_serialization());
            }
        }
        format!(
            "({})({}, {});",
            include_str!("../../src-ui/src/platform/native/htmlReplyCapability.js"),
            serde_json::to_string(&self.capability()).expect("string serialization"),
            serde_json::to_string(&origins).expect("origin serialization")
        )
    }

    /// Stage one composed page document and return its 43-character handle.
    /// Staging replaces the oldest slot: a chat renders a bounded number of
    /// replies at once, and an evicted handle only costs a re-stage.
    pub(super) fn stage(&self, label: &str, document: &str) -> Result<String, StageRefusal> {
        if !shell_label(label) {
            return Err(StageRefusal::Shell);
        }
        if document.len() > MAX_DOCUMENT_BYTES {
            return Err(StageRefusal::Oversize);
        }
        let mut handle = [0u8; 32];
        ring::rand::SystemRandom::new()
            .fill(&mut handle)
            .expect("OS randomness is required for reply staging");
        let mut pages = self.pages.lock().expect("staged pages lock");
        let slot = self.cursor.fetch_add(1, Ordering::Relaxed) % STAGE_SLOTS;
        pages[slot] = Some(StagedPage {
            handle,
            document: document.as_bytes().to_vec(),
        });
        Ok(encoded(&handle))
    }

    fn serve(&self, handle: [u8; 32]) -> Option<Vec<u8>> {
        let pages = self.pages.lock().expect("staged pages lock");
        pages
            .iter()
            .flatten()
            .find(|page| page.handle == handle)
            .map(|page| page.document.clone())
    }

    pub(super) fn enter(
        self: &Arc<Self>,
        label: &str,
        request: &Request<Vec<u8>>,
    ) -> Result<RequestPermit, Response<Vec<u8>>> {
        let refused = || reply(403, "text/plain", Vec::new());
        if !shell_label(label) {
            return Err(refused());
        }
        let capability = request
            .uri()
            .query()
            .and_then(|query| query.strip_prefix("capability="))
            .ok_or_else(refused)?;
        if capability.len() != 43 {
            return Err(refused());
        }
        let tag = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(capability)
            .map_err(|_| refused())?;
        // The fixed-message HMAC yields a per-launch 256-bit secret, checked in
        // constant time. It is not bound to label, path or port; those checks
        // are separate. No staged byte is touched before admission.
        ring::hmac::verify(&self.capability_key, SCHEME_MESSAGE, &tag).map_err(|_| refused())?;
        let handle = admit(request).ok_or_else(refused)?;
        let mut counts = self.in_flight.lock().expect("in-flight lock");
        let count = counts.entry(label.to_string()).or_default();
        if *count >= MAX_IN_FLIGHT {
            return Err(reply(429, "text/plain", Vec::new()));
        }
        *count += 1;
        Ok(RequestPermit {
            gate: Arc::clone(self),
            label: label.to_string(),
            handle,
        })
    }
}

pub(super) struct RequestPermit {
    gate: Arc<RequestGate>,
    label: String,
    handle: [u8; 32],
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        let mut counts = self.gate.in_flight.lock().expect("in-flight lock");
        if let Some(count) = counts.get_mut(&self.label) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.label);
            }
        }
    }
}

fn admit(request: &Request<Vec<u8>>) -> Option<[u8; 32]> {
    let uri = request.uri();
    if request.method() != Method::GET || !request.body().is_empty() {
        return None;
    }
    // Wry normalizes Windows and Android requests to the custom scheme; accept
    // its exact alias too.
    if !matches!(
        (uri.scheme_str(), uri.authority().map(|a| a.as_str())),
        (Some("station-html-reply"), Some("localhost"))
            | (Some("http"), Some("station-html-reply.localhost"))
    ) {
        return None;
    }
    let path = uri.path();
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2 || !parts[0].is_empty() {
        return None;
    }
    if parts[1].len() != 43 {
        return None;
    }
    let handle = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;
    if handle.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&handle);
    Some(out)
}

fn reply(status: u16, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut response = Response::new(body);
    *response.status_mut() =
        tauri::http::StatusCode::from_u16(status).expect("fixed protocol status");
    let headers = response.headers_mut();
    headers.insert("content-type", mime.parse().expect("fixed reply MIME"));
    headers.insert("cache-control", "no-store".parse().unwrap());
    // Applies to every delivery; the launch capability is never a Referer.
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    // Refusal bodies are empty; the sandbox policy only hardens them. A
    // delivered page carries NO response CSP on purpose: the staged document's
    // own meta policy precedes its bytes, and a header policy here would
    // re-create exactly the inherited-refusal defect this scheme exists to fix.
    if status != 200 {
        headers.insert(
            "content-security-policy",
            "default-src 'none'; sandbox".parse().unwrap(),
        );
    }
    response
}

pub(super) fn handle(request: Request<Vec<u8>>, permit: RequestPermit) -> Response<Vec<u8>> {
    match permit.gate.serve(permit.handle) {
        Some(document) => reply(200, "text/html", document),
        // A valid capability for an evicted or unknown handle says so plainly.
        None => reply(404, "text/plain", Vec::new()),
    }
}

#[derive(Debug)]
pub(super) enum StageRefusal {
    Shell,
    Oversize,
}

/// The shell's own webview stages one composed page document for framing.
#[tauri::command]
pub(super) fn station_html_reply_stage(
    window: tauri::WebviewWindow,
    gate: tauri::State<'_, Arc<RequestGate>>,
    document: String,
) -> Result<String, String> {
    match gate.stage(window.label(), &document) {
        Ok(handle) => Ok(handle),
        Err(StageRefusal::Oversize) => Err("Document exceeds the staged reply limit.".into()),
        Err(StageRefusal::Shell) => Err("Staging is limited to Station's own shell.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(format!("station-html-reply://localhost{path}"))
            .body(Vec::new())
            .unwrap()
    }

    fn authorized_request(gate: &RequestGate, handle: &str) -> Request<Vec<u8>> {
        request(&format!("/{handle}?capability={}", gate.capability()))
    }

    fn stage(gate: &RequestGate, label: &str, document: &str) -> String {
        gate.stage(label, document).expect("stage")
    }

    #[test]
    fn initialization_script_is_iife_with_json_arguments() {
        let gate = RequestGate::new();
        let dev_url = url::Url::parse("http://127.0.0.1:5173/path?ignored=yes#fragment").unwrap();
        let source = include_str!("../../src-ui/src/platform/native/htmlReplyCapability.js");
        for configured_url in [None, Some(&dev_url)] {
            let script = gate.initialization_script(configured_url);
            assert!(script.starts_with('('));
            // This envelope excludes both a global declaration and a trailing
            // top-level installHtmlReplyCapability(...) invocation.
            assert!(script.contains(&format!("({source})(")));
            assert!(script.ends_with(");"));
        }
    }

    #[test]
    fn serves_a_staged_document_without_a_response_csp() {
        let gate = RequestGate::new();
        let document = "<!doctype html><html><body>chart</body></html>";
        let page = stage(&gate, "main", document);
        let permit = gate
            .enter("main", &authorized_request(&gate, &page))
            .expect("admit");
        let response = handle(authorized_request(&gate, &page), permit);
        assert_eq!(response.status(), 200);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("text/html")
        );
        // The staged document's own meta policy must be the only CSP.
        assert!(response.headers().get("content-security-policy").is_none());
        assert!(response.headers().get("cache-control").is_some());
        assert_eq!(response.body().as_slice(), document.as_bytes());
    }

    #[test]
    fn an_evicted_handle_answers_404_with_a_hardened_refusal() {
        let gate = RequestGate::new();
        let mut handles = Vec::new();
        for index in 0..STAGE_SLOTS + 1 {
            handles.push(stage(&gate, "main", &format!("page-{index}")));
        }
        // STAGE_SLOTS + 1 stages evicted the first document's slot.
        let permit = gate
            .enter("main", &authorized_request(&gate, &handles[0]))
            .expect("admit");
        let response = handle(authorized_request(&gate, &handles[0]), permit);
        assert_eq!(response.status(), 404);
        assert_eq!(
            response
                .headers()
                .get("content-security-policy")
                .and_then(|v| v.to_str().ok()),
            Some("default-src 'none'; sandbox")
        );
        // The newest page survives its own slot.
        let permit = gate
            .enter("main", &authorized_request(&gate, &handles[STAGE_SLOTS]))
            .expect("admit");
        let response = handle(authorized_request(&gate, &handles[STAGE_SLOTS]), permit);
        assert_eq!(response.status(), 200);
    }

    #[test]
    fn only_shell_labels_stage_and_load() {
        let gate = RequestGate::new();
        assert!(matches!(
            gate.stage("attacker", "<html></html>"),
            Err(StageRefusal::Shell)
        ));
        let handle = stage(
            &gate,
            "workspace-pane-pop-out-123e4567-e89b-42d3-a456-426614174000",
            "pane",
        );
        assert!(gate
            .enter(
                "workspace-pane-pop-out-123e4567-e89b-42d3-a456-426614174000",
                &authorized_request(&gate, &handle)
            )
            .is_ok());
        assert!(gate
            .enter("attacker", &authorized_request(&gate, &handle))
            .is_err());
    }

    #[test]
    fn wrong_capability_or_shape_is_refused() {
        let gate = RequestGate::new();
        let handle = stage(&gate, "main", "page");
        // Wrong capability.
        assert!(gate
            .enter(
                "main",
                &request(&format!("/{handle}?capability={}", "A".repeat(43)))
            )
            .is_err());
        // Missing capability.
        assert!(gate.enter("main", &request(&format!("/{handle}"))).is_err());
        // Wrong path shape.
        assert!(gate
            .enter(
                "main",
                &request(&format!(
                    "/deep/path/{handle}?capability={}",
                    gate.capability()
                ))
            )
            .is_err());
        // Malformed handle.
        assert!(gate
            .enter(
                "main",
                &request(&format!("/short?capability={}", gate.capability()))
            )
            .is_err());
        // Non-GET.
        let mut post = Request::builder()
            .uri(format!(
                "station-html-reply://localhost/{handle}?capability={}",
                gate.capability()
            ))
            .method("POST")
            .body(Vec::new())
            .unwrap();
        *post.body_mut() = b"x".to_vec();
        assert!(gate.enter("main", &post).is_err());
        // Windows/Android alias origin is admitted for the same shape.
        let alias = Request::builder()
            .uri(format!(
                "http://station-html-reply.localhost/{handle}?capability={}",
                gate.capability()
            ))
            .body(Vec::new())
            .unwrap();
        assert!(gate.enter("main", &alias).is_ok());
    }

    #[test]
    fn oversize_documents_are_refused_at_stage_time() {
        let gate = RequestGate::new();
        let oversized = "x".repeat(MAX_DOCUMENT_BYTES + 1);
        assert!(matches!(
            gate.stage("main", &oversized),
            Err(StageRefusal::Oversize)
        ));
    }
}
