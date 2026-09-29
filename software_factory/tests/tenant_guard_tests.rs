//! Layer 4: the tenant boundary on the Rust service.
//!
//! These tests build the real router with the real guard and assert on what the handler
//! actually returns. A guard that is merely defined, or tested in isolation, proves
//! nothing: the defect fixed here was a guard that existed, was documented, was never
//! applied to the router, and therefore enforced nothing.

use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware,
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};
use software_factory::middleware::tenant_guard::{parse_tenant_keys, require_tenant_auth};
use software_factory::{routes, AppState};
use std::collections::HashMap;
use tower::ServiceExt;

const RE_KEY: &str = "re-cred-9f2a";
const HC_KEY: &str = "hc-cred-4b71";

/// The same shape `main.rs` builds, including the guard layer.
fn app() -> Router {
    let mut keys = HashMap::new();
    keys.insert("tenant_re_8841".to_string(), RE_KEY.to_string());
    keys.insert("tenant_hc_1042".to_string(), HC_KEY.to_string());

    let state = AppState::with_tenant_keys(
        "gemini-key-for-tests".into(),
        "https://cloud.appwrite.io/v1".into(),
        "proj_test".into(),
        keys,
    );

    Router::new()
        .route("/health", get(routes::health::health_check))
        .route("/ready", get(routes::health::readiness_check))
        .route("/api/v1/telemetry/ingest", post(routes::telemetry::ingest_telemetry))
        .route("/api/v1/tenants/me", get(routes::telemetry::current_tenant))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_tenant_auth))
        .with_state(state)
}

fn ingest_request(tenant: Option<&str>, key: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/v1/telemetry/ingest")
        .header("content-type", "application/json");
    if let Some(t) = tenant {
        builder = builder.header("x-tenant-id", t);
    }
    if let Some(k) = key {
        builder = builder.header("x-api-key", k);
    }
    builder
        .body(Body::from(
            json!({
                "tenantId": "tenant_re_8841",
                "niche": "RealEstate",
                "eventType": "PROPERTY_VALUATION_REQUEST",
                "idempotencyKey": "idem_guard_test",
                "payload": { "propertyId": "P-1", "listPrice": 100, "squareFootage": 10 }
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn missing_tenant_header_is_refused_before_the_handler_runs() {
    let response = app().oneshot(ingest_request(None, Some(RE_KEY))).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "a request with no tenant must not reach the pipeline"
    );
}

#[tokio::test]
async fn missing_credential_is_refused() {
    let response = app().oneshot(ingest_request(Some("tenant_re_8841"), None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// The core cross-tenant test: a valid credential presented for a different tenant.
#[tokio::test]
async fn a_credential_cannot_write_to_another_tenant() {
    // tenant_hc_1042's own valid credential, but claiming to be tenant_re_8841.
    let response = app()
        .oneshot(ingest_request(Some("tenant_re_8841"), Some(HC_KEY)))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "a credential bound to one tenant must not unlock another"
    );
}

#[tokio::test]
async fn an_unknown_tenant_cannot_be_invented() {
    let response = app()
        .oneshot(ingest_request(Some("tenant_does_not_exist"), Some("anything-at-all")))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_tenant_with_no_provisioned_credential_is_unwritable() {
    // tenant_log_5529 is seeded as a tenant but has no entry in the credential map.
    let mut keys = HashMap::new();
    keys.insert("tenant_re_8841".to_string(), RE_KEY.to_string());
    let state = AppState::with_tenant_keys(
        "k".into(),
        "https://cloud.appwrite.io/v1".into(),
        "p".into(),
        keys,
    );
    let router = Router::new()
        .route("/api/v1/telemetry/ingest", post(routes::telemetry::ingest_telemetry))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_tenant_auth))
        .with_state(state);

    let response = router
        .oneshot(ingest_request(Some("tenant_log_5529"), Some("guessed")))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "an unconfigured tenant must be unwritable rather than open"
    );
}

#[tokio::test]
async fn liveness_is_public_but_every_data_path_is_guarded() {
    let health = app()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK, "liveness must stay public for probes");

    // The tenant listing is a data path and must not be anonymous.
    let anon = app()
        .oneshot(
            Request::builder()
                .uri("/api/v1/tenants/me")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_refusal_body_never_echoes_the_presented_credential() {
    let secret = "sk-live-should-never-be-echoed-1234";
    let response = app()
        .oneshot(ingest_request(Some("tenant_re_8841"), Some(secret)))
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        !body.contains(secret),
        "a refusal echoed the presented credential: {body}"
    );
    let parsed: Value = serde_json::from_str(&body).expect("a refusal must be JSON, not prose");
    assert_eq!(parsed["code"], "TENANT_CREDENTIAL_MISMATCH");
}

#[test]
fn one_credential_bound_to_two_tenants_is_a_configuration_error() {
    // A shared secret cannot identify a partition. Accepting it silently would let either
    // tenant write as the other, which is the whole property the guard exists to provide.
    let spec = "tenant_re_8841:shared-key,tenant_hc_1042:shared-key";
    let error = parse_tenant_keys(spec).expect_err("a shared credential must be rejected");
    assert!(
        error.contains("exactly one partition"),
        "unexpected error text: {error}"
    );
}

#[test]
fn tenant_keys_parse_into_a_tenant_keyed_map() {
    let parsed = parse_tenant_keys("tenant_re_8841:a-key,tenant_hc_1042:b-key").unwrap();
    assert_eq!(parsed.get("tenant_re_8841").map(String::as_str), Some("a-key"));
    assert_eq!(parsed.get("tenant_hc_1042").map(String::as_str), Some("b-key"));
}

#[test]
fn a_malformed_credential_entry_is_rejected() {
    assert!(parse_tenant_keys("no-colon-here").is_err());
    assert!(parse_tenant_keys("tenant_re_8841:").is_err());
}
