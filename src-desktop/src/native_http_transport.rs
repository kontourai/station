//! Observe plaintext HTTP progress outside TLS. A failed write is ambiguous:
//! ureq's transport API cannot report how many bytes reached the socket.
use super::*;
use std::cell::Cell;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use ureq::unversioned::transport::{Buffers, ConnectionDetails, Connector, NextTimeout, Transport};

static RESPONSE_WAITS: Mutex<Vec<Arc<ResponseWait>>> = Mutex::new(Vec::new());

#[derive(Debug)]
struct ResponseWait {
    socket: Arc<TcpStream>,
    interrupted: AtomicBool,
}

struct ResponseWaitRegistration(Option<Arc<ResponseWait>>);
impl ResponseWaitRegistration {
    fn new(socket: Arc<TcpStream>, epoch: u64) -> Result<Self, ureq::Error> {
        let mut waits = RESPONSE_WAITS.lock().unwrap_or_else(|e| e.into_inner());
        if epoch != network_epoch() {
            return Err(network_change_error());
        }
        let wait = Arc::new(ResponseWait {
            socket,
            interrupted: AtomicBool::new(false),
        });
        waits.push(Arc::clone(&wait));
        Ok(Self(Some(wait)))
    }
    fn deregister(&mut self) -> bool {
        let Some(wait) = self.0.take() else {
            return false;
        };
        let mut waits = RESPONSE_WAITS.lock().unwrap_or_else(|e| e.into_inner());
        waits.retain(|entry| !Arc::ptr_eq(entry, &wait));
        wait.interrupted.load(Ordering::Acquire)
    }
}
impl Drop for ResponseWaitRegistration {
    fn drop(&mut self) {
        self.deregister();
    }
}

static NETWORK_EPOCH: AtomicU64 = AtomicU64::new(0);
pub(crate) fn network_epoch() -> u64 {
    NETWORK_EPOCH.load(Ordering::Acquire)
}
pub(crate) fn network_changed() {
    // Registration and epoch publication share this lock: a change between
    // the plaintext check and the blocking socket read cannot be missed.
    let waits = RESPONSE_WAITS.lock().unwrap_or_else(|e| e.into_inner());
    NETWORK_EPOCH.fetch_add(1, Ordering::AcqRel);
    for wait in waits.iter() {
        wait.interrupted.store(true, Ordering::Release);
        let _ = wait.socket.shutdown(Shutdown::Both);
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_io_kontourai_station_agentactivity_NativeHttpNetwork_changed(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    network_changed();
}

#[derive(Clone, Copy, Default)]
struct Progress {
    reused: bool,
    send_attempted: bool,
    network_changed: bool,
}
thread_local! {
    static RESPONSE_EPOCH: Cell<Option<u64>> = const { Cell::new(None) };
    static PROGRESS: Cell<Progress> = Cell::new(Progress::default());
}
fn observe(update: impl FnOnce(&mut Progress)) {
    PROGRESS.with(|cell| {
        let mut progress = cell.get();
        update(&mut progress);
        cell.set(progress);
    });
}

#[derive(Debug)]
pub(crate) struct ObserveConnector;
impl<T: Transport> Connector<T> for ObserveConnector {
    type Out = ObservedTransport<T>;
    fn connect(
        &self,
        _: &ConnectionDetails,
        chained: Option<T>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        observe(|p| p.reused = false);
        Ok(chained.map(|inner| ObservedTransport {
            inner,
            epoch: network_epoch(),
            used: false,
            response_epoch: network_epoch(),
            response_received: false,
        }))
    }
}
#[derive(Debug)]
pub(crate) struct ObservedTransport<T> {
    inner: T,
    epoch: u64,
    used: bool,
    response_epoch: u64,
    response_received: bool,
}
impl<T: Transport> Transport for ObservedTransport<T> {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        // Mark BEFORE calling: Err can mean a partial write, even over TLS.
        if amount > 0 {
            observe(|p| p.send_attempted = true);
        }
        self.inner.transmit_output(amount, timeout)?;
        // Churn during transmission must not interrupt an upload. Only changes
        // after the last successful write can invalidate a silent response wait.
        self.response_epoch = network_epoch();
        self.response_received = false;
        Ok(())
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        if self.response_received
            || matches!(
                timeout.reason,
                ureq::Timeout::Await100 | ureq::Timeout::SendBody
            )
        {
            return self.inner.await_input(timeout);
        }
        if self.response_epoch != network_epoch() {
            return Err(network_change_error());
        }
        // Only this plaintext response wait arms the socket below TLS. TLS
        // handshakes, Expect:100 and upload writes never register an abort.
        struct Scope(Option<u64>);
        impl Drop for Scope {
            fn drop(&mut self) {
                RESPONSE_EPOCH.with(|epoch| epoch.set(self.0));
            }
        }
        let _scope = Scope(RESPONSE_EPOCH.with(|epoch| epoch.replace(Some(self.response_epoch))));
        let result = self.inner.await_input(timeout);
        self.response_received |= !self.inner.buffers().input().is_empty();
        result
    }

    fn is_open(&mut self) -> bool {
        // ureq probes on return AND checkout. The request-local cell is reset
        // for each run, so only the checkout observation authorizes a retry.
        if self.used {
            observe(|p| p.reused = true);
        }
        self.used = true;
        self.response_received = false;
        self.epoch == network_epoch() && self.inner.is_open()
    }
    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}

fn network_change_error() -> ureq::Error {
    observe(|p| p.network_changed = true);
    std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "network_changed").into()
}

/// ureq does not expose a socket handle from its default TCP transport. Keep
/// TLS and CONNECT upstream, but own the TCP handle needed to wake a read.
#[derive(Debug)]
pub(crate) struct SocketConnector;
impl Connector<()> for SocketConnector {
    type Out = Box<dyn Transport>;
    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        use ureq::unversioned::transport::{ConnectProxyConnector, RustlsConnector};
        if details.config.proxy().is_some_and(|proxy| {
            !matches!(
                proxy.protocol(),
                ureq::ProxyProtocol::Http | ureq::ProxyProtocol::Https
            )
        }) {
            // This build has no SOCKS feature; never fall through to a direct
            // connection when the configured proxy cannot be honored.
            return Err(ureq::Error::ConnectionFailed);
        }
        ().chain(ConnectProxyConnector::default())
            .chain(SocketDial)
            .chain(RustlsConnector::default())
            .connect(details, chained)
            .map(|transport| transport.map(Transport::boxed))
    }
}

#[derive(Debug)]
struct SocketDial;
impl<T: Transport> Connector<T> for SocketDial {
    type Out = ureq::unversioned::transport::Either<T, SocketTransport>;
    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<T>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        use ureq::unversioned::transport::{Either, LazyBuffers};
        if let Some(inner) = chained {
            return Ok(Some(Either::A(inner)));
        }
        let started = Instant::now();
        let total = details.timeout.not_zero().map(|duration| *duration);
        let count = details.addrs.len();
        let total_weight = 2.0 * (1.0 - 0.5_f64.powi(count as i32));
        let mut weight = 1.0;
        let mut last = ureq::Error::ConnectionFailed;
        for addr in &details.addrs {
            let budget = total.map(|total| {
                total
                    .mul_f64(weight / total_weight)
                    .max(Duration::from_millis(10))
                    .min(total.saturating_sub(started.elapsed()))
            });
            if budget.is_some_and(|budget| budget.is_zero()) {
                return Err(ureq::Error::Timeout(details.timeout.reason));
            }
            let result = match budget {
                Some(budget) => TcpStream::connect_timeout(addr, budget),
                None => TcpStream::connect(addr),
            };
            match result {
                Ok(stream) => {
                    stream.set_nodelay(details.config.no_delay())?;
                    return Ok(Some(Either::B(SocketTransport {
                        socket: Arc::new(stream),
                        buffers: LazyBuffers::new(
                            details.config.input_buffer_size(),
                            details.config.output_buffer_size(),
                        ),
                    })));
                }
                Err(error) => {
                    use std::io::ErrorKind::*;
                    let address_failure = matches!(
                        error.kind(),
                        ConnectionRefused | HostUnreachable | NetworkUnreachable | AddrNotAvailable
                    );
                    #[cfg(windows)]
                    let address_failure = address_failure || error.raw_os_error() == Some(10013);
                    if !address_failure && !matches!(error.kind(), TimedOut | WouldBlock) {
                        return Err(error.into());
                    }
                    last = if matches!(error.kind(), TimedOut | WouldBlock) {
                        ureq::Error::Timeout(details.timeout.reason)
                    } else {
                        error.into()
                    };
                }
            }
            weight /= 2.0;
        }
        Err(last)
    }
}

#[derive(Debug)]
struct SocketTransport {
    socket: Arc<TcpStream>,
    buffers: ureq::unversioned::transport::LazyBuffers,
}
impl Transport for SocketTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.socket
            .set_write_timeout(timeout.not_zero().map(|duration| *duration))?;
        (&*self.socket)
            .write_all(&self.buffers.output()[..amount])
            .map_err(|error| socket_error(error, timeout))
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.socket
            .set_read_timeout(timeout.not_zero().map(|duration| *duration))?;
        let mut wait = RESPONSE_EPOCH
            .with(Cell::get)
            .map(|epoch| ResponseWaitRegistration::new(Arc::clone(&self.socket), epoch))
            .transpose()?;
        let result = (&*self.socket).read(self.buffers.input_append_buf());
        let interrupted = wait
            .as_mut()
            .is_some_and(ResponseWaitRegistration::deregister);
        drop(wait);
        if interrupted {
            return Err(network_change_error());
        }
        let amount = result.map_err(|error| socket_error(error, timeout))?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }
    fn is_open(&mut self) -> bool {
        if self.socket.set_nonblocking(true).is_err() {
            return false;
        }
        let open = matches!(self.socket.peek(&mut [0]), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock);
        self.socket.set_nonblocking(false).is_ok() && open
    }
}
fn socket_error(error: std::io::Error, timeout: NextTimeout) -> ureq::Error {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        ureq::Error::Timeout(timeout.reason)
    } else {
        error.into()
    }
}

pub(crate) fn run(
    agent: &ureq::Agent,
    request: ureq::http::Request<Vec<u8>>,
    cancel: &AtomicBool,
    deadline: Option<Instant>,
    revalidate: impl FnOnce() -> Result<(), NativeHttpBrokerFailure>,
) -> Result<ureq::http::Response<ureq::Body>, NativeHttpBrokerFailure> {
    PROGRESS.with(|cell| cell.set(Progress::default()));
    match agent.run(request.clone()) {
        Ok(response) => Ok(response),
        Err(error) => {
            let progress = PROGRESS.with(Cell::get);
            let transport_failure = matches!(
                error,
                ureq::Error::Io(_) | ureq::Error::Timeout(_) | ureq::Error::ConnectionFailed
            );
            let safe = !progress.send_attempted;
            if !progress.reused || !transport_failure || !safe {
                return Err(failure(&error));
            }
            if cancel.load(Ordering::Acquire) {
                return Err(NativeHttpBrokerFailure::coded("cancelled"));
            }
            let remaining = deadline.map(|at| at.saturating_duration_since(Instant::now()));
            if remaining.is_some_and(|budget| budget.is_zero()) {
                return Err(NativeHttpBrokerFailure::coded("response_timeout"));
            }
            let fresh = super::native_http_agent();
            let request = super::native_http_request_with_budgets(
                &fresh,
                request,
                NATIVE_HTTP_SEND_BODY_MIN_TIMEOUT,
                NATIVE_HTTP_SEND_BODY_MIN_RATE_BYTES_PER_SEC,
                NATIVE_HTTP_RECV_RESPONSE_TIMEOUT,
                NATIVE_HTTP_FOREGROUND_RECV_RESPONSE_TIMEOUT,
                remaining,
                remaining,
            );
            revalidate()?;
            // No callback or await may select replacement authority after this check.
            fresh.run(request).map_err(|error| failure(&error))
        }
    }
}

fn failure(error: &ureq::Error) -> NativeHttpBrokerFailure {
    if PROGRESS.with(Cell::get).network_changed {
        NativeHttpBrokerFailure::transport(NativeHttpTransportDetail {
            code: "network_changed",
            detail: "The network changed before Station responded. The request may have arrived; retry to check delivery.".into(),
        })
    } else {
        NativeHttpBrokerFailure::transport(native_request_transport_detail(error))
    }
}

#[cfg(test)]
mod response_wait_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::process::{Command, Stdio};

    // Epoch changes are process-global; keep these controls out of other tests' sockets.
    fn isolated(name: &str) -> bool {
        const WORKER: &str = "STATION_RESPONSE_WAIT_TEST";
        if std::env::var(WORKER).as_deref() == Ok(name) {
            return false;
        }
        assert!(Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("native_http_transport::response_wait_tests::{name}"),
                "--nocapture"
            ])
            .env(WORKER, name)
            .status()
            .unwrap()
            .success());
        true
    }

    #[test]
    fn response_wait_registration_deregisters_during_unwind() {
        if isolated("response_wait_registration_deregisters_during_unwind") {
            return;
        }
        for unwind in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let socket = Arc::new(TcpStream::connect(listener.local_addr().unwrap()).unwrap());
            let (mut peer, _) = listener.accept().unwrap();
            peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            let result = std::panic::catch_unwind(|| {
                let _registration =
                    ResponseWaitRegistration::new(Arc::clone(&socket), network_epoch()).unwrap();
                if unwind {
                    panic!("unwind after response-wait registration");
                }
            });
            assert_eq!(result.is_err(), unwind);
            network_changed();
            (&*socket)
                .write_all(b"still open")
                .expect("a deregistered wait must not be shut down by a later network change");
            let mut bytes = [0; 10];
            peer.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"still open");
        }
    }

    // The hosted Linux image provides python3/OpenSSL. Missing tools fail this
    // test rather than turning an unexercised TLS path into a passing receipt.
    #[cfg(target_os = "linux")]
    #[test]
    fn rustls_response_wait_wakes_on_network_change_without_replay() {
        if isolated("rustls_response_wait_wakes_on_network_change_without_replay") {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let certificate = directory.path().join("certificate.pem");
        let key = directory.path().join("key.pem");
        let output = Command::new("openssl")
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
                "-keyout",
                key.to_str().unwrap(),
                "-out",
                certificate.to_str().unwrap(),
            ])
            .output()
            .expect("OpenSSL is required for the hosted TLS fixture");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let root = ureq::tls::Certificate::from_pem(&std::fs::read(&certificate).unwrap()).unwrap();
        for method in ["GET", "POST"] {
            struct Server(std::process::Child);
            impl Drop for Server {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut server = Server(
                Command::new("python3")
                    .args([
                        "-u",
                        "-c",
                        r#"
import socket, ssl, sys
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
listener.settimeout(10)
print(listener.getsockname()[1], flush=True)
connection, _ = listener.accept()
connection.settimeout(10)
with context.wrap_socket(connection, server_side=True) as tls:
    request = b''
    while b'\r\n\r\n' not in request:
        data = tls.recv(4096)
        assert data, 'client closed before sending HTTP headers'
        request += data
    print('request received', flush=True)
    sys.stdin.readline()
listener.setblocking(False)
try:
    listener.accept()
    raise AssertionError('a written request was replayed')
except BlockingIOError:
    pass
"#,
                        certificate.to_str().unwrap(),
                        key.to_str().unwrap(),
                    ])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let mut output = BufReader::new(server.0.stdout.take().unwrap());
            let mut line = String::new();
            output.read_line(&mut line).unwrap();
            let port: u16 = line
                .trim()
                .parse()
                .expect("TLS fixture must publish its bound port");
            let agent = ureq::Agent::with_parts(
                native_http_agent_config()
                    .timeout_recv_response(Some(Duration::from_secs(4)))
                    .tls_config(
                        ureq::tls::TlsConfig::builder()
                            .root_certs([root.clone()].into())
                            .build(),
                    )
                    .build(),
                SocketConnector.chain(ObserveConnector),
                ureq::unversioned::resolver::DefaultResolver::default(),
            );
            let request = ureq::http::Request::builder()
                .method(method)
                .uri(format!("https://localhost:{port}/silent"))
                .body(Vec::new())
                .unwrap();
            let (done, result) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                done.send(
                    run(&agent, request, &AtomicBool::new(false), None, || {
                        panic!("a written TLS request must never replay")
                    })
                    .unwrap_err(),
                )
                .unwrap();
            });
            line.clear();
            output.read_line(&mut line).unwrap();
            assert_eq!(
                line.trim(),
                "request received",
                "the rustls handshake and HTTP write must complete"
            );
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if RESPONSE_WAITS
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|wait| wait.socket.peer_addr().unwrap().port() == port)
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "TLS response read never registered its socket"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            let started = Instant::now();
            network_changed();
            let error = result.recv_timeout(Duration::from_secs(6)).unwrap();
            assert_eq!(error.code, "network_changed", "{method}: {error:?}");
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "shutdown must wake the TLS read before its normal deadline"
            );
            worker.join().unwrap();
            server.0.stdin.take().unwrap().write_all(b"done\n").unwrap();
            assert!(server.0.wait().unwrap().success());
        }
    }
}
