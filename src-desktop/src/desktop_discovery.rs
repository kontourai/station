use std::{io::Read, time::Duration};
use tauri::{AppHandle, Manager};

pub(crate) fn admitted(app: &AppHandle) -> bool {
    let Some(authority) = app.try_state::<crate::NativeProfileAuthority>() else {
        return false;
    };
    let Ok(store) = crate::native_http_profile_snapshot(app) else {
        return false;
    };
    let context = {
        let Ok(state) = authority.0.lock() else {
            return false;
        };
        let Ok(context) = crate::authorized_profile_context_in_store(&state, &store) else {
            return false;
        };
        context
    };
    let Ok(credential) = crate::native_credential_for_origin(app, &context.exact_origin) else {
        return false;
    };
    let request = ureq::http::Request::builder()
        .method("GET")
        .uri(format!(
            "{}/api/feature-previews/desktop-nearby/admission",
            context.exact_origin
        ))
        .header("Authorization", format!("Bearer {credential}"))
        .body(Vec::new());
    let Ok(request) = request else {
        return false;
    };
    let agent = crate::native_http_agent_with(
        crate::native_http_agent_config()
            .timeout_global(Some(Duration::from_secs(2)))
            .build(),
    );
    if crate::revalidate_native_http_profile(
        app,
        &authority,
        Some(&context.binding_id),
        &context.exact_origin,
        &context.reference,
    )
    .is_err()
    {
        return false;
    }
    let Ok(mut response) = agent.run(request) else {
        return false;
    };
    if response.status().as_u16() != 200 {
        return false;
    }
    let mut body = String::new();
    if response
        .body_mut()
        .as_reader()
        .take(4097)
        .read_to_string(&mut body)
        .is_err()
        || body.len() > 4096
    {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else {
        return false;
    };
    value.get("success").and_then(serde_json::Value::as_bool) == Some(true)
        && value
            .pointer("/data/enabled")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && crate::native_http_profile_for_origin(
            app,
            &authority,
            Some(&context.binding_id),
            &context.exact_origin,
        )
        .is_ok()
}
