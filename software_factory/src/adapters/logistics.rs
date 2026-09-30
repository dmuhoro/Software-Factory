use super::{AdapterError, NicheAdapter};
use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct LogisticsAdapter;

#[async_trait]
impl NicheAdapter for LogisticsAdapter {
    fn niche_name(&self) -> &'static str {
        "logistics"
    }

    async fn validate_and_normalize(&self, raw: &Value) -> Result<Value, AdapterError> {
        let tracking_id = raw
            .get("shipmentTrackingId")
            .or_else(|| raw.get("waybillNumber"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AdapterError::MalformedContext("Missing shipmentTrackingId".to_string())
            })?;

        let temp = raw
            .get("cargoTemperatureCelsius")
            .and_then(|v| v.as_f64())
            .unwrap_or(4.0);

        let is_breached = temp < 2.0 || temp > 8.0;

        let mut normalized = raw.clone();
        if let Some(obj) = normalized.as_object_mut() {
            obj.insert("tracking_identifier".to_string(), json!(tracking_id));
            obj.insert("thermal_integrity_breached".to_string(), json!(is_breached));
            obj.insert("telematics_validated".to_string(), json!(true));
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
                        "shipmentTrackingId": { "type": "string" },
                        "delayProbabilityPercent": { "type": "number" },
                        "temperatureIntegrityBreached": { "type": "boolean" },
                        "customsClearanceRisk": { "type": "string" }
                    },
                    "required": ["shipmentTrackingId", "delayProbabilityPercent", "temperatureIntegrityBreached", "customsClearanceRisk"]
                }
            },
            "required": ["status", "confidenceScore", "nicheSpecificResult"]
        })
    }
}
