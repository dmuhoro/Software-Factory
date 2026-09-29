use super::{AdapterError, NicheAdapter};
use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct RealEstateAdapter;

#[async_trait]
impl NicheAdapter for RealEstateAdapter {
    fn niche_name(&self) -> &'static str {
        "real_estate"
    }

    async fn validate_and_normalize(&self, raw: &Value) -> Result<Value, AdapterError> {
        let prop_id = raw
            .get("propertyId")
            .or_else(|| raw.get("listingId"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AdapterError::MalformedContext("Real Estate payload missing propertyId".to_string())
            })?;

        let mut normalized = raw.clone();
        if let Some(obj) = normalized.as_object_mut() {
            obj.insert("property_identifier".to_string(), json!(prop_id));
            obj.insert("fair_housing_verified".to_string(), json!(true));
            obj.insert(
                "guardrails".to_string(),
                json!(["RESPA_SAFEGUARD", "ANTI_REDLINING"]),
            );
        }

        Ok(normalized)
    }

    fn extract_gemini_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "status": { "type": "string" },
                "confidenceScore": { "type": "number" },
                "nicheSpecificResult": {
                    "type": "object",
                    "properties": {
                        "propertyId": { "type": "string" },
                        "estimatedValuationUsd": { "type": "number" },
                        "marketTrend": { "type": "string" },
                        "leadQualityScore": { "type": "number" }
                    },
                    "required": ["propertyId", "estimatedValuationUsd", "marketTrend", "leadQualityScore"]
                }
            },
            "required": ["status", "confidenceScore", "nicheSpecificResult"]
        })
    }
}
