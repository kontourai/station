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
                                assert!(line.starts_with("GET /") || line.starts_with("POST /"));
                                let mut authorization = String::new();
                                let mut length = 0;
                                loop {
                                    line.clear();
                                    assert!(reader.read_line(&mut line).unwrap() > 0);
                                    if line == "\r\n" {
                                        break;
                                    }
                                    if let Some(value) =
                                        line.to_ascii_lowercase().strip_prefix("content-length:")
                                    {
                                        length = value.trim().parse::<u64>().unwrap();
                                    }
                                    if line.to_ascii_lowercase().starts_with("authorization:") {
                                        authorization = line.trim().to_owned();
                                    }
                                }
                                assert_eq!(
                                    std::io::copy(
                                        &mut std::io::Read::by_ref(&mut reader).take(length),
                                        &mut std::io::sink(),
                                    )
                                    .unwrap(),
                                    length
                                );
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
    assert_eq!(
        read_native_http_profile_snapshot(&path, || Err("unexpected initialization".into()))
            .unwrap()
            .revision,
        0
    );
    assert!(!cache.is_poisoned());
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
    let (entered, waiting) = std::sync::mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        prepare_mobile_station_profile_read(&reading, || {
            entered.send(()).unwrap();
            let _lock = lock_station_profiles(&reading)?;
            ensure_mobile_profile_store_genesis(&reading)
        })?;
        let contents = read_station_profile_store(&reading).map_err(|e| e.to_string())?;
        parse_station_profile_store(&contents)
    });
    waiting
        .recv_timeout(Duration::from_secs(3))
        .expect("reader waits on genesis publication");
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
fn native_http_failed_sent_requests_are_never_replayed() {
    for (method, partial_response) in [
        ("GET", false),
        ("HEAD", false),
        ("POST", false),
        ("GET", true),
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
            // The peer accepted this request; GET can be a long-poll too.
            // Neither an EOF nor a partial response permits replay.
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
        let result =
            native_http_transport::run(&agent, request, &AtomicBool::new(false), None, || {
                revalidated = true;
                Ok(())
            });
        assert_eq!(result.is_ok(), false, "{method} partial={partial_response}");
        assert!(!revalidated);
        assert!(!server.join().unwrap());
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

#[test]
fn native_http_network_change_during_upload_does_not_interrupt_or_replay_post() {
    const WORKER: &str = "STATION_BEFORE_SEND_EPOCH_WORKER";
    if std::env::var_os(WORKER).is_none() {
        assert!(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_http_performance_tests::native_http_network_change_during_upload_does_not_interrupt_or_replay_post", "--nocapture"])
            .env(WORKER, "1").status().unwrap().success());
        return;
    }
    use ureq::unversioned::transport::{
        Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout, Transport,
    };
    #[derive(Debug)]
    struct ChangeDuringUpload;
    #[derive(Debug)]
    struct ChangingTransport {
        inner: Box<dyn Transport>,
        writes: usize,
    }
    impl Connector<Box<dyn Transport>> for ChangeDuringUpload {
        type Out = ChangingTransport;
        fn connect(
            &self,
            _: &ConnectionDetails,
            inner: Option<Box<dyn Transport>>,
        ) -> Result<Option<Self::Out>, ureq::Error> {
            Ok(inner.map(|inner| ChangingTransport { inner, writes: 0 }))
        }
    }
    impl Transport for ChangingTransport {
        fn buffers(&mut self) -> &mut dyn Buffers {
            self.inner.buffers()
        }
        fn transmit_output(
            &mut self,
            amount: usize,
            timeout: NextTimeout,
        ) -> Result<(), ureq::Error> {
            self.inner.transmit_output(amount, timeout)?;
            self.writes += 1;
            if self.writes == 3 {
                native_http_transport::network_changed();
            }
            Ok(())
        }
        fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
            self.inner.await_input(timeout)
        }
        fn is_open(&mut self) -> bool {
            self.inner.is_open()
        }
        fn is_tls(&self) -> bool {
            self.inner.is_tls()
        }
    }
    let station = KeepAliveStation::start();
    let connector = DefaultConnector::default()
        .chain(ChangeDuringUpload)
        .chain(native_http_transport::ObserveConnector);
    let agent = ureq::Agent::with_parts(
        native_http_agent_config().build(),
        connector,
        ureq::unversioned::resolver::DefaultResolver::default(),
    );
    assert!(station.get(&agent, "first").starts_with("1:"));
    let request = ureq::http::Request::builder()
        .method("POST")
        .uri(&station.origin)
        .body(vec![42; 10 * 1024 * 1024])
        .unwrap();
    let epoch = native_http_transport::network_epoch();
    let mut revalidated = false;
    let mut response =
        native_http_transport::run(&agent, request, &AtomicBool::new(false), None, || {
            revalidated = true;
            Ok(())
        })
        .unwrap();
    assert!(response
        .body_mut()
        .read_to_string()
        .unwrap()
        .starts_with("1:"));
    assert_ne!(native_http_transport::network_epoch(), epoch);
    assert!(!revalidated);
    assert_eq!(station.connections.load(Ordering::SeqCst), 1);
}

#[test]
fn native_http_slow_reused_get_waits_for_response_without_replay() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(6)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        for request in 0..2 {
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            if request == 1 {
                std::thread::sleep(Duration::from_millis(3300));
            }
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .unwrap();
        }
        listener.set_nonblocking(true).unwrap();
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    });
    let agent = native_http_agent();
    assert_eq!(
        agent
            .get(&origin)
            .call()
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap(),
        "ok"
    );
    let request = ureq::http::Request::builder()
        .uri(&origin)
        .body(Vec::new())
        .unwrap();
    let mut response =
        native_http_transport::run(&agent, request, &AtomicBool::new(false), None, || {
            panic!("slow GET must not replay")
        })
        .unwrap();
    assert_eq!(response.body_mut().read_to_string().unwrap(), "ok");
    server.join().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn native_http_snapshot_hot_reads_do_not_read_profile_bytes_or_repeat_genesis() {
    const WORKER: &str = "STATION_SNAPSHOT_IO_WORKER";
    if std::env::var_os(WORKER).is_none() {
        assert!(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_http_performance_tests::native_http_snapshot_hot_reads_do_not_read_profile_bytes_or_repeat_genesis", "--nocapture"])
            .env(WORKER, "1").status().unwrap().success());
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let path = secure_mobile_station_profiles_path(root.path()).unwrap();
    write_empty_station_profile_store(&path).unwrap();
    let contents = format!("{}{}", EMPTY_STATION_PROFILE_STORE, " ".repeat(1024 * 1024));
    std::fs::write(&path, &contents).unwrap();
    let first = read_native_http_profile_snapshot(&path, || Ok(())).unwrap();
    std::thread::sleep(Duration::from_millis(2100));
    let settled =
        read_native_http_profile_snapshot(&path, || Err("repeated genesis".into())).unwrap();
    assert!(Arc::ptr_eq(&first, &settled));
    let read_bytes = || -> u64 {
        let io = std::fs::read_to_string("/proc/thread-self/io").unwrap();
        io.lines()
            .find_map(|line| line.strip_prefix("rchar: "))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    };
    let before = read_bytes();
    for _ in 0..16 {
        assert!(Arc::ptr_eq(
            &first,
            &read_native_http_profile_snapshot(&path, || Err("repeated genesis".into())).unwrap()
        ));
    }
    assert!(
        read_bytes() - before < 16 * 1024,
        "hot cache must not read a megabyte per request"
    );
    // Same-size external edits with restored mtime must still be observed.
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, contents.replace("\"revision\":0", "\"revision\":1")).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(
        read_native_http_profile_snapshot(&path, || Ok(()))
            .unwrap()
            .revision,
        1
    );
}

#[cfg(unix)]
#[test]
fn native_http_recent_metadata_collision_compares_bytes() {
    let root = tempfile::tempdir().unwrap();
    let path = secure_mobile_station_profiles_path(root.path()).unwrap();
    write_empty_station_profile_store(&path).unwrap();
    let mut cache = StationProfileSnapshotCache::default();
    assert_eq!(cache.read(&path).unwrap().revision, 0);
    std::fs::write(
        &path,
        EMPTY_STATION_PROFILE_STORE.replace("\"revision\":0", "\"revision\":1"),
    )
    .unwrap();
    // Model a filesystem timestamp collision: metadata matches the cached
    // version even though the bytes changed in the same timestamp window.
    cache.snapshot.as_mut().unwrap().1 =
        StationProfileFileVersion::of(&std::fs::metadata(&path).unwrap());
    // Waiting out the collision window must not turn the old byte snapshot
    // into trusted metadata without another read.
    std::thread::sleep(Duration::from_millis(2100));
    assert_eq!(cache.read(&path).unwrap().revision, 1);
}

#[cfg(unix)]
#[test]
fn native_http_snapshot_late_old_inode_cannot_replace_a_newer_publication() {
    const WORKER: &str = "STATION_SNAPSHOT_PUBLICATION_WORKER";
    if std::env::var_os(WORKER).is_none() {
        assert!(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_http_performance_tests::native_http_snapshot_late_old_inode_cannot_replace_a_newer_publication", "--nocapture"])
            .env(WORKER, "1").status().unwrap().success());
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let path = secure_mobile_station_profiles_path(root.path()).unwrap();
    write_empty_station_profile_store(&path).unwrap();
    let staged = root.path().join("replacement.json");
    std::fs::copy(&path, &staged).unwrap();
    std::fs::write(
        &staged,
        EMPTY_STATION_PROFILE_STORE.replace("\"revision\":0", "\"revision\":1"),
    )
    .unwrap();

    // Pause the writer after invalidation, before its atomic rename. Reader A
    // captures that generation and finishes reading the old inode.
    invalidate_native_http_profile_snapshot().unwrap();
    let generation = NATIVE_HTTP_PROFILE_GENERATION.load(Ordering::Acquire);
    let shared = NATIVE_HTTP_PROFILE_SNAPSHOTS.get_or_init(Default::default);
    let mut older = shared.lock().unwrap().clone();
    let previous = older.file_version();
    assert_eq!(older.read(&path).unwrap().revision, 0);
    std::fs::rename(&staged, &path).unwrap();
    // Reader B publishes the replacement before A resumes publication.
    let newer = read_native_http_profile_snapshot(&path, || Ok(())).unwrap();
    assert_eq!(newer.revision, 1);
    assert_eq!(
        NATIVE_HTTP_PROFILE_GENERATION.load(Ordering::Acquire),
        generation
    );
    let mut shared = shared.lock().unwrap();
    shared.publish_if_unchanged(older, previous);
    let installed = &shared.snapshot.as_ref().unwrap().3;
    assert_eq!(installed.revision, 1);
    assert!(Arc::ptr_eq(installed, &newer));
}

#[test]
fn native_http_silent_reused_connection_fails_on_epoch_change_without_replay() {
    const WORKER: &str = "STATION_SILENT_EPOCH_WORKER";
    if std::env::var_os(WORKER).is_none() {
        assert!(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_http_performance_tests::native_http_silent_reused_connection_fails_on_epoch_change_without_replay", "--nocapture"])
            .env(WORKER, "1").status().unwrap().success());
        return;
    }
    use ureq::unversioned::transport::{
        Buffers, ConnectionDetails, Connector, DefaultConnector, NextTimeout, Transport,
    };
    #[derive(Debug)]
    struct SignalWait {
        armed: Arc<AtomicBool>,
        waiting: std::sync::mpsc::Sender<()>,
    }
    #[derive(Debug)]
    struct WaitingTransport {
        inner: Box<dyn Transport>,
        signal: SignalWait,
    }
    impl Connector<Box<dyn Transport>> for SignalWait {
        type Out = WaitingTransport;
        fn connect(
            &self,
            _: &ConnectionDetails,
            inner: Option<Box<dyn Transport>>,
        ) -> Result<Option<Self::Out>, ureq::Error> {
            Ok(inner.map(|inner| WaitingTransport {
                inner,
                signal: SignalWait {
                    armed: Arc::clone(&self.armed),
                    waiting: self.waiting.clone(),
                },
            }))
        }
    }
    impl Transport for WaitingTransport {
        fn buffers(&mut self) -> &mut dyn Buffers {
            self.inner.buffers()
        }
        fn transmit_output(
            &mut self,
            amount: usize,
            timeout: NextTimeout,
        ) -> Result<(), ureq::Error> {
            self.inner.transmit_output(amount, timeout)
        }
        fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
            if self.signal.armed.swap(false, Ordering::AcqRel) {
                self.signal.waiting.send(()).unwrap();
            }
            self.inner.await_input(timeout)
        }
        fn is_open(&mut self) -> bool {
            self.inner.is_open()
        }
        fn is_tls(&self) -> bool {
            self.inner.is_tls()
        }
    }
    for method in ["GET", "POST"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (waiting, wait) = std::sync::mpsc::channel();
        let (done, finish) = std::sync::mpsc::channel();
        let armed = Arc::new(AtomicBool::new(false));
        let connector = DefaultConnector::default()
            .chain(SignalWait {
                armed: Arc::clone(&armed),
                waiting,
            })
            .chain(native_http_transport::ObserveConnector);
        let agent = ureq::Agent::with_parts(
            native_http_agent_config()
                .timeout_recv_response(Some(Duration::from_secs(4)))
                .build(),
            connector,
            ureq::unversioned::resolver::DefaultResolver::default(),
        );
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(6)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            for request in 0..2 {
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                if request == 0 {
                    reader
                        .get_mut()
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .unwrap();
                }
            }
            // The observer has already checked the epoch and entered its real
            // blocking read. Keep the peer silent until the client settles.
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            native_http_transport::network_changed();
            finish.recv_timeout(Duration::from_secs(6)).unwrap();
            listener.set_nonblocking(true).unwrap();
            assert!(
                matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock)
            );
        });
        agent
            .get(&origin)
            .call()
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap();
        armed.store(true, Ordering::Release);
        let request = ureq::http::Request::builder()
            .method(method)
            .uri(&origin)
            .body(Vec::new())
            .unwrap();
        let started = Instant::now();
        let result =
            native_http_transport::run(&agent, request, &AtomicBool::new(false), None, || {
                panic!("a written request must never replay")
            });
        let elapsed = started.elapsed();
        done.send(()).unwrap();
        server.join().unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.code, "network_changed", "{method}: {error:?}");
        assert!(elapsed < Duration::from_secs(2), "{method}: {elapsed:?}");
    }
}
