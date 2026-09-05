//! Android's application-network DNS resolver.
//!
//! Rust's `ToSocketAddrs` does not enter Android's per-UID resolver and therefore
//! misses VPN DNS such as Tailscale MagicDNS. The Java system resolver enters
//! Android's per-UID network policy and therefore sees the app's VPN DNS.

use jni::objects::{JObjectArray, JString, JValue};
use jni::JavaVM;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use ureq::http::Uri;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::NextTimeout;
use ureq::{config::Config, Error};

#[derive(Default)]
pub(crate) struct AndroidSystemResolver;

impl fmt::Debug for AndroidSystemResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AndroidSystemResolver")
    }
}

impl Resolver for AndroidSystemResolver {
    fn resolve(
        &self,
        uri: &Uri,
        _config: &Config,
        _timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, Error> {
        let authority = uri.authority().ok_or(Error::HostNotFound)?;
        let port = authority.port_u16().or_else(|| match uri.scheme_str() {
            Some("http") => Some(80),
            Some("https") => Some(443),
            _ => None,
        });
        let port = port.ok_or(Error::HostNotFound)?;
        if let Ok(ip) = authority.host().parse::<IpAddr>() {
            let mut result = self.empty();
            result.push(SocketAddr::new(ip, port));
            return Ok(result);
        }

        android_network_addresses(authority.host(), port).ok_or(Error::HostNotFound)
    }
}

fn android_network_addresses(host: &str, port: u16) -> Option<ResolvedSocketAddrs> {
    let android = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(android.vm().cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let host = env.new_string(host).ok()?;
    let addresses = match env.call_static_method(
        "java/net/InetAddress",
        "getAllByName",
        "(Ljava/lang/String;)[Ljava/net/InetAddress;",
        &[JValue::Object(&host)],
    ) {
        Ok(value) => value.l().ok()?,
        Err(_) => {
            // UnknownHostException is an ordinary resolver miss. A pending
            // JNI exception must be cleared before returning to Tauri's worker
            // or Android terminates the entire process at the native boundary.
            let _ = env.exception_clear();
            return None;
        }
    };
    let addresses = JObjectArray::from(addresses);
    let count = env.get_array_length(&addresses).ok()?;
    let mut result = AndroidSystemResolver.empty();
    for index in 0..count {
        let address = env.get_object_array_element(&addresses, index).ok()?;
        let text = env
            .call_method(&address, "getHostAddress", "()Ljava/lang/String;", &[])
            .ok()?
            .l()
            .ok()?;
        let text = JString::from(text);
        let text = env.get_string(&text).ok()?;
        if let Ok(ip) = text.to_string_lossy().parse::<IpAddr>() {
            result.push(SocketAddr::new(ip, port));
        }
    }
    (!result.is_empty()).then_some(result)
}
