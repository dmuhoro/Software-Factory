use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

pub async fn health_check() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "status": "healthy",
            "runtime": "Rust 1.78 + Tokio Multi-Threaded Async",
            "circuit_breaker": "CLOSED",
            "hpa_status": "READY"
        })),
    )
}
