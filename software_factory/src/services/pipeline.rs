use crate::adapters::get_adapter;
use crate::models::{IngestPayload, TransformationResponse};
use crate::services::{appwrite_client::AppwriteClient, gemini_client::GeminiClient};
use crate::AppState;
use std::time::Instant;
use tracing::{error, info, instrument};
use uuid::Uuid;

pub struct ConcurrencyPipeline;

impl ConcurrencyPipeline {
    #[instrument(skip(state, payload), fields(tenant_id = %payload.tenant_id, event_type = %payload.event_type))]
    pub async fn process_telemetry(
        state: &AppState,
        payload: IngestPayload,
    ) -> Result<TransformationResponse, String> {
        let start = Instant::now();
        let correlation_id = format!("rust_corr_{}", Uuid::new_v4());

        // 1. Verify tenant isolation in DashMap
        let tenant = state.tenants.get(&payload.tenant_id)
            .ok_or_else(|| format!("Tenant '{}' not found", payload.tenant_id))?;

        if !tenant.active {
            return Err(format!("Tenant '{}' is suspended", payload.tenant_id));
        }

        if tenant.niche != payload.niche {
            return Err(format!(
                "Tenant {:?} does not match requested niche {:?}",
                tenant.niche, payload.niche
            ));
        }

        // 2. Select swappable domain adapter
        let adapter = get_adapter(payload.niche);
        let normalized = adapter
            .validate_and_normalize(&payload.payload)
            .await
            .map_err(|e| format!("Adapter normalization failed: {}", e))?;

        let schema = adapter.extract_gemini_schema();

        // 3. Invoke Gemini structured output engine via Tokio task
        let gemini = GeminiClient::new(state.gemini_api_key.clone());
        let prompt = format!(
            "Tenant Partition: {}\nNiche: {}\nNormalized Payload:\n{}",
            payload.tenant_id,
            adapter.niche_name(),
            normalized
        );

        let ai_output = gemini
            .generate_structured(&prompt, schema)
            .await
            .map_err(|e| format!("AI generation failed: {}", e))?;

        let duration_ms = start.elapsed().as_millis() as u64;
        let transformation_id = format!("tx_rust_{}", Uuid::new_v4());

        // 4. Persist to Appwrite before answering.
        //
        // This was spawned and its result discarded, so a failed write was logged after the
        // caller had already been told the transformation succeeded, and the response
        // advertised a durable audit record that was never written. The write is now awaited:
        // if the audit record cannot be stored, the request is refused, because reporting
        // success for an unrecorded event is the failure mode this pipeline exists to
        // prevent. Throughput is unaffected in the healthy case, where the call is a single
        // bounded HTTP round trip.
        let appwrite = AppwriteClient::new(
            state.appwrite_endpoint.clone(),
            state.appwrite_project_id.clone(),
            state.appwrite_api_key.clone(),
        );

        if let Err(e) = appwrite
            .persist_transformation(&payload.tenant_id, &transformation_id, &ai_output)
            .await
        {
            error!(error = %e, transformation_id = %transformation_id, "Failed to persist transformation to Appwrite");
            return Err(format!("AUDIT_PERSIST_FAILED: {e}"));
        }

        info!(%duration_ms, %transformation_id, "Successfully processed telemetry event in Tokio pipeline");

        Ok(TransformationResponse {
            status: "success".to_string(),
            correlation_id,
            tenant_id: payload.tenant_id,
            niche: payload.niche,
            transformation_id,
            duration_ms,
            output: ai_output,
        })
    }
}
