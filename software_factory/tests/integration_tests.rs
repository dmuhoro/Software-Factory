//! Layer 4: the ingestion pipeline's end-to-end contract.
//!
//! `test_real_estate_telemetry_pipeline_success` used to assert success while the Gemini
//! client was returning a canned response for the placeholder key `TEST_KEY` and the
//! Appwrite client was discarding its payload and logging "persistence completed". The two
//! fictions cancelled, so the suite was green while nothing was persisted and no inference
//! had happened.
//!
//! Removing the placeholder-key path and awaiting the write makes that visible: the test
//! fails until it is rewritten against a real Appwrite stub and the explicit mock opt-in.
//! It now also asserts that the write actually arrived, which is the inverse of the defect.

use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use serde_json::json;
use software_factory::{
    models::{IndustryNiche, IngestPayload},
    services::ConcurrencyPipeline,
    AppState,
};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

/// A real HTTP server standing in for Appwrite, recording every document it is sent.
///
/// The stub is used instead of mocking the client so the test exercises the real request the
/// code makes: the URL shape, the project and key headers, and the JSON body.
async fn spawn_appwrite_stub() -> (String, Arc<Mutex<Vec<String>>>) {
    let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();

    let app = Router::new().route(
        "/databases/:db/collections/:coll/documents",
        post(move |body: Bytes| {
            let sink = sink.clone();
            async move {
                sink.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&body).to_string());
                (StatusCode::CREATED, "{}")
            }
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    (format!("http://{addr}"), received)
}

fn real_estate_payload() -> IngestPayload {
    IngestPayload {
        tenant_id: "tenant_re_8841".to_string(),
        niche: IndustryNiche::RealEstate,
        event_type: "PROPERTY_VALUATION_REQUEST".to_string(),
        idempotency_key: "idem_re_991823".to_string(),
        payload: json!({
            "propertyId": "PROP-LUXURY-4902",
            "listPrice": 1250000,
            "squareFootage": 3400
        }),
    }
}

#[tokio::test]
async fn a_valid_event_is_transformed_and_actually_persisted() {
    // The mock is opt-in through an explicit flag, and it marks its own output as a mock so a
    // fabricated response can never again be mistaken for a real inference.
    std::env::set_var("GEMINI_MOCK", "1");
    std::env::set_var("APPWRITE_API_KEY", "stub-project-key");

    let (endpoint, received) = spawn_appwrite_stub().await;
    let state = AppState::with_tenant_keys(
        "mocked-gemini-key".into(),
        endpoint,
        "proj_test".into(),
        Default::default(),
    );

    let result = ConcurrencyPipeline::process_telemetry(&state, real_estate_payload()).await;
    let response = result.expect("a valid event should complete the pipeline");

    assert_eq!(response.status, "success");
    assert_eq!(response.tenant_id, "tenant_re_8841");

    // The point of the rewrite: the document must genuinely exist downstream. The old
    // implementation returned Ok(()) without sending anything.
    let documents = received.lock().unwrap().clone();
    assert_eq!(
        documents.len(),
        1,
        "expected exactly one persisted document, got {}",
        documents.len()
    );
    let stored: serde_json::Value = serde_json::from_str(&documents[0]).unwrap();
    assert_eq!(stored["tenantId"], "tenant_re_8841", "the row must carry the tenant partition");
    assert!(stored["documentId"].as_str().unwrap().starts_with("tx_rust_"));

    std::env::remove_var("APPWRITE_API_KEY");
}

#[tokio::test]
async fn a_failed_audit_write_is_reported_instead_of_claimed_as_success() {
    std::env::set_var("GEMINI_MOCK", "1");
    // No APPWRITE_API_KEY: the write cannot happen, and the caller must be told.
    std::env::remove_var("APPWRITE_API_KEY");

    let state = AppState::with_tenant_keys(
        "mocked-gemini-key".into(),
        "https://appwrite.invalid/v1".into(),
        "proj_test".into(),
        Default::default(),
    );

    let result = ConcurrencyPipeline::process_telemetry(&state, real_estate_payload()).await;
    let error = result.expect_err("an event that cannot be persisted must not report success");
    assert!(
        error.starts_with("AUDIT_PERSIST_FAILED"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn test_cross_tenant_niche_conflation_rejected() {
    let state = AppState::new("TEST_KEY".into(), "https://cloud.appwrite.io/v1".into(), "proj_test".into());

    // tenant_re_8841 is Real Estate, but attempting to send Healthcare payload
    let payload = IngestPayload {
        tenant_id: "tenant_re_8841".to_string(),
        niche: IndustryNiche::Healthcare,
        event_type: "PATIENT_INTAKE".to_string(),
        idempotency_key: "idem_cross_violation".to_string(),
        payload: json!({ "patientCohortId": "COHORT-404" }),
    };

    let result = ConcurrencyPipeline::process_telemetry(&state, payload).await;
    assert!(result.is_err(), "Cross-niche conflation must be strictly rejected");
    assert!(result.unwrap_err().contains("does not match requested niche"));
}

#[tokio::test]
async fn test_healthcare_direct_phi_boundary_enforcement() {
    let state = AppState::new("TEST_KEY".into(), "https://cloud.appwrite.io/v1".into(), "proj_test".into());

    // Healthcare payload with illegal raw SSN
    let payload = IngestPayload {
        tenant_id: "tenant_hc_1042".to_string(),
        niche: IndustryNiche::Healthcare,
        event_type: "PATIENT_INTAKE".to_string(),
        idempotency_key: "idem_phi_violation".to_string(),
        payload: json!({
            "patientCohortId": "COHORT-104",
            "ssn": "000-12-3456"
        }),
    };

    let result = ConcurrencyPipeline::process_telemetry(&state, payload).await;
    assert!(result.is_err(), "Direct PHI in stream must trip compliance guardrails");
    assert!(result.unwrap_err().contains("Direct PHI detected"));
}

#[tokio::test]
async fn an_unknown_tenant_is_rejected_by_the_pipeline_itself() {
    let state = AppState::new("TEST_KEY".into(), "https://cloud.appwrite.io/v1".into(), "proj_test".into());

    let mut payload = real_estate_payload();
    payload.tenant_id = "tenant_invented_9999".to_string();

    let result = ConcurrencyPipeline::process_telemetry(&state, payload).await;
    assert!(result.is_err(), "an unknown tenant must not be processed");
    assert!(result.unwrap_err().contains("not found"));
}
