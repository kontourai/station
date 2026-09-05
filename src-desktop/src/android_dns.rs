//! Android's application-network DNS resolver.
//!
//! Rust's `ToSocketAddrs` does not enter Android's per-UID resolver and therefore
//! misses VPN DNS such as Tailscale MagicDNS. The application context is
//! initialized before Tauri starts by the credential bootstrap; resolve through
//! the active Android `Network` so DNS and routing describe the same VPN-bound
//! application identity.

use jni::objects::{JObject, JObjectArray, JString, JValue};
use jni::JavaVM;
use std::fmt;
use std::mem::ManuallyDrop;
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
    // `ndk_context` owns this global reference. Do not let the temporary JNI
    // wrapper delete it when this call returns.
    let context = ManuallyDrop::new(unsafe {
        JObject::from_raw(android.context().cast::<jni::sys::_jobject>())
    });
    let service_name = env.new_string("connectivity").ok()?;
    let manager = env
        .call_method(
            &*context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&service_name)],
        )
        .ok()?
        .l()
        .ok()?;
    if manager.is_null() {
        return None;
    }
    let network = env
        .call_method(&manager, "getActiveNetwork", "()Landroid/net/Network;", &[])
        .ok()?
        .l()
        .ok()?;
    if network.is_null() {
        return None;
    }
    let host = env.new_string(host).ok()?;
    let addresses = env
        .call_method(
            &network,
            "getAllByName",
            "(Ljava/lang/String;)[Ljava/net/InetAddress;",
            &[JValue::Object(&host)],
        )
        .ok()?
        .l()
        .ok()?;
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
