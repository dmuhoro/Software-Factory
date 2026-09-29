use crate::AppState;
use axum::extract::State;
use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

/// Renders the Prometheus exposition endpoint.
///
/// Sits outside the tenant guard, because a scraper holds no tenant credential and would
/// otherwise be refused -- and because metrics are aggregate operational counters, not
/// tenant data. Nothing tenant-identifying is exposed here; the exposure rules live in
/// `crate::metrics`.
pub async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    let body = crate::metrics::render(
        state.tenant_keys.len(),
        !state.appwrite_api_key.trim().is_empty(),
    );
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
}

/// Liveness. Answers only whether the process is running.
///
/// This handler previously reported `"circuit_breaker": "CLOSED"` and
/// `"hpa_status": "READY"` as string literals. Both were constants: the process would keep
/// answering 200 and claiming a closed breaker while the Gemini key was a placeholder and
/// the credential map was empty. A health endpoint that cannot report bad news is worse
/// than none, because a load balancer trusts it. Liveness is now limited to what it can
/// actually observe.
pub async fn health_check() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "status": "alive",
            // The version is the crate's, read from the manifest at compile time. This string
            // previously hardcoded "Rust 1.78" as a literal, which was an unverifiable claim
            // about a toolchain -- it was neither read from the build nor checked against
            // anything, and it was already wrong for the toolchain this project builds with.
            "version": env!("CARGO_PKG_VERSION"),
            "runtime": "Rust async (axum/Tokio)",
        })),
    )
}

/// Readiness. Reports the configuration this process actually loaded, so a pod that starts
/// without credentials is distinguishable from a healthy one.
///
/// Degraded states are reported as `503`, which is what keeps an unconfigured pod out of
/// the load balancer's rotation instead of letting it take traffic it cannot serve.
///
/// `APPWRITE_API_KEY` is included. It was previously absent from this list while
/// `README.md` stated that all five variables were required and that the process exits 1
/// naming any missing one. In practice the key defaulted to an empty string, so readiness
/// answered 200 on a runtime that could not persist a single record: the pod was added to
/// the load balancer and every write failed. The variable is now checked, and the doc
/// statement matches the code.
///
/// The check reads `AppState` rather than `std::env`. A readiness probe that reports on the
/// environment instead of on the object actually serving traffic can disagree with it: a
/// variable could be set in the environment while the state was built without it, in which
/// case this endpoint answers "ready" for a service that cannot work. Answering from state
/// makes the probe a property of the running service, which is the only thing a probe can
/// usefully describe. The names are reported, never the values, so the response carries no
/// credential.
pub async fn readiness_check(State(state): State<AppState>) -> impl IntoResponse {
    // Readiness reports what it can verify about its own configuration: the credentials it
    // would need in order to serve. It deliberately does not claim anything about a
    // downstream it has not contacted.
    let missing: Vec<&str> = [
        ("GEMINI_API_KEY", !state.gemini_api_key.trim().is_empty()),
        (
            "APPWRITE_ENDPOINT",
            !state.appwrite_endpoint.trim().is_empty(),
        ),
        (
            "APPWRITE_PROJECT_ID",
            !state.appwrite_project_id.trim().is_empty(),
        ),
        (
            "APPWRITE_API_KEY",
            !state.appwrite_api_key.trim().is_empty(),
        ),
        ("TENANT_API_KEYS", !state.tenant_keys.is_empty()),
    ]
    .into_iter()
    .filter_map(|(name, present)| if present { None } else { Some(name) })
    .collect();

    if missing.is_empty() {
        (
            StatusCode::OK,
            Json(json!({
                "status": "ready",
                "checks": { "configuration": "ok" },
                "tenants_configured": state.tenant_keys.len(),
                "persistence_configured": !state.appwrite_api_key.trim().is_empty(),
            })),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "degraded",
                // The missing NAMES, never their values. A readiness response is public.
                "missing_configuration": missing,
                "tenants_configured": state.tenant_keys.len(),
                "persistence_configured": !state.appwrite_api_key.trim().is_empty(),
            })),
        )
    }
}
