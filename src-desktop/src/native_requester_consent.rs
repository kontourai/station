use std::time::{Duration, Instant};
use url::Url;

// No Serialize/Debug: the requester secret must never cross IPC or logs.
pub(crate) struct Pending {
    pub request_id: String,
    pub scope: Option<String>,
    pub secret: String,
    pub origin: String,
    pub binding_id: String,
    pub captured_at: Instant,
}

pub(crate) fn is_creation_request(method: &str, url: &Url) -> bool {
    if method != "POST" {
        return false;
    }
    if url.path() == "/api/analytics/source-grant-approvals" {
        return true;
    }
    let parts: Vec<_> = url.path().split('/').collect();
    parts.len() == 6
        && parts[1..4] == ["api", "analytics", "recipient-candidates"]
        && uuid::Uuid::parse_str(parts[4]).is_ok()
        && parts[5] == "source-confirmation"
}

impl Pending {
    pub fn capture(origin: &str, binding_id: &str, cookie: &str, body: &[u8]) -> Option<Self> {
        if body.len() > 65536 {
            return None;
        }
        let mut attributes = cookie.split(';').map(str::trim);
        let secret = attributes.next()?.strip_prefix("station-consent=")?;
        if secret.len() != 43
            || !secret
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        let attributes: Vec<_> = attributes.map(str::to_ascii_lowercase).collect();
        if !["httponly", "path=/consent", "samesite=strict"]
            .iter()
            .all(|v| attributes.iter().any(|a| a == v))
        {
            return None;
        }
        let body: serde_json::Value = serde_json::from_slice(body).ok()?;
        let approval = body.get("approval")?;
        let request_id = approval.get("id")?.as_str()?;
        uuid::Uuid::parse_str(request_id).ok()?;
        if approval.get("status")?.as_str()? != "pending" {
            return None;
        }
        let review = Url::parse(approval.get("reviewUrl")?.as_str()?).ok()?;
        let source = Url::parse(origin).ok()?;
        if review.host_str() != source.host_str()
            || review.origin() == source.origin()
            || !matches!(review.scheme(), "http" | "https")
            || (source.scheme() == "https" && review.scheme() != "https")
            || !review.username().is_empty()
            || review.password().is_some()
            || review.path() != format!("/consent/{request_id}")
            || review.fragment().is_some()
        {
            return None;
        }
        let pairs: Vec<_> = review.query_pairs().collect();
        if pairs.len() > 1
            || pairs.iter().any(|(k, v)| {
                k != "scope"
                    || v.is_empty()
                    || v.len() > 128
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
            })
        {
            return None;
        }
        Some(Self {
            request_id: request_id.to_owned(),
            scope: pairs.first().map(|(_, v)| v.to_string()),
            secret: secret.to_owned(),
            origin: origin.to_owned(),
            binding_id: binding_id.to_owned(),
            captured_at: Instant::now(),
        })
    }

    pub fn is_current(&self, origin: &str, binding_id: &str) -> bool {
        self.origin == origin
            && self.binding_id == binding_id
            && self.captured_at.elapsed() < Duration::from_secs(300)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requester_capture_binds_the_server_issued_review_and_private_cookie() {
        let origin = "https://source.test";
        let id = "11234567-89ab-4cde-8fab-0123456789ab";
        let cookie = format!(
            "station-consent={}; HttpOnly; Path=/consent; SameSite=Strict",
            "a".repeat(43)
        );
        let body = |review: &str| {
            serde_json::to_vec(&serde_json::json!({
                "approval": { "id": id, "status": "pending", "reviewUrl": review }
            }))
            .unwrap()
        };
        let bytes = body(&format!(
            "https://source.test:444/consent/{id}?scope=person:test"
        ));
        let pending = Pending::capture(origin, "epoch-a", &cookie, &bytes).unwrap();
        assert_eq!(pending.scope.as_deref(), Some("person:test"));
        assert!(pending.is_current(origin, "epoch-a"));
        assert!(!pending.is_current(origin, "epoch-b"));
        assert!(!pending.is_current("https://other.test", "epoch-a"));
        for review in [
            format!("https://other.test:444/consent/{id}"),
            format!("http://source.test:444/consent/{id}"),
            format!("https://source.test/consent/{id}"),
            format!("https://user@source.test:444/consent/{id}"),
            format!("https://source.test:444/consent/{id}?scope=one&scope=two"),
            "https://source.test:444/consent/wrong-id".into(),
        ] {
            assert!(Pending::capture(origin, "epoch-a", &cookie, &body(&review)).is_none());
        }
        assert!(
            Pending::capture(origin, "epoch-a", &cookie.replace("HttpOnly", ""), &bytes).is_none()
        );
        assert!(Pending::capture(
            origin,
            "epoch-a",
            &cookie.replace("Path=/consent", "Path=/"),
            &bytes
        )
        .is_none());
        assert!(Pending::capture(origin, "epoch-a", &cookie, &vec![b'a'; 65537]).is_none());
        assert!(is_creation_request(
            "POST",
            &Url::parse("https://source.test/api/analytics/source-grant-approvals").unwrap()
        ));
        assert!(is_creation_request(
            "POST",
            &Url::parse(&format!(
                "https://source.test/api/analytics/recipient-candidates/{id}/source-confirmation"
            ))
            .unwrap()
        ));
        assert!(!is_creation_request(
            "GET",
            &Url::parse("https://source.test/api/analytics/source-grant-approvals").unwrap()
        ));
        assert!(!is_creation_request(
            "POST",
            &Url::parse("https://source.test/api/plugins/host-approvals").unwrap()
        ));
    }
}
