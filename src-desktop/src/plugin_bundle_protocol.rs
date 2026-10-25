//! Executable asset delivery, never a general authenticated proxy.
use std::io::Read;
use std::time::Duration;
use tauri::http::{Method, Request, Response};
use tauri::{AppHandle, Manager};

const MAX_BUNDLE_BYTES: usize = 16 * 1024 * 1024;

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
    let port = uri.query()?.strip_prefix("port=")?;
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
    let origin = format!("http://127.0.0.1:{port}");
    if status.api_base.as_deref() != Some(&origin) || status.port != Some(port) {
        return Err(());
    }
    let authority = app.try_state::<super::NativeProfileAuthority>().ok_or(())?;
    let store = super::native_http_profile_snapshot(app).map_err(|_| ())?;
    let state = authority.0.lock().map_err(|_| ())?;
    let reference = super::authorized_direct_profile_for_origin_in_store(&state, &store, &origin)
        .map_err(|_| ())?;
    let active = state.active.as_ref().ok_or(())?;
    let profile = super::selected_profile_from_store(&store, &active.name).map_err(|_| ())?;
    let desktop = app.try_state::<super::DesktopServerState>().ok_or(())?;
    let launch = &desktop.supervisor.context.launch;
    super::validate_local_self_provision_owner(&store, &active.name, launch, &status, || {
        super::service_state::resolve_runtime_owned_service(
            &launch.station_root,
            &launch.station_home,
        )
    })
    .map_err(|_| ())?;
    if profile.setup_source != "local" {
        return Err(());
    }
    Ok(Binding {
        status,
        reference,
        epoch: active.binding_id.clone(),
    })
}

pub(super) fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
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
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let headers = headers.to_string();
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
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{headers}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            // Oversize rejection may close before the writer finishes.
            let _ = stream.write_all(&body);
            String::from_utf8(raw).unwrap()
        });
        (port, thread)
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
                .uri(format!("{scheme}/api/plugins/demo/{file}?port={port}"))
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
            assert!(!response.headers().contains_key("set-cookie"));
            let sent = server.join().unwrap().to_ascii_lowercase();
            assert!(sent.starts_with(&format!("get /api/plugins/demo/{file} http/1.1\r\n")));
            assert!(sent.contains("authorization: bearer host-only-credential\r\n"));
            assert!(!sent.contains("renderer-controlled"));
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
