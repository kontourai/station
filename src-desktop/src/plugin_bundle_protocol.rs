//! Executable asset delivery, never a general authenticated proxy.
use base64::Engine;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::http::{Method, Request, Response};
use tauri::{AppHandle, Manager};

const MAX_BUNDLE_BYTES: usize = 16 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 4;

pub(super) struct RequestGate {
    capability_key: ring::hmac::Key,
    in_flight: Mutex<HashMap<String, usize>>,
}

pub(super) struct RequestPermit {
    gate: Arc<RequestGate>,
    label: String,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        let mut counts = self
            .gate
            .in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = counts.get_mut(&self.label) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.label);
            }
        }
    }
}

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

impl RequestGate {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            capability_key: ring::hmac::Key::generate(
                ring::hmac::HMAC_SHA256,
                &ring::rand::SystemRandom::new(),
            )
            .expect("OS randomness is required for plugin delivery"),
            in_flight: Mutex::new(HashMap::new()),
        })
    }

    fn capability(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(ring::hmac::sign(&self.capability_key, b"station-plugin-assets").as_ref())
    }

    pub(super) fn initialization_script(&self, dev_url: Option<&url::Url>) -> String {
        let packaged_origin = if cfg!(target_os = "windows") {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        let mut origins = vec![packaged_origin.to_string()];
        if cfg!(debug_assertions) {
            if let Some(url) = dev_url {
                origins.push(url.origin().ascii_serialization());
            }
        }
        format!(
            "({})({}, {});",
            include_str!("../../src-ui/src/platform/native/pluginBundleCapability.js"),
            serde_json::to_string(&self.capability()).expect("string serialization"),
            serde_json::to_string(&origins).expect("origin serialization")
        )
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
        let (_, capability) = request
            .uri()
            .query()
            .and_then(|query| query.split_once("&capability="))
            .ok_or_else(refused)?;
        if capability.len() != 43 {
            return Err(refused());
        }
        let tag = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(capability)
            .map_err(|_| refused())?;
        // The fixed-message HMAC yields a per-launch 256-bit secret, checked in
        // constant time. It is not bound to label, path or port; those checks
        // are separate. No credential or slot is touched before admission.
        ring::hmac::verify(&self.capability_key, b"station-plugin-assets", &tag)
            .map_err(|_| refused())?;
        if admit(request).is_none() {
            return Err(refused());
        }
        let mut counts = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        let count = counts.entry(label.to_string()).or_default();
        if *count >= MAX_IN_FLIGHT {
            return Err(reply(429, "text/plain", Vec::new()));
        }
        // Reserve before spawn_blocking: queued work also consumes this label's slot.
        *count += 1;
        Ok(RequestPermit {
            gate: Arc::clone(self),
            label: label.to_string(),
        })
    }
}

struct Asset<'a> {
    path: &'a str,
    port: u16,
    mime: &'static str,
}

fn admit(request: &Request<Vec<u8>>) -> Option<Asset<'_>> {
    let uri = request.uri();
    if request.method() != Method::GET || !request.body().is_empty() {
        return None;
    }
    // Wry normalizes Windows requests to the custom scheme; accept its exact alias too.
    if !matches!(
        (uri.scheme_str(), uri.authority().map(|a| a.as_str())),
        (Some("station-plugin"), Some("localhost"))
            | (Some("http"), Some("station-plugin.localhost"))
    ) {
        return None;
    }
    let path = uri.path();
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 5 || parts[..3] != ["", "api", "plugins"] {
        return None;
    }
    let name = parts[3];
    if name.is_empty()
        || name.len() > 128
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return None;
    }
    let mime = match parts[4] {
        "bundle.js" => "application/javascript",
        "bundle.css" => "text/css",
        _ => return None,
    };
    let query = uri.query()?;
    let port = query
        .split_once("&capability=")
        .map_or(query, |(port, _)| port)
        .strip_prefix("port=")?;
    let parsed = port.parse::<u16>().ok()?;
    if parsed == 0 || port != parsed.to_string() {
        return None;
    }
    Some(Asset {
        path,
        port: parsed,
        mime,
    })
}

fn reply(status: u16, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut response = Response::new(body);
    *response.status_mut() =
        tauri::http::StatusCode::from_u16(status).expect("fixed protocol status");
    let headers = response.headers_mut();
    headers.insert("content-type", mime.parse().expect("fixed asset MIME"));
    headers.insert("cache-control", "no-store".parse().unwrap());
    // Applies to stylesheet subresources too; the launch capability is never a Referer.
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    // Even navigation to an asset cannot create an IPC-enabled HTML document.
    headers.insert(
        "content-security-policy",
        "default-src 'none'; sandbox".parse().unwrap(),
    );
    response
}

fn deliver(
    request: &Request<Vec<u8>>,
    authorize: impl FnOnce(u16) -> Result<zeroize::Zeroizing<String>, ()>,
    still_current: impl FnOnce() -> bool,
) -> Response<Vec<u8>> {
    let refused = || reply(403, "text/plain", Vec::new());
    let Some(asset) = admit(request) else {
        return refused();
    };
    let Ok(credential) = authorize(asset.port) else {
        return refused();
    };
    // Destination comes only from the supervised port, never from a renderer host.
    let endpoint = format!("http://127.0.0.1:{}{}", asset.port, asset.path);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let result = (|| {
        let mut response = agent
            .get(&endpoint)
            .header("Authorization", &format!("Bearer {}", credential.as_str()))
            .call()
            .map_err(|_| ())?;
        if response.status().as_u16() != 200 {
            return Err(());
        }
        if asset.mime == "application/javascript"
            && response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next())
                != Some(asset.mime)
        {
            return Err(());
        }
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take((MAX_BUNDLE_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| ())?;
        if body.len() > MAX_BUNDLE_BYTES || !still_current() {
            return Err(());
        }
        Ok(body)
    })();
    match result {
        Ok(body) => reply(200, asset.mime, body),
        Err(()) => refused(),
    }
}

#[derive(PartialEq, Eq)]
struct Binding {
    status: super::BundledServerStatus,
    reference: super::NativeCredentialReference,
    epoch: String,
}

fn binding(app: &AppHandle, port: u16) -> Result<Binding, ()> {
    let status = super::unified_server_status(app);
    let authority = app.try_state::<super::NativeProfileAuthority>().ok_or(())?;
    let store = super::native_http_profile_snapshot(app).map_err(|_| ())?;
    let state = authority.0.lock().map_err(|_| ())?;
    let desktop = app.try_state::<super::DesktopServerState>().ok_or(())?;
    let launch = &desktop.supervisor.context.launch;
    bind_local_owner(port, status, &state, &store, launch, || {
        super::service_state::resolve_runtime_owned_service(
            &launch.station_root,
            &launch.station_home,
        )
    })
}

fn bind_local_owner(
    port: u16,
    status: super::BundledServerStatus,
    state: &super::NativeProfileAuthorityState,
    store: &super::CredentialProfileStore,
    launch: &super::SidecarLaunchContext,
    resolve_service: impl FnOnce() -> Result<
        Option<(String, super::service_state::ResolvedLocalService)>,
        String,
    >,
) -> Result<Binding, ()> {
    let origin = format!("http://127.0.0.1:{port}");
    if status.api_base.as_deref() != Some(&origin) || status.port != Some(port) {
        return Err(());
    }
    let reference = super::authorized_direct_profile_for_origin_in_store(state, store, &origin)
        .map_err(|_| ())?;
    let active = state.active.as_ref().ok_or(())?;
    super::validate_local_self_provision_owner(
        store,
        &active.name,
        launch,
        &status,
        resolve_service,
    )
    .map_err(|_| ())?;
    Ok(Binding {
        status,
        reference,
        epoch: active.binding_id.clone(),
    })
}

pub(super) fn handle(
    app: &AppHandle,
    request: Request<Vec<u8>>,
    _permit: RequestPermit,
) -> Response<Vec<u8>> {
    // Keep the permit over binding/keyring reads as well as HTTP: OS credential
    // prompts have no timeout, but moving them outside would permit unbounded
    // queued credential work. A blocked prompt affects only this webview label.
    // Admission precedes profile/keyring access; refused paths cannot exercise credentials.
    let captured = std::cell::RefCell::new(None);
    deliver(
        &request,
        |port| {
            let owner = binding(app, port)?;
            let credential = super::credential_entry(&owner.reference)
                .map_err(|_| ())?
                .get_password()
                .map_err(|_| ())?;
            *captured.borrow_mut() = Some((port, owner));
            Ok(zeroize::Zeroizing::new(credential))
        },
        || {
            captured
                .borrow()
                .as_ref()
                .is_some_and(|(port, owner)| binding(app, *port).as_ref() == Ok(owner))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use tauri::http::Uri;

    fn request(path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(format!("station-plugin://localhost{path}"))
            .body(Vec::new())
            .unwrap()
    }

    fn serve(body: Vec<u8>, headers: &str) -> (u16, std::thread::JoinHandle<String>) {
        serve_status(body, headers, "200 OK")
    }

    fn serve_status(
        body: Vec<u8>,
        headers: &str,
        status: &str,
    ) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let headers = if headers.is_empty() {
            String::new()
        } else {
            format!("{headers}\r\n")
        };
        let status = status.to_string();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut raw = Vec::new();
            while !raw.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                raw.push(byte[0]);
            }
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            // Oversize rejection may close before the writer finishes.
            let _ = stream.write_all(&body);
            String::from_utf8(raw).unwrap()
        });
        (port, thread)
    }

    fn authorized_request(gate: &RequestGate) -> Request<Vec<u8>> {
        request(&format!(
            "/api/plugins/demo/bundle.js?port=1234&capability={}",
            gate.capability()
        ))
    }

    #[test]
    fn initialization_script_is_iife_with_json_arguments() {
        let gate = RequestGate::new();
        let dev_url = url::Url::parse("http://127.0.0.1:5173/path?ignored=yes#fragment").unwrap();
        let source = include_str!("../../src-ui/src/platform/native/pluginBundleCapability.js");
        for configured_url in [None, Some(&dev_url)] {
            let script = gate.initialization_script(configured_url);
            assert!(script.starts_with('('));
            // This envelope excludes both a global declaration and a trailing
            // top-level installPluginBundleCapability(...) invocation.
            let prefix = format!("({source})(");
            let arguments = script
                .strip_prefix(prefix.as_str())
                .and_then(|rest| rest.strip_suffix(");"))
                .expect("the included source must be invoked only as an IIFE");
            // Parse the emitted literals, not a second rendering of them: this
            // rejects unquoted/unescaped arguments, extra code and wrong order.
            let (capability, origins): (String, Vec<String>) =
                serde_json::from_str(&format!("[{arguments}]")).unwrap();
            assert_eq!(capability, gate.capability());
            let mut expected_origins = vec![if cfg!(target_os = "windows") {
                "http://tauri.localhost".to_string()
            } else {
                "tauri://localhost".to_string()
            }];
            if cfg!(debug_assertions) && configured_url.is_some() {
                expected_origins.push("http://127.0.0.1:5173".to_string());
            }
            assert_eq!(origins, expected_origins);
        }
    }

    #[test]
    fn missing_capability_is_refused_before_credentials() {
        let gate = RequestGate::new();
        let response = match gate.enter("main", &request("/api/plugins/demo/bundle.js?port=1234")) {
            Err(response) => response,
            Ok(_permit) => deliver(
                &authorized_request(&gate),
                |_| panic!("missing capability reached credentials"),
                || true,
            ),
        };
        assert_eq!(response.status(), 403);
        assert!(response.body().is_empty());
    }

    #[test]
    fn wrong_capability_is_refused_without_consuming_slots() {
        let gate = RequestGate::new();
        let foreign = RequestGate::new();
        for _ in 0..(MAX_IN_FLIGHT * 2) {
            let response = match gate.enter("main", &authorized_request(&foreign)) {
                Err(response) => response,
                Ok(_permit) => deliver(
                    &authorized_request(&gate),
                    |_| panic!("wrong capability reached credentials"),
                    || true,
                ),
            };
            assert_eq!(response.status(), 403);
            assert!(response.body().is_empty());
        }
        let permits: Vec<_> = (0..MAX_IN_FLIGHT)
            .map(|_| {
                gate.enter("main", &authorized_request(&gate))
                    .unwrap_or_else(|_| panic!("unauthorized request consumed a slot"))
            })
            .collect();
        // Invalid capabilities stay 403 even at capacity, rather than leaking 429.
        assert_eq!(
            gate.enter("main", &authorized_request(&foreign))
                .err()
                .unwrap()
                .status(),
            403
        );
        drop(permits);
    }

    #[test]
    fn request_capacity_is_independent_per_webview_and_released_on_unwind() {
        let gate = RequestGate::new();
        let request = authorized_request(&gate);
        let main: Vec<_> = (0..MAX_IN_FLIGHT)
            .map(|_| {
                gate.enter("main", &request)
                    .unwrap_or_else(|_| panic!("main slot unavailable"))
            })
            .collect();
        let label = "workspace-pane-pop-out-41a4f105-33ca-4fa0-b054-23f02b6e74bd";
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _popouts: Vec<_> = (0..MAX_IN_FLIGHT)
                .map(|_| {
                    gate.enter(label, &request)
                        .unwrap_or_else(|_| panic!("main consumed pop-out capacity"))
                })
                .collect();
            assert_eq!(gate.enter(label, &request).err().unwrap().status(), 429);
            // This proves permit drop on unwind, not spawn_blocking scheduling.
            panic!("injected unwind");
        }));
        assert!(result.is_err());
        let restored: Vec<_> = (0..MAX_IN_FLIGHT)
            .map(|_| {
                gate.enter(label, &request)
                    .unwrap_or_else(|_| panic!("panic leaked slot"))
            })
            .collect();
        assert_eq!(gate.enter("main", &request).err().unwrap().status(), 429);
        drop((main, restored));
        assert!(gate.in_flight.lock().unwrap().is_empty());
    }

    #[test]
    fn foreign_webviews_are_refused_before_credentials() {
        let gate = RequestGate::new();
        for label in [
            "browser-preview-41a4f105-33ca-4fa0-b054-23f02b6e74bd",
            "unknown",
            "",
            "main-copy",
            "workspace-pane-pop-out-unknown",
            "workspace-pane-pop-out-41a4f10533ca4fa0b05423f02b6e74bd",
            "workspace-pane-pop-out-41a4f105-33ca-1fa0-b054-23f02b6e74bd",
            "workspace-pane-pop-out-41a4f105-33ca-4fa0-b054-23f02b6e74bd-extra",
        ] {
            let response = match gate.enter(label, &authorized_request(&gate)) {
                Err(response) => response,
                Ok(_permit) => deliver(
                    &request("/api/plugins/demo/bundle.js?port=1234"),
                    |_| panic!("foreign webview reached credentials: {label}"),
                    || true,
                ),
            };
            assert_eq!(response.status(), 403, "{label}");
        }
        for label in [
            "main",
            "workspace-pane-pop-out-41a4f105-33ca-4fa0-b054-23f02b6e74bd",
        ] {
            assert!(
                gate.enter(label, &authorized_request(&gate)).is_ok(),
                "{label}"
            );
        }
    }

    #[test]
    fn concurrent_requests_are_capped_before_credentials_and_slots_are_released() {
        let gate = RequestGate::new();
        let (started, observed) = std::sync::mpsc::channel();
        let mut workers = Vec::new();
        let mut releases = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            let gate = Arc::clone(&gate);
            let started = started.clone();
            let (release, released) = std::sync::mpsc::channel();
            releases.push(release);
            workers.push(std::thread::spawn(move || {
                let _permit = gate
                    .enter("main", &authorized_request(&gate))
                    .unwrap_or_else(|_| panic!("slot unavailable"));
                deliver(
                    &request("/api/plugins/demo/bundle.js?port=1234"),
                    |_| {
                        started.send(()).unwrap();
                        released.recv_timeout(Duration::from_secs(5)).unwrap();
                        Err(())
                    },
                    || true,
                )
            }));
        }
        for _ in 0..MAX_IN_FLIGHT {
            observed.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        let response = match gate.enter("main", &authorized_request(&gate)) {
            Err(response) => response,
            Ok(_permit) => deliver(
                &request("/api/plugins/demo/bundle.js?port=1234"),
                |_| panic!("over-limit request reached credentials"),
                || true,
            ),
        };
        assert_eq!(response.status(), 429);
        // A foreign page remains forbidden even when this label is at capacity.
        assert_eq!(
            gate.enter("browser-preview-busy", &authorized_request(&gate))
                .err()
                .unwrap()
                .status(),
            403
        );
        for release in releases {
            release.send(()).unwrap();
        }
        for worker in workers {
            assert_eq!(worker.join().unwrap().status(), 403);
        }
        let permits: Vec<_> = (0..MAX_IN_FLIGHT)
            .map(|_| {
                gate.enter("main", &authorized_request(&gate))
                    .unwrap_or_else(|_| panic!("slot leaked"))
            })
            .collect();
        assert_eq!(
            gate.enter("main", &authorized_request(&gate))
                .err()
                .unwrap()
                .status(),
            429
        );
        drop(permits);
        assert!(gate.enter("main", &authorized_request(&gate)).is_ok());
    }

    fn owner_fixture() -> (
        tempfile::TempDir,
        super::super::CredentialProfileStore,
        super::super::NativeProfileAuthorityState,
        super::super::SidecarLaunchContext,
        super::super::BundledServerStatus,
    ) {
        use super::super::*;
        let directory = tempfile::tempdir().unwrap();
        let station_root = directory.path().join("station");
        let station_home = station_root.join("instances/plugin-test");
        std::fs::create_dir_all(&station_home).unwrap();
        let launch = SidecarLaunchContext {
            resource_dir: directory.path().join("resources"),
            station_root,
            station_home,
            home: directory.path().to_string_lossy().into_owned(),
            shell_path: String::new(),
            channel: None,
            pinned_port: Some(43123),
            supervisor_birth: "birth".into(),
            instance_id: "inst".into(),
        };
        let store = parse_station_profile_store(&serde_json::json!({
            "schemaVersion":1,"revision":1,"defaultProfile":"local","projectProfiles":{},
            "profiles":[{"schemaVersion":1,"name":"local","endpoint":"http://127.0.0.1:43123",
                "credentialRef":{"kind":"station-bearer","id":"host-reference"},
                "environmentId":"environment-local","setupSource":"local","configurationState":"configured",
                "localService":{"instanceId":"inst","baseDir":launch.station_home.to_str().unwrap(),"serverPort":43123,"uiPort":43001},
                "createdAt":1,"updatedAt":1}]
        }).to_string()).unwrap();
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &store).unwrap();
        authority.active = Some(AuthorizedProfile {
            name: "local".into(),
            reference: store.profiles[0].credential_ref.clone().unwrap(),
            binding_id: "epoch".into(),
        });
        let mut status = BundledServerStatus::initial(String::new(), String::new());
        status.phase = bundled_server_state::ServerPhase::Running;
        status.port = Some(43123);
        status.api_base = Some("http://127.0.0.1:43123".into());
        status.instance_id = Some("inst".into());
        status.generation = Some(1);
        status.boot_id = Some("boot".into());
        (directory, store, authority, launch, status)
    }

    #[test]
    fn binding_refuses_port_and_api_base_mismatches() {
        let (_directory, store, authority, launch, status) = owner_fixture();
        let bind = |port, status| {
            bind_local_owner(port, status, &authority, &store, &launch, || {
                panic!("sidecar has no service manifest")
            })
        };
        assert!(bind(43123, status.clone()).is_ok());
        assert!(bind(43124, status.clone()).is_err());
        let mut wrong_port = status.clone();
        wrong_port.port = Some(43124);
        assert!(bind(43123, wrong_port).is_err());
        let mut wrong_base = status;
        wrong_base.api_base = Some("http://127.0.0.1:43124".into());
        assert!(bind(43123, wrong_base).is_err());
    }

    #[test]
    fn binding_refuses_foreign_local_owner() {
        let (_directory, store, authority, mut launch, status) = owner_fixture();
        assert!(bind_local_owner(
            43123,
            status.clone(),
            &authority,
            &store,
            &launch,
            || panic!("sidecar route")
        )
        .is_ok());
        launch.station_home = launch.station_root.join("instances/foreign");
        std::fs::create_dir_all(&launch.station_home).unwrap();
        assert!(
            bind_local_owner(43123, status, &authority, &store, &launch, || panic!(
                "sidecar route"
            ))
            .is_err()
        );
    }

    #[test]
    fn binding_refuses_nonlocal_setup_source() {
        let (_directory, mut store, authority, launch, status) = owner_fixture();
        assert!(bind_local_owner(
            43123,
            status.clone(),
            &authority,
            &store,
            &launch,
            || panic!("sidecar route")
        )
        .is_ok());
        store.profiles[0].setup_source = "paired".into();
        // Pairing metadata alone is not local ownership; direct authorization is still valid.
        assert!(super::super::authorized_direct_profile_for_origin_in_store(
            &authority,
            &store,
            "http://127.0.0.1:43123"
        )
        .is_ok());
        assert!(
            bind_local_owner(43123, status, &authority, &store, &launch, || panic!(
                "sidecar route"
            ))
            .is_err()
        );
    }

    #[test]
    fn upstream_errors_and_redirects_are_refused_without_following() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        for status in ["404 Not Found", "500 Internal Server Error", "302 Found"] {
            let (port, server) = serve_status(b"untrusted".to_vec(), &format!("Content-Type: application/javascript\r\nLocation: http://127.0.0.1:{}/api/plugins/demo/bundle.js", destination.local_addr().unwrap().port()), status);
            let response = deliver(
                &request(&format!("/api/plugins/demo/bundle.js?port={port}")),
                |_| Ok(zeroize::Zeroizing::new("secret".into())),
                || true,
            );
            assert_eq!(response.status(), 403, "{status}");
            assert!(response.body().is_empty());
            server.join().unwrap();
            assert_eq!(
                destination.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

    #[test]
    fn javascript_with_wrong_or_missing_content_type_is_refused() {
        for headers in ["Content-Type: text/html", "Content-Type: text/css", ""] {
            let (port, server) = serve(b"untrusted".to_vec(), headers);
            let response = deliver(
                &request(&format!("/api/plugins/demo/bundle.js?port={port}")),
                |_| Ok(zeroize::Zeroizing::new("secret".into())),
                || true,
            );
            assert_eq!(response.status(), 403, "{headers}");
            assert!(response.body().is_empty());
            server.join().unwrap();
        }
    }

    #[test]
    fn allowed_assets_use_host_credential_without_forwarding_headers() {
        for (file, mime, scheme) in [
            (
                "bundle.js",
                "application/javascript",
                "station-plugin://localhost",
            ),
            ("bundle.css", "text/css", "http://station-plugin.localhost"),
        ] {
            let (port, server) = serve(
                b"asset bytes".to_vec(),
                &format!("Content-Type: {mime}\r\nSet-Cookie: secret=hidden"),
            );
            let request = Request::builder()
                .uri(format!("{scheme}/api/plugins/demo/{file}?port={port}&capability=transient-test-capability"))
                .header("Authorization", "renderer-controlled")
                .body(Vec::new())
                .unwrap();
            let response = deliver(
                &request,
                |actual| {
                    assert_eq!(actual, port);
                    Ok(zeroize::Zeroizing::new("host-only-credential".into()))
                },
                || true,
            );
            assert_eq!(response.status(), 200);
            assert_eq!(response.body(), b"asset bytes");
            assert_eq!(response.headers()["content-type"], mime);
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.headers()["referrer-policy"], "no-referrer");
            assert!(!response.headers().contains_key("set-cookie"));
            let sent = server.join().unwrap().to_ascii_lowercase();
            assert!(sent.starts_with(&format!("get /api/plugins/demo/{file} http/1.1\r\n")));
            assert!(sent.contains("authorization: bearer host-only-credential\r\n"));
            assert!(!sent.contains("renderer-controlled"));
            assert!(!sent.contains("capability"));
        }
    }

    #[test]
    fn other_paths_traversal_hosts_methods_and_queries_never_reach_credentials() {
        for path in [
            "/api/plugins/demo/plugin.json",
            "/api/plugins/demo/bundle.js/extra",
            "/api/settings",
            "/api/plugins/../bundle.js",
            "/api/plugins/./bundle.js",
            "/api/plugins/%2e%2e/bundle.js",
            "/api/plugins/demo%2f../bundle.js",
            "/api/plugins/demo%5cevil/bundle.js",
            "/api/plugins//bundle.js",
            "/api/plugins/demo/bundle.js?port=0",
            "/api/plugins/demo/bundle.js?port=65536",
            "/api/plugins/demo/bundle.js?port=1234&url=http://evil.test",
            "/api/plugins/demo/bundle.js?port=1234&port=1235",
            "/api/plugin-drafts/demo/bundle.js",
        ] {
            let path = if path.contains('?') {
                path.into()
            } else {
                format!("{path}?port=1234")
            };
            let response = deliver(
                &request(&path),
                |_| panic!("refused path reached credential: {path}"),
                || true,
            );
            assert_eq!(response.status(), 403, "{path}");
        }
        for uri in [
            "station-plugin://evil.test/api/plugins/demo/bundle.js?port=1234",
            "station-plugin://localhost:1234/api/plugins/demo/bundle.js?port=1234",
            "http://127.0.0.1/api/plugins/demo/bundle.js?port=1234",
        ] {
            let mut req = request("/api/plugins/demo/bundle.js?port=1234");
            *req.uri_mut() = uri.parse::<Uri>().unwrap();
            assert_eq!(
                deliver(&req, |_| panic!("wrong host reached credentials"), || true).status(),
                403
            );
        }
        for method in [Method::POST, Method::HEAD, Method::OPTIONS] {
            let mut req = request("/api/plugins/demo/bundle.js?port=1234");
            *req.method_mut() = method;
            assert_eq!(
                deliver(
                    &req,
                    |_| panic!("wrong method reached credentials"),
                    || true
                )
                .status(),
                403
            );
        }
    }

    #[test]
    fn oversize_decoded_content_and_retired_authority_are_refused() {
        for (body, current) in [
            (vec![b'x'; MAX_BUNDLE_BYTES + 1], true),
            (b"valid".to_vec(), false),
        ] {
            let (port, server) = serve(body, "Content-Type: application/javascript");
            let req = request(&format!("/api/plugins/demo/bundle.js?port={port}"));
            let response = deliver(
                &req,
                |_| Ok(zeroize::Zeroizing::new("secret".into())),
                || current,
            );
            assert_eq!(response.status(), 403);
            assert!(response.body().is_empty());
            server.join().unwrap();
        }
    }
}
