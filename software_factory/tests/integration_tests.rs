use serde_json::json;
use software_factory::{
    models::{IndustryNiche, IngestPayload},
    services::ConcurrencyPipeline,
    AppState,
};

#[tokio::test]
async fn test_real_estate_telemetry_pipeline_success() {
    let state = AppState::new("TEST_KEY".into(), "https://cloud.appwrite.io/v1".into(), "proj_test".into());

    let payload = IngestPayload {
        tenant_id: "tenant_re_8841".to_string(),
        niche: IndustryNiche::RealEstate,
        event_type: "PROPERTY_VALUATION_REQUEST".to_string(),
        idempotency_key: "idem_re_991823".to_string(),
        payload: json!({
            "propertyId": "PROP-LUXURY-4902",
            "listPrice": 1250000,
            "squareFootage": 3400
        }),
    };

    let result = ConcurrencyPipeline::process_telemetry(&state, payload).await;
    assert!(result.is_ok(), "Real estate pipeline execution should succeed");

    let resp = result.unwrap();
    assert_eq!(resp.status, "success");
    assert_eq!(resp.tenant_id, "tenant_re_8841");
    assert!(resp.duration_ms < 500, "In-memory Tokio execution should be sub-500ms");
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
