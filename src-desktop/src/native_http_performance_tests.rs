use super::*;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

struct KeepAliveStation {
    origin: String,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    server: Option<std::thread::JoinHandle<()>>,
}

impl KeepAliveStation {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let count = Arc::clone(&connections);
        let stopping = Arc::clone(&stop);
        let server = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let id = count.fetch_add(1, Ordering::SeqCst) + 1;
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        workers.push(std::thread::spawn(move || {
                            let mut reader = BufReader::new(stream);
                            loop {
                                let mut line = String::new();
                                match reader.read_line(&mut line) {
                                    Ok(0) | Err(_) => break,
                                    Ok(_) => {}
                                }
                                assert!(line.starts_with("GET /"));
                                let mut authorization = String::new();
                                loop {
                                    line.clear();
                                    assert!(reader.read_line(&mut line).unwrap() > 0);
                                    if line == "\r\n" {
                                        break;
                                    }
                                    if line.to_ascii_lowercase().starts_with("authorization:") {
                                        authorization = line.trim().to_owned();
                                    }
                                }
                                let body = format!("{id}:{authorization}");
                                write!(
                                    reader.get_mut(),
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                                    body.len()
                                )
                                .unwrap();
                            }
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => panic!("accept: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            origin,
            connections,
            stop,
            server: Some(server),
        }
    }

    fn get(&self, agent: &ureq::Agent, bearer: &str) -> String {
        let request = ureq::http::Request::builder()
            .uri(format!("{}/api/system/status", self.origin))
            .header("Authorization", format!("Bearer {bearer}"))
            .body(Vec::new())
            .unwrap();
        agent
            .run(request)
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap()
    }
}

impl Drop for KeepAliveStation {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.server.take().unwrap().join().unwrap();
    }
}

fn pool_key(origin: &str) -> NativeHttpPoolKey {
    NativeHttpPoolKey {
        origin: origin.to_owned(),
        binding_id: "epoch-a".into(),
        reference: NativeCredentialReference {
            kind: "station-bearer".into(),
            id: "credential-a".into(),
        },
        profile_revision: 1,
        credential_digest: [1; 32],
    }
}

#[test]
fn native_http_pool_reuses_connections_and_partitions_every_authority_component() {
    let station = KeepAliveStation::start();
    let mut store = parse_station_profile_store(
        &serde_json::json!({
            "schemaVersion":1, "revision":1, "defaultProfile":"one", "projectProfiles":{},
            "profiles":[{"schemaVersion":1, "name":"one", "endpoint":station.origin,
                "credentialRef":{"kind":"station-bearer", "id":"credential-a"},
                "environmentId":"environment-one", "setupSource":"hosted",
                "configurationState":"configured", "createdAt":1, "updatedAt":1}]
        })
        .to_string(),
    )
    .unwrap();
    let mut state = NativeProfileAuthorityState::default();
    observe_configured_profile_bindings(&mut state, &store).unwrap();
    let first = authorize_active_profile_in_state(&mut state, &store, "one").unwrap();
    let reference = store.profiles[0].credential_ref.clone().unwrap();
    for _ in 0..4 {
        let agent = native_http_agent_in_store(
            &mut state,
            &store,
            Some(&first.binding_id),
            &station.origin,
            &reference,
            "first",
        )
        .unwrap();
        assert_eq!(
            station.get(&agent, "first"),
            "1:authorization: Bearer first"
        );
    }
    let renewed = authorize_active_profile_in_state(&mut state, &store, "one").unwrap();
    assert!(native_http_agent_in_store(
        &mut state,
        &store,
        Some(&first.binding_id),
        &station.origin,
        &reference,
        "first"
    )
    .is_err());
    let agent = native_http_agent_in_store(
        &mut state,
        &store,
        Some(&renewed.binding_id),
        &station.origin,
        &reference,
        "first",
    )
    .unwrap();
    assert!(station.get(&agent, "first").starts_with("2:"));
    store.revision += 1;
    let agent = native_http_agent_in_store(
        &mut state,
        &store,
        None,
        &station.origin,
        &reference,
        "first",
    )
    .unwrap();
    assert!(station.get(&agent, "first").starts_with("3:"));
    let agent = native_http_agent_in_store(
        &mut state,
        &store,
        None,
        &station.origin,
        &reference,
        "changed",
    )
    .unwrap();
    assert_eq!(
        station.get(&agent, "changed"),
        "4:authorization: Bearer changed"
    );
    state
        .transitioning
        .insert(credential_reference_key(&reference).unwrap());
    assert!(native_http_agent_in_store(
        &mut state,
        &store,
        None,
        &station.origin,
        &reference,
        "changed"
    )
    .is_err());
    state.transitioning.clear();
    store.profiles[0].credential_ref.as_mut().unwrap().id = "credential-b".into();
    observe_configured_profile_bindings(&mut state, &store).unwrap();
    authorize_active_profile_in_state(&mut state, &store, "one").unwrap();
    let replacement = store.profiles[0].credential_ref.clone().unwrap();
    assert!(native_http_agent_in_store(
        &mut state,
        &store,
        None,
        &station.origin,
        &reference,
        "changed"
    )
    .is_err());
    let agent = native_http_agent_in_store(
        &mut state,
        &store,
        None,
        &station.origin,
        &replacement,
        "changed",
    )
    .unwrap();
    assert!(station.get(&agent, "changed").starts_with("5:"));
    let other = KeepAliveStation::start();
    assert!(native_http_agent_in_store(
        &mut state,
        &store,
        None,
        &other.origin,
        &replacement,
        "changed"
    )
    .is_err());
    assert_eq!(other.connections.load(Ordering::SeqCst), 0);
    assert_eq!(station.connections.load(Ordering::SeqCst), 5);
}

#[test]
fn native_http_pool_connection_harness() {
    let fresh = KeepAliveStation::start();
    for _ in 0..8 {
        fresh.get(&native_http_agent(), "fixture");
    }
    assert_eq!(fresh.connections.load(Ordering::SeqCst), 8);
    let shared = KeepAliveStation::start();
    let mut pool = NativeHttpAgentPool::default();
    for _ in 0..8 {
        shared.get(&pool.agent(pool_key(&shared.origin)), "fixture");
    }
    assert_eq!(shared.connections.load(Ordering::SeqCst), 1);
    println!("native HTTP harness: 8 requests; fresh-agent connections=8; authority-pooled connections=1");
}

#[test]
fn native_http_channel_delivers_raw_bytes_and_json_control_messages() {
    use tauri::ipc::InvokeResponseBody;
    let received = Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = Arc::clone(&received);
    let mut channel = Channel::<InvokeResponseBody>::new(move |body| {
        capture.lock().unwrap().push(body);
        Ok(())
    });
    let bytes: Vec<u8> = (0..64 * 1024).map(|i| (i % 256) as u8).collect();
    NativeHttpMessageSink::send(
        &mut channel,
        NativeHttpMessage::Response {
            status: 200,
            headers: Default::default(),
            body_length: Some(bytes.len() as u64),
        },
    )
    .unwrap();
    NativeHttpMessageSink::send(
        &mut channel,
        NativeHttpMessage::Chunk {
            bytes: bytes.clone(),
        },
    )
    .unwrap();
    NativeHttpMessageSink::send(&mut channel, NativeHttpMessage::End).unwrap();
    let received = received.lock().unwrap();
    assert!(
        matches!(&received[0], InvokeResponseBody::Json(json) if json.contains("\"type\":\"response\""))
    );
    assert!(matches!(&received[1], InvokeResponseBody::Raw(raw) if *raw == bytes));
    assert!(matches!(&received[2], InvokeResponseBody::Json(json) if json == "{\"type\":\"end\"}"));
    let old = serde_json::to_vec(&serde_json::json!({ "type": "chunk", "bytes": bytes })).unwrap();
    println!("native IPC harness: 65536 payload bytes; JSON-number message={} bytes; raw payload=65536 bytes", old.len());
    assert!(old.len() > 3 * 65536);
}

#[test]
fn native_http_upload_decodes_base64_and_refuses_invalid_or_oversized_bodies() {
    use base64::Engine;
    let bytes: Vec<u8> = (0..=255).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let request = serde_json::json!({ "requestId": "binary", "url": "https://station.example/api/upload", "method": "POST", "body": encoded });
    let parsed: NativeHttpRequest = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(parsed.body.unwrap(), bytes);
    for invalid in [
        serde_json::json!("%%%"),
        serde_json::json!([1, 2, 3]),
        serde_json::json!("A".repeat(NATIVE_HTTP_BODY_LIMIT.div_ceil(3) * 4 + 1)),
    ] {
        let mut request = request.clone();
        request["body"] = invalid;
        assert!(serde_json::from_value::<NativeHttpRequest>(request).is_err());
    }
}

#[test]
fn native_http_agent_negotiates_gzip_and_returns_decoded_bytes_without_wire_length() {
    // gzip of "hello native gzip", produced independently with Python gzip.compress(mtime=0).
    const GZIP: &[u8] = &[
        31, 139, 8, 0, 0, 0, 0, 0, 2, 19, 203, 72, 205, 201, 201, 87, 200, 75, 44, 201, 44, 75, 85,
        72, 175, 202, 44, 0, 0, 7, 179, 210, 220, 17, 0, 0, 0,
    ];
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut accept_encoding = String::new();
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            if line.to_ascii_lowercase().starts_with("accept-encoding:") {
                accept_encoding = line;
            }
        }
        write!(reader.get_mut(), "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", GZIP.len()).unwrap();
        reader.get_mut().write_all(GZIP).unwrap();
        accept_encoding
    });
    let mut response = native_http_agent().get(origin).call().unwrap();
    assert_eq!(response.body().content_length(), None);
    assert!(!response.headers().contains_key("content-encoding"));
    assert_eq!(
        response.body_mut().read_to_string().unwrap(),
        "hello native gzip"
    );
    assert!(server.join().unwrap().contains("gzip"));
}

#[cfg(unix)]
#[test]
fn native_http_profile_cache_refreshes_external_edits_and_rejects_unsafe_cached_files() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.path().join("profiles.json");
    write_empty_station_profile_store(&path).unwrap();
    let mut cache = StationProfileSnapshotCache::default();
    let first = cache.read(&path).unwrap();
    assert!(
        Arc::ptr_eq(&first, &cache.read(&path).unwrap()),
        "unchanged chunks reuse the parsed store"
    );
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let edited = EMPTY_STATION_PROFILE_STORE.replace("\"revision\":0", "\"revision\":1");
    std::fs::write(&path, &edited).unwrap();
    // A same-size edit with restored mtime must still invalidate via ctime.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(cache.read(&path).unwrap().revision, 1);
    let staged = root.path().join("replacement.json");
    std::fs::write(&staged, EMPTY_STATION_PROFILE_STORE).unwrap();
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600)).unwrap();
    replace_station_profile_store(&staged, &path).unwrap();
    assert_eq!(cache.read(&path).unwrap().revision, 0);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(cache.read(&path).is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&path, "malformed").unwrap();
    assert!(cache.read(&path).is_err());
    std::fs::remove_file(&path).unwrap();
    assert!(cache.read(&path).is_err());
    symlink(&staged, &path).unwrap();
    assert!(cache.read(&path).is_err());
}

#[test]
fn native_http_initialized_mobile_reads_do_not_acquire_a_writer_lock() {
    let root = tempfile::tempdir().unwrap();
    let path = secure_mobile_station_profiles_path(root.path()).unwrap();
    let initialize = || {
        let _lock = lock_station_profiles(&path)?;
        ensure_mobile_profile_store_genesis(&path)
    };
    prepare_mobile_station_profile_read(&path, initialize).unwrap();
    // Hold the real write lock: a read must complete without waiting for it,
    // creating another lock record or calling the durable genesis writer.
    let _held = lock_station_profiles(&path).unwrap();
    prepare_mobile_station_profile_read(&path, || Err("unexpected writer lock".into())).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(
        prepare_mobile_station_profile_read(&path, || Err("must not recreate".into())).is_err()
    );
}

#[test]
fn native_http_profile_replacement_recovers_a_poisoned_snapshot_cache() {
    const WORKER: &str = "STATION_SNAPSHOT_POISON_WORKER";
    if std::env::var_os(WORKER).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_http_performance_tests::native_http_profile_replacement_recovers_a_poisoned_snapshot_cache", "--nocapture"])
            .env(WORKER, "1").status().unwrap();
        assert!(status.success());
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let path = secure_mobile_station_profiles_path(root.path()).unwrap();
    write_empty_station_profile_store(&path).unwrap();
    let cache = NATIVE_HTTP_PROFILE_SNAPSHOTS.get_or_init(Default::default);
    cache.lock().unwrap().read(&path).unwrap();
    let _ = std::panic::catch_unwind(|| {
        let _held = cache.lock().unwrap();
        panic!("injected snapshot panic");
    });
    let next = root.path().join("next.json");
    std::fs::copy(&path, &next).unwrap();
    replace_station_profile_store(&next, &path).unwrap();
    assert_eq!(cache.lock().unwrap().read(&path).unwrap().revision, 0);
}

#[test]
fn native_http_genesis_read_waits_for_publication_but_missing_initialized_store_still_refuses() {
    let root = tempfile::tempdir().unwrap();
    let path = secure_mobile_station_profiles_path(root.path()).unwrap();
    let writer = lock_station_profiles(&path).unwrap();
    std::fs::write(
        path.with_file_name(".profiles-initialized"),
        b"station-mobile-profiles-v1\n",
    )
    .unwrap();
    let reading = path.clone();
    let reader = std::thread::spawn(move || {
        prepare_mobile_station_profile_read(&reading, || {
            let _lock = lock_station_profiles(&reading)?;
            ensure_mobile_profile_store_genesis(&reading)
        })?;
        let contents = read_station_profile_store(&reading).map_err(|e| e.to_string())?;
        parse_station_profile_store(&contents)
    });
    write_empty_station_profile_store(&path).unwrap();
    drop(writer);
    assert_eq!(reader.join().unwrap().unwrap().revision, 0);
    std::fs::remove_file(&path).unwrap();
    assert!(prepare_mobile_station_profile_read(&path, || {
        let _lock = lock_station_profiles(&path)?;
        ensure_mobile_profile_store_genesis(&path)
    })
    .is_err());
}

#[test]
fn native_http_stale_pool_retries_only_safe_exchanges_on_a_fresh_connection() {
    for (method, partial_response, expected_retry) in [
        ("GET", false, true),
        ("HEAD", false, true),
        ("POST", false, false),
        ("GET", true, false),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let read_request = |reader: &mut BufReader<std::net::TcpStream>| {
                let mut line = String::new();
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                }
            };
            read_request(&mut reader);
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
            read_request(&mut reader);
            // The peer accepted the request. A POST is now ambiguous; even
            // one response-header byte prevents replay of GET/HEAD.
            if partial_response {
                reader.get_mut().write_all(b"HTTP/1.1 ").unwrap();
            }
            drop(reader);
            listener.set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut retried = false;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut reader = BufReader::new(stream);
                        read_request(&mut reader);
                        reader
                            .get_mut()
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                            .unwrap();
                        retried = true;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(error) => panic!("accept: {error}"),
                }
            }
            retried
        });
        let agent = native_http_agent();
        agent
            .get(&origin)
            .call()
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap();
        let request = ureq::http::Request::builder()
            .method(method)
            .uri(&origin)
            .body(Vec::new())
            .unwrap();
        let mut revalidated = false;
        let result = native_http_transport::run(&agent, request, &AtomicBool::new(false), || {
            revalidated = true;
            Ok(())
        });
        assert_eq!(
            result.is_ok(),
            expected_retry,
            "{method} partial={partial_response}"
        );
        assert_eq!(revalidated, expected_retry);
        assert_eq!(server.join().unwrap(), expected_retry);
    }
}

#[test]
fn native_http_network_change_retires_pool_and_already_cloned_agents() {
    const WORKER: &str = "STATION_NETWORK_EPOCH_WORKER";
    if std::env::var_os(WORKER).is_none() {
        assert!(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_http_performance_tests::native_http_network_change_retires_pool_and_already_cloned_agents", "--nocapture"])
            .env(WORKER, "1").status().unwrap().success());
        return;
    }
    let station = KeepAliveStation::start();
    let mut pool = NativeHttpAgentPool::default();
    let saved = pool.agent(pool_key(&station.origin));
    assert!(station.get(&saved, "a").starts_with("1:"));
    native_http_transport::network_changed();
    assert!(station.get(&saved, "a").starts_with("2:"));
    let replacement = pool.agent(pool_key(&station.origin));
    assert!(station.get(&replacement, "a").starts_with("3:"));
}
