use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

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
            "runtime": "Rust 1.78 + Tokio Multi-Threaded Async",
        })),
    )
}

/// Readiness. Reports the configuration this process actually loaded, so a pod that starts
/// without credentials is distinguishable from a healthy one.
///
/// Degraded states are reported as `503`, which is what keeps an unconfigured pod out of
/// the load balancer's rotation instead of letting it take traffic it cannot serve.
pub async fn readiness_check() -> impl IntoResponse {
    // A fresh probe process cannot see the serving process's in-memory credential map, so
    // readiness reports what it can verify about its own configuration: the variables it
    // would need in order to serve.
    let required = ["GEMINI_API_KEY", "APPWRITE_ENDPOINT", "APPWRITE_PROJECT_ID", "TENANT_API_KEYS"];
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|name| std::env::var(name).map(|v| v.trim().is_empty()).unwrap_or(true))
        .collect();

    if missing.is_empty() {
        (
            StatusCode::OK,
            Json(json!({
                "status": "ready",
                "checks": { "configuration": "ok" },
            })),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "degraded",
                "missing_configuration": missing,
            })),
        )
    }
}
