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
    response_seen: bool,
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
        Ok(chained.map(|inner| ObservedTransport {
            inner,
            epoch: network_epoch(),
            used: false,
        }))
    }
}
#[derive(Debug)]
pub(crate) struct ObservedTransport<T> {
    inner: T,
    epoch: u64,
    used: bool,
}
impl<T: Transport> Transport for ObservedTransport<T> {
    fn buffers(&mut self) -> &mut dyn Buffers {
        if !self.inner.buffers().input().is_empty() {
            observe(|p| p.response_seen = true);
        }
        self.inner.buffers()
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        if self.epoch != network_epoch() {
            return Err(ureq::Error::Io(std::io::ErrorKind::NotConnected.into()));
        }
        // Mark BEFORE calling: Err can mean a partial write, even over TLS.
        if amount > 0 {
            observe(|p| p.send_attempted = true);
        }
        self.inner.transmit_output(amount, timeout)
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        let result = self.inner.await_input(timeout);
        if !self.inner.buffers().input().is_empty() {
            observe(|p| p.response_seen = true);
        }
        result
    }
    fn is_open(&mut self) -> bool {
        // ureq probes on return AND checkout. The request-local cell is reset
        // for each run, so only the checkout observation authorizes a retry.
        if self.used {
            observe(|p| p.reused = true);
        }
        self.used = true;
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
            let read_only = matches!(
                *request.method(),
                ureq::http::Method::GET | ureq::http::Method::HEAD
            );
            let safe = !progress.send_attempted || (read_only && !progress.response_seen);
            if !progress.reused || !transport_failure || !safe {
                return Err(NativeHttpBrokerFailure::transport(
                    native_request_transport_detail(&error),
                ));
            }
            if cancel.load(Ordering::Acquire) {
                return Err(NativeHttpBrokerFailure::coded("cancelled"));
            }
            revalidate()?;
            // No callback or await may select replacement authority after this check.
            super::native_http_agent().run(request).map_err(|error| {
                NativeHttpBrokerFailure::transport(native_request_transport_detail(&error))
            })
        }
    }
}
