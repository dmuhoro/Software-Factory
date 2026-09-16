use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

pub async fn require_tenant_header(req: Request<Body>, next: Next) -> Response {
    let has_tenant_header = req.headers().contains_key("x-tenant-id");

    if !has_tenant_header && !req.uri().path().starts_with("/health") {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "status": "error",
                "code": "MISSING_TENANT_HEADER",
                "message": "x-tenant-id header is strictly required to enforce partition boundaries"
            })),
        ).into_response();
    }

    next.run(req).await
}
