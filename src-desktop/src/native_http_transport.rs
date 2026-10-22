//! Observe plaintext HTTP progress outside TLS. A failed write is ambiguous:
//! ureq's transport API cannot report how many bytes reached the socket.
use super::*;
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use ureq::unversioned::transport::{Buffers, ConnectionDetails, Connector, NextTimeout, Transport};

static NETWORK_EPOCH: AtomicU64 = AtomicU64::new(0);
pub(crate) fn network_epoch() -> u64 {
    NETWORK_EPOCH.load(Ordering::Acquire)
}
pub(crate) fn network_changed() {
    NETWORK_EPOCH.fetch_add(1, Ordering::AcqRel);
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
        let started = Instant::now();
        loop {
            if self.response_epoch != network_epoch() {
                observe(|p| p.network_changed = true);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionAborted,
                    "network_changed",
                )
                .into());
            }
            let remaining = timeout.after.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(ureq::Error::Timeout(timeout.reason));
            }
            let slice = Duration::from_millis(100).min(remaining);
            let result = self.inner.await_input(NextTimeout {
                after: slice.into(),
                reason: timeout.reason,
            });
            match result {
                Ok(progress) => {
                    self.response_received |= !self.inner.buffers().input().is_empty();
                    return Ok(progress);
                }
                Err(ureq::Error::Timeout(_)) => {}
                Err(ureq::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(error) => return Err(error),
            }
        }
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
