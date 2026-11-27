use super::{
    authorized_profile_context_in_store, credential_entry, native_http_agent,
    native_http_profile_snapshot, native_request_binding_stale, scoped_profile_for_origin,
    AuthorizedProfileContext, NativeCommandError, NativeCredentialBinding, NativeProfileAuthority,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::rand::SecureRandom;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const AUTHORIZATION_TTL: Duration = Duration::from_secs(600);
const REFRESH_INTERVAL: Duration = Duration::from_secs(15);
const LOOKUP_BUDGET: Duration = Duration::from_secs(20);
const RESPONSE_LIMIT: u64 = 32 * 1024;
const MAX_ROUTES: usize = 16;
const MAX_PROBES: usize = 4;

pub(super) struct Authorization {
    binding_id: String,
    profile_revision: u64,
    canonical_origin: String,
    environment_id: String,
    origins: Vec<String>,
    created_at: Instant,
    expires_at: Instant,
    expires_at_ms: u64,
}

impl Authorization {
    pub(super) fn permits(
        &self,
        binding_id: &str,
        profile_revision: u64,
        binding: &NativeCredentialBinding,
        origin: &str,
    ) -> bool {
        self.binding_id == binding_id
            && self.profile_revision == profile_revision
            && self.canonical_origin == binding.exact_origin
            && self.environment_id == binding.environment_id
            && self.expires_at > Instant::now()
            && self.origins.iter().any(|candidate| candidate == origin)
    }

    fn receipt(&self) -> Receipt {
        Receipt {
            binding_id: self.binding_id.clone(),
            exact_origin: self.canonical_origin.clone(),
            authorized_origins: self.origins.clone(),
            expires_at_ms: self.expires_at_ms,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    binding_id: String,
    exact_origin: String,
    authorized_origins: Vec<String>,
    expires_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Routes {
    environment_id: String,
    routes: Vec<Route>,
    publication: Option<Publication>,
}

#[derive(Deserialize)]
struct Route {
    kind: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Publication {
    app_origins: Vec<String>,
    status: String,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Proof {
    protocol_version: u8,
    environment_id: String,
    nonce: String,
    signature: String,
}

fn route_error() -> NativeCommandError {
    NativeCommandError::new(
        "route_verification_failed",
        "Station routes could not be verified",
    )
}

fn https_origin(origin: &str) -> bool {
    let Ok(parsed) = url::Url::parse(origin) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.origin().ascii_serialization() == origin
        && matches!(parsed.host(), Some(url::Host::Domain(domain)) if domain.split('.').all(|label| !label.is_empty() && label.len() <= 63 && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') && !label.starts_with('-') && !label.ends_with('-')))
        && parsed.port() != Some(0)
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}

fn advertised_origins(
    routes: Routes,
    environment_id: &str,
) -> Result<Vec<String>, NativeCommandError> {
    if routes.environment_id != environment_id || routes.routes.len() > MAX_ROUTES {
        return Err(route_error());
    }
    let Some(publication) = routes.publication else {
        return Ok(Vec::new());
    };
    if publication.app_origins.len() > MAX_ROUTES {
        return Err(route_error());
    }
    match publication.status.as_str() {
        "disabled" => return Ok(Vec::new()),
        "ready" | "unavailable" | "ambiguous" => {}
        _ => return Err(route_error()),
    }
    let mut origins = Vec::new();
    for origin in publication.app_origins {
        if !https_origin(&origin)
            || !routes
                .routes
                .iter()
                .any(|route| route.kind == "tailscale-https" && route.url == origin)
        {
            return Err(route_error());
        }
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins.sort();
    Ok(origins)
}

fn read_json<T: serde::de::DeserializeOwned>(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T, NativeCommandError> {
    if response.status().as_u16() != 200
        || response
            .body()
            .content_length()
            .is_some_and(|length| length > RESPONSE_LIMIT)
    {
        return Err(route_error());
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(RESPONSE_LIMIT)
        .read_to_string()
        .map_err(|_| route_error())?;
    serde_json::from_str(&body).map_err(|_| route_error())
}

fn request_json(
    agent: &ureq::Agent,
    method: &str,
    url: String,
    body: Vec<u8>,
    credential: Option<&str>,
    deadline: Instant,
) -> Result<ureq::http::Response<ureq::Body>, NativeCommandError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|budget| !budget.is_zero())
        .ok_or_else(route_error)?;
    let budget = remaining.min(Duration::from_secs(5));
    let mut request = ureq::http::Request::builder()
        .method(method)
        .uri(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json");
    if let Some(credential) = credential {
        request = request.header("Authorization", format!("Bearer {credential}"));
    }
    let request = request.body(body).map_err(|_| route_error())?;
    let request = agent
        .configure_request(request)
        .timeout_global(Some(budget))
        .timeout_recv_body(Some(budget))
        .build();
    agent.run(request).map_err(|_| route_error())
}

fn public_proof(
    agent: &ureq::Agent,
    origin: &str,
    environment_id: &str,
    nonce: &str,
    deadline: Instant,
) -> Result<Proof, NativeCommandError> {
    let body = serde_json::json!({ "protocolVersion": 1, "nonce": nonce }).to_string();
    let response = request_json(
        agent,
        "POST",
        format!("{origin}/.well-known/station/v1/proof"),
        body.into_bytes(),
        None,
        deadline,
    )?;
    let proof: Proof = read_json(response)?;
    if proof.protocol_version != 1
        || proof.environment_id != environment_id
        || proof.nonce != nonce
        || proof.signature.len() != 43
    {
        return Err(route_error());
    }
    Ok(proof)
}

fn discover(
    agent: &ureq::Agent,
    context: &AuthorizedProfileContext,
    credential: &str,
) -> Result<Vec<String>, NativeCommandError> {
    if !super::credential_endpoint_uses_secure_transport(&context.exact_origin) {
        return Err(route_error());
    }
    let deadline = Instant::now() + LOOKUP_BUDGET;
    let response = request_json(
        agent,
        "GET",
        format!("{}/api/system/routes", context.exact_origin),
        Vec::new(),
        Some(credential),
        deadline,
    )?;
    if response.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    let candidates = advertised_origins(read_json(response)?, &context.environment_id)?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let mut random = [0_u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| route_error())?;
    let nonce = URL_SAFE_NO_PAD.encode(random);
    let anchor_proof = public_proof(
        agent,
        &context.exact_origin,
        &context.environment_id,
        &nonce,
        deadline,
    )?;
    let mut origins = Vec::new();
    for candidate in candidates
        .into_iter()
        .filter(|origin| origin != &context.exact_origin)
        .take(MAX_PROBES)
    {
        if Instant::now() >= deadline {
            break;
        }
        if public_proof(agent, &candidate, &context.environment_id, &nonce, deadline)
            .is_ok_and(|proof| proof == anchor_proof)
        {
            origins.push(candidate);
        }
    }
    Ok(origins)
}

struct RefreshGuard {
    authority: NativeProfileAuthority,
    binding_id: String,
    profile_revision: u64,
    completed: bool,
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.authority.0.lock() {
            if !self.completed
                && state
                    .route_authorization
                    .as_ref()
                    .is_some_and(|authorization| {
                        authorization.binding_id == self.binding_id
                            && authorization.profile_revision == self.profile_revision
                    })
            {
                state.route_authorization = None;
            }
            state.route_refreshing = false;
        }
    }
}

fn refresh(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    binding_id: &str,
) -> Result<Receipt, NativeCommandError> {
    let store = native_http_profile_snapshot(app).map_err(|_| native_request_binding_stale())?;
    let context = {
        let mut state = authority
            .0
            .lock()
            .map_err(|_| native_request_binding_stale())?;
        let context = authorized_profile_context_in_store(&state, &store)?;
        if context.binding_id != binding_id || uuid::Uuid::parse_str(binding_id).is_err() {
            return Err(native_request_binding_stale());
        }
        super::scoped_profile_for_origin_in_store(
            &state,
            &store,
            &context.binding_id,
            &context.exact_origin,
        )?;
        if let Some(authorization) = &state.route_authorization {
            if authorization.binding_id == binding_id
                && authorization.profile_revision == store.revision
                && authorization.created_at.elapsed() < REFRESH_INTERVAL
            {
                return Ok(authorization.receipt());
            }
        }
        if state.route_refreshing {
            return Err(NativeCommandError::new(
                "route_refresh_busy",
                "Station route verification is already running",
            ));
        }
        state.route_refreshing = true;
        context
    };
    let mut guard = RefreshGuard {
        authority: authority.clone(),
        binding_id: context.binding_id.clone(),
        profile_revision: context.profile_revision,
        completed: false,
    };
    let credential = zeroize::Zeroizing::new(
        credential_entry(&context.reference)?
            .get_password()
            .map_err(|_| route_error())?,
    );
    scoped_profile_for_origin(app, authority, binding_id, &context.exact_origin)?;
    let origins = discover(&native_http_agent(), &context, &credential);
    drop(credential);
    let current_store =
        native_http_profile_snapshot(app).map_err(|_| native_request_binding_stale())?;
    let mut state = authority
        .0
        .lock()
        .map_err(|_| native_request_binding_stale())?;
    let current = authorized_profile_context_in_store(&state, &current_store)?;
    if current.binding_id != context.binding_id
        || current.profile_revision != context.profile_revision
        || current.reference != context.reference
        || current.exact_origin != context.exact_origin
        || current.environment_id != context.environment_id
    {
        return Err(native_request_binding_stale());
    }
    let origins = origins?;
    let now = Instant::now();
    let authorization = Authorization {
        binding_id: context.binding_id,
        profile_revision: context.profile_revision,
        canonical_origin: context.exact_origin,
        environment_id: context.environment_id,
        origins,
        created_at: now,
        expires_at: now + AUTHORIZATION_TTL,
        expires_at_ms: (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| route_error())?
            + AUTHORIZATION_TTL)
            .as_millis() as u64,
    };
    let receipt = authorization.receipt();
    state.route_authorization = Some(authorization);
    guard.completed = true;
    Ok(receipt)
}

#[tauri::command]
pub(super) async fn station_profile_refresh_routes(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    binding_id: String,
) -> Result<Receipt, NativeCommandError> {
    let authority = authority.inner().clone();
    tauri::async_runtime::spawn_blocking(move || refresh(&app, &authority, &binding_id))
        .await
        .map_err(|_| route_error())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn request(socket: &mut TcpStream) -> String {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).unwrap()
    }

    fn reply(socket: &mut TcpStream, body: serde_json::Value) {
        let body = body.to_string();
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    }

    fn context(origin: String) -> AuthorizedProfileContext {
        AuthorizedProfileContext {
            reference: super::super::NativeCredentialReference {
                kind: "station-bearer".into(),
                id: "route-test".into(),
            },
            exact_origin: origin,
            environment_id: "environment-one".into(),
            client_instance_id: None,
            binding_id: uuid::Uuid::new_v4().to_string(),
            profile_revision: 0,
        }
    }

    fn fixture_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
        let mut command = std::process::Command::new(program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }

    #[test]
    fn discovery_admits_tls_route_only_when_fresh_proof_matches_anchor() {
        use std::io::BufRead;
        use std::process::Stdio;
        let directory = tempfile::tempdir().unwrap();
        let certificate = directory.path().join("certificate.pem");
        let key = directory.path().join("key.pem");
        let openssl = if cfg!(windows) {
            std::path::PathBuf::from(
                std::env::var_os("ProgramFiles").expect("Program Files is required"),
            )
            .join("Git/usr/bin/openssl.exe")
        } else {
            std::path::PathBuf::from("openssl")
        };
        let output = fixture_command(openssl)
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost",
                "-addext",
                "basicConstraints=critical,CA:FALSE",
                "-keyout",
            ])
            .arg(&key)
            .arg("-out")
            .arg(&certificate)
            .output()
            .expect("OpenSSL is required for the TLS route fixture");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let root = ureq::tls::Certificate::from_pem(&std::fs::read(&certificate).unwrap()).unwrap();
        let agent = super::super::native_http_agent_with(
            super::super::native_http_agent_config()
                .tls_config(
                    ureq::tls::TlsConfig::builder()
                        .root_certs([root].into())
                        .build(),
                )
                .build(),
        );
        for mode in ["match", "nonce", "signature", "environment"] {
            struct Child(std::process::Child);
            impl Drop for Child {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut child = Child(fixture_command(if cfg!(windows) { "python" } else { "python3" })
                .args(["-u", "-c", r#"
import http.server, json, re, ssl, sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == '/.well-known/station/v1/proof'
        assert self.headers.get('Authorization') is None
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert set(body) == {'nonce', 'protocolVersion'}
        assert body['protocolVersion'] == 1
        assert re.fullmatch(r'[A-Za-z0-9_-]{43}', body['nonce'])
        proof = dict(protocolVersion=1, environmentId='environment-one', nonce=body['nonce'], signature='a'*43)
        if sys.argv[3] == 'nonce': proof['nonce'] = 'different-nonce'
        if sys.argv[3] == 'signature': proof['signature'] = 'b'*43
        if sys.argv[3] == 'environment': proof['environmentId'] = 'other-environment'
        payload = json.dumps(proof).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
server.timeout = 8
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = context.wrap_socket(server.socket, server_side=True)
print(server.server_port, flush=True)
server.handle_request()
"#])
                .arg(&certificate).arg(&key).arg(mode).stdout(Stdio::piped()).spawn().expect("Python is required for the TLS route fixture"));
            let mut output = std::io::BufReader::new(child.0.stdout.take().unwrap());
            let mut line = String::new();
            output.read_line(&mut line).unwrap();
            let port: u16 = line
                .trim()
                .parse()
                .expect("TLS fixture must publish a bound port");
            let candidate = format!("https://localhost:{port}");
            let advertised = candidate.clone();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                assert!(request(&mut socket)
                    .to_ascii_lowercase()
                    .contains("authorization: bearer anchor-secret"));
                reply(
                    &mut socket,
                    serde_json::json!({"environmentId":"environment-one", "routes":[{"kind":"tailscale-https","url":advertised}], "publication":{"status":"ready","appOrigins":[advertised]}}),
                );
                let (mut socket, _) = listener.accept().unwrap();
                let received = request(&mut socket);
                let body: serde_json::Value =
                    serde_json::from_str(received.split_once("\r\n\r\n").unwrap().1).unwrap();
                reply(
                    &mut socket,
                    serde_json::json!({"protocolVersion":1,"environmentId":"environment-one","nonce":body["nonce"],"signature":"a".repeat(43)}),
                );
            });
            let origins = discover(&agent, &context(origin), "anchor-secret").unwrap();
            assert_eq!(
                origins,
                if mode == "match" {
                    vec![candidate]
                } else {
                    Vec::new()
                },
                "{mode}"
            );
            server.join().unwrap();
            assert!(child.0.wait().unwrap().success());
        }
    }

    #[test]
    fn discovery_keeps_bearer_at_anchor_and_refuses_untrusted_tls() {
        let candidate = TcpListener::bind("127.0.0.1:0").unwrap();
        let candidate_port = candidate.local_addr().unwrap().port();
        let candidate_server = std::thread::spawn(move || {
            let (mut socket, _) = candidate.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0_u8; 4096];
            let count = socket.read(&mut bytes).unwrap();
            assert!(count > 0);
            assert!(!String::from_utf8_lossy(&bytes[..count]).contains("anchor-secret"));
            assert_eq!(bytes[0], 0x16);
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let received = request(&mut socket);
            assert!(received.starts_with("GET /api/system/routes HTTP/1.1"));
            assert!(received
                .to_ascii_lowercase()
                .contains("authorization: bearer anchor-secret"));
            let candidate_origin = format!("https://localhost:{candidate_port}");
            reply(
                &mut socket,
                serde_json::json!({
                    "environmentId": "environment-one",
                    "routes": [{"kind":"tailscale-https", "url":candidate_origin}],
                    "publication": {"status":"ready", "appOrigins":[candidate_origin]}
                }),
            );
            let (mut socket, _) = listener.accept().unwrap();
            let received = request(&mut socket);
            assert!(received.starts_with("POST /.well-known/station/v1/proof HTTP/1.1"));
            assert!(!received.to_ascii_lowercase().contains("authorization:"));
            let body: serde_json::Value =
                serde_json::from_str(received.split_once("\r\n\r\n").unwrap().1).unwrap();
            reply(
                &mut socket,
                serde_json::json!({"protocolVersion":1,"environmentId":"environment-one","nonce":body["nonce"],"signature":"a".repeat(43)}),
            );
        });
        assert!(
            discover(&native_http_agent(), &context(origin), "anchor-secret")
                .unwrap()
                .is_empty()
        );
        server.join().unwrap();
        candidate_server.join().unwrap();
    }

    #[test]
    fn discovery_refuses_identity_reassignment_and_disabled_publication() {
        for (environment_id, status, succeeds) in [
            ("other-environment", "ready", false),
            ("environment-one", "disabled", true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                assert!(request(&mut socket).starts_with("GET /api/system/routes HTTP/1.1"));
                reply(
                    &mut socket,
                    serde_json::json!({
                        "environmentId":environment_id,
                        "routes":[{"kind":"tailscale-https","url":"https://not-contacted.example"}],
                        "publication":{"status":status,"appOrigins":["https://not-contacted.example"]}
                    }),
                );
            });
            let result = discover(&native_http_agent(), &context(origin), "anchor-secret");
            if succeeds {
                assert!(result.unwrap().is_empty());
            } else {
                assert!(result.is_err());
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn discovery_refuses_cleartext_non_loopback_anchor() {
        assert!(discover(
            &native_http_agent(),
            &context("http://192.0.2.1:1234".into()),
            "anchor-secret"
        )
        .is_err());
    }

    #[test]
    fn discovery_does_not_follow_anchor_redirect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            assert!(request(&mut socket).contains("anchor-secret"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://not-contacted.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert!(discover(&native_http_agent(), &context(origin), "anchor-secret").is_err());
        server.join().unwrap();
    }

    #[test]
    fn scoped_transport_admits_verified_origin_and_revokes_on_epoch_revision_and_expiry() {
        let store = super::super::parse_station_profile_store(r#"{
            "schemaVersion":1,"revision":0,"defaultProfile":"one","projectProfiles":{},
            "profiles":[{"schemaVersion":1,"name":"one","endpoint":"http://127.0.0.1:59991","credentialRef":{"kind":"station-bearer","id":"route-test"},"environmentId":"environment-one","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}]
        }"#).unwrap();
        let mut state = super::super::NativeProfileAuthorityState::default();
        super::super::observe_configured_profile_bindings(&mut state, &store).unwrap();
        let receipt =
            super::super::authorize_active_profile_in_state(&mut state, &store, "one").unwrap();
        let candidate = "https://station.example";
        let scoped = |state: &super::super::NativeProfileAuthorityState,
                      store: &super::super::CredentialProfileStore,
                      origin: &str| {
            super::super::scoped_profile_for_origin_in_store(
                state,
                store,
                &receipt.binding_id,
                origin,
            )
        };
        assert!(scoped(&state, &store, candidate).is_err());
        state.route_authorization = Some(Authorization {
            binding_id: receipt.binding_id.clone(),
            profile_revision: 0,
            canonical_origin: receipt.exact_origin.clone(),
            environment_id: "environment-one".into(),
            origins: vec![candidate.into()],
            created_at: Instant::now(),
            expires_at: Instant::now() + AUTHORIZATION_TTL,
            expires_at_ms: 1,
        });
        let reference = scoped(&state, &store, candidate).unwrap();
        assert_eq!(reference.id, "route-test");
        assert!(super::super::native_http_agent_in_store(
            &mut state,
            &store,
            Some(&receipt.binding_id),
            candidate,
            &reference,
            "anchor-secret"
        )
        .is_ok());
        assert!(super::super::authorized_direct_profile_for_origin_in_store(
            &state, &store, candidate
        )
        .is_err());
        assert!(scoped(&state, &store, "https://forged.example").is_err());
        let mut revised = store.clone();
        revised.revision += 1;
        assert!(scoped(&state, &revised, candidate).is_err());
        state.route_authorization.as_mut().unwrap().expires_at =
            Instant::now() - Duration::from_secs(1);
        assert!(scoped(&state, &store, candidate).is_err());
        assert!(scoped(&state, &store, &receipt.exact_origin).is_ok());
        state.route_authorization.as_mut().unwrap().expires_at = Instant::now() + AUTHORIZATION_TTL;
        super::super::authorize_active_profile_in_state(&mut state, &store, "one").unwrap();
        assert!(scoped(&state, &store, candidate).is_err());

        let authority = NativeProfileAuthority(std::sync::Arc::new(std::sync::Mutex::new(state)));
        for (different_epoch, newer_revision, completed) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            let mut current_store = store.clone();
            current_store.revision += u64::from(newer_revision);
            let current_receipt = {
                let mut state = authority.0.lock().unwrap();
                let current_receipt = super::super::authorize_active_profile_in_state(
                    &mut state,
                    &current_store,
                    "one",
                )
                .unwrap();
                state.route_authorization = Some(Authorization {
                    binding_id: current_receipt.binding_id.clone(),
                    profile_revision: current_store.revision,
                    canonical_origin: current_receipt.exact_origin.clone(),
                    environment_id: "environment-one".into(),
                    origins: vec![candidate.into()],
                    created_at: Instant::now(),
                    expires_at: Instant::now() + AUTHORIZATION_TTL,
                    expires_at_ms: 1,
                });
                state.route_refreshing = true;
                assert!(super::super::native_http_agent_in_store(
                    &mut state,
                    &current_store,
                    Some(&current_receipt.binding_id),
                    candidate,
                    &reference,
                    "anchor-secret",
                )
                .is_ok());
                current_receipt
            };
            let mut guard = RefreshGuard {
                authority: authority.clone(),
                binding_id: if different_epoch {
                    receipt.binding_id.clone()
                } else {
                    current_receipt.binding_id.clone()
                },
                profile_revision: store.revision,
                completed: false,
            };
            guard.completed = completed;
            drop(guard);
            let mut state = authority.0.lock().unwrap();
            assert!(!state.route_refreshing);
            let permitted = different_epoch || newer_revision || completed;
            assert_eq!(
                super::super::native_http_agent_in_store(
                    &mut state,
                    &current_store,
                    Some(&current_receipt.binding_id),
                    candidate,
                    &reference,
                    "anchor-secret",
                )
                .is_ok(),
                permitted,
                "epoch changed: {different_epoch}, revision changed: {newer_revision}, completed: {completed}",
            );
        }
    }
}
