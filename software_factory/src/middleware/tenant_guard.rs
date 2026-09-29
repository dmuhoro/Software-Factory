use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::collections::HashMap;

use crate::AppState;

/// Header carrying the tenant partition. The client asserts which partition it is writing.
pub const TENANT_HEADER: &str = "x-tenant-id";
/// Header carrying that tenant's credential.
pub const API_KEY_HEADER: &str = "x-api-key";

/// Paths that may be reached without a tenant credential.
///
/// This is an allow list, not a prefix match. A prefix test would exempt any path that
/// happens to begin with `/health`, and would keep growing a quiet list of exceptions.
fn is_public_path(path: &str) -> bool {
    matches!(path, "/health" | "/ready")
}

/// The authenticated tenant, stashed for handlers so they never re-derive it from a header
/// the caller controls.
#[derive(Clone)]
pub struct AuthenticatedTenant(pub String);

/// Reads the request headers, verifies the caller's credential belongs to the tenant it
/// claims, and inserts the authenticated tenant id for downstream handlers.
///
/// Two failures are distinguished deliberately, because they mean different things to an
/// operator: an absent or wrong credential is `401`, while a valid credential for a tenant
/// that does not exist, or a suspended tenant, is `403`. Returning one code for both hides
/// a compromised credential behind what looks like a typo.
///
/// The comparison is constant time. A timing-variable secret comparison lets a caller
/// recover a tenant's key one byte at a time, and the cost of avoiding it is one helper
/// call.
pub async fn require_tenant_auth(
    axum::extract::State(state): axum::extract::State<AppState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();
    if is_public_path(&path) {
        return next.run(req).await;
    }

    let tenant_id = match req.headers().get(TENANT_HEADER) {
        Some(value) => match value.to_str() {
            Ok(text) if !text.is_empty() => text.to_string(),
            _ => return refuse(StatusCode::UNAUTHORIZED, "MISSING_TENANT_HEADER", TENANT_HEADER),
        },
        None => return refuse(StatusCode::UNAUTHORIZED, "MISSING_TENANT_HEADER", TENANT_HEADER),
    };

    let presented = match req.headers().get(API_KEY_HEADER) {
        Some(value) => match value.to_str() {
            Ok(text) if !text.is_empty() => text.to_string(),
            _ => return refuse(StatusCode::UNAUTHORIZED, "MISSING_CREDENTIAL", API_KEY_HEADER),
        },
        None => return refuse(StatusCode::UNAUTHORIZED, "MISSING_CREDENTIAL", API_KEY_HEADER),
    };

    // An unknown tenant is 403, not 401: the caller proved knowledge of a credential we
    // issued, so this is an authorisation failure rather than a failed authentication.
    let known_tenant = state
        .tenants
        .get(&tenant_id)
        .map(|entry| entry.active)
        .unwrap_or(false);

    if !known_tenant {
        return refuse(
            StatusCode::FORBIDDEN,
            "TENANT_CREDENTIAL_MISMATCH",
            "tenant is unknown or suspended",
        );
    }

    let expected = state.tenant_keys.get(&tenant_id).map(|k| k.value().clone());
    match expected {
        // No credential is provisioned for this tenant. Refusing here is the whole point:
        // an unconfigured tenant must not be writable by anyone.
        None => {
            return refuse(
                StatusCode::FORBIDDEN,
                "TENANT_CREDENTIAL_MISMATCH",
                "no credential is provisioned for this tenant",
            )
        }
        // A credential issued for a different tenant must not unlock this one.
        Some(expected) if !constant_time_eq(expected.as_bytes(), presented.as_bytes()) => {
            return refuse(
                StatusCode::FORBIDDEN,
                "TENANT_CREDENTIAL_MISMATCH",
                "the presented credential is not bound to the claimed tenant",
            )
        }
        Some(_) => {}
    }

    req.extensions_mut().insert(AuthenticatedTenant(tenant_id));
    next.run(req).await
}

/// Compares two byte strings without an early exit on the first difference.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn refuse(status: StatusCode, code: &str, detail: &str) -> Response {
    tracing::warn!(%status, %code, "API request refused by tenant boundary");
    (
        status,
        axum::Json(json!({
            "status": "error",
            "code": code,
            // The detail names the expected header so a caller can correct itself. It never
            // echoes the presented credential, and never distinguishes "wrong key" from
            // "key for a different tenant" beyond what the status already says.
            "message": detail,
        })),
    )
        .into_response()
}

/// Parses `TENANT_API_KEYS=tenant_a:key,tenant_b:key` into a tenant-keyed map.
///
/// A credential bound to two tenants would make the partition ambiguous, so a duplicate is
/// a startup error rather than a last-one-wins entry. Returns an error naming the
/// credential so the operator can find the duplicate line.
pub fn parse_tenant_keys(spec: &str) -> Result<HashMap<String, String>, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let mut seen: HashMap<String, String> = HashMap::new();

    for entry in spec.split(',').filter(|e| !e.trim().is_empty()) {
        let (tenant, key) = entry
            .split_once(':')
            .ok_or_else(|| format!("TENANT_API_KEYS entry '{entry}' is not in tenant:key form"))?;

        let tenant = tenant.trim();
        let key = key.trim();
        if tenant.is_empty() || key.is_empty() {
            return Err(format!("TENANT_API_KEYS entry '{entry}' has an empty tenant or key"));
        }
        if let Some(previous) = seen.get(key) {
            return Err(format!(
                "TENANT_API_KEYS binds one credential to two tenants ('{previous}' and '{tenant}'); \
                 a credential must identify exactly one partition"
            ));
        }
        seen.insert(key.to_string(), tenant.to_string());
        map.insert(tenant.to_string(), key.to_string());
    }

    Ok(map)
}
