use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::Value;
use std::time::Duration;
use tracing::info;

pub struct AppwriteClient {
    pub endpoint: String,
    pub project_id: String,
    /// Project API key. Without it Appwrite rejects writes, so its absence is what makes
    /// persistence impossible rather than something to work around.
    pub api_key: String,
    pub database_id: String,
    pub collection_id: String,
}

impl AppwriteClient {
    pub fn new(endpoint: String, project_id: String, api_key: String) -> Self {
        Self {
            endpoint,
            project_id,
            api_key,
            database_id: "b2b_software_factory".to_string(),
            collection_id: "transformations".to_string(),
        }
    }

    /// Writes the transformation to Appwrite and reports whether the write happened.
    ///
    /// This previously discarded the payload, wrote nothing, logged "Async persistence to
    /// Appwrite completed with tenant attribute permissions", and returned `Ok(())`. Because
    /// the pipeline spawned it and discarded the result, a caller received a success
    /// response and an audit trail asserting an immutable record that was never written.
    /// The only honest options are to perform the write or to report that it did not
    /// happen, so the request is now issued and any failure is returned to the caller.
    pub async fn persist_transformation(
        &self,
        tenant_id: &str,
        transformation_id: &str,
        payload: &Value,
    ) -> Result<(), String> {
        if self.api_key.trim().is_empty() {
            return Err("APPWRITE_API_KEY is not configured, so nothing was persisted".to_string());
        }

        let url = format!(
            "{}/databases/{}/collections/{}/documents",
            self.endpoint.trim_end_matches('/'),
            self.database_id,
            self.collection_id
        );

        // The tenant id is written as an Appwrite attribute so the row is partitioned by the
        // same key the request boundary authenticated.
        let mut body = serde_json::Map::new();
        body.insert(
            "documentId".to_string(),
            Value::String(transformation_id.to_string()),
        );
        body.insert("tenantId".to_string(), Value::String(tenant_id.to_string()));
        body.insert("payload".to_string(), payload.clone());
        body.insert("data".to_string(), payload.clone());

        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert(
            "x-appwrite-project",
            HeaderValue::from_str(&self.project_id)
                .map_err(|_| "APPWRITE_PROJECT_ID is not a valid header value".to_string())?,
        );
        headers.insert(
            "x-appwrite-key",
            HeaderValue::from_str(&self.api_key.clone())
                .map_err(|_| "APPWRITE_API_KEY is not a valid header value".to_string())?,
        );
        headers.insert(
            "x-appwrite-response-format",
            HeaderValue::from_static("1.5.3"),
        );

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Appwrite client could not be built: {e}"))?;

        let response = client
            .post(&url)
            .headers(headers)
            .header("x-appwrite-response-format", "1.5.3")
            .json(&Value::Object(body))
            .send()
            .await
            .map_err(|e| format!("Appwrite write for {tenant_id} failed in transport: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            // The status is logged; the upstream body is not relayed, since it can echo the
            // project key or internal document ids back into a client-visible error.
            return Err(format!(
                "Appwrite write for {tenant_id} was rejected with status {status}"
            ));
        }

        info!(
            %tenant_id,
            %transformation_id,
            %status,
            database_id = %self.database_id,
            "Persisted transformation to Appwrite with tenant attribute permissions"
        );
        Ok(())
    }
}
