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

// Checkout-only retirement is independent of the epoch that wakes response waits.
static IDLE_GENERATION: AtomicU64 = AtomicU64::new(0);
pub(crate) fn retire_idle_connections() {
    IDLE_GENERATION.fetch_add(1, Ordering::AcqRel);
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
            idle_generation: IDLE_GENERATION.load(Ordering::Acquire),
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
    idle_generation: u64,
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
        self.epoch == network_epoch()
            && self.idle_generation == IDLE_GENERATION.load(Ordering::Acquire)
            && self.inner.is_open()
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
        let wait = RESPONSE_EPOCH
            .with(Cell::get)
            .map(|epoch| {
                let mut waits = RESPONSE_WAITS.lock().unwrap_or_else(|e| e.into_inner());
                if epoch != network_epoch() {
                    return Err(network_change_error());
                }
                let wait = Arc::new(ResponseWait {
                    socket: Arc::clone(&self.socket),
                    interrupted: AtomicBool::new(false),
                });
                waits.push(Arc::clone(&wait));
                Ok(wait)
            })
            .transpose()?;
        let result = (&*self.socket).read(self.buffers.input_append_buf());
        if let Some(wait) = wait {
            let mut waits = RESPONSE_WAITS.lock().unwrap_or_else(|e| e.into_inner());
            waits.retain(|entry| !Arc::ptr_eq(entry, &wait));
            if wait.interrupted.load(Ordering::Acquire) {
                return Err(network_change_error());
            }
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
mod tests {
    use super::*;

    #[test]
    fn ios_resume_leaves_registered_response_wait_alive_and_never_replays_post() {
        const WORKER: &str = "STATION_IOS_RESPONSE_WAIT_WORKER";
        if std::env::var_os(WORKER).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "native_http_transport::tests::ios_resume_leaves_registered_response_wait_alive_and_never_replays_post", "--nocapture"])
                .env(WORKER, "1").status().unwrap().success());
            return;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let agent = super::super::native_http_agent();
        let client = std::thread::spawn(move || {
            let request = ureq::http::Request::builder()
                .method("POST")
                .uri(origin)
                .body(Vec::new())
                .unwrap();
            run(&agent, request, &AtomicBool::new(false), None, || {
                panic!("resume must never replay a sent POST")
            })
            .map(|mut response| response.body_mut().read_to_string().unwrap())
        });
        let (mut peer, _) = listener.accept().unwrap();
        peer.set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let waits = loop {
            let waits = RESPONSE_WAITS.lock().unwrap().clone();
            if !waits.is_empty() {
                break waits;
            }
            assert!(
                Instant::now() < deadline,
                "POST must reach the registered socket response wait"
            );
            std::thread::sleep(Duration::from_millis(1));
        };
        crate::ios_network_path::resumed();
        assert!(
            waits
                .iter()
                .all(|wait| !wait.interrupted.load(Ordering::Acquire)),
            "resume must leave registered response waits uninterrupted"
        );
        peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
            .unwrap();
        assert_eq!(client.join().unwrap().unwrap(), "ok");
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
            "sent POST must not open a replay connection"
        );
    }
}
