use serde_json::{json, Value};
use tracing::{error, info};

pub struct GeminiClient {
    pub api_key: String,
    pub client: reqwest::Client,
}

impl GeminiClient {
    /// Builds a client, surfacing a TLS or resolver failure as an error.
    ///
    /// `build().unwrap()` panicked the worker thread on a TLS setup failure, which
    /// presented as a mysterious crash instead of a configuration error.
    pub fn try_new(api_key: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| format!("Gemini HTTP client could not be built: {e}"))?;
        Ok(Self { api_key, client })
    }

    pub fn new(api_key: String) -> Self {
        Self::try_new(api_key).unwrap_or_else(|e| panic!("{e}"))
    }

    /// Invokes Google Gemini with structured output schema configuration
    pub async fn generate_structured(&self, prompt: &str, schema: Value) -> Result<Value, String> {
        info!("Executing Gemini structured inference via Tokio async runtime");

        // A caller holding a placeholder key used to receive this canned response
        // indistinguishable from a real one, and the response body even asserted
        // "complianceVerified": true. The mock is now opt-in through an explicit flag, so
        // a misconfigured deployment errors instead of confidently inventing an answer.
        if std::env::var("GEMINI_MOCK").as_deref() == Ok("1") {
            if self.api_key.trim().is_empty() {
                return Err("GEMINI_MOCK=1 is set but no API key was provided".to_string());
            }
            return Ok(json!({
                "status": "success",
                "confidenceScore": 0.96,
                "nicheSpecificResult": {
                    "processedBy": "Software Factory Tokio Engine",
                    "throughputMetrics": "Zero Latency Spikes",
                    "schemaEnforced": true
                },
                "recommendedActions": [
                    "Dispatch automated notification to tenant operator",
                    "Persist immutable audit record in Appwrite ledger"
                ],
                "anomaliesDetected": [],
                "complianceVerified": true,
                "mock": true
            }));
        }

        if self.api_key.trim().is_empty() {
            return Err("GEMINI_API_KEY is not configured; refusing to generate".to_string());
        }

        // The key travels in a header rather than the query string: a query string is
        // captured by intermediary access logs, which is a durable copy of the credential.
        let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";
        let key_header = reqwest::header::HeaderValue::from_str(&self.api_key)
            .map_err(|_| "GEMINI_API_KEY contains characters illegal in a header".to_string())?;

        let body = json!({
            "contents": [{ "parts": [{ "text": prompt }] }],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": schema,
                "temperature": 0.1
            }
        });

        let resp = self.client.post(url)
            .header("x-goog-api-key", key_header)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP request to Gemini failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            error!(%status, %text, "Gemini API error");
            return Err(format!("Gemini API responded with status {}: {}", status, text));
        }

        let json_resp: Value = resp.json().await.map_err(|e| format!("Invalid JSON from Gemini: {}", e))?;
        let content_text = json_resp["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or_else(|| "Missing candidates text in Gemini response".to_string())?;

        serde_json::from_str(content_text).map_err(|e| format!("Failed to parse structured output: {}", e))
    }
}
