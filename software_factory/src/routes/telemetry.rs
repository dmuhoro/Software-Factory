use crate::models::{IngestPayload, TenantProfile};
use crate::services::ConcurrencyPipeline;
use crate::AppState;
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;

pub async fn ingest_telemetry(
    State(state): State<AppState>,
    Json(payload): Json<IngestPayload>,
) -> impl IntoResponse {
    match ConcurrencyPipeline::process_telemetry(&state, payload).await {
        Ok(result) => (StatusCode::OK, Json(json!(result))),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": "error",
                "code": "MALFORMED_CONTEXT",
                "message": err
            })),
        ),
    }
}

pub async fn list_tenants(State(state): State<AppState>) -> impl IntoResponse {
    let list: Vec<TenantProfile> = state
        .tenants
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    (StatusCode::OK, Json(json!({ "status": "success", "tenants": list })))
}
