use crate::middleware::tenant_guard::AuthenticatedTenant;
use crate::models::{IngestPayload, TenantProfile};
use crate::services::ConcurrencyPipeline;
use crate::AppState;
use axum::{
    extract::{Extension, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;
use tracing::error;

pub async fn ingest_telemetry(
    State(state): State<AppState>,
    Json(payload): Json<IngestPayload>,
) -> impl IntoResponse {
    match ConcurrencyPipeline::process_telemetry(&state, payload).await {
        Ok(result) => (StatusCode::OK, Json(json!(result))),
        Err(err) => {
            // The pipeline's message names the tenant and the specific violation, which is
            // right for a log and wrong for a response body. The caller gets a stable code
            // and a fixed sentence; the detail is recorded server-side.
            let (status, code) = classify(&err);
            error!(%code, detail = %err, "Telemetry ingestion refused");
            (
                status,
                Json(json!({
                    "status": "error",
                    "code": code,
                    "message": "the request was refused; see the server log for detail",
                })),
            )
        }
    }
}

/// Maps an internal pipeline failure onto a stable code and an honest status.
///
/// Every one of these arrived as `400 Bad Request` before, which told a caller to fix a
/// payload that was in fact rejected by a server-side partition or compliance rule.
fn classify(detail: &str) -> (StatusCode, &'static str) {
    if detail.contains("not found") {
        (StatusCode::NOT_FOUND, "TENANT_NOT_FOUND")
    } else if detail.contains("suspended") {
        (StatusCode::FORBIDDEN, "TENANT_SUSPENDED")
    } else if detail.contains("does not match requested niche") {
        (StatusCode::CONFLICT, "CROSS_TENANT_CONFLATION_VIOLATION")
    } else if detail.contains("Direct PHI detected") {
        (StatusCode::UNPROCESSABLE_ENTITY, "MALFORMED_CONTEXT")
    } else {
        (StatusCode::BAD_REQUEST, "MALFORMED_CONTEXT")
    }
}

/// Returns the calling tenant's own profile.
///
/// This replaces a handler that returned every tenant in the process to any unauthenticated
/// caller. It reads the tenant id the guard resolved from the presented credential rather
/// than from a header, so a caller cannot read another partition by asking for it.
pub async fn current_tenant(
    State(state): State<AppState>,
    Extension(AuthenticatedTenant(tenant_id)): Extension<AuthenticatedTenant>,
) -> impl IntoResponse {
    match state.tenants.get(&tenant_id) {
        Some(entry) => {
            let profile: TenantProfile = entry.value().clone();
            (
                StatusCode::OK,
                Json(json!({ "status": "success", "tenant": profile })),
            )
        }
        // The guard admits only tenants present in the map, so this is a lost race with a
        // de-registration rather than an unauthorised read.
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "status": "error",
                "code": "TENANT_NOT_FOUND",
                "message": "the authenticated tenant is no longer provisioned",
            })),
        ),
    }
}
